package main

import (
	"strings"
	"testing"
)

// resetStepLineGlobals gives each test a clean slate: the armed state
// is package-level (see stepline_cmd.go) and would otherwise leak
// between tests.
func resetStepLineGlobals(t *testing.T) {
	t.Helper()
	stepLineAnchors.Store(nil)
	stepLineArmed.Store(false)
	stepLineOver.Store(false)
	stepLineSP0.Store(0)
}

func TestStepLine_AnchorsCommand(t *testing.T) {
	resetStepLineGlobals(t)
	d := newRemoteWithCPU(t)
	if got := d.cmdStepLineAnchors(nil); got != "OK 0 anchors" {
		t.Fatalf("empty query: %q", got)
	}
	if got := d.cmdStepLineAnchors([]string{"$8000", "$8010"}); got != "OK 2 anchors" {
		t.Fatalf("add: %q", got)
	}
	// A second add accumulates (the IDE uploads in chunks).
	if got := d.cmdStepLineAnchors([]string{"$8020"}); got != "OK 3 anchors" {
		t.Fatalf("chunked add: %q", got)
	}
	// Re-adding an existing address is idempotent.
	if got := d.cmdStepLineAnchors([]string{"$8000"}); got != "OK 3 anchors" {
		t.Fatalf("dup add: %q", got)
	}
	if got := d.cmdStepLineAnchors([]string{"bogus"}); !strings.HasPrefix(got, "ERR") {
		t.Fatalf("bad addr accepted: %q", got)
	}
	if got := d.cmdStepLineAnchors([]string{"clear"}); got != "OK anchors cleared" {
		t.Fatalf("clear: %q", got)
	}
	if got := d.cmdStepLineAnchors(nil); got != "OK 0 anchors" {
		t.Fatalf("post-clear query: %q", got)
	}
}

func TestStepLine_ArmRequiresAnchors(t *testing.T) {
	resetStepLineGlobals(t)
	d := newRemoteWithCPU(t)
	if got := d.cmdStepLine(nil); !strings.HasPrefix(got, "ERR no line anchors") {
		t.Fatalf("armed without anchors: %q", got)
	}
	d.cmdStepLineAnchors([]string{"$8000"})
	if got := d.cmdStepLine(nil); got != "OK step-line armed" {
		t.Fatalf("arm: %q", got)
	}
	if !stepLineArmed.Load() {
		t.Fatal("arm flag not set")
	}
	if got := d.cmdStepLine([]string{"off"}); got != "OK step-line disarmed" {
		t.Fatalf("off: %q", got)
	}
	if stepLineArmed.Load() {
		t.Fatal("off left the arm flag set")
	}
	if got := d.cmdStepLine([]string{"sideways"}); !strings.HasPrefix(got, "ERR usage") {
		t.Fatalf("bad arg accepted: %q", got)
	}
}

func TestStepLine_FiresOnAnchorAndDisarms(t *testing.T) {
	resetStepLineGlobals(t)
	d := newRemoteWithCPU(t)
	d.cmdStepLineAnchors([]string{"$8000", "$8010"})
	d.cmdStepLine(nil)

	if d.checkStepLine(0x8004) {
		t.Fatal("fired off-anchor")
	}
	if !d.checkStepLine(0x8010) {
		t.Fatal("did not fire on an anchor")
	}
	if !d.paused.Load() {
		t.Fatal("fire did not pause")
	}
	if stepLineArmed.Load() {
		t.Fatal("one-shot did not disarm on fire")
	}
	// Disarmed: the same anchor no longer halts.
	d.paused.Store(false)
	if d.checkStepLine(0x8010) {
		t.Fatal("fired while disarmed")
	}
}

func TestStepLine_OverGuardsOnSP(t *testing.T) {
	resetStepLineGlobals(t)
	d := newRemoteWithCPU(t)
	d.cmdStepLineAnchors([]string{"$8000"})
	d.emu.cpu.SP = 0xFF00
	if got := d.cmdStepLine([]string{"over"}); got != "OK step-line armed" {
		t.Fatalf("arm over: %q", got)
	}

	// A deeper frame (callee): guarded, keeps running.
	d.emu.cpu.SP = 0xFEFE
	if d.checkStepLine(0x8000) {
		t.Fatal("over-mode fired inside a deeper frame")
	}
	if !stepLineArmed.Load() {
		t.Fatal("guarded miss consumed the one-shot")
	}
	// Back at the arming depth: fires.
	d.emu.cpu.SP = 0xFF00
	if !d.checkStepLine(0x8000) {
		t.Fatal("over-mode did not fire at the arming depth")
	}
}

func TestStepLine_PlainModeIgnoresSP(t *testing.T) {
	resetStepLineGlobals(t)
	d := newRemoteWithCPU(t)
	d.cmdStepLineAnchors([]string{"$8000"})
	d.emu.cpu.SP = 0xFF00
	d.cmdStepLine(nil)
	// Anchor inside a push region / mapped callee: plain mode fires
	// anyway (basic-step parity — and asm sources step through
	// push/pop regions constantly).
	d.emu.cpu.SP = 0xFEFC
	if !d.checkStepLine(0x8000) {
		t.Fatal("plain mode applied the SP guard")
	}
}

func TestStepLine_ArmWhilePausedStepsOffCurrentInstruction(t *testing.T) {
	resetStepLineGlobals(t)
	d := newRemoteWithCPU(t)
	// NOP at the paused PC in RAM; the arm must execute exactly one
	// instruction so the run can never re-halt without progress.
	d.emu.cpu.PC = 0x8000
	d.emu.mem.Write(0x8000, 0x00)
	d.paused.Store(true)
	d.cmdStepLineAnchors([]string{"$8000", "$8001"})
	if got := d.cmdStepLine(nil); got != "OK step-line armed" {
		t.Fatalf("arm: %q", got)
	}
	if d.paused.Load() {
		t.Fatal("arm did not resume")
	}
	if d.emu.cpu.PC != 0x8001 {
		t.Fatalf("arm stepped to $%04X, want $8001", d.emu.cpu.PC)
	}
	// The next M1 is the next line's anchor: fires there, not on the
	// line stepped from.
	if !d.checkStepLine(d.emu.cpu.PC) {
		t.Fatal("did not fire on the next line's anchor")
	}
}

func TestStepLine_Dispatch(t *testing.T) {
	resetStepLineGlobals(t)
	d := newRemoteWithCPU(t)
	for _, tc := range []struct {
		line       string
		wantPrefix string
	}{
		{"step-line-anchors $8000", "OK 1 anchors"},
		{"step-line", "OK step-line armed"},
		{"step-line off", "OK step-line disarmed"},
		{"step-line-anchors clear", "OK anchors cleared"},
		{"step-line", "ERR no line anchors"},
	} {
		if got := d.handleCommand(tc.line); !strings.HasPrefix(got, tc.wantPrefix) {
			t.Fatalf("%q -> %q, want prefix %q", tc.line, got, tc.wantPrefix)
		}
	}
}
