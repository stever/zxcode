package main

import (
	"strings"
	"testing"

	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/roms"
	"github.com/stever/zxplay_go/pkg/z80"
)

// writePPC mimics the interpreter's LD (PPC),HL store order: low
// byte then high byte, through the real Memory.Write path so the
// chained RAM-write hook fires exactly as it does live.
func writePPC(d *remoteDebugger, line uint16) {
	d.emu.mem.Write(0x5C45, byte(line))
	d.emu.mem.Write(0x5C46, byte(line>>8))
}

// resetBasicBPGlobals gives each test a clean slate: the armed
// state is package-level (see basicbp_cmd.go) and would otherwise
// leak between tests. Clearing basicBPHookMem makes the next ensure
// install a fresh hook on that test's own Memory.
func resetBasicBPGlobals(t *testing.T) {
	t.Helper()
	basicBPPtr.Store(nil)
	basicStepFlag.Store(false)
	basicBPLast.Store(0)
	basicBPOwner.Store(nil)
	basicBPHookMem.Store(nil)
}

func TestBasicBP_CommandParsing(t *testing.T) {
	resetBasicBPGlobals(t)
	d := newRemoteWithCPU(t)
	if got := d.cmdSetBasicBP(nil); !strings.HasPrefix(got, "ERR usage") {
		t.Errorf("no args = %q", got)
	}
	for _, bad := range []string{"0", "10000", "abc", "-5"} {
		if got := d.cmdSetBasicBP([]string{bad}); !strings.HasPrefix(got, "ERR bad line") {
			t.Errorf("set %q = %q, want ERR bad line", bad, got)
		}
	}
	if got := d.cmdSetBasicBP([]string{"30"}); got != "OK basic-bp at line 30" {
		t.Errorf("set 30 = %q", got)
	}
	if got := d.cmdSetBasicBP([]string{"10"}); got != "OK basic-bp at line 10" {
		t.Errorf("set 10 = %q", got)
	}
	if got := d.cmdListBasicBPs(); got != "OK 10 30" {
		t.Errorf("list = %q, want \"OK 10 30\"", got)
	}
	if got := d.cmdClearBasicBP([]string{"10"}); got != "OK basic-bp cleared at line 10" {
		t.Errorf("clear 10 = %q", got)
	}
	if got := d.cmdListBasicBPs(); got != "OK 30" {
		t.Errorf("list after clear = %q", got)
	}
	if got := d.cmdClearBasicBP(nil); got != "OK basic-bps cleared" {
		t.Errorf("clear all = %q", got)
	}
	if got := d.cmdListBasicBPs(); got != "OK no basic-bps" {
		t.Errorf("list empty = %q", got)
	}
}

func TestBasicBP_Dispatch(t *testing.T) {
	resetBasicBPGlobals(t)
	d := newRemoteWithCPU(t)
	d.paused.Store(true)
	cases := []struct {
		line       string
		wantPrefix string
	}{
		{"set-basic-bp 100", "OK basic-bp at line 100"},
		{"list-basic-bps", "OK 100"},
		{"clear-basic-bp 100", "OK basic-bp cleared"},
		{"basic-step off", "OK basic-step disarmed"},
	}
	for _, c := range cases {
		if got := d.handleCommand(c.line); !strings.HasPrefix(got, c.wantPrefix) {
			t.Errorf("handleCommand(%q) = %q, want prefix %q", c.line, got, c.wantPrefix)
		}
	}
}

func TestBasicBP_FiresOnTargetLineOnly(t *testing.T) {
	resetBasicBPGlobals(t)
	d := newRemoteWithCPU(t)
	d.cmdSetBasicBP([]string{"30"})

	writePPC(d, 10)
	writePPC(d, 20)
	if d.paused.Load() {
		t.Fatal("paused before target line reached")
	}
	writePPC(d, 30)
	if !d.paused.Load() {
		t.Fatal("did not pause on target line 30")
	}
}

func TestBasicBP_EdgeTriggered(t *testing.T) {
	resetBasicBPGlobals(t)
	d := newRemoteWithCPU(t)
	d.cmdSetBasicBP([]string{"30"})

	writePPC(d, 30)
	if !d.paused.Load() {
		t.Fatal("did not pause on first entry to line 30")
	}
	// Continue: the line-start advance re-stores the same value
	// while line 30 executes. Must not re-fire.
	d.paused.Store(false)
	writePPC(d, 30)
	if d.paused.Load() {
		t.Fatal("re-fired without leaving line 30")
	}
	// Leaving and re-entering the line fires again (loop case).
	writePPC(d, 40)
	if d.paused.Load() {
		t.Fatal("fired on non-target line 40")
	}
	writePPC(d, 30)
	if !d.paused.Load() {
		t.Fatal("did not re-fire on re-entry to line 30")
	}
}

// A lo-then-hi byte pair transiently forms (new lo | old hi) in
// memory. The hook only evaluates at the high-byte write, so a
// breakpoint on the transient word must not fire: jumping from
// line 530 ($0212) to line 10 ($000A) passes through $020A = 522
// between the two byte stores.
func TestBasicBP_IgnoresTransientWord(t *testing.T) {
	resetBasicBPGlobals(t)
	d := newRemoteWithCPU(t)
	d.cmdSetBasicBP([]string{"522"})

	writePPC(d, 530)
	writePPC(d, 10)
	if d.paused.Load() {
		t.Fatal("fired on transient word during lo/hi byte pair")
	}
}

