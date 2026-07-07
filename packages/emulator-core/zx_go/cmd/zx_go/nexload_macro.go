package main

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/conorarmstrong/zx_go/pkg/next/sdcard"
)

// nextMenuLoopPC is the PC the NextZXOS ROM spins at while it waits for a key
// at the welcome screen and at the main menu — the signal that the boot has
// reached an interactive prompt.
const nextMenuLoopPC = 0x0c90

// nexKeyMatrix maps the characters needed to type a NextZXOS command line onto
// Spectrum keyboard-matrix (row, mask) presses. Symbols use SYMBOL SHIFT
// (row 7, 0x02) plus the symbol's key. Paths are typed lowercase — the SD card
// is FAT (case-insensitive) so this still matches mixed-case folder names.
var nexKeyMatrix = func() map[rune][][2]int {
	sym := [2]int{7, 0x02} // SYMBOL SHIFT
	letters := map[rune][2]int{
		'a': {1, 0x01}, 'b': {7, 0x10}, 'c': {0, 0x08}, 'd': {1, 0x04}, 'e': {2, 0x04},
		'f': {1, 0x08}, 'g': {1, 0x10}, 'h': {6, 0x10}, 'i': {5, 0x04}, 'j': {6, 0x08},
		'k': {6, 0x04}, 'l': {6, 0x02}, 'm': {7, 0x04}, 'n': {7, 0x08}, 'o': {5, 0x02},
		'p': {5, 0x01}, 'q': {2, 0x01}, 'r': {2, 0x08}, 's': {1, 0x02}, 't': {2, 0x10},
		'u': {5, 0x08}, 'v': {0, 0x10}, 'w': {2, 0x02}, 'x': {0, 0x04}, 'y': {5, 0x10},
		'z': {0, 0x02},
		'0': {4, 0x01}, '1': {3, 0x01}, '2': {3, 0x02}, '3': {3, 0x04}, '4': {3, 0x08},
		'5': {3, 0x10}, '6': {4, 0x10}, '7': {4, 0x08}, '8': {4, 0x04}, '9': {4, 0x02},
	}
	m := map[rune][][2]int{
		' ':  {{7, 0x01}},      // SPACE
		'.':  {sym, {7, 0x04}}, // SYMBOL SHIFT + M
		'/':  {sym, {0, 0x10}}, // SYMBOL SHIFT + V
		'-':  {sym, {6, 0x08}}, // SYMBOL SHIFT + J
		'_':  {sym, {4, 0x01}}, // SYMBOL SHIFT + 0 — appears in compiler temp
		//                         names (tmp…); untypeable here meant the macro
		//                         silently dropped it and NextZXOS then couldn't
		//                         find the file ("No such file or dir").
		'\'': {sym, {4, 0x08}}, // SYMBOL SHIFT + 7
		'"':  {sym, {5, 0x01}}, // SYMBOL SHIFT + P
		':':  {sym, {0, 0x02}}, // SYMBOL SHIFT + Z
	}
	for r, k := range letters {
		m[r] = [][2]int{k}
	}
	return m
}()

// macroStep is one stage of the NEXLOAD macro. Keys are held for the whole
// step (released and re-pressed on entry to each step); frames is how many
// emulated frames the step lasts. A step with waitMenu set instead runs until
// the CPU reaches the NextZXOS menu wait loop (or a safety timeout), which is
// how the boot phase waits for an interactive prompt.
type macroStep struct {
	keys     [][2]int
	frames   int
	waitMenu bool
}

// nexloadMacro drives the genuine NextZXOS `.nexload` dot command from the GUI
// run loop, one step per frame: it reaches the menu, opens the Command Line,
// types `.nexload <sdPath>`, and runs it. This is the faithful way to load a
// .nex — NextZXOS sets up the OS environment the game expects, so games that
// depend on the runtime (and would crash under bank-injection) work exactly as
// on hardware. Built only after the .nex is present on the SD card.
type nexloadMacro struct {
	steps []macroStep
	idx   int
	frame int
	keyOn bool
}

