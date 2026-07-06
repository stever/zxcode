package main

import (
	"fmt"

	"github.com/conorarmstrong/zx_go/pkg/roms"
	"github.com/conorarmstrong/zx_go/pkg/ula"
)

// Tape auto-run: mount a .tap and drive the guest to start loading it, the way
// a user would. Reuses the nexloadMacro step machinery (see nexload_macro.go).
// Timings are frame counts at 50 Hz, tuned against the headless browser harness.

// new48TapeMacro types LOAD "" ENTER at the 48K BASIC prompt. At the K cursor
// the J key emits the LOAD keyword; " is SYMBOL SHIFT + P. The fast-load trap
// then synthesises the load from the mounted blocks.
func new48TapeMacro() *nexloadMacro {
	sym := [2]int{7, 0x02}          // SYMBOL SHIFT
	p := [2]int{5, 0x01}            // P
	var steps []macroStep
	hold := func(keys [][2]int, frames int) { steps = append(steps, macroStep{keys: keys, frames: frames}) }
	wait := func(frames int) { steps = append(steps, macroStep{frames: frames}) }

	wait(150)                          // boot to the © prompt (K cursor)
	hold([][2]int{{6, 0x08}}, 4)       // J -> LOAD keyword
	wait(12)
	hold([][2]int{sym, p}, 4)          // SYMBOL SHIFT + P -> "
	wait(12)
	hold([][2]int{sym, p}, 4)          // SYMBOL SHIFT + P -> "
	wait(12)
	hold([][2]int{{6, 0x01}}, 6)       // ENTER -> run LOAD ""
	wait(600)                          // fast-load the tape
	return &nexloadMacro{steps: steps}
}

// new128TapeMacro selects the 128 menu's default "Tape Loader" entry, which
// issues LOAD "" itself.
func new128TapeMacro() *nexloadMacro {
	var steps []macroStep
	hold := func(keys [][2]int, frames int) { steps = append(steps, macroStep{keys: keys, frames: frames}) }
	wait := func(frames int) { steps = append(steps, macroStep{frames: frames}) }

	wait(250)                    // boot to the 128 menu (Tape Loader default)
	hold([][2]int{{6, 0x01}}, 6) // ENTER -> Tape Loader (does LOAD "")
	wait(600)                    // fast-load the tape
	return &nexloadMacro{steps: steps}
}

// newTapePlayerFromBytes mounts tape bytes as a TapePlayer, sniffing the
// container: TZX images carry the "ZXTape!" signature; anything else is
// treated as raw TAP blocks (TAP has no magic to check).
func newTapePlayerFromBytes(data []byte) (*ula.TapePlayer, error) {
	tp := ula.NewTapePlayer()
	if len(data) >= 8 && string(data[0:7]) == "ZXTape!" && data[7] == 0x1A {
		if err := tp.LoadTZXBytes(data); err != nil {
			return nil, fmt.Errorf("load tape (TZX): %w", err)
		}
		return tp, nil
	}
	if err := tp.LoadTAPBytes(data); err != nil {
		return nil, fmt.Errorf("load tape (TAP): %w", err)
	}
	return tp, nil
}

// loadAndRunTape mounts a .tap/.tzx image and drives the guest to LOAD it. It
// reboots first for a clean BASIC prompt / 128 menu, mounts the deck (after
// reboot, so ula.Reset doesn't clear it), starts playback, and arms the
// model-appropriate keystroke macro. Runs paused so the machine isn't stepped
// mid-setup.
func (e *emulator) loadAndRunTape(data []byte) error {
	if e.ula == nil {
		return fmt.Errorf("current model has no tape deck")
	}
	tp, err := newTapePlayerFromBytes(data)
	if err != nil {
		return err
	}
	e.paused.Store(true)
	e.reboot()
	e.ula.SetTapePlayer(tp)
	tp.Play()
	if e.model == roms.Model128K || e.model == roms.ModelPlus2 {
		e.nexloadMacro = new128TapeMacro()
	} else {
		e.nexloadMacro = new48TapeMacro()
	}
	e.paused.Store(false)
	return nil
}
