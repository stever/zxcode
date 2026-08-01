package main

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/stever/zxplay_go/pkg/next/sdcard"
)

// nextMenuLoopPC is the PC the NextZXOS ROM spins at while it waits for a key
// at the welcome screen and at the main menu — the signal that the boot has
// reached an interactive prompt.
const nextMenuLoopPC = 0x0c90

// sdImageStore is the writable card backing store the import/staging
// paths (importAndRunNex/Bas, putSDFile) write through: the flat
// ImageSource on desktop, the SparseSource in the browser. It is both
// the SPI card's BlockSource and the FAT machinery's Image.
type sdImageStore interface {
	sdcard.BlockSource
	sdcard.Image
	Dirty() bool
}

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
		' ': {{7, 0x01}},      // SPACE
		'.': {sym, {7, 0x04}}, // SYMBOL SHIFT + M
		'/': {sym, {0, 0x10}}, // SYMBOL SHIFT + V
		'-': {sym, {6, 0x08}}, // SYMBOL SHIFT + J
		'_': {sym, {4, 0x01}}, // SYMBOL SHIFT + 0 — appears in compiler temp
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
// emulated frames the step lasts.
//
// Two step kinds run until a condition instead of a frame count:
//   - waitMenu: run until the CPU reaches the NextZXOS menu wait loop (or a
//     safety timeout) — how the boot phase waits for the interactive prompt.
//   - waitCursor: hold this step's keys until the live menu cursor index at
//     $F700 reads cursorTarget (or a safety cap). Cursor-feedback navigation:
//     it self-times through the menu appearing (cursor keys are ignored at
//     the welcome, where $F700 stays 0) and lands exactly on the target item
//     regardless of how long the menu took or auto-repeat timing — the same
//     signal the headless ZX_GO_NAV_128K path uses.
type macroStep struct {
	keys         [][2]int
	frames       int
	waitMenu     bool
	waitCursor   bool
	cursorTarget byte
	// menuLongStreak overrides the unbroken-streak threshold that lets a
	// waitMenu step pass WITHOUT having seen the CPU away from the
	// key-wait (0 = the 600-frame default). The first waitMenu of a boot
	// needs the long default — some boot phases fake stability — but a
	// SECOND waitMenu that follows an already-proven key-wait plus an
	// inert keypress only has to distinguish "still at the menu" from a
	// welcome→menu transition in flight, so a short threshold is safe
	// and saves ~10s of emulated time on the common no-welcome path.
	menuLongStreak int
	// estFrames is this step's nominal duration for progress reporting
	// (see progress); required for the condition-driven steps whose
	// frames field is 0.
	estFrames int
	// waitLoad runs until the guest has read loadBytes worth of SD data
	// blocks since the step began (or a size-scaled timeout): the
	// .nexload file transfer triggered by the macro's final ENTER. The
	// step's in-progress fraction is byte-based, so the loading ring
	// tracks the actual file transfer; it also keeps the macro (and the
	// boot fast-forward, which ends at the tail) covering the load.
	waitLoad  bool
	loadBytes int
}

// nextMenuCursorAddr is the logical address NextZXOS keeps the main-menu
// cursor index at (0 = the top item). Read to drive cursor-feedback menu
// navigation; also surfaced in the headless FD state dump.
const nextMenuCursorAddr = 0xF700

// menuItemCommandLine is the cursor index of "Command Line" in the NextZXOS
// main menu (Browser = 0, Command Line = 1; verified on the current distro in
// both boot modes). If a NextZXOS update reorders the menu this must change —
// the cycle tests (bas_run_cycle_test.go) fail loudly if it drifts.
const menuItemCommandLine = 1

// waitCursorCap bounds a waitCursor step so a menu that never presents (bad
// SD/boot) can't wedge the macro; on the cap it advances anyway (degraded,
// caught by the cycle tests) rather than hanging. Sized to ride out the
// whole welcome→menu transition: $F700 holds GARBAGE until the menu first
// draws (values like 70/99 observed on the r55 card), so the step must
// keep holding its key until the real cursor appears and reaches the
// target — a 600-frame cap expired mid-transition and ran the macro out
// before the menu existed.
const waitCursorCap = 2500

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
	// menuStreak counts consecutive per-frame samples at the menu
	// key-wait PC during a waitMenu step (see tick) — a run proves the
	// menu is really up; single hits occur transiently mid-boot.
	menuStreak int
	// menuSawAway records that this waitMenu step has observed the CPU
	// AWAY from the key-wait loop: a step entered while the PREVIOUS
	// screen's key-wait is still winding down (e.g. right after the
	// SPACE that dismisses the welcome) must watch the transition leave
	// and come back before a short streak counts (see tick).
	menuSawAway bool
	// waitLoad bookkeeping: the card's data-block counter at step entry,
	// the bytes observed since, and the step-frame of the last increase
	// (idle detection) — see tick / progress.
	loadBase     uint64
	loadSeen     int
	loadLastMove int
}

