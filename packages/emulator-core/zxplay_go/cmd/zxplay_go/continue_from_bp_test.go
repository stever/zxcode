package main

import (
	"strings"
	"testing"
)

// Continue while sitting ON a breakpoint must execute the current
// instruction — NOT accept a pending IRQ first. IRQ delivery pushes the
// un-executed BP address as the return, so the handler RETs straight back
// onto the BP and continue bounces at the same PC forever; with the 50 Hz
// frame INT there is nearly always one pending (e.g. right after a tape
// load, which is how the browser debugger hit this).
func TestContinueFromBreakpointWithPendingIRQ(t *testing.T) {
	d := newRemoteWithCPU(t)
	c := d.emu.cpu

	// ld a,2 at $8000, with a BP armed there and an IRQ pending.
	d.emu.mem.Write(0x8000, 0x3E)
	d.emu.mem.Write(0x8001, 0x02)
	c.PC = 0x8000
	c.IFF1 = true
	c.IM = 1
	c.IRQPending.Store(true)
	if got := d.handleCommand("set-breakpoint $8000"); !strings.HasPrefix(got, "OK") {
		t.Fatalf("set-breakpoint = %q", got)
	}
	d.paused.Store(true)

	if got := d.handleCommand("continue"); got != "OK continuing" {
		t.Fatalf("continue = %q", got)
	}
	if c.PC != 0x8002 {
		t.Fatalf("PC = $%04X after continue step-off, want $8002 (IRQ must not hijack the step)", c.PC)
	}
	if c.A != 2 {
		t.Fatalf("A = %d, want 2 (the BP instruction must have executed)", c.A)
	}
	if !c.IRQPending.Load() {
		t.Fatal("the pending IRQ should still be pending for the next M1")
	}
	if d.paused.Load() {
		t.Fatal("continue should leave the debugger unpaused")
	}
}
