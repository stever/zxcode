package main

import (
	"strings"
	"testing"
)

// Covers runtime arming of the instruction-history ring (`history-on` /
// `history-off`). The browser bridge constructs the debugger with history
// off, so these are the only way its UI gets a ring.

func TestCmdHistoryOnOff(t *testing.T) {
	d := newRemoteWithCPU(t)

	if got := d.cmdHistory(nil); !strings.HasPrefix(got, "ERR history disabled") {
		t.Fatalf("history before arming = %q, want ERR history disabled", got)
	}

	if got := d.cmdHistoryOn(nil); got != "OK history armed entries=0 capacity=4096 wide=false" {
		t.Fatalf("history-on = %q", got)
	}
	if d.emu.debugHistory == nil || d.history != d.emu.debugHistory {
		t.Fatal("history-on must stash the shared ring on the emulator")
	}

	// The recorder hook is live: an instruction lands in the ring.
	d.emu.cpu.PC = 0x8000
	d.emu.mem.Write(0x8000, 0x00) // nop
	d.emu.cpu.StepInstruction()
	if got := d.cmdHistory(nil); got != "OK entries=1 capacity=4096" {
		t.Fatalf("history after one step = %q", got)
	}

	// Same geometry re-arm keeps the entries; a new geometry replaces.
	if got := d.cmdHistoryOn([]string{"4096"}); got != "OK history armed entries=1 capacity=4096 wide=false" {
		t.Fatalf("re-arm same geometry = %q", got)
	}
	if got := d.cmdHistoryOn([]string{"128", "wide"}); got != "OK history armed entries=0 capacity=128 wide=true" {
		t.Fatalf("re-arm new geometry = %q", got)
	}

	if got := d.cmdHistoryOff(); got != "OK history off" {
		t.Fatalf("history-off = %q", got)
	}
	if d.history != nil || d.emu.debugHistory != nil {
		t.Fatal("history-off must release the ring")
	}
	// The hook is gone: stepping records nothing and off is idempotent.
	d.emu.cpu.StepInstruction()
	if got := d.cmdHistoryOff(); got != "OK history off" {
		t.Fatalf("second history-off = %q", got)
	}

	if got := d.cmdHistoryOn([]string{"0"}); !strings.HasPrefix(got, "ERR usage") {
		t.Fatalf("history-on 0 = %q, want ERR usage", got)
	}
	if got := d.cmdHistoryOn([]string{"junk"}); !strings.HasPrefix(got, "ERR usage") {
		t.Fatalf("history-on junk = %q, want ERR usage", got)
	}
}

func TestHistoryOnOffNeedImplicitPause(t *testing.T) {
	// Both mutate the CPU's pre-fetch hook list, which the execution
	// goroutine iterates without a lock.
	for _, cmd := range []string{"history-on", "history-off"} {
		if !commandsNeedingPause[cmd] {
			t.Errorf("commandsNeedingPause[%q] = false, want true", cmd)
		}
	}
}
