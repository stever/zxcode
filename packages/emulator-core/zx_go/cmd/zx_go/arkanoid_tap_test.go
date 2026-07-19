package main

import (
	"image/png"
	"os"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
	"github.com/conorarmstrong/zx_go/pkg/ula"
)

// TestArkanoidTapBatVisible: clean-tape end-to-end regression for the
// beam-time render capture (#194). Loads Arkanoid from a local .tap
// (skips when absent; ARKANOID_TAP overrides), presses through the
// title into the attract demo — the shipped demo plays the real game
// engine with a baked-in score of 110 — and asserts the bat stays
// visible in the RENDERED frame during live ball flight. The game
// XOR-erases the bat in the vblank and redraws it ahead of the beam
// each frame, so an end-of-frame memory render never shows it.
func TestArkanoidTapBatVisible(t *testing.T) {
	path := os.Getenv("ARKANOID_TAP")
	if path == "" {
		path = os.Getenv("HOME") + "/Downloads/Retro/ZX Spectrum/TFW8B/Home/Games/Classic/Arkanoid (1987).tap"
	}
	if _, err := os.Stat(path); err != nil {
		t.Skipf("tap not present: %v", err)
	}

	emu, err := newEmulator(roms.Model128K)
	if err != nil {
		t.Fatal(err)
	}
	tp := ula.NewTapePlayer()
	if err := tp.LoadTAP(path); err != nil {
		t.Fatal(err)
	}
	emu.ula.SetTapePlayer(tp)
	tp.Play()
	installTapeTrap(emu)

	run := func(n int) {
		for i := 0; i < n; i++ {
			runOneFrameHeadless(emu, roms.Model128K)
		}
	}
	tapEnter := func() {
		emu.kbd.PressMatrixKey(6, 0x01, true)
		run(10)
		emu.kbd.PressMatrixKey(6, 0x01, false)
		run(60)
	}

	// Boot the 128K menu, ENTER = Tape Loader; trap-load the game.
	run(180)
	tapEnter()
	run(600)
	// Title -> highscores -> story -> demo game.
	tapEnter()
	tapEnter()
	// Wait for the blue playfield.
	reached := false
	for i := 0; i < 40 && !reached; i++ {
		run(100)
		blue := 0
		for a := 0x5800; a < 0x5B00; a += 7 {
			if emu.mem.Read(uint16(a))&0x38 == 0x08 {
				blue++
			}
		}
		reached = blue > 40
	}
	if !reached {
		t.Fatal("never reached the playfield")
	}
	run(400) // round intro + serve; demo ball in flight
	if d := os.Getenv("ARK_SCRATCH"); d != "" {
		img := emu.renderFrame()
		if f, err := os.Create(d + "/regcheck.png"); err == nil {
			_ = png.Encode(f, img)
			f.Close()
		}
	}

	// The bat must be visible in the RENDERED image on (nearly) every
	// flight frame. Bat = a horizontal run of bright non-paper pixels
	// in the bottom paper band.
	visible := 0
	const frames = 25
	for f := 0; f < frames; f++ {
		run(1)
		img := emu.renderFrame()
		n := 0
		for y := 24 + 170; y < 24+192; y++ {
			for x := 32 + 16; x < 32+240; x++ {
				r, g, b, _ := img.At(x, y).RGBA()
				// Bat body: cyan and white pixels (paper blue has g≈0,
				// black has both ≈0 — neither matches).
				if g>>8 > 150 && b>>8 > 150 {
					n++
				}
				_ = r
			}
		}
		if n > 25 {
			visible++
		}
	}
	if visible < frames-3 {
		t.Errorf("bat visible in %d/%d rendered demo-flight frames, want nearly all (beam-time capture, #194)", visible, frames)
	} else {
		t.Logf("bat visible in %d/%d rendered demo-flight frames", visible, frames)
	}
}