// nexLoadableSize returns how many bytes of a .nex file NextZXOS's .nexload
// actually reads: the 512-byte header, the loading-screen blocks its flags
// announce, and 16K per bank to load. Self-streaming games append payload
// the loader never touches (Atic Atac: a 111MB appendix after 3 banks), so
// the FILE size wildly overstates the launch transfer. V1.3-only screen
// types (bits 5-6) are not sized here — an undercount only makes the ring
// finish early, and the waitLoad idle detection closes the gap. Anything
// unparseable reports the file size.
func nexLoadableSize(data []byte) int {
	if len(data) < 512 || string(data[0:4]) != "Next" {
		return len(data)
	}
	n := 512
	flags := data[10]
	if flags&0x80 == 0 && flags&(0x01|0x04) != 0 {
		n += 512 // palette block (Layer 2 / LoRes screens without no-palette)
	}
	if flags&0x01 != 0 {
		n += 49152 // Layer 2 256x192 loading screen
	}
	if flags&0x02 != 0 {
		n += 6912 // ULA screen
	}
	if flags&0x04 != 0 {
		n += 12288 // LoRes
	}
	if flags&0x08 != 0 {
		n += 12288 // Timex HiRes
	}
	if flags&0x10 != 0 {
		n += 12288 // Timex HiCol
	}
	n += int(data[9]) * 16384
	if n > len(data) {
		n = len(data)
	}
	return n
}

// macroPromptSettleFrames is the settle pad after ENTER on "Command Line",
// before typing. The command prompt is a separate environment (no $F700
// cursor to poll and it idles at the same $0C90 loop as the menu, so PC gives
// no signal either), so this stays a timed pad. A sweep showed the cycle
// completes even at 0; kept modest so the pause is short but a margin remains
// for timing drift on an SD distro update. The end-to-end cycle tests
// (bas_run_cycle_test.go) run at this shipped value and are the guard.
//
// The menu-settle wait that used to sit before the cursor-down step is gone:
// the waitCursor step (hold DOWN until $F700 == Command Line) self-times
// through the menu appearing, so no separate pad is needed there.
const macroPromptSettleFrames = 20

