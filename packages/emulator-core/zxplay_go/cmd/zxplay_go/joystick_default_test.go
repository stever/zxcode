package main

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
)

// TestEffectiveJoystickFor locks in the rule that an unconfigured joystick
// falls back to Kempston on EVERY model.
//
// It used to fall back only on the Next, where the FPGA always decodes port
// $1F, and classic machines were left at None so that a live $1F could not
// disturb a 48K title sampling the floating bus. That reasoning was wrong on
// both halves: the floating-bus port is $FF (A7..A5 high), which cannot match
// the Kempston decode (A7..A5 low), and leaving classics at None meant the
// commonest interface on the commonest games was unreachable — the pad simply
// did nothing, with no indication why.
//
// A brief attempt to close that gap by DETECTING Kempston use (arm the
// interface once a game had been seen polling $1F) was worse still: games
// probe for the interface with a tight read loop — Manic Miner does exactly
// 256 reads at startup — and arming it partway through answers "absent,
// absent, absent, present". Such a routine reads that as absent and stops
// polling for good. The interface has to be there from the guest's first
// read, so it is fitted at construction (newEmulator) and this fallback
// simply points the pad at it.
func TestEffectiveJoystickFor(t *testing.T) {
	cases := []struct {
		name       string
		configured JoystickType
		model      roms.SpectrumModel
		want       JoystickType
	}{
		{"Next + unconfigured -> Kempston", JoystickNone, roms.ModelNext, JoystickKempston},
		{"Next + explicit Kempston stays", JoystickKempston, roms.ModelNext, JoystickKempston},
		{"Next + explicit Sinclair stays", JoystickSinclair1, roms.ModelNext, JoystickSinclair1},
		{"48K + unconfigured -> Kempston", JoystickNone, roms.Model48K, JoystickKempston},
		{"48K + Kempston stays", JoystickKempston, roms.Model48K, JoystickKempston},
		{"48K + explicit Cursor stays", JoystickCursor, roms.Model48K, JoystickCursor},
		{"128K + unconfigured -> Kempston", JoystickNone, roms.Model128K, JoystickKempston},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := effectiveJoystickFor(c.configured, c.model); got != c.want {
				t.Fatalf("effectiveJoystickFor(%v, %v) = %v, want %v", c.configured, c.model, got, c.want)
			}
		})
	}
}
