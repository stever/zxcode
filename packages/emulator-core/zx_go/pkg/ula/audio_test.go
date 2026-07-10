package ula

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/audio"
)

// TestFlushAudioFrameSilent verifies that a frame with no speaker
// toggles produces a constant DC level matching the initial speaker
// state — and crucially, exactly one frame's worth of samples.
func TestFlushAudioFrameSilent(t *testing.T) {
	u := newAudioTestULA(t)
	u.Speaker = false
	u.frameStartSpeakerState = false

	samples, _ := generateBeeperFrame(u.audioEvents, u.frameStartSpeakerState, 69888)

	if len(samples) != audio.SamplesPerFrame {
		t.Fatalf("len(samples) = %d, want %d", len(samples), audio.SamplesPerFrame)
	}
	for i, s := range samples {
		if s != beeperLow {
			t.Errorf("sample %d = %d, want %d (silent low)", i, s, beeperLow)
			break
		}
	}
}

// TestFlushAudioFrameInitialHigh verifies that a "speaker held high
// for the whole frame" case produces all-high samples.
func TestFlushAudioFrameInitialHigh(t *testing.T) {
	u := newAudioTestULA(t)
	u.frameStartSpeakerState = true

	samples, _ := generateBeeperFrame(u.audioEvents, u.frameStartSpeakerState, 69888)
	for i, s := range samples {
		if s != beeperHigh {
			t.Errorf("sample %d = %d, want %d (high)", i, s, beeperHigh)
			break
		}
	}
}

// TestFlushAudioFrameSquareWave drives a single mid-frame toggle and
// verifies the sample stream actually transitions where it should —
// the whole point of the rewrite. Before the fix this transition
// would have been collapsed away by the audio reader sampling once
// per buffer refill.
func TestFlushAudioFrameSquareWave(t *testing.T) {
	u := newAudioTestULA(t)
	u.frameStartSpeakerState = false
	// Toggle high at exactly the middle of the frame.
	u.audioEvents = []audioEvent{
		{tstateOffset: 69888 / 2, state: true},
	}

	samples, _ := generateBeeperFrame(u.audioEvents, u.frameStartSpeakerState, 69888)

	// First sample must be low.
	if samples[0] != beeperLow {
		t.Errorf("sample 0 = %d, want %d", samples[0], beeperLow)
	}
	// Last sample must be high.
	if samples[len(samples)-1] != beeperHigh {
		t.Errorf("last sample = %d, want %d", samples[len(samples)-1], beeperHigh)
	}
	// Find the transition point and check it's near the middle.
	transition := -1
	for i := 1; i < len(samples); i++ {
		if samples[i-1] != samples[i] {
			transition = i
			break
		}
	}
	if transition < 0 {
		t.Fatal("no transition found in sample stream")
	}
	mid := audio.SamplesPerFrame / 2
	if transition < mid-2 || transition > mid+2 {
		t.Errorf("transition at sample %d, expected ~%d", transition, mid)
	}
}

// TestFlushAudioFrameMultipleToggles verifies several toggles per
// frame are reproduced in order. Drives a 4-step pattern across the
// frame and checks each segment has the expected level.
func TestFlushAudioFrameMultipleToggles(t *testing.T) {
	u := newAudioTestULA(t)
	u.frameStartSpeakerState = false
	const tpf = 69888
	u.audioEvents = []audioEvent{
		{tstateOffset: tpf / 4, state: true},
		{tstateOffset: tpf / 2, state: false},
		{tstateOffset: 3 * tpf / 4, state: true},
	}

	samples, _ := generateBeeperFrame(u.audioEvents, u.frameStartSpeakerState, 69888)

	// Sample at the middle of each quarter and check the level.
	check := func(t *testing.T, sampleIdx int, want int16, label string) {
		t.Helper()
		if samples[sampleIdx] != want {
			t.Errorf("%s (sample %d): got %d, want %d", label, sampleIdx, samples[sampleIdx], want)
		}
	}
	q := audio.SamplesPerFrame / 4
	check(t, q/2, beeperLow, "quarter 1 (low)")
	check(t, q+q/2, beeperHigh, "quarter 2 (high)")
	check(t, 2*q+q/2, beeperLow, "quarter 3 (low)")
	check(t, 3*q+q/2, beeperHigh, "quarter 4 (high)")
}

// TestFlushAudioFrameIntegratesSubSampleToggles is the regression
// test for the "fuzzy beep" fix. It drives several speaker toggles
// inside a single audio sample window and verifies the output sample
// reflects the *average* speaker level over the window, not just the
// state at one instant. Without integration the sample would jump
// between full high and full low depending on which toggle landed
// closest to the midpoint, producing pulse-width jitter.
func TestFlushAudioFrameIntegratesSubSampleToggles(t *testing.T) {
	const tpf = 69888
	tstatesPerSample := tpf / audio.SamplesPerFrame // ~79

	// Build events that toggle the speaker at 1/4 and 3/4 of the
	// way through sample 0's window. The speaker is therefore:
	//   - low for 25% of the window (state 0 → 25)
	//   - high for 50% of the window (25 → 75)
	//   - low for 25% of the window (75 → end)
	// Total high time = 50% → output should be exactly midway
	// between beeperLow and beeperHigh, i.e. 0.
	events := []audioEvent{
		{tstateOffset: tstatesPerSample / 4, state: true},
		{tstateOffset: 3 * tstatesPerSample / 4, state: false},
	}

	samples, _ := generateBeeperFrame(events, false, 69888)

	// Sample 0 should be near the midpoint between beeperLow and
	// beeperHigh. Without the integration fix, sample 0 would be
	// either beeperLow or beeperHigh (full ±6000). The integer
	// truncation of the event offsets means the duty cycle isn't
	// exactly 50% — typical result is ±100 — but anything inside
	// ±500 confirms the integration is averaging across the whole
	// window, not snapping to a single value.
	got := samples[0]
	if got < -500 || got > 500 {
		t.Errorf("sample 0 = %d, want near 0 (~50%% duty cycle averaged); a value near ±6000 means integration is broken", got)
	}
}

