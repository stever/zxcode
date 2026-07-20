package main

import (
	"fmt"
	"image/png"
	"os"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// TestSpaceInvadersProbe is the #204 regression probe: the Space
// Invaders .nex (arcade-faithful port; bare-file import via the typed
// `.nexload /zx.nex` route) draws its whole arcade overlay — score
// header, invader field, INSERT COIN — on the classic ULA screen with
// NR$14=black transparency, layered ABOVE a 320x256 hi-res Layer 2
// planet backdrop by NR$15 priority USL. Before the CaptureULABase
// wide-L2 ULA repaint, the composed frame showed only the planet: the
// game looked stuck on its "initial screen" while running perfectly
// underneath (the coin key K and start key 1 worked, invisibly).
//
// The probe asserts (1) the composed attract frame contains the white
// arcade overlay, and (2) K (coin) + 1 (start) enter game mode (the
// game's $FB0D bit 0 mode flag clears and the credit is consumed).
// Skips unless the local game file and an SD image are present.
// Run: ZX_GO_SI_PROBE=1 ZX_GO_NEXT_SD_IMG=<tbblue.mmc> \
//	go test ./cmd/zx_go/ -run TestSpaceInvadersProbe -v
func TestSpaceInvadersProbe(t *testing.T) {
	if os.Getenv("ZX_GO_SI_PROBE") == "" {
		t.Skip("diagnostic probe; set ZX_GO_SI_PROBE=1 to run")
	}
	// ZX_GO_SI_NEX overrides the game-file location; fallbacks cover the
	// places the local library has lived.
	paths := []string{
		os.Getenv("ZX_GO_SI_NEX"),
		os.Getenv("HOME") + "/Documents/ZX Spectrum/ZX Spectrum Next/Space Invaders.nex",
		os.Getenv("HOME") + "/Documents/ZX Spectrum Next/Space Invaders.nex",
		os.Getenv("HOME") + "/Downloads/ZX Spectrum Next/Space Invaders.nex",
	}
	var nexData []byte
	var err error
	for _, p := range paths {
		if p == "" {
			continue
		}
		if nexData, err = os.ReadFile(p); err == nil {
			break
		}
	}
	if err != nil {
		t.Skipf("no local Space Invaders (set ZX_GO_SI_NEX): %v", err)
	}

	prev := cliFlagsActive
	nf := cliFlags{}
	if prev != nil {
		nf = *prev
	}
	nf.noSound = true
	cliFlagsActive = &nf
	t.Cleanup(func() { cliFlagsActive = prev })

	emu, err := newNextEmulator()
	if err != nil {
		t.Skipf("Next ROMs not installed: %v", err)
	}
	if emu.sdImageSrc == nil {
		t.Skip("no SD image mounted (set ZX_GO_NEXT_SD_IMG)")
	}

	outDir := os.Getenv("ZX_GO_SI_PROBE_DIR")
	if outDir == "" {
		outDir = t.TempDir()
	}

	frame := 0
	step := func() {
		emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		if emu.kbd != nil {
			emu.kbd.Tick()
		}
		if emu.nexloadMacro != nil && emu.nexloadMacro.tick(emu) {
			emu.nexloadMacro = nil
		}
		frame++
	}
	shot := func(tag string) {
		fp, err := os.Create(fmt.Sprintf("%s/si_%06d_%s.png", outDir, frame, tag))
		if err != nil {
			return
		}
		defer fp.Close()
		_ = png.Encode(fp, emu.renderFrame())
	}
	// whitePixels counts near-white grey pixels in the composed frame —
	// the arcade overlay's ink (classic non-bright white). The planet
	// backdrop (blue sky / orange surface) has none.
	whitePixels := func() int {
		img := emu.renderFrame()
		n := 0
		for i := 0; i+3 < len(img.Pix); i += 4 {
			r, g, b := img.Pix[i], img.Pix[i+1], img.Pix[i+2]
			if r >= 0xB0 && r == g && g == b {
				n++
			}
		}
		return n
	}
	press := func(row int, mask byte) {
		for f := 0; f < 30; f++ {
			emu.kbd.PressMatrixKey(row, mask, true)
			step()
		}
		emu.kbd.PressMatrixKey(row, mask, false)
		for f := 0; f < 120; f++ {
			step()
		}
	}
	read := func(a uint16) byte { return emu.mem.Read(a) }

	// Bare-name import = the browser/GUI File->Open route (#184).
	emu.importAndRunNex("Space Invaders.nex", nexData)
	for f := 0; f < 8000 && emu.nexloadMacro != nil; f++ {
		step()
	}
	// (1) The arcade overlay is visible in the COMPOSED frame. The
	// attract cycles through phases (some show only the planet), so
	// sample across ~40s of attract and take the maximum.
	maxWhite := 0
	for i := 0; i < 20; i++ {
		for f := 0; f < 100; f++ {
			step()
		}
		if w := whitePixels(); w > maxWhite {
			maxWhite = w
		}
	}
	shot("attract")
	if maxWhite < 500 {
		t.Fatalf("attract overlay invisible: max %d white pixels in the composed frame (want >= 500 — score header + invaders)", maxWhite)
	}
	t.Logf("attract overlay visible: max %d white pixels", maxWhite)

	// (2) Coin (K) + start (1) enter game mode: the game's mode flag
	// $FB0D bit 0 (1 = attract, 0 = game) clears and the credit at
	// $F04E is consumed.
	press(6, 0x04) // K = insert coin
	if c := read(0xF04E); c != 1 {
		t.Fatalf("coin not registered: credits=%d (want 1)", c)
	}
	press(3, 0x01) // 1 = one-player start
	if md := read(0xFB0D); md&0x01 != 0 {
		t.Fatalf("start not accepted: $FB0D=$%02X still has the attract bit", md)
	}
	if c := read(0xF04E); c != 0 {
		t.Fatalf("credit not consumed on start: credits=%d", c)
	}
	for f := 0; f < 600; f++ {
		step()
	}
	shot("gamemode")
	t.Logf("game mode entered at frame %d, overlay white pixels=%d", frame, whitePixels())
}
