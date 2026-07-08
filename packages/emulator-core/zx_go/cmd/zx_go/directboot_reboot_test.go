package main

import (
	"os"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// TestDirectBootSurvivesReboot proves the direct-core boot path
// (ZX_GO_NO_FPGA_BOOTROM=1 + ZX_GO_NEXT_DIRECT_BOOT=1) reaches the NextZXOS
// welcome both from cold construction AND after reboot() — the compile-run
// macros (importAndRunNex / importAndRunBas) reboot first, so a direct boot
// that only works once is unusable for the site's run cycle.
func TestDirectBootSurvivesReboot(t *testing.T) {
	if os.Getenv("ZX_GO_NEXT_DIRECT_BOOT") == "" || os.Getenv("ZX_GO_NO_FPGA_BOOTROM") == "" {
		t.Skip("set ZX_GO_NO_FPGA_BOOTROM=1 ZX_GO_NEXT_DIRECT_BOOT=1 to run")
	}
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
	bootToWelcome := func(stage string) {
		frames := 0
		for ; frames < nextBootFFFrameCap && emu.cpu.PC != nextMenuLoopPC; frames++ {
			emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
			if emu.peripherals != nil {
				emu.peripherals.Frame()
			}
			emu.noteBootFrame()
		}
		if emu.cpu.PC != nextMenuLoopPC {
			t.Fatalf("%s: did not reach the NextZXOS welcome (PC=%#04x after %d frames)", stage, emu.cpu.PC, frames)
		}
		t.Logf("%s: welcome after %d frames", stage, frames)
	}
	bootToWelcome("cold direct boot")
	emu.reboot()
	bootToWelcome("reboot direct boot")
}
