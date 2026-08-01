package main

import (
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
)

// Line-call breakpoints: source-line breakpoints for COMPILED BASIC.
// Boriel ZX BASIC's `--enable-break` codegen calls one fixed runtime
// routine (`.core.CHECK_BREAK`, address known from the compiler's -M
// label map) once per executed source line, with the line number in HL
// — zxbc line numbers are file lines, so the value maps straight onto
// the editor. Anchoring on that PC and comparing HL against an armed
// set gives line breakpoints without any knowledge of the generated
// code layout; `linecall-step` (halt at the next anchor call, whatever
// the line) gives line stepping.
//
// The anchor address changes with every build, so the IDE re-sends
// `linecall-anchor` each time it loads a program's source map, and
// disarms it when the map goes stale — a stale anchor would sit on
// arbitrary code of the next binary.
//
// The check halts at the routine's first M1 — the interpreter-BASIC
// counterpart is edge-triggered on PPC writes (basicbp_cmd.go); here
// each anchor entry is a discrete per-line event, so instead of edge
// tracking a one-shot suppress flag skips the re-match when `continue`
// resumes on the not-yet-executed anchor instruction.
//
// State is package-level for the same reason as basic-bp: on wasm every
// machine switch/reset orphans the remoteDebugger, and a re-attached
// session re-arms idempotently against the surviving state.

// lineCallSpec is the armed line set, swapped atomically so the M1
// hot path reads it lock-free (read-copy-update under d.mu).
type lineCallSpec struct {
	lines map[uint16]struct{}
}

var (
	lineCallAnchor   atomic.Uint32                // 0 = disarmed
	lineCallBPs      atomic.Pointer[lineCallSpec] // armed lines
	lineCallStep     atomic.Bool                  // one-shot next-line halt
	lineCallSuppress atomic.Bool                  // skip the re-match after continue
)

// checkLineCallBP is called from BreakpointCheck on every M1 fetch.
// Cost while disarmed: one atomic load and a compare. Returns true to
// halt ExecuteFrame.
func (d *remoteDebugger) checkLineCallBP(pc uint16) bool {
	a := lineCallAnchor.Load()
	if a == 0 || pc != uint16(a) {
		return false
	}
	if lineCallSuppress.Load() {
		// The continue after a hit resumes on the anchor instruction
		// itself; this M1 is the same not-yet-executed call, not a new
		// line event.
		lineCallSuppress.Store(false)
		return false
	}
	line := uint16(d.emu.cpu.H)<<8 | uint16(d.emu.cpu.L)
	reason := ""
	if lineCallStep.Load() {
		lineCallStep.Store(false)
		reason = "linecall-step"
	} else if spec := lineCallBPs.Load(); spec != nil {
		if _, ok := spec.lines[line]; ok {
			reason = "linecall-bp"
		}
	}
	if reason == "" {
		return false
	}
	lineCallSuppress.Store(true)
	slog.Info(reason+" hit",
		"line", line,
		"pc", fmt.Sprintf("$%04X", pc))
	d.paused.Store(true)
	d.snapshotOnBPHit(pc, reason)
	return true
}

// cmdLineCallAnchor implements `linecall-anchor [ADDR|off]`. Setting an
// anchor (or turning it off) also clears the one-shot flags, so state
// from a previous program cannot eat the fresh arm's first hit.
func (d *remoteDebugger) cmdLineCallAnchor(args []string) string {
	if len(args) == 0 {
		if a := lineCallAnchor.Load(); a != 0 {
			return fmt.Sprintf("OK linecall-anchor $%04X", a)
		}
		return "OK linecall-anchor off"
	}
	if strings.EqualFold(args[0], "off") {
		lineCallAnchor.Store(0)
		lineCallStep.Store(false)
		lineCallSuppress.Store(false)
		return "OK linecall-anchor off"
	}
	addr, err := parseHex(args[0])
	if err != nil || addr == 0 {
		return "ERR usage: linecall-anchor ADDR|off  (ADDR = the per-line runtime call, e.g. zxbc's CHECK_BREAK)"
	}
	lineCallAnchor.Store(uint32(addr))
	lineCallStep.Store(false)
	lineCallSuppress.Store(false)
	return fmt.Sprintf("OK linecall-anchor $%04X", addr)
}

// cmdSetLineCallBP implements `set-linecall-bp LINE` (decimal file line).
func (d *remoteDebugger) cmdSetLineCallBP(args []string) string {
	if len(args) < 1 {
		return "ERR usage: set-linecall-bp LINE  (halt when the anchored per-line call reports this line)"
	}
	line, err := strconv.Atoi(args[0])
	if err != nil || line < 1 || line > 0xFFFF {
		return "ERR bad line: want 1-65535 decimal"
	}
	next := map[uint16]struct{}{uint16(line): {}}
	if spec := lineCallBPs.Load(); spec != nil {
		for l := range spec.lines {
			next[l] = struct{}{}
		}
	}
	lineCallBPs.Store(&lineCallSpec{lines: next})
	return fmt.Sprintf("OK linecall-bp at line %d", line)
}

// cmdClearLineCallBP implements `clear-linecall-bp [LINE]` — one line,
// or every armed line when no argument is given.
func (d *remoteDebugger) cmdClearLineCallBP(args []string) string {
	if len(args) == 0 {
		lineCallBPs.Store(nil)
		return "OK linecall-bps cleared"
	}
	line, err := strconv.Atoi(args[0])
	if err != nil || line < 1 || line > 0xFFFF {
		return "ERR bad line: want 1-65535 decimal"
	}
	spec := lineCallBPs.Load()
	if spec == nil {
		return "OK linecall-bps cleared"
	}
	next := map[uint16]struct{}{}
	for l := range spec.lines {
		if l != uint16(line) {
			next[l] = struct{}{}
		}
	}
	if len(next) == 0 {
		lineCallBPs.Store(nil)
	} else {
		lineCallBPs.Store(&lineCallSpec{lines: next})
	}
	return fmt.Sprintf("OK linecall-bp cleared at line %d", line)
}

// cmdListLineCallBPs implements `list-linecall-bps`.
func (d *remoteDebugger) cmdListLineCallBPs() string {
	spec := lineCallBPs.Load()
	if spec == nil || len(spec.lines) == 0 {
		return "OK no linecall-bps"
	}
	lines := make([]int, 0, len(spec.lines))
	for l := range spec.lines {
		lines = append(lines, int(l))
	}
	sort.Ints(lines)
	out := "OK"
	for _, l := range lines {
		out += fmt.Sprintf(" %d", l)
	}
	if a := lineCallAnchor.Load(); a != 0 {
		out += fmt.Sprintf(" (anchor $%04X)", a)
	} else {
		out += " (no anchor - inert)"
	}
	return out
}

// cmdLineCallStep implements `linecall-step [off]`: a one-shot halt at
// the next anchor call, whatever the line, resuming the CPU the way
// `continue` does. Inert until an anchor is set.
func (d *remoteDebugger) cmdLineCallStep(args []string) string {
	if len(args) >= 1 && strings.EqualFold(args[0], "off") {
		lineCallStep.Store(false)
		return "OK linecall-step disarmed"
	}
	if lineCallAnchor.Load() == 0 {
		return "ERR no linecall-anchor set"
	}
	lineCallStep.Store(true)
	if d.paused.Load() {
		d.paused.Store(false)
		d.stepping.Store(false)
		select {
		case d.resumeCh <- struct{}{}:
		default:
		}
	}
	return "OK linecall-step armed"
}
