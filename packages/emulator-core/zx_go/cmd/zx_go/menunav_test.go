package main

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// TestMenuCursorNavigation pins the cursor-feedback navigation: the waitCursor
// step must leave the NextZXOS menu cursor ($F700) exactly on Command Line
// (menuItemCommandLine) without overshooting it. If a NextZXOS update reorders
// the main menu, this fails with a clear message rather than a generic
// cycle-never-completed failure. ROM/SD-gated, so CI stays green without them.
func TestMenuCursorNavigation(t *testing.T) {
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
		t.Skip("no SD image mounted (set ZX_GO_NEXT_SD_IMG)")
	}
	if err := emu.importAndRunBas(plus3dosProgram([]byte{
		0x00, 0x0A, 0x17, 0x00, 0xF4, '3', '2', '7', '6', '8',
		0x0E, 0x00, 0x00, 0x00, 0x80, 0x00, 0x2C, '1', '2', '3',
		0x0E, 0x00, 0x00, 0x7B, 0x00, 0x00, 0x0D,
	}, 10)); err != nil {
		t.Fatalf("importAndRunBas: %v", err)
	}

	// Locate the waitCursor step so we can observe only the menu-navigation
	// window (after it completes, $F700 is no longer a menu cursor).
	m := emu.nexloadMacro
	cursorStep := -1
	for i, s := range m.steps {
		if s.waitCursor {
			cursorStep = i
			break
		}
	}
	if cursorStep < 0 {
		t.Fatal("macro has no waitCursor step")
	}

	const maxFrames = 4000
	maxCursor := byte(0)
	landed := false
	for f := 0; f < maxFrames && emu.nexloadMacro != nil; f++ {
		emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		if emu.kbd != nil {
			emu.kbd.Tick()
		}
		// Observe from the waitCursor step through the ENTER step (cursorStep
		// + 2: waitCursor, the settle wait, then ENTER): before that window
		// $F700 holds uninitialised garbage from the boot phase; after ENTER
		// it is no longer a menu cursor. Watching PAST the waitCursor step
		// matters — a held cursor key released one frame late can auto-repeat
		// the cursor off the target after the step completed, so ENTER opens
		// the wrong item (Command Line read, NextBASIC opened).
		if idx := emu.nexloadMacro.idx; idx >= cursorStep && idx <= cursorStep+2 {
			if c := emu.mem.Read(nextMenuCursorAddr); c > maxCursor {
				maxCursor = c
			}
		}
		if emu.nexloadMacro.tick(emu) {
			emu.nexloadMacro = nil
			break
		}
		// The frame the cursor step first completes, the cursor must be on
		// the target item.
		if !landed && emu.nexloadMacro != nil && emu.nexloadMacro.idx > cursorStep {
			landed = true
			if got := emu.mem.Read(nextMenuCursorAddr); got != menuItemCommandLine {
				t.Fatalf("cursor landed on %d, want Command Line (%d) — menu order changed?", got, menuItemCommandLine)
			}
		}
	}
	if !landed {
		t.Fatal("waitCursor step never completed (menu never presented?)")
	}
	if maxCursor > menuItemCommandLine {
		t.Errorf("cursor overshot to %d before landing on %d — auto-repeat outran the feedback check", maxCursor, menuItemCommandLine)
	}
	t.Logf("cursor navigated to Command Line (%d) cleanly; peak index %d", menuItemCommandLine, maxCursor)
}