// newCommandLineMacro builds a macro that boots to the NextZXOS menu, opens
// the Command Line, types cmd (lowercase — the SD card is FAT and NextZXOS
// keywords are case-insensitive) and presses ENTER, then waits tailFrames for
// the command to do its work. Timings mirror the verified headless sequence.
func newCommandLineMacro(cmd string, tailFrames int) *nexloadMacro {
	var steps []macroStep
	hold := func(keys [][2]int, frames int) { steps = append(steps, macroStep{keys: keys, frames: frames}) }
	wait := func(frames int) { steps = append(steps, macroStep{frames: frames}) }

	steps = append(steps, macroStep{waitMenu: true}) // boot to the welcome screen
	hold([][2]int{{7, 0x01}}, 40)                    // SPACE -> "Start NextZXOS"
	wait(140)                                        // settle on the main menu
	hold([][2]int{{0, 0x01}, {4, 0x10}}, 6)          // cursor DOWN -> Command Line
	wait(10)
	hold([][2]int{{6, 0x01}}, 6) // ENTER -> command prompt
	wait(92)
	for _, c := range strings.ToLower(cmd) {
		if keys, ok := nexKeyMatrix[c]; ok {
			hold(keys, 4)
			wait(10)
		} else {
			// A char the Spectrum matrix can't type is dropped, leaving a typed
			// path that misses the file ("No such file or dir"). Names are
			// sanitised to typeable chars upstream, so warn if that ever
			// diverges from this matrix again rather than failing silently.
			slog.Warn("nexload macro: unmappable char dropped from command", "char", string(c), "cmd", cmd)
		}
	}
	wait(15)
	hold([][2]int{{6, 0x01}}, 6) // ENTER -> run the command
	wait(tailFrames)

	return &nexloadMacro{steps: steps}
}

// newNexloadMacro builds the macro that loads sdPath (an absolute SD-card path,
// e.g. "/games/Next/Sonic/sonic.nex") via the genuine `.nexload` dot command.
// Spaces are typed literally (NEXLOAD takes the rest of the line as the
// filename, so no quoting is needed).
func newNexloadMacro(sdPath string) *nexloadMacro {
	// Short tail: the macro's job ends at the typed ENTER (keys are released
	// on entering the tail step); the machine runs on regardless. Headless
	// renderers poll zxMacroActive to know when the typing is over, so a
	// long tail would just delay their capture start.
	return newCommandLineMacro(".nexload "+sdPath, 100)
}

// tick advances the macro by one frame. It must be called once per executed
// frame, after the frame runs, so keys pressed here are seen by the next
// frame's keyboard scan. Returns true when the macro is finished (the caller
// should then drop it).
func (m *nexloadMacro) tick(e *emulator) bool {
	if m.idx >= len(m.steps) {
		m.releaseAll(e)
		return true
	}
	s := &m.steps[m.idx]
	if m.frame == 0 {
		// Entering a step: drop any previously-held keys, then press
		// this step's keys (if any).
		m.releaseAll(e)
		for _, k := range s.keys {
			e.kbd.PressMatrixKey(k[0], byte(k[1]), true)
		}
		m.keyOn = len(s.keys) > 0
	}
	m.frame++
	if s.waitMenu {
		// Safety timeout so a failed/absent boot can't wedge the macro. A
		// cold NextZXOS boot can take ~2500 frames; allow ample margin.
		if e.cpu.PC == nextMenuLoopPC || m.frame > 4000 {
			m.idx++
			m.frame = 0
		}
		return false
	}
	if m.frame >= s.frames {
		m.idx++
		m.frame = 0
	}
	return false
}

// neutralAutoexec is a PLUS3DOS-headered one-line program (9999 REM) with NO
// autostart line. Written over c:/nextzxos/autoexec.bas by importAndRunNex:
// a previous importAndRunBas leaves its auto-running program there, and every
// later boot — including the reboot the nexload macro performs — would run
// that stale program first and derail the macro's keystrokes. NextZXOS only
// auto-RUNs an autoexec with an autostart line, so this one is inert.
func neutralAutoexec() []byte {
	prog := []byte{0x27, 0x0F, 0x02, 0x00, 0xEA, 0x0D} // 9999 REM
	out := make([]byte, 128+len(prog))
	copy(out, "PLUS3DOS")
	out[8] = 0x1A
	out[9] = 1
	total := len(out)
	out[11] = byte(total)
	out[12] = byte(total >> 8)
	out[13] = byte(total >> 16)
	out[14] = byte(total >> 24)
	out[15] = 0 // +3 BASIC header: type 0 = Program
	out[16] = byte(len(prog))
	out[17] = byte(len(prog) >> 8)
	out[18] = 0x00
	out[19] = 0x80 // autostart line $8000 = none
	out[20] = out[16]
	out[21] = out[17] // vars offset = program length
	sum := 0
	for i := 0; i < 127; i++ {
		sum += int(out[i])
	}
	out[127] = byte(sum)
	copy(out[128:], prog)
	return out
}