// TestFlushAudioFramePartialOverlap verifies the integration handles
// a transition that lands AT a sample boundary correctly — sample N
// should be 100% in the new state, sample N-1 should be 100% in the
// old state, with no smearing.
func TestFlushAudioFramePartialOverlap(t *testing.T) {
	const tpf = 69888
	const samples = audio.SamplesPerFrame
	// Toggle exactly at the boundary between sample 100 and sample 101.
	events := []audioEvent{
		{tstateOffset: 101 * tpf / samples, state: true},
	}
	out, _ := generateBeeperFrame(events, false, 69888)

	if out[100] != beeperLow {
		t.Errorf("sample 100 (just before boundary): got %d, want %d", out[100], beeperLow)
	}
	if out[101] != beeperHigh {
		t.Errorf("sample 101 (at boundary): got %d, want %d", out[101], beeperHigh)
	}
}

// TestFrameTailEventsNotDropped is the regression test for the hardcoded
// 48K frame length: on the 128K family and the Next a frame is 70908
// T-states, so toggles in the [69888, 70908) tail must still be integrated
// into the last samples and reflected in finalState. With the old 69888
// window they were silently dropped and the next frame started with an
// inverted speaker level — a 50Hz buzz on any sustained tone.
func TestFrameTailEventsNotDropped(t *testing.T) {
	const tpf = 70908 // 128K/Next frame
	events := []audioEvent{
		{tstateOffset: 70000, state: true},
	}
	samples, finalState := generateBeeperFrame(events, false, tpf)

	if !finalState {
		t.Errorf("finalState = false, want true (tail toggle at 70000 must count)")
	}
	last := samples[len(samples)-1]
	if last <= beeperLow {
		t.Errorf("last sample = %d, want > %d (tail toggle must raise the final window's average)", last, beeperLow)
	}
}

// TestFrameBoundaryEventDrained: an event at exactly tstatesPerFrame never
// lands in a [sampleStart, sampleEnd) window (the last window is exclusive
// at the boundary; turbo-division rounding can produce such offsets), so it
// contributes nothing to this frame's samples but must still update
// finalState for the next frame's seed.
func TestFrameBoundaryEventDrained(t *testing.T) {
	const tpf = 70908
	events := []audioEvent{
		{tstateOffset: tpf, state: true},
	}
	samples, finalState := generateBeeperFrame(events, false, tpf)

	if !finalState {
		t.Errorf("finalState = false, want true (boundary event must be drained into finalState)")
	}
	for i, s := range samples {
		if s != beeperLow {
			t.Errorf("sample %d = %d, want %d (boundary event is outside every window)", i, s, beeperLow)
			break
		}
	}
}

// TestCrossFrameToneContinuity plays a constant-period square wave across two
// 128K-length frames and verifies the second frame is seeded with the correct
// phase. The period (997 T) is chosen so frame 1's last toggle lands in the
// [69888, 70908) tail region and frame 2's first toggle falls beyond sample
// 0's window; with the old 69888 window the tail toggle was lost and frame 2
// started phase-inverted.
func TestCrossFrameToneContinuity(t *testing.T) {
	const tpf = 70908
	const period = 997

	var frame1, frame2 []audioEvent
	state := false
	toggles1 := 0
	for tp := period; tp < 2*tpf; tp += period {
		state = !state
		if tp < tpf {
			frame1 = append(frame1, audioEvent{tstateOffset: tp, state: state})
			toggles1++
		} else {
			frame2 = append(frame2, audioEvent{tstateOffset: tp - tpf, state: state})
		}
	}

	_, finalState := generateBeeperFrame(frame1, false, tpf)
	wantSeed := toggles1%2 == 1
	if finalState != wantSeed {
		t.Fatalf("finalState after frame 1 = %v, want %v (%d toggles from low)", finalState, wantSeed, toggles1)
	}

	// Frame 2's first sample window ([0, ~80) T) is covered by finalState up
	// to the first frame-2 event; its level must match that seed, not the
	// inverse — the audible symptom of the dropped-tail bug.
	samples2, _ := generateBeeperFrame(frame2, finalState, tpf)
	if firstEvent := frame2[0].tstateOffset; firstEvent <= tpf/audio.SamplesPerFrame {
		t.Fatalf("test setup: frame 2 first event at %d T lands inside sample 0's window", firstEvent)
	}
	want := beeperLow
	if finalState {
		want = beeperHigh
	}
	if samples2[0] != want {
		t.Errorf("frame 2 sample 0 = %d, want %d (seeded phase)", samples2[0], want)
	}
}

// newAudioTestULA returns a bare ULA struct suitable for the audio
// generator tests. It has no real memory or audio system attached;
// the tests only use the per-frame event slice.
func newAudioTestULA(t *testing.T) *ULA {
	t.Helper()
	return &ULA{}
}
