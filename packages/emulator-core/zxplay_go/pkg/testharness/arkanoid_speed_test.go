package testharness

import (
	"image"
	"os"
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
)

// Arkanoid (Imagine, 1987) is the canonical floating-bus beam-racer:
// it runs with interrupts DISABLED and paces its game loop entirely
// against the ULA. Its sync routine ($848F in this snapshot) spins on
// IN A,(C) from port $28FF until the bus returns non-$FF (raster
// entered the paper), then beam-chases through the frame with a poll
// loop that phase-locks itself via a contended screen write
// (LD ($401F),A) and treats "bus reads $FF on 4 consecutive polls" as
// "the raster left the paper" — its end-of-frame signal.
//
// That signal only decodes correctly when three timing grids agree
// with the hardware AND each other:
//
//	– the floating-bus fetch window (ula.floatingBusByte): first 128 T
//	  of each paper line from the top-left-pixel time (48K 14336,
//	  128K 14362), bitmap/attr on slots 2..5 of each 8;
//	– the memory-contention pattern (memory.contentionDelay): base
//	  one T earlier (14335 / 14361), {6,5,4,3,2,1,0,0};
//	– the IN instruction's bus-sample point: the 4th T-state of the
//	  I/O machine cycle (instruction T+11 for IN r,(C)), where the
//	  write-stall lock always lands the sample on a data slot.
//
// With any of the three off, the poll loop misreads mid-paper idle
// slots as "frame over", the game loop runs 2-3x per frame, and the
// ball flies at double speed or more (#194). This test pins the
// repaired behaviour: exactly ONE game update per displayed frame,
// measured as the ball's on-screen speed — 3 px/frame vertically for
// this snapshot's resume state, matching FUSE 1.6.0 on the same file.
//
// The snapshot is licensed content and lives outside the repo; the
// test skips when it is absent. Set ARKANOID_Z80 to point at it.
func arkanoidSnapshotPath(t *testing.T) string {
	t.Helper()
	path := os.Getenv("ARKANOID_Z80")
	if path == "" {
		path = os.Getenv("HOME") + "/Desktop/Arkanoid (1987).z80"
	}
	if _, err := os.Stat(path); err != nil {
		t.Skipf("Arkanoid snapshot not available: %v", err)
	}
	return path
}

// ballCentroid returns the centroid of pixels that differ between two
// frames. During steady ball flight the diff is exactly the ball's
// erase+draw pair, so consecutive centroids move at the ball's speed.
func ballCentroid(a, b *image.RGBA) (cx, cy float64, n int) {
	bnds := a.Bounds()
	var sx, sy, cnt int
	for y := bnds.Min.Y; y < bnds.Max.Y; y++ {
		for x := bnds.Min.X; x < bnds.Max.X; x++ {
			ai := a.PixOffset(x, y)
			bi := b.PixOffset(x, y)
			if a.Pix[ai] != b.Pix[bi] || a.Pix[ai+1] != b.Pix[bi+1] || a.Pix[ai+2] != b.Pix[bi+2] {
				sx += x
				sy += y
				cnt++
			}
		}
	}
	if cnt == 0 {
		return 0, 0, 0
	}
	return float64(sx) / float64(cnt), float64(sy) / float64(cnt), cnt
}

// TestArkanoidBallSpeed loads the (128K-hardware) snapshot and pins
// the ball's speed at one game update per 50Hz frame.
func TestArkanoidBallSpeed(t *testing.T) {
	path := arkanoidSnapshotPath(t)
	// The .z80 is v2 hardware-mode 3: a 128K machine (7FFD=$10 — 48K
	// ROM paged, 128K timing). The browser's zxLoadSnapshot makes the
	// same choice.
	h, err := New(roms.Model128K)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.LoadSnapshot(path); err != nil {
		t.Fatal(err)
	}

	// The pacing guard: count passes of $8498 (the paper-start sync
	// exit). One per frame while the ball is in flight = 50Hz game
	// loop. The broken timing model produced 2-3 per frame.
	syncs := 0
	h.CPU().AddPreFetchHook("ark-pace", func(pc uint16) {
		if pc == 0x8498 {
			syncs++
		}
	})
	defer h.CPU().RemovePreFetchHook("ark-pace")

	// Let the resumed game settle into steady ball flight (the first
	// ~13 frames re-sync), then track the ball for 20 frames.
	h.RunFrames(14)
	prev := image.NewRGBA(h.ScreenImage().Bounds())
	copy(prev.Pix, h.ScreenImage().Pix)

	syncs = 0
	const frames = 20
	var firstX, firstY, lastX, lastY float64
	samples := 0
	for f := 0; f < frames; f++ {
		h.RunFrames(1)
		img := h.ScreenImage()
		cur := image.NewRGBA(img.Bounds())
		copy(cur.Pix, img.Pix)
		cx, cy, n := ballCentroid(prev, cur)
		prev = cur
		// Steady flight: the diff is the ball pair only (~26 px).
		if n == 0 || n > 80 {
			continue
		}
		if samples == 0 {
			firstX, firstY = cx, cy
		}
		lastX, lastY = cx, cy
		samples++
	}
	if samples < frames-2 {
		t.Fatalf("ball not in steady flight: only %d/%d clean frame diffs", samples, frames)
	}

	// Game-loop rate: exactly one paper-start sync per frame.
	if syncs < frames-1 || syncs > frames+1 {
		t.Errorf("game-loop rate: %d sync-exits in %d frames, want %d (one per frame)", syncs, frames, frames)
	}

	// Ball speed: this snapshot's resume state flies at 1 px/frame
	// horizontally and 3 px/frame vertically (FUSE 1.6.0 reference).
	// The pre-fix core measured ~6 px/frame vertical.
	vy := (firstY - lastY) / float64(samples-1)
	if vy < 0 {
		vy = -vy
	}
	vx := (firstX - lastX) / float64(samples-1)
	if vx < 0 {
		vx = -vx
	}
	t.Logf("ball speed: %.2f px/frame horizontal, %.2f px/frame vertical over %d frames", vx, vy, samples)
	if vy < 2.5 || vy > 3.5 {
		t.Errorf("ball vertical speed %.2f px/frame, want 3.0 ± 0.5 (FUSE reference)", vy)
	}

	// The bat must be VISIBLE in the rendered frame during flight.
	// The game XOR-erases it in the vblank and redraws it next frame
	// before the beam returns, so it exists on the CRT for every scan
	// of its rows while being absent from memory at the frame
	// boundary. The renderer's beam-time scanline capture
	// (ula.CaptureScanlines) is what makes this pass; an end-of-frame
	// memory render shows no bat in any flight frame (#194).
	visible := 0
	const checkFrames = 10
	for f := 0; f < checkFrames; f++ {
		h.RunFrames(1)
		img := h.ScreenImage()
		n := 0
		for y := 24 + 176; y < 24+186; y++ {
			for x := 32 + 32; x < 32+224; x++ {
				r, g, b, _ := img.At(x, y).RGBA()
				if r>>8 > 120 || (g>>8 > 120 && b>>8 > 120) {
					n++
				}
			}
		}
		if n > 40 {
			visible++
		}
	}
	if visible < checkFrames-1 {
		t.Errorf("bat visible in %d/%d rendered flight frames, want all (beam-time capture)", visible, checkFrames)
	}
}
