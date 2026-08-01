package main

import (
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"sync/atomic"

	"github.com/stever/zxplay_go/pkg/memory"
)

// NextBASIC line breakpoints. The NextZXOS interpreter (like the
// classic 48K ROM it descends from) records the line number of the
// statement being interpreted in the PPC system variable at $5C45,
// which lives in RAM bank 5 (paged at $4000). Every interpreter
// store to PPC writes the low byte then the high byte (LD (nn),HL
// order), so a completed line value is visible exactly at the
// high-byte write. Watching those writes gives line-granular
// breakpoints for interpreted BASIC with no dependency on ROM code
// addresses — the sysvar location is the stable contract.
//
// Firing is edge-triggered on the assembled 16-bit value changing:
// entering a line can store the same number more than once (the
// GO TO/GO SUB jump routine and the line-start advance both write
// it), and `continue` from a hit must not re-fire while the line
// is still executing.
const (
	ppcBank  = 5      // classic RAM bank 5, always paged at $4000
	ppcLoOff = 0x1C45 // PPC low byte: $5C45 - $4000
	ppcHiOff = 0x1C46 // PPC high byte

	// maxBasicLine is the highest line number the NextZXOS editor
	// accepts. Values above it seen in PPC are interpreter states,
	// not program lines (e.g. $FFFE while running a direct command),
	// and never satisfy a basic-step.
	maxBasicLine = 9999
)

// basicBPSpec is the armed line set, swapped atomically so the
// write hook reads it lock-free. Commands build a fresh map per
// mutation (read-copy-update under handleCommand's d.mu).
type basicBPSpec struct {
	lines map[uint16]struct{}
}

// The armed state is package-level (like watch-mem's memWatchPtr)
// rather than per-debugger: on wasm every machine switch/reset
// detaches and orphans the remoteDebugger while the RAM-write hook
// it chained stays installed on the surviving Memory. Global state
// plus a per-Memory install guard means re-attaching debuggers
// share the one hook instead of stacking armed duplicates, and the
// hook always pauses the CURRENT debugger via basicBPOwner.
var (
	basicBPPtr     atomic.Pointer[basicBPSpec]
	basicStepFlag  atomic.Bool
	basicBPLast    atomic.Uint32
	basicBPOwner   atomic.Pointer[remoteDebugger]
	basicBPHookMem atomic.Pointer[memory.Memory]
)

// cmdSetBasicBP implements `set-basic-bp LINE` (decimal).
func (d *remoteDebugger) cmdSetBasicBP(args []string) string {
	if len(args) < 1 {
		return "ERR usage: set-basic-bp LINE  (halt when the BASIC interpreter reaches this line)"
	}
	line, err := strconv.Atoi(args[0])
	if err != nil || line < 1 || line > maxBasicLine {
		return fmt.Sprintf("ERR bad line: want 1-%d decimal", maxBasicLine)
	}
	next := map[uint16]struct{}{uint16(line): {}}
	if spec := basicBPPtr.Load(); spec != nil {
		for l := range spec.lines {
			next[l] = struct{}{}
		}
	}
	basicBPPtr.Store(&basicBPSpec{lines: next})
	d.ensureBasicBPHook()
	return fmt.Sprintf("OK basic-bp at line %d", line)
}

// cmdClearBasicBP implements `clear-basic-bp [LINE]` — one line,
// or every armed line when no argument is given.
func (d *remoteDebugger) cmdClearBasicBP(args []string) string {
	if len(args) == 0 {
		basicBPPtr.Store(nil)
		return "OK basic-bps cleared"
	}
	line, err := strconv.Atoi(args[0])
	if err != nil || line < 1 || line > maxBasicLine {
		return fmt.Sprintf("ERR bad line: want 1-%d decimal", maxBasicLine)
	}
	spec := basicBPPtr.Load()
	if spec == nil {
		return "OK basic-bps cleared"
	}
	next := map[uint16]struct{}{}
	for l := range spec.lines {
		if l != uint16(line) {
			next[l] = struct{}{}
		}
	}
	if len(next) == 0 {
		basicBPPtr.Store(nil)
	} else {
		basicBPPtr.Store(&basicBPSpec{lines: next})
	}
	return fmt.Sprintf("OK basic-bp cleared at line %d", line)
}

// cmdListBasicBPs implements `list-basic-bps`.
func (d *remoteDebugger) cmdListBasicBPs() string {
	spec := basicBPPtr.Load()
	if spec == nil || len(spec.lines) == 0 {
		return "OK no basic-bps"
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
	if last := basicBPLast.Load(); last >= 1 && last <= maxBasicLine {
		out += fmt.Sprintf(" (last line %d)", last)
	}
	return out
}

// cmdBasicStep implements `basic-step`: a one-shot halt at the next
// BASIC line transition, whatever the line. Resumes the CPU the way
// `continue` does; the hook fires when the interpreter stores a new
// program line into PPC. Stays armed across direct-command PPC
// values ($FFFE), so a step issued on a program's final line simply
// never fires — disarm with `basic-step off`.
func (d *remoteDebugger) cmdBasicStep(args []string) string {
	if len(args) >= 1 && args[0] == "off" {
		basicStepFlag.Store(false)
		return "OK basic-step disarmed"
	}
	basicStepFlag.Store(true)
	d.ensureBasicBPHook()
	if d.paused.Load() {
		d.paused.Store(false)
		d.stepping.Store(false)
		select {
		case d.resumeCh <- struct{}{}:
		default:
		}
	}
	return "OK basic-step armed"
}

// ensureBasicBPHook makes this debugger the one a fire pauses and
// chains the PPC write watcher onto the current machine's RAM-write
// hook — once per Memory, however many debugger attach/detach
// cycles that Memory outlives. An idle installed hook costs two
// compares per RAM write.
func (d *remoteDebugger) ensureBasicBPHook() {
	basicBPOwner.Store(d)
	mem := d.emu.mem
	if basicBPHookMem.Load() == mem {
		return
	}
	basicBPHookMem.Store(mem)
	// Seed the edge tracker with the line the interpreter is already
	// on, so arming while paused inside line N doesn't fire on N's
	// own statement-advance re-store after resume — only on a real
	// re-entry.
	if page := mem.GetPage(ppcBank); len(page) > ppcHiOff {
		basicBPLast.Store(uint32(page[ppcHiOff])<<8 | uint32(page[ppcLoOff]))
	}
	prior := mem.GetRAMWriteHook()
	mem.SetRAMWriteHook(func(bank int, addr uint16, val byte) {
		if prior != nil {
			prior(bank, addr, val)
		}
		if bank != ppcBank || addr != ppcHiOff {
			return
		}
		page := mem.GetPage(ppcBank)
		if len(page) <= ppcLoOff {
			return
		}
		line := uint32(val)<<8 | uint32(page[ppcLoOff])
		if line == basicBPLast.Load() {
			return
		}
		basicBPLast.Store(line)
		reason := ""
		if basicStepFlag.Load() && line <= maxBasicLine {
			basicStepFlag.Store(false)
			reason = "basic-step"
		} else if spec := basicBPPtr.Load(); spec != nil {
			if _, ok := spec.lines[uint16(line)]; ok {
				reason = "basic-bp"
			}
		}
		if reason == "" {
			return
		}
		owner := basicBPOwner.Load()
		if owner == nil {
			return
		}
		slog.Info(reason+" hit",
			"line", line,
			"pc", fmt.Sprintf("$%04X", owner.emu.cpu.PC))
		owner.paused.Store(true)
		owner.snapshotOnBPHit(owner.emu.cpu.PC, reason)
	})
}
