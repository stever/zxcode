package testharness

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/audio"
	"github.com/stever/zxplay_go/pkg/roms"
)

// beeperLoopCode is a deterministic beeper loop, byte-identical on every
// model: DI, then forever { XOR $10; OUT ($FE),A; LD B,240; DJNZ $; JR }.
// Half period 45+13*239 = 3152 T ≈ 555 Hz at 3.5 MHz. Interrupts stay
// disabled, so the per-frame execution residue is periodic — exactly the
// pattern that false-fired the old audio-flush idempotence guard (whole
// frames of audio dropped: 17% on the 48K, 2% on the 128K, 0 on the Next
// for this very loop).
var beeperLoopCode = []byte{
	0xF3,       // DI
	0xAF,       // XOR A
	0xEE, 0x10, // loop: XOR $10
	0xD3, 0xFE, // OUT ($FE),A
	0x06, 0xF0, // LD B,240
	0x10, 0xFE, // d: DJNZ d
	0x18, 0xF6, // JR loop
}

// TestBeeperAudioEveryFrameFlushed pins "N frames executed ⇒ N frames of
// audio generated" on 48K, 128K and Next: a sustained beep must come out
// gap-free on every model (the "why does the same beep sound worse on the
// 48K?" regression). Drains the ring per frame exactly the way the
// browser's zxPullAudio path does.
func TestBeeperAudioEveryFrameFlushed(t *testing.T) {
	for _, m := range []struct {
		name  string
		model roms.SpectrumModel
	}{
		{"48k", roms.Model48K},
		{"128k", roms.Model128K},
		{"next", roms.ModelNext},
	} {
		t.Run(m.name, func(t *testing.T) {
			h, err := New(m.model)
			if err != nil {
				t.Fatalf("harness: %v", err)
			}
			defer h.CloseFiles()
			u := h.ULA()
			u.EnableAudio()
			as := u.Audio()
			if as == nil {
				t.Skip("no audio device available (audio.New failed)")
			}
			as.Stop() // per-frame PullMono below is the ring's only consumer

			for i, b := range beeperLoopCode {
				h.WriteMemory(0x8000+uint16(i), b)
			}
			h.CPU().PC = 0x8000

			const frames = 200
			pull := make([]int16, audio.SamplesPerFrame*4)
			total := 0
			for i := 0; i < frames; i++ {
				h.RunFrames(1)
				u.FlushAudioFrame() // idempotent after RunFrames' Render, as in the app loops
				total += as.PullMono(pull)
			}
			if want := frames * audio.SamplesPerFrame; total != want {
				t.Fatalf("%s: %d samples for %d frames, want %d — %d whole frames of audio dropped",
					m.name, total, frames, want, (want-total)/audio.SamplesPerFrame)
			}
		})
	}
}
