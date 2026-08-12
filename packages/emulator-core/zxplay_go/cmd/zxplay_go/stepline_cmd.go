package main

import (
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
)

// Source-line stepping for ADDRESS-MAP languages (sjasmplus, Pasta80,
// z88dk C, sdcc, zmac, pasmo). The IDE's line->address map gives every
// mapped source line an anchor: the address of its first instruction.
// `step-line-anchors` uploads that set (the IDE re-sends it whenever a
// compile refreshes the map), and `step-line` arms a one-shot halt at
// the next anchor the PC reaches — i.e. "run to the next source line",
// whatever file it is in.
//
// Semantics mirror `basic-step`, the interpreted-BASIC line step: the
// halt fires on ANY next mapped line, including the first line of a
// mapped callee (like basic-step entering a GOSUB). Calls into unmapped
// code (ROM, library runtime) run through transparently. There is
// deliberately NO stack-depth guard on the default form — an SP guard
// would skip perfectly good next lines inside push/pop regions, which
// assembly sources hit constantly. `step-line over` adds the guard
// (fire only at SP >= the arming SP) for C/Pascal-style "don't enter
// the callee" stepping, where lines are SP-balanced.
//
// Arming while paused first executes ONE instruction (plain
// StepInstruction — see `continue` for why not WithIRQ) so the run
// can never re-halt without progress: not on the anchor being sat on,
// and not on a shared PC breakpoint at the paused address. A tight
// one-line loop (`jr $`) therefore re-pauses on the same line after
// one iteration instead of hanging.
//
// State is package-level for the same reason as basic-bp/linecall: on
// wasm every machine switch/reset orphans the remoteDebugger, and a
// re-attached session re-arms idempotently against the surviving state.

// stepLineSpec is the anchor set, swapped atomically so the M1 hot
// path reads it lock-free (read-copy-update under d.mu).
type stepLineSpec struct {
	addrs map[uint16]struct{}
}

var (
	stepLineAnchors atomic.Pointer[stepLineSpec] // mapped-line addresses
	stepLineArmed   atomic.Bool                  // one-shot next-line halt
	stepLineOver    atomic.Bool                  // guard: fire only at SP >= SP0
	stepLineSP0     atomic.Uint32                // SP captured when arming
)

// checkStepLine is called from BreakpointCheck on every M1 fetch.
// Cost while disarmed: one atomic load. Returns true to halt
// ExecuteFrame.
func (d *remoteDebugger) checkStepLine(pc uint16) bool {
	if !stepLineArmed.Load() {
		return false
	}
	spec := stepLineAnchors.Load()
	if spec == nil {
		return false
	}
	if _, ok := spec.addrs[pc]; !ok {
		return false
	}
	if stepLineOver.Load() && d.emu.cpu.SP < uint16(stepLineSP0.Load()) {
		// A deeper frame (mapped callee, or an interrupt handler that
		// wandered into mapped code): keep running until the stack
		// unwinds to the arming depth or shallower.
		return false
	}
	stepLineArmed.Store(false)
	slog.Info("step-line hit", "pc", fmt.Sprintf("$%04X", pc))
	d.paused.Store(true)
	d.snapshotOnBPHit(pc, "step-line")
	return true
}

// cmdStepLineAnchors implements `step-line-anchors [clear|ADDR...]`:
// no args reports the count, `clear` empties the set, addresses add to
// it — the IDE uploads a fresh map as `clear` plus chunked adds, so no
// single command line has to carry thousands of addresses.
func (d *remoteDebugger) cmdStepLineAnchors(args []string) string {
	if len(args) == 0 {
		if spec := stepLineAnchors.Load(); spec != nil {
			return fmt.Sprintf("OK %d anchors", len(spec.addrs))
		}
		return "OK 0 anchors"
	}
	if strings.EqualFold(args[0], "clear") {
		stepLineAnchors.Store(nil)
		stepLineArmed.Store(false)
		return "OK anchors cleared"
	}
	next := map[uint16]struct{}{}
	if spec := stepLineAnchors.Load(); spec != nil {
		for a := range spec.addrs {
			next[a] = struct{}{}
		}
	}
	for _, arg := range args {
		addr, err := parseHex(arg)
		if err != nil {
			return "ERR usage: step-line-anchors [clear|ADDR...]  (hex/dec mapped-line addresses)"
		}
		next[addr] = struct{}{}
	}
	stepLineAnchors.Store(&stepLineSpec{addrs: next})
	return fmt.Sprintf("OK %d anchors", len(next))
}

// cmdStepLine implements `step-line [over|off]`: a one-shot halt at the
// next uploaded line anchor, resuming the CPU the way `continue` does.
// `over` guards on the arming SP so mapped callees are run through;
// `off` disarms. Inert until anchors are uploaded.
func (d *remoteDebugger) cmdStepLine(args []string) string {
	over := false
	if len(args) >= 1 {
		switch {
		case strings.EqualFold(args[0], "off"):
			stepLineArmed.Store(false)
			return "OK step-line disarmed"
		case strings.EqualFold(args[0], "over"):
			over = true
		default:
			return "ERR usage: step-line [over|off]"
		}
	}
	spec := stepLineAnchors.Load()
	if spec == nil || len(spec.addrs) == 0 {
		return "ERR no line anchors (upload with step-line-anchors)"
	}
	stepLineOver.Store(over)
	if d.paused.Load() {
		// SP before the progress step: the paused instruction may push
		// (or be the call itself), and callee depth is measured from
		// the line the user is stepping FROM.
		stepLineSP0.Store(uint32(d.emu.cpu.SP))
		d.emu.cpu.StepInstruction()
		stepLineArmed.Store(true)
		d.paused.Store(false)
		d.stepping.Store(false)
		select {
		case d.resumeCh <- struct{}{}:
		default:
		}
	} else {
		stepLineSP0.Store(uint32(d.emu.cpu.SP))
		stepLineArmed.Store(true)
	}
	return "OK step-line armed"
}
