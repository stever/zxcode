package testharness

import (
	"crypto/md5"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/install/installtest"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// These tests run the vendored .nex builds from
// Threetwosevensixseven/ZXSpectrumNextTests (MIT; provenance and licence
// in testdata/ext327/). All four are builds of the same DMACopy.asm in
// its four modes; the DMA modes must produce byte-identical memory
// results to the LDIR ground-truth modes. Each mode signs its run so a
// pass is unambiguous: border black = DMA ran, border blue = LDIR ran,
// and the fill modes use different attribute bytes (0x46 DMA, 0x42 LDIR).
//
// The programs are fully self-contained (org $8000, DI, own IM2 vector
// table, no OS calls), so they run on the harness Next with a fake
// distro ROM — no licensed assets, which keeps these live in CI. The
// conformance dashboard resolves the ext-327 DMACopy row from these
// tests (conformance/manifest.json).

const (
	ext327Pixels   = 0x1800 // ULA bitmap $4000-$57FF
	ext327Attrs    = 0x0300 // ULA attributes $5800-$5AFF
	ext327CopyLen  = 0x1B00 // bitmap + attributes, copied from $C000
	ext327BorderDM = 0      // black border = the DMA path executed
	ext327BorderLD = 1      // blue border = the LDIR path executed
)

func runExt327(t *testing.T, name string, frames int) *Harness {
	t.Helper()
	installtest.RedirectConfig(t)
	installFakeDistroForLoad(t)
	h, err := New(roms.ModelNext)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.CloseFiles)
	if err := h.LoadNEX(filepath.Join("testdata", "ext327", name)); err != nil {
		t.Fatal(err)
	}
	// Enough frames for the program to finish its work and settle into
	// its HALT loop (the Level2Order LDIR fills alone span ~15 frames).
	h.RunFrames(frames)
	return h
}

func assertExt327Fill(t *testing.T, h *Harness, wantAttr, wantBorder byte) {
	t.Helper()
	for i := 0; i < ext327Pixels; i++ {
		if got := h.Memory(uint16(0x4000 + i)); got != 0xAA {
			t.Fatalf("bitmap byte $%04X = %#02x, want 0xAA", 0x4000+i, got)
		}
	}
	for i := 0; i < ext327Attrs; i++ {
		if got := h.Memory(uint16(0x5800 + i)); got != wantAttr {
			t.Fatalf("attr byte $%04X = %#02x, want %#02x", 0x5800+i, got, wantAttr)
		}
	}
	if got := h.ULA().BorderColour; got != wantBorder {
		t.Fatalf("border = %d, want %d (the mode's signature)", got, wantBorder)
	}
}

func assertExt327Copy(t *testing.T, h *Harness, wantBorder byte) {
	t.Helper()
	blank := true
	for i := 0; i < ext327CopyLen; i++ {
		src := h.Memory(uint16(0xC000 + i))
		dst := h.Memory(uint16(0x4000 + i))
		if src != dst {
			t.Fatalf("copy mismatch at offset $%04X: screen $%04X = %#02x, source $%04X = %#02x",
				i, 0x4000+i, dst, 0xC000+i, src)
		}
		if src != 0 {
			blank = false
		}
	}
	if blank {
		t.Fatal("source screen at $C000 is all zero — the .nex banks did not load")
	}
	if got := h.ULA().BorderColour; got != wantBorder {
		t.Fatalf("border = %d, want %d (the mode's signature)", got, wantBorder)
	}
}

// TestExt327LDIRFill establishes the ground truth: the CPU-driven fill.
func TestExt327LDIRFill(t *testing.T) {
	h := runExt327(t, "LDIRFill.nex", 5)
	assertExt327Fill(t, h, 0x42, ext327BorderLD)
}

// TestExt327DMAFill is the conformance claim: the zxnDMA fill must leave
// memory in the same state the LDIR fill does (attribute byte aside —
// the test program uses it to sign which path ran).
func TestExt327DMAFill(t *testing.T) {
	h := runExt327(t, "DMAFill.nex", 5)
	assertExt327Fill(t, h, 0x46, ext327BorderDM)
}

func TestExt327LDIRCopy(t *testing.T) {
	h := runExt327(t, "LDIRCopy.nex", 5)
	assertExt327Copy(t, h, ext327BorderLD)
}

func TestExt327DMACopy(t *testing.T) {
	h := runExt327(t, "DMACopy.nex", 5)
	assertExt327Copy(t, h, ext327BorderDM)
}