// newCommandLineMacro builds a macro that boots to the NextZXOS menu, opens
// the Command Line, types cmd (lowercase — the SD card is FAT and NextZXOS
// keywords are case-insensitive) and presses ENTER, then waits tailFrames for
// the command to do its work. Timings mirror the verified headless sequence.
func newCommandLineMacro(cmd string, tailFrames int) *nexloadMacro {
	var steps []macroStep
	hold := func(keys [][2]int, frames int) { steps = append(steps, macroStep{keys: keys, frames: frames}) }
	wait := func(frames int) { steps = append(steps, macroStep{frames: frames}) }

	steps = append(steps, macroStep{waitMenu: true}) // boot to the welcome/menu key-wait
	hold([][2]int{{3, 0x01}}, 40)                    // digit 1: dismisses a welcome, inert at the menu (see newBrowserLaunchMacro)
	// Cursor-feedback: hold DOWN until the menu cursor ($F700) lands on
	// Command Line. Self-times through the menu appearing and can't overshoot
	// the target — no fixed menu-settle pad needed.
	steps = append(steps, macroStep{
		keys:         [][2]int{{0, 0x01}, {4, 0x10}}, // CAPS SHIFT + 6 = cursor DOWN
		waitCursor:   true,
		cursorTarget: menuItemCommandLine,
	})
	wait(8)                      // let the cursor-down key-state clear before ENTER
	hold([][2]int{{6, 0x01}}, 6) // ENTER -> command prompt
	wait(macroPromptSettleFrames)
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

// newNexloadMacro builds the TYPED launch: Command Line + `.nexload sdPath`.
// It carries the root-anchored IDE deliveries and bare .nex opens (#184);
// folder-qualified game imports use newBrowserLaunchMacro instead (#178).
// Also used by the oracle bisect tooling (`img.mmc!nexload=...` specs match
// ZEsarUX's typed side).
func newNexloadMacro(sdPath string) *nexloadMacro {
	return newCommandLineMacro(".nexload "+sdPath, 100)
}

// browserSettleFrames pads between opening the Browser (or entering a
// directory) and the next keypress: the Browser reads the directory and
// draws its panel before it accepts input, and presses during the draw are
// eaten. 100 holds 2x margin over the observed floor (the cycle test and a
// real TX-1696 launch still navigate correctly at 50) while keeping the
// user-visible launch short — this pad runs on camera now.
const browserSettleFrames = 100

// browserDownGapFrames separates the Browser cursor-DOWN presses so each
// registers as its own keypress (no auto-repeat involvement). 12 holds 2x
// margin over the observed floor of 6.
const browserDownGapFrames = 12

// newBrowserLaunchMacro launches a .nex through the NextZXOS Browser —
// the same launch a real Next user performs, which is the point (#178):
// a .nex started from the Browser gets the OS's fully-initialised menu
// context, where the NextZXOS personality/mode switches games request
// succeed, AND it keeps its ORIGINAL folder + filename, which some
// games verify or build data paths from (TX-1696 exits unless launched
// as <its folder>/main.nex). Both of the old synthetic entry points
// fail for such games: a boot-time autoexec leaves the mode switch
// retrying forever, and a typed Command-Line `.nexload` (with the
// renamed /zx.nex) errors back to the menu. Neither is how real
// hardware launches anything.
//
// dirDowns / fileDowns are the cursor-DOWN counts computed from the
// card's actual sorted listings (sdcard.ListDir): the Browser opens at
// the root with its cursor on the first row, and a subdirectory opens
// with the cursor on its "." row, so the game folder's row index and
// the .nex's row index (2 + sorted position, after "." and "..") are
// exactly the presses needed. No typing — filenames need not be
// typeable, and 8.3 aliasing is irrelevant.
//
// Any welcome screen is crossed with a digit press (inert if the menu
// is already up — see the step comment) followed by a fixed pad: the
// key-wait PC and the menu cursor byte both give ambiguous readings
// through the welcome→menu transition, so state divination is avoided;
// the pads are absorbed by the boot fast-forward in the browser.
func newBrowserLaunchMacro(dirDowns, fileDowns, loadBytes int) *nexloadMacro {
	var steps []macroStep
	hold := func(keys [][2]int, frames int) { steps = append(steps, macroStep{keys: keys, frames: frames}) }
	wait := func(frames int) { steps = append(steps, macroStep{frames: frames}) }
	down := func(n int) {
		for i := 0; i < n; i++ {
			hold([][2]int{{0, 0x01}, {4, 0x10}}, 4) // CAPS SHIFT + 6 = cursor DOWN
			wait(browserDownGapFrames)
		}
	}
	enter := func() { hold([][2]int{{6, 0x01}}, 6) }

	steps = append(steps, macroStep{waitMenu: true, estFrames: 1200}) // boot to welcome/menu key-wait
	// Dismiss a welcome screen if one is up. The key must be a DIGIT, not
	// SPACE: every card in the current fleet reboots straight to the main
	// menu (no welcome), and there SPACE pages to the "More..." menu — a
	// visible page-flip-and-back that confused users, kept harmless only
	// by the key repeat happening to toggle an even number of times. A
	// digit is "any key" to the welcome's key-wait but does nothing at the
	// menu (verified headless: screenshot identical with and without it).
	hold([][2]int{{3, 0x01}}, 40) // digit 1
	// Ride out a possible welcome->menu transition with feedback instead
	// of a fixed pad: if the digit dismissed a welcome the CPU has already
	// left the key-wait (the 40-frame hold is ample), so the away-and-back
	// path applies; on the common menu-direct boot the key was inert and a
	// short unbroken streak right after an already-proven key-wait is
	// enough — worth ~550 frames over the old wait(600).
	steps = append(steps, macroStep{waitMenu: true, menuLongStreak: 60, estFrames: 80})
	enter()                   // open the Browser (menu cursor sits on it)
	wait(browserSettleFrames) // root directory read + panel draw
	down(dirDowns)            // cursor to the game folder
	enter()                   // enter it
	wait(browserSettleFrames) // folder directory read
	down(fileDowns)           // cursor to the .nex
	enter()                   // launch: the OS runs .nexload on it
	// Meter the actual .nexload file transfer: SD data blocks since the
	// ENTER, against the file's size. This is the ring's home stretch —
	// and because the boot fast-forward runs until the macro's tail, the
	// load itself is time-compressed too. The nominal weight makes big
	// files own most of the bar (their transfer IS most of the launch).
	if loadBytes > 0 {
		est := loadBytes / 2048
		if est < 100 {
			est = 100
		}
		steps = append(steps, macroStep{waitLoad: true, loadBytes: loadBytes, estFrames: est})
	}
	wait(100) // tail: the loaded program is running

	return &nexloadMacro{steps: steps}
}

// progress reports how far through its script the macro is, 0..1, for the
// host's loading indicator. Each step contributes its nominal duration —
// frames for timed steps, estFrames for the condition-driven ones (whose
// real duration varies with boot speed) — and the current step counts its
// elapsed frames capped at that nominal, so a slow boot parks the bar at
// its slice instead of running it off the end. Monotonic by construction.
func (m *nexloadMacro) progress() float64 {
	nominal := func(s *macroStep) int {
		if s.frames > 0 {
			return s.frames
		}
		if s.estFrames > 0 {
			return s.estFrames
		}
		if s.waitMenu || s.waitCursor {
			return 300 // condition step without an estimate
		}
		return 1
	}
	total, done := 0, 0
	for i := range m.steps {
		s := &m.steps[i]
		n := nominal(s)
		total += n
		if i < m.idx {
			done += n
		} else if i == m.idx {
			if s.waitLoad && s.loadBytes > 0 {
				// Byte-based: the ring tracks the actual file transfer.
				f := float64(m.loadSeen) / float64(s.loadBytes)
				if f > 1 {
					f = 1
				}
				done += int(f * float64(n))
			} else if m.frame < n {
				done += m.frame
			} else {
				done += n
			}
		}
	}
	if total == 0 || m.idx >= len(m.steps) {
		return 1
	}
	return float64(done) / float64(total)
}

// inTail reports whether the macro has reached its final step — the tail
// wait after the run/load ENTER, i.e. the loaded program is now running.
// Boot fast-forward (fastboot.go) covers the boot and typing steps but must
// end here so the program itself runs at normal speed. Both constructors end
// their step list with the tail wait, so "last step" identifies it.
func (m *nexloadMacro) inTail() bool {
	return m.idx >= len(m.steps)-1
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
		// The menu/welcome key-wait spins at nextMenuLoopPC continuously,
		// so demand a RUN of consecutive per-frame samples there AND the
		// menu cursor byte reading 0: a single PC hit is not proof —
		// mid-boot code passes through $0C90 transiently, and some boot
		// phases spin at it long enough to fake a streak (observed on
		// the r55 card: the macro's key presses all fired mid-boot and
		// were eaten, leaving the machine idle at the menu). $F700 holds
		// nonzero garbage through those phases and 0 at the welcome and
		// at the freshly-drawn menu, so the pair discriminates. Safety
		// timeout so a failed/absent boot can't wedge the macro; a cold
		// NextZXOS boot takes ~2500 frames.
		if e.cpu.PC == nextMenuLoopPC && e.mem.Read(nextMenuCursorAddr) == 0 {
			m.menuStreak++
		} else {
			m.menuStreak = 0
			m.menuSawAway = true
		}
		// A short streak only counts after the step has seen the CPU
		// away from the key-wait: a waitMenu entered while the previous
		// screen's loop is still running (right after the welcome's
		// dismissal keypress) would otherwise fire before the transition
		// even starts. A LONG unbroken streak counts regardless — the
		// step began at an already-stable interactive screen (headless
		// boots skip the welcome, so no transition ever happens).
		longStreak := s.menuLongStreak
		if longStreak == 0 {
			longStreak = 600
		}
		if (m.menuSawAway && m.menuStreak >= 30) || m.menuStreak >= longStreak || m.frame > 4000 {
			slog.Debug("macro: waitMenu done", "idx", m.idx, "stepFrames", m.frame, "pc", fmt.Sprintf("$%04X", e.cpu.PC))
			m.menuStreak = 0
			m.menuSawAway = false
			m.idx++
			m.frame = 0
		}
		return false
	}
	if s.waitLoad {
		if m.frame == 1 && e.sdCard != nil {
			m.loadBase = e.sdCard.DataBlocksRead()
			m.loadLastMove = 1
		}
		if e.sdCard != nil {
			if seen := int(e.sdCard.DataBlocksRead()-m.loadBase) * 512; seen > m.loadSeen {
				m.loadSeen = seen
				m.loadLastMove = m.frame
			}
		}
		// Complete when the loadable bytes have streamed (FAT and
		// directory reads overcount slightly — harmless, the tail wait
		// follows), when a started transfer goes SD-idle for 3 seconds
		// (the loader read less than estimated — e.g. a V1.3 screen
		// block not sized by nexLoadableSize, or a load error), when no
		// card can be observed, or on a size-scaled timeout so a launch
		// that never reads degrades to the old fixed-tail behaviour
		// instead of wedging the macro.
		idle := m.loadSeen > 0 && m.frame-m.loadLastMove > 150
		if e.sdCard == nil || m.loadSeen >= s.loadBytes || idle || m.frame > 6000+s.loadBytes/512 {
			slog.Debug("macro: waitLoad done", "idx", m.idx, "stepFrames", m.frame, "bytes", m.loadSeen)
			m.idx++
			m.frame = 0
		}
		return false
	}
	if s.waitCursor {
		// Hold this step's keys (cursor DOWN) until the menu cursor reaches
		// the target item, or the safety cap fires. The keys stay held from
		// the frame==0 press above. Release them HERE, in the same tick that
		// observes the target: the next step's entry-release only runs after
		// one more frame has executed, and that frame is enough for the menu
		// scan loop to auto-repeat the still-held key past the target (the
		// cursor read Command Line but ENTER landed on NextBASIC).
		if e.mem.Read(nextMenuCursorAddr) == s.cursorTarget || m.frame > waitCursorCap {
			slog.Debug("macro: waitCursor done", "idx", m.idx, "stepFrames", m.frame, "cursor", e.mem.Read(nextMenuCursorAddr))
			m.releaseAll(e)
			m.idx++
			m.frame = 0
		}
		return false
	}
	if m.frame >= s.frames {
		if len(s.keys) > 0 {
			slog.Debug("macro: key step done", "idx", m.idx, "frames", s.frames)
		}
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
	if _, err := sdcard.WriteFileToImage(e.sdImageSrc, "nextzxos", "autoexec.bas", neutralAutoexec()); err != nil {
		slog.Warn("nex import: could not neutralise autoexec.bas", "err", err)
	}
	// A ROOT-ANCHORED name ("/program.nex") is the IDE contract: compiled
	// programs stage their project assets root-relative (putSDFile), so
	// the program must run from the root — write it there and drive the
	// typed `.nexload` launch, leaving the current directory at the root.
	if strings.HasPrefix(fileName, "/") {
		name := fileName[strings.LastIndex(fileName, "/")+1:]
		sdPath, err := sdcard.WriteFileToImage(e.sdImageSrc, "", name, data)
		if err != nil {
			e.paused.Store(false)
			slog.Error("nex import: copy to SD card failed", "file", fileName, "err", err)
			e.showGUIError(fmt.Errorf("copy %q to SD card: %w", fileName, err))
			return
		}
		slog.Info("nex import: launching via typed .nexload", "sdPath", sdPath)
		e.startNexloadMacro(sdPath)
		return
	}
	relPath := strings.Trim(strings.ReplaceAll(fileName, "\\", "/"), "/")
	i := strings.LastIndex(relPath, "/")
	if i < 0 {
		// A BARE name is a plain .nex opened directly (File->Open, a ?u=
		// .nex link) — not a folder-distributed game, so it gets the fast
		// typed Command Line launch (#184), not the Browser navigation the
		// zip flow needs. Import to one fixed, short 8.3 name at the card
		// ROOT and OVERWRITE it in place — never preserve the source name:
		// a fresh long name would mint a ~N alias (LONEWOLF.NEX ->
		// LONEWO~1.NEX) and the typing macro cannot produce '~' (it typed
		// "lonewo1.nex" and NextZXOS answered "No such file or dir"). The
		// fixed root-level name also keeps the typed `.nexload /zx.nex` as
		// short as possible. A game that needs its own folder/filename
		// (TX-1696 verifies it; Atic Atac F_OPENs its own name) is
		// folder-distributed — deliver it as a zip to take the Browser
		// route below.
		const importedNexName = "zx.nex"
		sdPath, err := sdcard.WriteFileToImage(e.sdImageSrc, "", importedNexName, data)
		if err != nil {
			e.paused.Store(false)
			slog.Error("nex import: copy to SD card failed", "file", fileName, "err", err)
			e.showGUIError(fmt.Errorf("copy %q to SD card: %w", fileName, err))
			return
		}
		// Persist so the imported game survives restarts (race-free while paused).
		if flat, ok := e.sdImageSrc.(*sdcard.ImageSource); ok && e.sdImagePath != "" {
			if err := flat.WriteBackTo(e.sdImagePath); err != nil {
				slog.Warn("nex import: persisting to the SD image failed", "err", err)
			}
		}
		slog.Info("nex import: launching via typed .nexload", "file", fileName, "sdPath", sdPath)
		e.startNexloadMacro(sdPath)
		return
	}
	// A FOLDER-QUALIFIED name is the game flow (a zip unpacked onto the
	// card, or headless ZX_GO_RUN_NEX_FILE): stage the .nex under its
	// ORIGINAL folder and filename — some games verify their location or
	// build data paths from it (TX-1696 exits unless it runs as
	// <its folder>/main.nex; Atic Atac F_OPENs its own filename) — and
	// launch it through the NextZXOS Browser. Overwrite in place so
	// re-imports don't mint ~N aliases.
	gameDir, nexName := relPath[:i], relPath[i+1:]
	sdPath, err := sdcard.WriteFileToImage(e.sdImageSrc, gameDir, nexName, data)
	if err != nil {
		e.paused.Store(false)
		slog.Error("nex import: copy to SD card failed", "file", fileName, "err", err)
		e.showGUIError(fmt.Errorf("copy %q to SD card: %w", fileName, err))
		return
	}
	// Persist so the imported game survives restarts (race-free while paused).
	if flat, ok := e.sdImageSrc.(*sdcard.ImageSource); ok && e.sdImagePath != "" {
		if err := flat.WriteBackTo(e.sdImagePath); err != nil {
			slog.Warn("nex import: persisting to the SD image failed", "err", err)
		}
	}
	// Compute the Browser cursor positions from the card's real sorted
	// listings (the Browser opens at the root, cursor on row 0; a
	// subdirectory opens with the cursor on ".", so its entries start
	// at row 2).
	dirDowns, fileDowns, derr := browserRowsFor(e.sdImageSrc, gameDir, nexName)
	if derr != nil {
		e.paused.Store(false)
		slog.Error("nex import: browser row computation failed", "err", derr)
		e.showGUIError(derr)
		return
	}
	slog.Info("nex import: loading via the NextZXOS Browser",
		"file", fileName, "sdPath", sdPath, "dirDowns", dirDowns, "fileDowns", fileDowns)
	e.startBrowserLaunchMacro(dirDowns, fileDowns, nexLoadableSize(data))
}

// browserRowsFor computes the cursor-DOWN counts the Browser macro needs
// to reach gameDir at the root and nexName inside it, from the card's
// actual listings in Browser sort order.
func browserRowsFor(dev sdcard.Image, gameDir, nexName string) (int, int, error) {
	rootNames, err := sdcard.ListDir(dev, "")
	if err != nil {
		return 0, 0, fmt.Errorf("nex import: list root: %w", err)
	}
	dirDowns := -1
	for i, n := range rootNames {
		if strings.EqualFold(n, gameDir) {
			dirDowns = i
			break
		}
	}
	if dirDowns < 0 {
		return 0, 0, fmt.Errorf("nex import: folder %q not in root listing", gameDir)
	}
	dirNames, err := sdcard.ListDir(dev, gameDir)
	if err != nil {
		return 0, 0, fmt.Errorf("nex import: list %q: %w", gameDir, err)
	}
	fileDowns := -1
	for i, n := range dirNames {
		if strings.EqualFold(n, nexName) {
			fileDowns = 2 + i // after the "." and ".." rows
			break
		}
	}
	if fileDowns < 0 {
		return 0, 0, fmt.Errorf("nex import: %q not in %q listing", nexName, gameDir)
	}
	return dirDowns, fileDowns, nil
}

// importAndRunBas writes data — a PLUS3DOS-headered, autostart-lined NextBASIC
// program — to a fixed short 8.3 name at the card ROOT (/zx.bas) and drives the
// NextZXOS Command Line
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
	if _, err := sdcard.WriteFileToImage(e.sdImageSrc, "nextzxos", "autoexec.bas", neutralAutoexec()); err != nil {
		slog.Warn("bas import: could not neutralise autoexec.bas", "err", err)
	}
	// Root-level, fixed short name (mirrors the .nex import): keeps the typed
	// `load "/zx.bas"` as short as possible so the keystroke macro finishes
	// quicker than the old `/imported/program.bas`.
	if _, err := sdcard.WriteFileToImage(e.sdImageSrc, "", "zx.bas", data); err != nil {
		e.paused.Store(false)
		return fmt.Errorf("write zx.bas: %w", err)
	}
	// Persist so the program survives restarts (no-op on wasm: sdImagePath == "").
	if flat, ok := e.sdImageSrc.(*sdcard.ImageSource); ok && e.sdImagePath != "" {
		if err := flat.WriteBackTo(e.sdImagePath); err != nil {
			slog.Warn("bas import: persisting to the SD image failed", "err", err)
		}
	}
	slog.Info("bas import: LOADing via the NextZXOS command line", "bytes", len(data))
	// Arm the macro before releasing pause (see startNexloadMacro).
	e.reboot()
	e.nexloadMacro = newCommandLineMacro(`load "/zx.bas"`, 100)
	e.paused.Store(false)
	return nil
}

