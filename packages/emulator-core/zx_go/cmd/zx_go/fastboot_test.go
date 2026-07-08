package main

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// TestBootFastForwardGating covers the pure decision logic: model gating,
// the macro tail handoff, and the frame cap — no ROMs needed.
func TestBootFastForwardGating(t *testing.T) {
	// Non-Next machines never fast-forward.
	e := &emulator{model: roms.Model48K}
	if e.bootFastForwardActive() {
		t.Error("48K: fast-forward must be off")
	}

	// Next from power-on (zero values): armed until the menu is seen.
	e = &emulator{model: roms.ModelNext}
	if !e.bootFastForwardActive() {
		t.Error("Next power-on: fast-forward must be on")
	}
	e.bootMenuSeen = true
	if e.bootFastForwardActive() {
		t.Error("menu seen: fast-forward must be off")
	}

	// Cap: a boot that never reaches the menu loop stops fast-forwarding.
	e = &emulator{model: roms.ModelNext, bootFrames: nextBootFFFrameCap}
	if e.bootFastForwardActive() {
		t.Error("frame cap reached: fast-forward must be off")
	}

	// A macro overrides the menu latch: fast-forward through boot + typing,
	// off in the tail step (program running) and once the macro is dropped.
	m := newCommandLineMacro(`load "/zx.bas"`, 100)
	e = &emulator{model: roms.ModelNext, nexloadMacro: m, bootMenuSeen: true}
	if m.inTail() {
		t.Fatal("fresh macro must not start in its tail step")
	}
	if !e.bootFastForwardActive() {
		t.Error("macro typing: fast-forward must be on")
	}
	m.idx = len(m.steps) - 1
	if !m.inTail() {
		t.Fatal("last step must be the tail")
	}
	if e.bootFastForwardActive() {
		t.Error("macro tail: fast-forward must be off")
	}
	e.nexloadMacro = nil
	if e.bootFastForwardActive() {
		t.Error("macro done + menu seen: fast-forward must be off")
	}

	// resetBootProgress re-arms after a reboot.
	e.bootFrames = nextBootFFFrameCap
	e.bootMenuSeen = true
	e.resetBootProgress()
	if !e.bootFastForwardActive() {
		t.Error("after resetBootProgress: fast-forward must be on")
	}
}

// TestBootFastForwardColdBoot boots a real Next (skipped when the gitignored
// ROMs/SD are absent) driving frames exactly as the wasm zxFrame path does,
// and verifies fast-forward stays on through the boot and latches off at the
// NextZXOS welcome key-wait loop.
func TestBootFastForwardColdBoot(t *testing.T) {
	prev := cliFlagsActive
	nf := cliFlags{}
	if prev != nil {
		nf = *prev
	}
	nf.noSound = true
	cliFlagsActive = &nf
	t.Cleanup(func() { cliFlagsActive = prev })

	emu, err := newNextEmulator()
	if err != nil {
		t.Skipf("Next ROMs not installed: %v", err)
	}
	if !emu.bootFastForwardActive() {
		t.Fatal("cold boot: fast-forward must start on")
	}
	frames := 0
	for ; frames < nextBootFFFrameCap && emu.bootFastForwardActive(); frames++ {
		emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		emu.noteBootFrame()
	}
	if !emu.bootMenuSeen || emu.cpu.PC != nextMenuLoopPC {
		t.Skipf("Next did not reach the NextZXOS welcome (PC=%#04x after %d frames); SD/boot config unavailable", emu.cpu.PC, frames)
	}
	if emu.bootFastForwardActive() {
		t.Error("welcome reached: fast-forward must be off")
	}
	t.Logf("boot fast-forward ended at the welcome after %d frames", frames)

	// A reboot re-arms it (the compile-run cycle path).
	emu.reboot()
	if !emu.bootFastForwardActive() {
		t.Error("after reboot: fast-forward must be re-armed")
	}
}