// importAndRunNex copies data onto the SD card and starts the loader macro.
// It runs on its own goroutine (the SD write can be large) with the emulator
// paused so the in-memory image isn't modified mid-read.
func (e *emulator) importAndRunNex(fileName string, data []byte) {
	if e.sdImageSrc == nil {
		return
	}
	e.paused.Store(true)
	// Disarm any auto-running autoexec.bas left by importAndRunBas — the
	// macro below reboots, and a stale program would run over it.
	if _, err := sdcard.WriteFileToFAT32(e.sdImageSrc.Bytes(), "nextzxos", "autoexec.bas", neutralAutoexec()); err != nil {
		slog.Warn("nex import: could not neutralise autoexec.bas", "err", err)
	}
	// Always import to one fixed, short 8.3 name and OVERWRITE it in place —
	// never preserve the source name. AddFileToFAT32 would mint a unique alias
	// when re-importing into an already-populated card (LONEWOLF.NEX ->
	// LONEWO~1.NEX), and the typing macro cannot produce '~': it typed
	// "lonewo1.nex" and NextZXOS answered "No such file or dir". A fixed name
	// also keeps the typed `.nexload` command as short as possible, so the
	// keystroke macro finishes far quicker. (The .nex's own filename is
	// irrelevant to the game; saves are game-managed, e.g. lonewolf.sav.)
	const importedNexName = "g.nex"
	sdPath, err := sdcard.WriteFileToFAT32(e.sdImageSrc.Bytes(), "imported", importedNexName, data)
	if err != nil {
		e.paused.Store(false)
		slog.Error("nex import: copy to SD card failed", "file", fileName, "err", err)
		e.showGUIError(fmt.Errorf("copy %q to SD card: %w", fileName, err))
		return
	}
	// Persist so the imported game survives restarts (race-free while paused).
	if e.sdImagePath != "" {
		if err := e.sdImageSrc.WriteBackTo(e.sdImagePath); err != nil {
			slog.Warn("nex import: persisting to the SD image failed", "err", err)
		}
	}
	slog.Info("nex import: loading via NextZXOS", "file", fileName, "sdPath", sdPath)
	e.startNexloadMacro(sdPath)
}

// importAndRunBas writes data — a PLUS3DOS-headered, autostart-lined NextBASIC
// program — to c:/imported/program.bas and drives the NextZXOS Command Line
// to LOAD it. The autostart line runs it on load, and when it ends (STOP, END
// or falling off) the machine is left at the NextBASIC editor report WITH THE
// PROGRAM OUTPUT STILL ON SCREEN — the 48K-like experience. (The previous
// autoexec.bas approach lost the output: when an autoexec terminates,
// NextZXOS immediately redraws its main menu, and no in-program trick
// survives programs that end via STOP.) Runs with the emulator paused so the
// in-memory SD image isn't modified mid-read.
func (e *emulator) importAndRunBas(data []byte) error {
	if e.sdImageSrc == nil {
		return fmt.Errorf("no SD image mounted")
	}
	e.paused.Store(true)
	// Self-heal any auto-running autoexec.bas left by the earlier approach.
	if _, err := sdcard.WriteFileToFAT32(e.sdImageSrc.Bytes(), "nextzxos", "autoexec.bas", neutralAutoexec()); err != nil {
		slog.Warn("bas import: could not neutralise autoexec.bas", "err", err)
	}
	if _, err := sdcard.WriteFileToFAT32(e.sdImageSrc.Bytes(), "imported", "program.bas", data); err != nil {
		e.paused.Store(false)
		return fmt.Errorf("write program.bas: %w", err)
	}
	// Persist so the program survives restarts (no-op on wasm: sdImagePath == "").
	if e.sdImagePath != "" {
		if err := e.sdImageSrc.WriteBackTo(e.sdImagePath); err != nil {
			slog.Warn("bas import: persisting to the SD image failed", "err", err)
		}
	}
	slog.Info("bas import: LOADing via the NextZXOS command line", "bytes", len(data))
	// Arm the macro before releasing pause (see startNexloadMacro).
	e.reboot()
	e.nexloadMacro = newCommandLineMacro(`load "/imported/program.bas"`, 100)
	e.paused.Store(false)
	return nil
}

// startNexloadMacro reboots into a clean NextZXOS and begins driving the
// .nexload command to load the .nex at sdPath (an absolute SD-card path) via
// the genuine OS loader. The reboot guarantees a fresh OS state regardless of
// what was running before.
func (e *emulator) startNexloadMacro(sdPath string) {
	e.reboot()
	// Arm the macro before releasing pause: the emulation goroutine's
	// run loop checks e.nexloadMacro on every frame it executes, so
	// setting it first avoids a window where an unpaused frame runs
	// with no macro driving it yet.
	e.nexloadMacro = newNexloadMacro(sdPath)
	e.paused.Store(false)
}

// releaseAll clears every key the macro might be holding.
func (m *nexloadMacro) releaseAll(e *emulator) {
	if !m.keyOn {
		return
	}
	for row := 0; row < 8; row++ {
		e.kbd.PressMatrixKey(row, 0xFF, false)
	}
	m.keyOn = false
}
