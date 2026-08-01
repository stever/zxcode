package testharness

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stever/zxplay_go/pkg/next/install"
	"github.com/stever/zxplay_go/pkg/next/install/installtest"
	"github.com/stever/zxplay_go/pkg/roms"
)

// TestNextWideFrameLayerAnchoring pins the one 320×256 frame coordinate
// system every Next wide layer shares (#171). In the FPGA the tilemap,
// the sprite engine and Layer 2's wide modes all consume the SAME
// whc/wvc counters (zxnext.vhd:4208/4337/4389 ← zxula_timing.vhd
// o_whc/o_wvc): frame (0,0) is the top-left of the 32-px border ring
// and the classic paper starts at (32,32). The regression this guards:
// the render paths used three different vertical origins (tilemap 32 px
// low in the paper area and torn 24 px against itself at the
// paper/border seam; wide Layer 2 8 px low with its bottom 16 rows
// cropped and painted over sprites regardless of NR$15).
//
// Three phases on one harness, each layer asserted against frame
// coordinates:
//
//  1. Tilemap: uniform non-transparent tiles must paint EVERY frame row
//     0..255 the same colour — continuity across the border/paper seam
//     (rows 31/32) and the paper/border seam (rows 223/224) included.
//  2. Layer 2 320×256: a painted column x=0 must show at frame x=0 from
//     row 0 to row 255 (the bottom 16 rows were cropped pre-#171).
//  3. Sprites over wide Layer 2: a sprite at frame (0,0) with
//     over-border enabled must paint ABOVE the opaque Layer 2 in the
//     default SLU priority (pre-#171 the hi-res L2 overlay covered
//     sprites unconditionally).
func TestNextWideFrameLayerAnchoring(t *testing.T) {
	installtest.RedirectConfig(t)
	installtest.AssertSandboxed(t)
	dir, err := install.Path()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, install.DistroROM), make([]byte, 0x4000), 0644); err != nil {
		t.Fatal(err)
	}
	h, err := New(roms.ModelNext)
	if err != nil {
		t.Fatalf("New(ModelNext): %v", err)
	}
	writeReg := func(reg, val byte) {
		h.ULA().WritePort(0x243B, reg)
		h.ULA().WritePort(0x253B, val)
	}
	rgbAt := func(x, y int) [3]byte {
		return frameRGB(h.ScreenImage(), x, y)
	}

	if img := h.ScreenImage(); img.Bounds().Dx() != 640 || img.Bounds().Dy() != 256 {
		t.Fatalf("Next frame = %dx%d, want 640x256 (the live Next output width)", img.Bounds().Dx(), img.Bounds().Dy())
	}

	mem := h.MemoryBus()

	// --- Phase 1: tilemap anchoring + seam continuity -------------------
	// Map in bank 7 offset 0 (NR$6E bit 7), tiles at bank 7 offset $0800
	// (NR$6F = $88), strip_flags (1 byte/entry, NR$6C default attr 0),
	// on_top so the ULA paper cannot hide it. Every entry tile 1; tile 1
	// all nibble-5 pixels; tilemap palette entry 5 = blue ($03 → 0,0,255).
	bank7 := mem.GetPage(7)
	for i := 0; i < 40*32; i++ {
		bank7[i] = 0x01
	}
	for i := 0; i < 32; i++ {
		bank7[0x0800+32+i] = 0x55
	}
	writeReg(0x6E, 0x80)
	writeReg(0x6F, 0x88)
	writeReg(0x6C, 0x00)
	writeReg(0x43, 3<<4) // palette write target: Tilemap first
	writeReg(0x40, 5)
	writeReg(0x41, 0x03)
	writeReg(0x6B, 0xA1) // enable | strip_flags | on_top

	h.RunFrames(2)
	blue := [3]byte{0, 0, 255}
	// Every frame row at one paper-region column AND one border column:
	// full coverage top row 0 → bottom row 255, no seam tears.
	for _, x := range []int{10, 100} {
		for y := 0; y < 256; y++ {
			if got := rgbAt(x, y); got != blue {
				t.Fatalf("tilemap at frame (%d,%d) = %v, want blue — vertical anchoring/seam broken", x, y, got)
			}
		}
	}
	writeReg(0x6B, 0x00) // tilemap off

	// --- Phase 2: Layer 2 320×256 anchoring + full height ---------------
	// Wide-mode framebuffer is column-major (layer2.vhd:160 — addr =
	// x&y): bank offsets 0..255 are column x=0, rows 0..255. Palette
	// entry 5 = red ($E0 → 255,0,0).
	l2bank := mem.GetPage(1)
	for i := 0; i < 256; i++ {
		l2bank[i] = 5
	}
	writeReg(0x12, 1)    // Layer 2 bank
	writeReg(0x70, 0x10) // resolution 1 = 320×256
	// Open the Layer 2 clip window to the full 256 rows, as wide-mode
	// software does (the reset default y2=191 clips rows 192-255).
	writeReg(0x1C, 0x01) // reset the NR$18 clip write index
	writeReg(0x18, 0)    // x1
	writeReg(0x18, 255)  // x2 (doubled to 511, floored to width)
	writeReg(0x18, 0)    // y1
	writeReg(0x18, 255)  // y2
	writeReg(0x43, 1<<4) // palette write target: Layer 2 first
	writeReg(0x40, 5)
	writeReg(0x41, 0xE0)
	writeReg(0x69, 0x80) // Layer 2 enable

	h.RunFrames(2)
	red := [3]byte{255, 0, 0}
	for _, y := range []int{0, 32, 128, 240, 255} {
		if got := rgbAt(0, y); got != red {
			t.Fatalf("Layer 2 320-mode column 0 at frame row %d = %v, want red — wide L2 anchoring/height broken", y, got)
		}
	}

	// --- Phase 3: sprite above wide Layer 2 at the frame origin ---------
	// Sprite 0 at frame (0,0), pattern all index 4, sprite palette entry
	// 4 = green ($1C → 0,255,0). NR$15 = enable | over-border, priority
	// SLU (sprites above Layer 2).
	writeReg(0x43, 2<<4) // palette write target: Sprites first
	writeReg(0x40, 4)
	writeReg(0x41, 0x1C)
	h.ULA().WritePort(0x303B, 0) // select sprite/pattern 0
	for i := 0; i < 256; i++ {
		h.ULA().WritePort(0x005B, 0x04)
	}
	h.ULA().WritePort(0x0057, 0x00) // X = 0
	h.ULA().WritePort(0x0057, 0x00) // Y = 0
	h.ULA().WritePort(0x0057, 0x00) // palette offset / mirrors / X8
	h.ULA().WritePort(0x0057, 0x80) // visible, pattern 0
	writeReg(0x15, 0x03)            // sprites on + over border, SLU

	h.RunFrames(2)
	green := [3]byte{0, 255, 0}
	if got := rgbAt(0, 0); got != green {
		t.Fatalf("sprite at frame (0,0) over wide Layer 2 = %v, want green — sprite origin or SLU-over-L2 broken", got)
	}
	// One row inside the paper band too: sprite rows 32..47 overlap the
	// paper's first rows, still above Layer 2.
	if got := rgbAt(0, 15); got != green {
		t.Fatalf("sprite at frame (0,15) = %v, want green (16x16 sprite spans rows 0..15)", got)
	}

	// --- Phase 4: tilemap above wide Layer 2 in the U-above-L modes -----
	// The RAMS configuration: USL priority (NR$15 bits 4:2 = 100) puts
	// the ULA+TM slot above Layer 2 — its menu text/Galaxian formation
	// are tilemap over opaque L2 art. Re-enable the phase-1 tilemap and
	// assert it covers the L2 column; flipping back to SLU must bury it
	// under L2 again (faithful: ULA+TM is below L2 there).
	writeReg(0x6B, 0xA1)
	writeReg(0x15, 0x13) // USL | sprites on + over border
	h.RunFrames(2)
	if got := rgbAt(0, 100); got != blue {
		t.Fatalf("USL: tilemap over wide L2 at frame (0,100) = %v, want blue", got)
	}
	writeReg(0x15, 0x03) // back to SLU
	h.RunFrames(2)
	if got := rgbAt(0, 100); got != red {
		t.Fatalf("SLU: wide L2 must cover the tilemap at frame (0,100) = %v, want red", got)
	}
}
