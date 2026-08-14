package ula

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/audio"
	"github.com/stever/zxplay_go/pkg/keyboard"
	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/roms"
)

// TestFlushAudioFrameEqualFrameResidues is the regression test for the
// classic-model frame-dropping bug in flushAudioFrame's idempotence guard.
// On 48K/128K the raw T-state counter wraps to its per-frame residue at the
// end of every ExecuteFrame, and the guard compared it against the previous
// flush's value — so two consecutive frames ending on the SAME residue read
// as "no CPU time has passed" and the whole frame's audio was silently
// dropped (its speaker events crammed into the next flush). Deterministic
// beeper loops repeat residues constantly: a measured 555 Hz beep lost 17%
// of its frames on the 48K and 2% on the 128K, while the Next (monotonic
// clock) was clean. The guard must ride the monotonic reference clock.
func TestFlushAudioFrameEqualFrameResidues(t *testing.T) {
	mem, err := memory.New("", roms.Model48K)
	if err != nil {
		t.Fatalf("memory.New(Model48K): %v", err)
	}
	var raw uint64 // the wrapped, frame-relative counter ExecuteFrame leaves
	var ref uint64 // the monotonic reference clock (z80.CPU.RefTstates)
	mem.TStates = &raw
	u := New(mem, keyboard.New())
	u.SetTapeRefClock(func() uint64 { return ref })
	u.audio = &audio.AudioSystem{} // ring only; no playback device needed

	pull := make([]int16, audio.SamplesPerFrame*2)
	const tpf = 69888
	// Three frames that each end on the SAME wrapped residue, as a
	// deterministic beeper loop produces constantly. Every one must
	// yield a full frame of samples.
	for frame := 1; frame <= 3; frame++ {
		ref += tpf
		raw = 7
		u.FlushAudioFrame()
		if n := u.audio.PullMono(pull); n != audio.SamplesPerFrame {
			t.Fatalf("frame %d: flushed %d samples, want %d (equal residue must not skip the flush)",
				frame, n, audio.SamplesPerFrame)
		}
	}
	// A duplicate flush with NO time elapsed (Render + explicit
	// FlushAudioFrame in the same frame) must still be a no-op.
	u.FlushAudioFrame()
	if n := u.audio.PullMono(pull); n != 0 {
		t.Fatalf("duplicate flush pushed %d samples, want 0", n)
	}
}