// TestExt327Level2Order runs the six NR$15 layer-ordering builds of the
// suite's Level2Order test and asserts the composite at pixels that pin
// every layer relation. The scene: Layer 2 shows a red top third
// ($C0), a transparent middle third and a green bottom third ($1C);
// the ULA shows vertical stripes whose bright-magenta PAPER palette
// entry is redefined to the global transparency colour (so paper
// columns are see-through); a sprite sits in the top third. The
// transparency fallback is black.
func TestExt327Level2Order(t *testing.T) {
	l2red := [3]byte{219, 0, 0}   // $C0 through the default RGB332 palette
	l2green := [3]byte{0, 255, 0} // $1C
	ink := [3]byte{0, 0, 255}     // ULA bright blue ink
	fall := [3]byte{0, 0, 0}      // NR$4A fallback (black)
	// Sprite pattern row 5 pixels $BF / $DF through the default palette.
	sprIn := [3]byte{182, 255, 255}
	sprPa := [3]byte{219, 255, 255}

	cases := []struct {
		order                        int
		name                         string
		topInk, topPaper             [3]byte
		botInk, botPaper             [3]byte
		spriteInkCol, spritePaperCol [3]byte
	}{
		// L above U: Layer 2 covers the stripes outside the middle.
		{0, "SLU", l2red, l2red, l2green, l2green, sprIn, sprPa},
		{1, "LSU", l2red, l2red, l2green, l2green, l2red, l2red},
		{3, "LUS", l2red, l2red, l2green, l2green, l2red, l2red},
		// U above L: ink stays on top, paper columns reveal Layer 2.
		{2, "SUL", ink, l2red, ink, l2green, sprIn, sprPa},
		{4, "USL", ink, l2red, ink, l2green, ink, sprPa},
		{5, "ULS", ink, l2red, ink, l2green, ink, l2red},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := runExt327(t, fmt.Sprintf("Level2Order_%d.nex", c.order), 40)
			img := h.ScreenImage()
			at := func(sx, sy int) [3]byte {
				px := img.RGBAAt(32+sx, 24+sy)
				return [3]byte{px.R, px.G, px.B}
			}
			check := func(what string, sx, sy int, want [3]byte) {
				if got := at(sx, sy); got != want {
					t.Errorf("%s at (%d,%d): got %v, want %v", what, sx, sy, got, want)
				}
			}
			// Stripe columns: even x = ink, odd x = paper ($AA).
			check("top ink", 100, 20, c.topInk)
			check("top paper", 101, 20, c.topPaper)
			// Middle third: Layer 2 is transparent in every order, so
			// ink shows and paper falls through to the black fallback.
			check("mid ink", 100, 100, ink)
			check("mid paper", 101, 100, fall)
			check("bot ink", 100, 170, c.botInk)
			check("bot paper", 101, 170, c.botPaper)
			// Sprite 0 sits at sprite frame Y 80 = paper row 48; its
			// dense pattern row 5 is paper row 53. With sprites active
			// the image is the 320x256 frame, so the at() helper's
			// 24+sy convention lands 24+61 = image row 85 = that same
			// paper row 53 (85-32). The alignment is pinned
			// paper-relative by TestNexttestsSpritesRelative (sprite
			// fill exactly inside its ULA outline). Sampled on an ink
			// column (36, pattern $BF) and a paper column (37, $DF).
			check("sprite/ink col", 36, 61, c.spriteInkCol)
			check("sprite/paper col", 37, 61, c.spritePaperCol)
		})
	}
}

