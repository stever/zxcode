package main

import (
	"image"
	"os"
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
	"github.com/stever/zxplay_go/pkg/snapshot"
)

// TestArkanoidBrowserPath reproduces the browser's exact load path:
// newEmulator(Model128K) + applySnapshotToEmulator (what zxLoadSnapshot
// calls), frames via ExecuteFrame(frameTStates()) like zxFrame — with
// AUDIO ENABLED, which is what the harness never exercises. The audio
// flush stamps ula.frameStartTstate with the previous frame's wrap
// overshoot, and a floating bus computed relative to that stamp
// jitters against the contention grid — the #194 fast-ball bug
// reproduced ONLY on this path. Measures the ball's on-screen speed.
// Skips when the local snapshot is absent (ARKANOID_Z80 overrides).
func TestArkanoidBrowserPath(t *testing.T) {
	path := os.Getenv("ARKANOID_Z80")
	if path == "" {
		path = os.Getenv("HOME") + "/Desktop/Arkanoid (1987).z80"
	}
	if _, err := os.Stat(path); err != nil {
		t.Skipf("snapshot not available: %v", err)
	}

	e, err := newEmulator(roms.Model128K)
	if err != nil {
		t.Fatal(err)
	}
	snap := snapshot.New()
	if err := snap.Load(path); err != nil {
		t.Fatal(err)
	}
	if err := applySnapshotToEmulator(e, snap); err != nil {
		t.Fatal(err)
	}
	e.paused.Store(false)

	runFrame := func() {
		e.cpu.ExecuteFrame(e.frameTStates())
		if e.peripherals != nil {
			e.peripherals.Frame()
		}
		e.ula.Render()
	}

	for i := 0; i < 14; i++ {
		runFrame()
	}
	grab := func() *image.RGBA {
		img := e.ula.Render()
		c := image.NewRGBA(img.Bounds())
		copy(c.Pix, img.Pix)
		return c
	}
	prev := grab()
	var firstY, lastY float64
	samples := 0
	for f := 0; f < 20; f++ {
		runFrame()
		cur := grab()
		var sx, sy, n int
		b := cur.Bounds()
		for y := b.Min.Y; y < b.Max.Y; y++ {
			for x := b.Min.X; x < b.Max.X; x++ {
				i := cur.PixOffset(x, y)
				if cur.Pix[i] != prev.Pix[i] || cur.Pix[i+1] != prev.Pix[i+1] || cur.Pix[i+2] != prev.Pix[i+2] {
					sx += x
					sy += y
					n++
				}
			}
		}
		prev = cur
		if n == 0 || n > 80 {
			continue
		}
		cy := float64(sy) / float64(n)
		if samples == 0 {
			firstY = cy
		}
		lastY = cy
		samples++
	}
	if samples < 10 {
		t.Fatalf("ball not in steady flight (%d samples)", samples)
	}
	vy := (firstY - lastY) / float64(samples-1)
	if vy < 0 {
		vy = -vy
	}
	t.Logf("browser-path ball speed: %.2f px/frame vertical (%d samples)", vy, samples)
	if vy < 2.5 || vy > 3.5 {
		t.Errorf("ball speed %.2f px/frame, want 3.0 +/- 0.5", vy)
	}
}
