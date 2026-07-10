package ula

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/audio"
	"github.com/conorarmstrong/zx_go/pkg/keyboard"
	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// TestAudioEventOffsetsUseReferenceClock is the regression test for
// mid-frame NR$07 speed changes. Games drop to 3.5 MHz just for their
// beeper routines and return to turbo afterwards; the old offset scaling
// divided the raw within-frame delta by the multiplier AT WRITE TIME, so a
// toggle recorded after the drop kept its turbo-scale offset — landing past
// the 70908-T frame window (dropped: silence) or out of order relative to
// earlier toggles (garbled reconstruction). Offsets must instead come from
// the CPU's segment-scaled reference clock.
func TestAudioEventOffsetsUseReferenceClock(t *testing.T) {
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	var raw, ref uint64
	mult := 8
	mem.TStates = &raw
	mem.RefTstates = func() uint64 { return ref }
	mem.SpeedMultiplier = func() int { return mult }

	u := New(mem, keyboard.New())
	u.audio = &audio.AudioSystem{} // non-nil gates event recording; not drained here

	// Frame origin.
	u.frameStartTstate = 0
	u.frameStartRefTstate = 0

	// First half of the frame at 28 MHz (x8): 40000 raw = 5000 reference T.
	raw, ref = 40000, 5000
	u.WritePort(0xFE, 0x10) // speaker on

	// Guest drops to 3.5 MHz for the sound effect; 1000 reference T later
	// it toggles again. Raw advances only 1000 now (x1).
	mult = 1
	raw, ref = 41000, 6000
	u.WritePort(0xFE, 0x00) // speaker off

	if len(u.audioEvents) != 2 {
		t.Fatalf("recorded %d audio events, want 2", len(u.audioEvents))
	}
	if got := u.audioEvents[0].tstateOffset; got != 5000 {
		t.Errorf("turbo-segment event offset = %d, want 5000 (reference T)", got)
	}
	// The old write-time division yielded (41000-0)/1 = 41000 here — deep
	// into the frame's tail for an event only 6000 reference T in, and 8x
	// out of scale with its neighbour.
	if got := u.audioEvents[1].tstateOffset; got != 6000 {
		t.Errorf("post-slowdown event offset = %d, want 6000 (reference T)", got)
	}
}