// TestExt327ULAScreenPaging runs the three implemented builds of the
// suite's ULAScreenPaging test. Each shows main.scr, then switches the
// ULA between the main (bank 5) and shadow (bank 7) screens via $7FFD
// bit 3 while key 1 (red border) or key 2 (green border) is held — on
// the 128K personality directly, and inside the +3 special all-RAM
// configurations 0/1/2/3 and 4/5/6/7 (entered via $1FFD) for the other
// two builds. In 4/5/6/7 the program itself lives in bank 6 and
// survives its own paging switch.
func TestExt327ULAScreenPaging(t *testing.T) {
	for _, nex := range []string{"ULAScreenR520.nex", "ULAScreen0123.nex", "ULAScreen4567.nex"} {
		t.Run(nex, func(t *testing.T) {
			h := runExt327(t, nex, 5)
			mem := h.MemoryBus()
			if got := mem.ScreenPage; got != 5 {
				t.Fatalf("initial screen page = %d, want 5 (main)", got)
			}
			innerSum := func() [16]byte {
				// Hash only the 256x192 paper area: the border colour
				// changes with the held key and must not affect the
				// screen-content comparison.
				img := h.ScreenImage()
				var buf []byte
				for y := 24; y < 216; y++ {
					row := img.PixOffset(32, y)
					buf = append(buf, img.Pix[row:row+256*4]...)
				}
				return md5.Sum(buf)
			}
			mainSum := innerSum()

			// Hold key 2 (row 3 = keys 1-5, bit 1): shadow screen.
			h.kbd.PressMatrixKey(3, 0x02, true)
			h.RunFrames(4)
			if got := mem.ScreenPage; got != 7 {
				t.Errorf("with key 2 held: screen page = %d, want 7 (shadow)", got)
			}
			if got := h.ULA().BorderColour; got != 4 {
				t.Errorf("with key 2 held: border = %d, want 4 (green)", got)
			}
			shadowSum := innerSum()
			if shadowSum == mainSum {
				t.Error("shadow screen renders identically to the main screen")
			}
			h.kbd.PressMatrixKey(3, 0x02, false)

			// Hold key 1: back to the main screen.
			h.kbd.PressMatrixKey(3, 0x01, true)
			h.RunFrames(4)
			if got := mem.ScreenPage; got != 5 {
				t.Errorf("with key 1 held: screen page = %d, want 5 (main)", got)
			}
			if got := h.ULA().BorderColour; got != 2 {
				t.Errorf("with key 1 held: border = %d, want 2 (red)", got)
			}
			if back := innerSum(); back != mainSum {
				t.Error("main screen after switching back differs from the initial render")
			}
		})
	}
}

// TestExt327MMUPaging runs both builds of the suite's MMUPaging test.
// The program copies marker bytes out of 16K banks (paged at $C000 via
// port $7FFD, or at $0000-$3FFF via the MMU) into the screen bitmap.
// Bank markers: bank1[0]=$FF, bank3[$1E]=$AA, bank4[0]=$CC, bank6[0]=$49.
func TestExt327MMUPaging(t *testing.T) {
	cases := []struct {
		nex  string
		want map[uint16]byte
	}{
		{"MMUPaging7FFD.nex", map[uint16]byte{
			0x4000: 0xFF, 0x4002: 0xAA, 0x4004: 0xCC, 0x4006: 0x49,
		}},
		// The MMU variant's fourth read re-reads $001E after a $7FFD
		// write WITHOUT re-paging: the FPGA resets MMU slots 0/1 to
		// ROM on classic paging-port writes (paging_golden.txt:
		// "MMU 0 5 / W7FFD 0 -> MAP $0000 ROM"), so the read hits the
		// ROM — $00 with the harness's blank distro ROM.
		{"MMUPagingMMU.nex", map[uint16]byte{
			0x4000: 0xFF, 0x4002: 0xAA, 0x4004: 0xAA, 0x4006: 0x00, 0x4008: 0xCC,
		}},
	}
	for _, c := range cases {
		t.Run(c.nex, func(t *testing.T) {
			h := runExt327(t, c.nex, 5)
			for addr, want := range c.want {
				if got := h.Memory(addr); got != want {
					t.Errorf("[$%04X] = %#02x, want %#02x", addr, got, want)
				}
			}
		})
	}
}

// TestExt327DFFDPaging runs the suite's DFFDPaging test: markers are
// written into banks 1 and 3 of metabank 0 and metabank 1 (port $DFFD
// high-bank extension) and read back through $7FFD / $DFFD / MMU
// combinations. The screen records each value read; the vars array
// records each NR$56/$57 read-back. Both derive from the FPGA rules:
// the physical bank is DFFD<<3 | 7FFD bits 0-2, and every classic
// paging-port write re-syncs MMU slots 6/7.
func TestExt327DFFDPaging(t *testing.T) {
	h := runExt327(t, "DFFDPaging.nex", 5)
	wantScreen := map[uint16]byte{
		0x4000: 1, 0x4001: 3, 0x4002: 3, // 7FFD phase: metabank 0 then 1
		0x4004: 1, 0x4005: 3, 0x4006: 1, // MMU phase: DFFD re-sync interleaved
	}
	for addr, want := range wantScreen {
		if got := h.Memory(addr); got != want {
			t.Errorf("[$%04X] = %d, want %d", addr, got, want)
		}
	}
	wantVars := []byte{2, 3, 2, 3, 18, 19, 18, 19, 2, 3, 2, 3, 18, 19, 2, 3}
	for i, want := range wantVars {
		if got := h.Memory(uint16(0x5B00 + i)); got != want {
			t.Errorf("vars[%d] (NR$%02X read-back) = %d, want %d", i, 0x56+i%2, got, want)
		}
	}
}
