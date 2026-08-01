//go:build !js

package audio

import (
	"os"
	"testing"
	"time"
)

// TestAudioDriftProbe is a MANUAL diagnostic, skipped unless
// ZX_GO_AUDIO_PROBE=1: it reproduces the GUI's exact audio topology in
// real time against the REAL output device — a producer goroutine
// pushing SamplesPerFrame of a 440 Hz square wave every 20 ms (the
// emulation tick's cadence, paced by the OS clock) while oto drains the
// ring at the device clock's rate — and reports ring depth and the
// underrun/drop counters once a second.
//
//	ZX_GO_AUDIO_PROBE=1 go test -run TestAudioDriftProbe -v ./pkg/audio/
//
// How to read it: depth sliding steadily DOWN with underruns climbing
// means the device clock runs faster than the OS clock (each underrun
// is an audible cushion rebuild); depth sliding UP with drops climbing
// means the producer is faster (each drop burst is an audible skip).
// Depth wobbling around the cushion with both counters flat means the
// clocks agree on this host and the stutter lies elsewhere.
func TestAudioDriftProbe(t *testing.T) {
	if os.Getenv("ZX_GO_AUDIO_PROBE") == "" {
		t.Skip("manual probe; set ZX_GO_AUDIO_PROBE=1 to run against the real audio device")
	}
	as, err := New()
	if err != nil {
		t.Fatalf("audio init: %v", err)
	}
	if err := as.Start(); err != nil {
		t.Fatalf("audio start: %v", err)
	}
	defer as.Stop()

	const seconds = 20
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	deadline := time.After(seconds * time.Second)
	report := time.NewTicker(time.Second)
	defer report.Stop()

	buf := make([]int16, SamplesPerFrame)
	phase := 0
	minD, maxD := int(^uint(0)>>1), -1
	sample := func() {
		as.queueMu.Lock()
		d := as.queueSize
		as.queueMu.Unlock()
		if d < minD {
			minD = d
		}
		if d > maxD {
			maxD = d
		}
	}
	for {
		select {
		case <-tick.C:
			// 440 Hz square at ~1/4 amplitude (audible but polite).
			for i := range buf {
				if (phase/50)%2 == 0 {
					buf[i] = 8000
				} else {
					buf[i] = -8000
				}
				phase++
			}
			as.PushBeeperSamples(buf)
			sample()
		case <-report.C:
			as.queueMu.Lock()
			ur, dr, cur := as.statUnderruns, as.statDropped, as.queueSize
			as.queueMu.Unlock()
			t.Logf("depth cur=%5d min=%5d max=%5d (cushion=%d cap=%d)  underruns=%d dropped=%d",
				cur, minD, maxD, underrunCushion, queueCapacity, ur, dr)
			minD, maxD = int(^uint(0)>>1), -1
		case <-deadline:
			return
		}
	}
}
