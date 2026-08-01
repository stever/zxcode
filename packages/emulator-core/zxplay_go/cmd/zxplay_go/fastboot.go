package main

import "github.com/stever/zxplay_go/pkg/roms"

// Boot fast-forward: from a Spectrum Next power-on/reset until NextZXOS
// reaches its first interactive prompt (the welcome/menu key-wait loop at
// nextMenuLoopPC), the host may run the machine at many frames per tick so
// the ~2500-frame cold boot passes in a couple of wall-clock seconds instead
// of ~50. Unlike the ZX_GO_NEXT_DIRECT_BOOT / warm-boot debug shortcuts this
// is not a skip: every instruction of the FPGA bootrom, TBBLUE.FW and
// NextZXOS still executes unmodified — it is pure time compression, so it
// stays inside the project's "no hacks" rule and The Next License.
//
// When a nexload/BASIC keystroke macro triggered the reboot, fast-forward
// extends past the boot through the macro's typing phase (its step timings
// are frame-counted, so they behave identically at any host speed) and ends
// at the macro's tail step — the point where the loaded program is running.
//
// The browser build drives this: zxFrame's caller polls zxFastBoot() and
// runs extra frames per displayed frame while it reports true (discarding
// the fast-forwarded audio). The desktop run loop does not use it yet.

// nextBootFFFrameCap bounds fast-forward for a boot that never reaches the
// menu loop (e.g. no SD card mounted drops to 48K BASIC, whose key wait is
// elsewhere). Mirrors the nexload macro's waitMenu safety timeout.
const nextBootFFFrameCap = 4000

// noteBootFrame records one executed frame's boot progress. Call once per
// executed frame, after the frame ran (so cpu.PC is the frame-end PC — the
// same sampling the macro's waitMenu step relies on: the menu wait parks the
// CPU at nextMenuLoopPC, so a frame-boundary sample lands on it reliably).
func (e *emulator) noteBootFrame() {
	if e.model != roms.ModelNext {
		return
	}
	if e.bootFrames < nextBootFFFrameCap {
		e.bootFrames++
	}
	if e.cpu.PC == nextMenuLoopPC {
		e.bootMenuSeen = true
	}
}

// bootFastForwardActive reports whether the machine is still in its
// boot/loading phase and the host should run it at maximum speed.
func (e *emulator) bootFastForwardActive() bool {
	if e.model != roms.ModelNext {
		return false
	}
	if m := e.nexloadMacro; m != nil {
		// Boot + typing under fast-forward; the tail step (program
		// running) at normal speed.
		return !m.inTail()
	}
	return !e.bootMenuSeen && e.bootFrames < nextBootFFFrameCap
}

// resetBootProgress re-arms boot fast-forward; called from reboot() and at
// construction time (the zero values are already armed, so only reboot
// strictly needs it).
func (e *emulator) resetBootProgress() {
	e.bootFrames = 0
	e.bootMenuSeen = false
}