// putSDFile writes data to filePath relative to the SD card root, creating
// intermediate directories and overwriting any existing file of that name —
// the runtime-asset side of importAndRunBas: a NextBASIC program LOADs
// project files (sprite sheets etc.) from the card, so they are staged where
// the program (at root, /zx.bas) resolves the same relative path the source
// spells out, mirroring the layout of the project's download ZIP unzipped
// onto a real card. Path segments that don't fit FAT 8.3 are written as VFAT
// LFN entries (a real card stores them the same way), so NextZXOS's own FS
// code resolves the program's literal path either way. Pauses the emulator
// around the write like the importers.
func (e *emulator) putSDFile(filePath string, data []byte) error {
	if e.sdImageSrc == nil {
		return fmt.Errorf("no SD image mounted")
	}
	segments := strings.Split(filePath, "/")
	for _, seg := range segments[:len(segments)-1] {
		if seg == "" {
			return fmt.Errorf("empty directory segment in %q", filePath)
		}
	}
	dirPath := strings.Join(segments[:len(segments)-1], "/")
	fileName := segments[len(segments)-1]
	e.paused.Store(true)
	defer e.paused.Store(false)
	if _, err := sdcard.WriteFileToImage(e.sdImageSrc, dirPath, fileName, data); err != nil {
		return err
	}
	if flat, ok := e.sdImageSrc.(*sdcard.ImageSource); ok && e.sdImagePath != "" {
		if err := flat.WriteBackTo(e.sdImagePath); err != nil {
			slog.Warn("sd put: persisting to the SD image failed", "file", filePath, "err", err)
		}
	}
	return nil
}

// startNexloadMacro reboots and drives the TYPED `.nexload sdPath` launch
// (see newNexloadMacro) — the route for root-anchored IDE deliveries, bare
// .nex opens (#184), the typed-path tests and the oracle tooling.
func (e *emulator) startNexloadMacro(sdPath string) {
	e.reboot()
	e.nexloadMacro = newNexloadMacro(sdPath)
	e.paused.Store(false)
}

// startBrowserLaunchMacro reboots into a clean NextZXOS and drives the
// Browser to launch the staged .nex (see newBrowserLaunchMacro) — the OS
// runs its own .nexload on it exactly as when a user selects a .nex on
// real hardware. The reboot guarantees a fresh OS state regardless of
// what was running before.
func (e *emulator) startBrowserLaunchMacro(dirDowns, fileDowns, loadBytes int) {
	e.reboot()
	// Arm the macro before releasing pause: the emulation goroutine's
	// run loop checks e.nexloadMacro on every frame it executes, so
	// setting it first avoids a window where an unpaused frame runs
	// with no macro driving it yet.
	e.nexloadMacro = newBrowserLaunchMacro(dirDowns, fileDowns, loadBytes)
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
