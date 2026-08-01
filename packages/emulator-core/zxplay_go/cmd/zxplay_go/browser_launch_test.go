package main

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
)

// TestImportAndRunNexBrowserCycle exercises the GAME import route: a
// folder-qualified name makes importAndRunNex stage the .nex under its
// original folder ("tstgame/zx.nex") and launch it by navigating the
// NextZXOS Browser — the way a player runs a game on real hardware, and
// the only launch context some games accept (#178: TX-1696 exits unless
// run as <its folder>/main.nex). The loaded code POKEs a sentinel,
// proving the staging, the computed cursor navigation, and the Browser's
// own load path work end to end.
func TestImportAndRunNexBrowserCycle(t *testing.T) {
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
	if emu.sdImageSrc == nil {
		t.Skip("no SD image mounted (set ZX_GO_NEXT_SD_IMG); the load path needs one")
	}

	// LD A,123 ; LD ($8000),A ; JR $ — running at $C000, writes bank 2[0].
	emu.importAndRunNex("tstgame/zx.nex", minimalNex([]byte{0x3E, 0x7B, 0x32, 0x00, 0x80, 0x18, 0xFE}))
	if emu.nexloadMacro == nil {
		t.Fatal("importAndRunNex did not arm the Browser launch macro")
	}

	sentinel := emu.mem.GetPage(2)
	sentinel[0] = 0

	const maxFrames = 8000
	frame := 0
	for ; frame < maxFrames && sentinel[0] != 123; frame++ {
		emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		if emu.kbd != nil {
			emu.kbd.Tick()
		}
		if emu.nexloadMacro != nil && emu.nexloadMacro.tick(emu) {
			emu.nexloadMacro = nil
		}
		emu.noteBootFrame()
	}
	if sentinel[0] != 123 {
		t.Fatalf(".nex never ran: bank2[0]=%d after %d frames (PC=%#04x, macro done=%v)",
			sentinel[0], frame, emu.cpu.PC, emu.nexloadMacro == nil)
	}
	t.Logf(".nex staged at tstgame/zx.nex and Browser-launched after %d frames", frame)
}