func TestBasicStep_OneShotNextLine(t *testing.T) {
	resetBasicBPGlobals(t)
	d := newRemoteWithCPU(t)
	writePPC(d, 10)

	if got := d.cmdBasicStep(nil); got != "OK basic-step armed" {
		t.Fatalf("arm = %q", got)
	}
	// Same line again: no transition, still armed.
	writePPC(d, 10)
	if d.paused.Load() {
		t.Fatal("basic-step fired without a line transition")
	}
	writePPC(d, 20)
	if !d.paused.Load() {
		t.Fatal("basic-step did not fire on next line")
	}
	if basicStepFlag.Load() {
		t.Fatal("basic-step still armed after firing")
	}
	// One-shot: the following transition must not pause again.
	d.paused.Store(false)
	writePPC(d, 30)
	if d.paused.Load() {
		t.Fatal("basic-step fired twice")
	}
}

func TestBasicStep_IgnoresDirectCommandPPC(t *testing.T) {
	resetBasicBPGlobals(t)
	d := newRemoteWithCPU(t)
	writePPC(d, 10)
	d.cmdBasicStep(nil)

	// Direct-command sentinel ($FFFE) is not a program line; the
	// step stays armed until a real line runs.
	writePPC(d, 0xFFFE)
	if d.paused.Load() {
		t.Fatal("basic-step fired on direct-command PPC value")
	}
	if !basicStepFlag.Load() {
		t.Fatal("basic-step disarmed by direct-command PPC value")
	}
	writePPC(d, 20)
	if !d.paused.Load() {
		t.Fatal("basic-step did not fire on the next real line")
	}
}

func TestBasicStep_ResumesPausedCPU(t *testing.T) {
	resetBasicBPGlobals(t)
	d := newRemoteWithCPU(t)
	d.resumeCh = make(chan struct{}, 1)
	d.paused.Store(true)

	if got := d.cmdBasicStep(nil); got != "OK basic-step armed" {
		t.Fatalf("arm = %q", got)
	}
	if d.paused.Load() {
		t.Fatal("basic-step left the CPU paused")
	}
	select {
	case <-d.resumeCh:
	default:
		t.Fatal("basic-step did not signal resumeCh")
	}
}

// Sinclair BASIC on the classic machines uses the same PPC sysvar the
// Next does, and every classic memory setup maps $4000 to page index 5 —
// the hook's bank filter. Pin that for the 48K, where zmakebas/bas2tap
// programs most often run.
func TestBasicBP_FiresOn48KModel(t *testing.T) {
	resetBasicBPGlobals(t)
	mem, err := memory.New(newTestRomDir(t), roms.Model48K)
	if err != nil {
		t.Fatalf("memory.New: %v", err)
	}
	d := &remoteDebugger{emu: &emulator{cpu: z80.New(mem, nil), mem: mem}}
	d.cmdSetBasicBP([]string{"30"})

	writePPC(d, 20)
	if d.paused.Load() {
		t.Fatal("paused before target line reached")
	}
	writePPC(d, 30)
	if !d.paused.Load() {
		t.Fatal("did not pause on target line 30 on the 48K model")
	}
}

// The wasm attach/detach cycle (machine reset, Play reattach) creates a
// fresh remoteDebugger over the SAME Memory. The hook must not stack —
// one fire, pausing the new owner, not the orphaned core it was
// installed under.
func TestBasicBP_ReattachSameMemorySingleFire(t *testing.T) {
	resetBasicBPGlobals(t)
	d1 := newRemoteWithCPU(t)
	d1.cmdSetBasicBP([]string{"30"})

	// Second debugger over the same emulator (what wasmDebugAttach does
	// after a detach): re-arming must adopt the existing hook.
	d2 := &remoteDebugger{emu: d1.emu}
	d2.cmdSetBasicBP([]string{"30"})

	var hits int
	prior := d1.emu.mem.GetRAMWriteHook()
	d1.emu.mem.SetRAMWriteHook(func(bank int, addr uint16, val byte) {
		prior(bank, addr, val)
		if addr == 0x1C46 && bank == 5 {
			hits++
		}
	})
	writePPC(d2, 30)
	if hits != 1 {
		t.Errorf("PPC hi write seen %d times, want 1", hits)
	}
	if d1.paused.Load() {
		t.Fatal("fire paused the orphaned debugger")
	}
	if !d2.paused.Load() {
		t.Fatal("fire did not pause the current debugger")
	}
}

// Chained hooks must keep firing: arming a basic-bp after watch-mem
// (or vice versa) composes rather than clobbers.
func TestBasicBP_ChainsPriorHook(t *testing.T) {
	resetBasicBPGlobals(t)
	d := newRemoteWithCPU(t)
	var priorCalls int
	d.emu.mem.SetRAMWriteHook(func(bank int, addr uint16, val byte) {
		priorCalls++
	})
	d.cmdSetBasicBP([]string{"30"})

	writePPC(d, 30)
	if priorCalls != 2 {
		t.Errorf("prior hook saw %d writes, want 2", priorCalls)
	}
	if !d.paused.Load() {
		t.Fatal("did not pause on target line with chained hook")
	}
}
