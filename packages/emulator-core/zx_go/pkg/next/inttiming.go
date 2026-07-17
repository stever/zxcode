package next

import "github.com/conorarmstrong/zx_go/pkg/roms"

// Frame-interrupt timing model, transcribed from the FPGA core so the
// whole class of INT-timing behaviour conforms in one place (timing.md
// §1a/§1c). See inttiming_test.go for the conformance matrix.
//
// The maskable frame INT (`int_ula`) asserts for a narrow pulse when the
// 7 MHz video counters reach (hc=c_int_h, vc=c_int_v)
// (video/zxula_timing.vhd:551). The pulse is held for a fixed number of
// CPU cycles — 32 for 48K/+3, 36 for 128K/Pentagon (zxnext.vhd:2014-2033).
//
// FrameIntTiming maps the NR$03 machine-timing field (bits 2:0; 00X=48K,
// 010=128K, 011=+3, 100=Pentagon — zxnext.vhd:149) and the 50/60 Hz flag
// (NR$05) to:
//   - assertTstate: the frame-relative tstate (3.5 MHz) of the INT pulse,
//     = (c_int_v·(c_max_hc+1) + c_int_h) / 2 (the video grid runs at 7 MHz,
//     so two 7 MHz ticks per 3.5 MHz T-state).
//   - pulseTstates: the pulse width in CPU cycles.
//
// The per-mode (c_int_h, c_int_v, c_max_hc) constants are zxula_timing.vhd
// lines 155-298.
// FrameIntTimingForModel maps a classic SpectrumModel to its frame-INT
// pulse parameters via the NR$03 machine-timing encoding, so the
// desktop emulator and the test harness configure CPUs identically.
// ok is false for machines that drive their own interrupt (ZX80/81,
// SAM) — leave those on their existing model.
func FrameIntTimingForModel(model roms.SpectrumModel, sixtyHz bool) (assertTstate, pulseTstates int, ok bool) {
	var nr03 byte
	switch model {
	case roms.Model48K:
		nr03 = 0x01
	case roms.Model128K, roms.ModelPlus2:
		nr03 = 0x02
	case roms.ModelPlus3, roms.ModelPlus2A, roms.ModelNext:
		nr03 = 0x03
	case roms.ModelPentagon:
		nr03 = 0x04
	default:
		return 0, 0, false
	}
	assertTstate, pulseTstates = FrameIntTiming(nr03, sixtyHz)
	return assertTstate, pulseTstates, true
}

// FrameIntTiming is the (assert, pulse) projection of the full frame
// geometry table — see FrameGeometryFor (geometry.go) for the complete
// per-mode constants and their VHDL citations.
func FrameIntTiming(nr03MachineTiming byte, sixtyHz bool) (assertTstate, pulseTstates int) {
	g := FrameGeometryFor(nr03MachineTiming, sixtyHz)
	return g.IntAssertTstate(), g.PulseTstates
}
