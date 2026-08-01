package main

import (
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"log/slog"
	"math/bits"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/driver/desktop"

	"github.com/stever/zxplay_go/pkg/audio"
	"github.com/stever/zxplay_go/pkg/audiodac"
	"github.com/stever/zxplay_go/pkg/betadisk"
	"github.com/stever/zxplay_go/pkg/debugger"
	"github.com/stever/zxplay_go/pkg/keyboard"
	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/multiface"
	"github.com/stever/zxplay_go/pkg/next"
	"github.com/stever/zxplay_go/pkg/next/copper"
	"github.com/stever/zxplay_go/pkg/next/dac"
	"github.com/stever/zxplay_go/pkg/next/esxdos"
	"github.com/stever/zxplay_go/pkg/next/install"
	"github.com/stever/zxplay_go/pkg/next/layer2"
	nextmouse "github.com/stever/zxplay_go/pkg/next/mouse"
	"github.com/stever/zxplay_go/pkg/next/nextregs"
	"github.com/stever/zxplay_go/pkg/next/palette"
	"github.com/stever/zxplay_go/pkg/next/sdcard"
	"github.com/stever/zxplay_go/pkg/next/sprite"
	"github.com/stever/zxplay_go/pkg/next/tilemap"
	"github.com/stever/zxplay_go/pkg/peripherals"
	"github.com/stever/zxplay_go/pkg/roms"
	"github.com/stever/zxplay_go/pkg/rzx"
	"github.com/stever/zxplay_go/pkg/sam"
	"github.com/stever/zxplay_go/pkg/snapshot"
	"github.com/stever/zxplay_go/pkg/ula"
	"github.com/stever/zxplay_go/pkg/z80"
	"github.com/stever/zxplay_go/pkg/zx8x"
)

const (
	// tstatesPerFrame is the 48K ULA frame length. The 128K family and
	// the Next use a longer frame — see frameTStatesForModel, which the
	// ExecuteFrame loops use so the maskable INT cadence is model-correct
	// (timing.md §1a; the Next previously ran the 48K 69888 by mistake).
	tstatesPerFrame = 69888

	// tapeTurboFramesPerTick is how many emulated frames run per 50 Hz tick
	// while fast tape loading is active. ~64× turns a multi-minute real-time
	// tape load into ~10 s of wall-clock without starving the UI thread
	// (the emulation core sustains well over 64 frames per 20 ms tick).
	tapeTurboFramesPerTick = 64

	// tapeAutoPauseFrames is how many consecutive FRAMES the loader can be
	// idle (no tape-rate $FE reads) before the tape is auto-paused so it
	// doesn't advance past content nothing is listening to (boot before the
	// loader starts, the next multi-load part). MUST exceed the 48 ROM's
	// LD-START settle delay — after detecting the first edge the ROM burns a
	// FULL SECOND (50 frames) in a read-free delay loop ($0574 LD-WAIT)
	// before sampling again; pausing inside that window hands the woken
	// loader a dead tape and it restarts from LD-START, a thrash that crawls
	// the load at ~2% (#192). 75 frames = 1.5 s. The window costs nothing:
	// tape time only advances when the guest actually reads port $FE
	// (tapeLevel's lazy catch-up), so a playing-but-unpolled deck loses no
	// content within the window.
	tapeAutoPauseFrames = 75

	// tapeLoadReadThreshold is the per-frame port-$FE read count above which
	// the CPU is considered to be in a tape loader's edge-timing loop (which
	// polls $FE thousands of times per frame) rather than a running game
	// (which reads it only sparsely, for the keyboard). Gates fast-load turbo.
	tapeLoadReadThreshold = 500
)

// frameTStatesForModel returns the ULA frame length in 3.5 MHz T-states
// for a machine model. The table lives on roms.SpectrumModel so pkg/ula's
// audio reconstruction shares the same per-model lengths.
func frameTStatesForModel(model roms.SpectrumModel) int {
	return model.FrameTStates()
}

// frameTStates returns the LIVE per-frame T-state budget for this
// emulator: on the Next the memory's NR$03/NR$05 geometry mirror
// (guest timing retunes — 48K/128K/+3/Pentagon × 50/60 Hz — change the
// frame length, memory.FrameTStates), elsewhere the fixed per-model
// table. Frame loops must read it per frame, which is also what
// applies a retune at the frame BOUNDARY — the FPGA's vsync effective-
// timing latch (zxnext.vhd:6693-6706).
func (e *emulator) frameTStates() int {
	if e.mem != nil {
		return e.mem.FrameTStates()
	}
	return frameTStatesForModel(e.model)
}

type keyState struct {
	key     fyne.KeyName
	pressed bool
}

// JoystickType identifies which joystick interface (if any) is currently
// active. Only one joystick interface can be active at a time.
type JoystickType int

const (
	JoystickNone      JoystickType = iota
	JoystickKempston               // Hardware port 0x1F (handled by ULA)
	JoystickSinclair1              // Sinclair Interface 2 joystick 1 (keys 6..0; Next NR$05 mode 011)
	JoystickSinclair2              // Sinclair Interface 2 joystick 2 (keys 1..5; Next NR$05 mode 000)
	JoystickCursor                 // Protek/Cursor joystick (keys 5/6/7/8/0)
)

type emulator struct {
	cpu *z80.CPU
	mem *memory.Memory

	// zx8x is non-nil only for the Sinclair ZX80/ZX81, whose CPU-generated
	// display has no ULA. When set, the render loop reads zx8x.Image() and the
	// ula/peripherals fields are nil.
	zx8x *zx8x.Machine

	// sam is non-nil only for the SAM Coupé, which has its own memory map,
	// I/O/ASIC, keyboard and sound (pkg/sam). When set, the run loop calls
	// sam.RunFrame(), the render loop reads sam.Render(), keys route to sam.Kbd,
	// and the ula/mem/kbd fields hold inert stand-ins (the SAM uses its own).
	sam *sam.Machine

	// samAudio plays the SAM Coupé's SAA1099 output. Created (GUI only, unless
	// --no-sound) when the SAM machine is built; the run loop pushes a mono
	// downmix each frame. nil for every other machine and in headless mode.
	samAudio    *audio.AudioSystem
	samAudioBuf []int16 // reused per-frame mono buffer for samAudio

	// speccyDAC is the classic-Spectrum SpecDrum/Covox 8-bit DAC (non-nil on
	// 48K/128K/+2/+2A/+3; nil on Next/ZX8x). Toggled from the Peripherals menu.
	speccyDAC *audiodac.DAC

	// betaDisk is the Beta Disk / TR-DOS interface, created lazily the first
	// time a .TRD is mounted (classic models only). nil until then.
	betaDisk *betadisk.Interface

	// fastTape, when set, runs the emulation at many frames per tick while a
	// tape is actively loading, so a multi-minute real-time tape load (custom
	// turbo loaders go through the edge-timed ROM/loader loop, which can't be
	// trap-accelerated) finishes in seconds. Toggled from the Tape menu.
	fastTape atomic.Bool

	// tapeReadActive tracks whether the previous tick saw a tape-loader-like
	// rate of port-$FE reads. Turbo only engages while this holds, so once a
	// game stops loading and starts running (e.g. its menu), turbo disengages
	// and the game runs at normal speed with audio — even if the tape still
	// has blocks queued for a later multi-load stage.
	tapeReadActive bool
	tapeIdleTicks  int // consecutive frames the loader has been idle (auto-pause)
	// lastTapeFEReads snapshots the ULA's port-$FE read counter at the end of
	// each frame, so tapeFrameHook can compute the per-frame read delta.
	lastTapeFEReads uint64

	// sdImageSrc is the live card backing store the import/staging
	// paths write through (.nex/.bas import, zxPutFile): a flat
	// ImageSource on desktop or a SparseSource in the browser. nil
	// when no writable card image is mounted (folder mode without an
	// image, classic machines). sdImagePath is the opt-in write-back
	// path (--sd-writeback, flat images only).
	sdImageSrc  sdImageStore
	sdImagePath string
	// sdCard is the live SPI card (when one is mounted); the .nex launch
	// macro reads its DataBlocksRead counter to meter load progress.
	sdCard      *sdcard.Card
	ula         *ula.ULA
	kbd         *keyboard.Keyboard
	peripherals *peripherals.PeripheralManager

	// nextMouse is the Next's Kempston mouse ($FADF/$FBDF/$FFDF) when
	// the current core is a Next — desktop mouse input feeds it in
	// parallel with the classic peripheral-manager mouse.
	nextMouse *nextmouse.Mouse
	// model is the machine this emulator was built for. Used to pick the
	// ULA frame length (frameTStatesForModel) so the maskable INT cadence
	// is model-correct in the GUI render loop too (timing.md §1a).
	model roms.SpectrumModel

	paused atomic.Bool
	ticker *time.Ticker

	// Track physical key states to prevent OS repeat issues
	physicalKeys map[fyne.KeyName]bool
	keyMutex     sync.Mutex

	// Frame counter
	frameCounter int32

	// FPS overlay (View → Show FPS, desktop GUI only). fpsFrames counts
	// EXECUTED frames per wall second — during fast-tape turbo that is
	// several per tick, so the readout doubles as a turbo indicator.
	// fpsText is the bottom-right canvas label, set up in desktopMain;
	// nil in headless/wasm where the run loop never touches it.
	fpsShow   atomic.Bool
	fpsFrames atomic.Int64
	fpsText   *canvas.Text

	// Window reference for fullscreen toggle
	window fyne.Window

	// Separate goroutine for processing keys
	keyQueue chan keyState
	stopChan chan struct{}

	// CRT scanline filter toggle. When true, the rendered image is upscaled
	// 2x and every other row is darkened to mimic a CRT.
	crtFilter atomic.Bool

	// CRT post-process destination. When the filter is enabled the render
	// goroutine writes the upscaled image here and points screen.Image at
	// it. Sized lazily on first use; reused across frames.
	crtScratch *image.RGBA

	// Currently active joystick interface. Mutated only from the UI thread.
	joystickType JoystickType

	// Last host joystick vector applied by SetJoystickState (12-bit
	// i_JOY layout). Held so a poll-based host input source can hand us
	// whole snapshots and we dispatch only the edges. UI thread only.
	joyState uint16

	// Diagnostic accumulators over every vector SetJoystickState has
	// applied: the OR of all bits ever seen, and how many non-idle
	// vectors arrived. Live state cannot answer "did input reach the
	// machine?" after the user lets go.
	joyBitsSeen     uint16
	joyNonZeroCount uint64

	// RZX session state. At most one of rzxPlayback / rzxRecord is
	// non-nil at any given time (FUSE rzx.c:164,278). Atomic so the
	// per-frame read in the emulation goroutine doesn't need a lock,
	// and so menu-thread Set calls don't race the per-IN ULA hook.
	// rzxRecordFilename is only touched from the UI thread (set on
	// Start, read on Stop), so it doesn't need atomic protection.
	rzxPlayback       atomic.Pointer[rzx.Playback]
	rzxRecord         atomic.Pointer[rzx.Recording]
	rzxRecordFilename string

	// Spectrum Next subsystem refs. Non-nil only on ModelNext.
	// nextEsxdos is the RST 8 dispatcher (used to attach an SD
	// mount); nextDAC is the four-channel DAC bank (used to
	// verify mixing). nextRegs is the NextReg file (used by the
	// debugger for read-back). All owned by the Next bus
	// constructed in newNextEmulator.
	nextEsxdos  *esxdos.Dispatcher
	nextDAC     *dac.Bank
	nextRegs    *nextregs.Dispatcher
	nextPalette *palette.Bank
	nextTilemap *tilemap.Tilemap
	nextCopper  *copper.Copper
	// nextNMIPacer is the copper NR$02 NMI pacer (nil when the
	// bisection switch ZX_GO_NO_COPPER_NMI_PACER disables it).
	// Exposed for probe instrumentation (#187).
	nextNMIPacer *copperNMIPacer
	nextSprites  *sprite.Engine
	nextLayer2   *layer2.Layer2

	// nexloadMacro, when non-nil, drives the NextZXOS .nexload dot
	// command from the run loop to load a .nex via the genuine OS
	// loader (File -> Open). It is advanced once per executed frame and
	// cleared when finished.
	nexloadMacro *nexloadMacro

	// Boot fast-forward tracking (ModelNext; see fastboot.go). bootFrames
	// counts frames since power-on/reset (saturating at the cap) and
	// bootMenuSeen latches once the CPU reaches the NextZXOS welcome/menu
	// key-wait loop — the "boot finished" signal. Updated by noteBootFrame,
	// reset by reboot().
	bootFrames   int
	bootMenuSeen bool

	// cpuSpeedForce is the user-facing "CPU Speed" override (ModelNext):
	// 0 = Auto (follow the guest's NextReg $07), 1..4 = force 3.5/7/14/28 MHz.
	// The zero value is Auto so no constructor init is needed. NextZXOS runs
	// at 28 MHz by default, which makes some games (e.g. RustHawk) run too
	// fast; forcing 3.5 MHz is the emulator equivalent of the Next's menu
	// speed selector / F8 hotkey. Applied each frame via applyForcedCPUSpeed.
	cpuSpeedForce int

	// debugHistory is the shared M1-fetch ring populated by the
	// CPU pre-fetch hook. Both the telnet `history` / `prev`
	// commands and the visual debugger's History tab read from it.
	// nil until the first surface that needs it (telnet via
	// --debugger-history, or the visual debugger menu) creates it.
	debugHistory *debugger.History

	// debugBreakpoints is the SINGLE shared breakpoint store used by
	// both the telnet and visual debuggers, so a breakpoint set from
	// one surface is visible and active in the other. Lazily created
	// by whichever debugger initialises first (see sharedBreakpoints).
	debugBreakpoints *debugger.BreakpointSet

	// debugRegWatches is the SINGLE shared register-watchpoint set,
	// likewise shared between the telnet and visual debuggers.
	debugRegWatches *debugger.RegWatchSet

	// timeTravel is the rolling snapshot ring, owned by the emulator
	// so BOTH the telnet `tt-*` commands and the visual debugger's
	// Time-Travel tab drive the same buffer. nil when disabled.
	timeTravel *timeTravelBuffer

	// rdbg is the optional ZRCP-style telnet debugger. Constructed
	// in main when --debugger-port>0; nil otherwise. WaitIfPaused
	// is safe on a nil receiver, so the GUI loop can call it
	// unconditionally.
	rdbg *remoteDebugger
}

// sharedBreakpoints returns the emulator's single shared breakpoint
// store, creating it on first use. Both the telnet debugger and the
// visual debugger call this so they operate on the same set.
func (e *emulator) sharedBreakpoints() *debugger.BreakpointSet {
	if e.debugBreakpoints == nil {
		e.debugBreakpoints = debugger.NewBreakpointSet()
	}
	return e.debugBreakpoints
}

// sharedRegWatches returns the emulator's single shared
// register-watchpoint set (telnet `watch-reg` + the GUI Watchpoints
// tab operate on the same instance).
func (e *emulator) sharedRegWatches() *debugger.RegWatchSet {
	if e.debugRegWatches == nil {
		e.debugRegWatches = debugger.NewRegWatchSet()
	}
	return e.debugRegWatches
}

// joystickKeySymbols returns the Spectrum keys (as fyne.KeyName values that
// the emulator's keyboard package recognises) corresponding to up/down/left/
// right/fire for the active joystick. Returns nil if the joystick type
// uses something other than the keyboard matrix (e.g. Kempston).
func joystickKeySymbols(t JoystickType) [5]fyne.KeyName {
	switch t {
	case JoystickSinclair1:
		// Sinclair/Interface 2 joystick 1: 6=left 7=right 8=down 9=up
		// 0=fire — the layout games' "Sinclair" option reads, and the
		// Next's NR$05 mode 011 (nextreg.txt; keyjoy_64_6.coe entries
		// 0-4). These were swapped with Sinclair 2 until #202 — the
		// same swap the FPGA itself once shipped ("Sinclair 1 and
		// Sinclair 2 joystick types were reversed in the hardware",
		// core changelog 3.01.01).
		return [5]fyne.KeyName{fyne.Key9, fyne.Key8, fyne.Key6, fyne.Key7, fyne.Key0}
	case JoystickSinclair2:
		// Sinclair/Interface 2 joystick 2: 1=left 2=right 3=down 4=up
		// 5=fire — Next NR$05 mode 000.
		return [5]fyne.KeyName{fyne.Key4, fyne.Key3, fyne.Key1, fyne.Key2, fyne.Key5}
	case JoystickCursor:
		// Cursor joystick: 5=left 6=down 7=up 8=right 0=fire
		// Index order: up, down, left, right, fire
		return [5]fyne.KeyName{fyne.Key7, fyne.Key6, fyne.Key5, fyne.Key8, fyne.Key0}
	}
	return [5]fyne.KeyName{}
}

// joystickKeyForArrow maps a physical arrow / fire key to one of the five
// joystick directions. Returns -1 if the key is not a joystick input.
// Index order matches joystickKeySymbols: 0=up, 1=down, 2=left, 3=right, 4=fire.
func joystickKeyForArrow(name fyne.KeyName) int {
	switch name {
	case fyne.KeyUp:
		return 0
	case fyne.KeyDown:
		return 1
	case fyne.KeyLeft:
		return 2
	case fyne.KeyRight:
		return 3
	case desktop.KeyAltRight, desktop.KeyControlRight:
		return 4
	}
	return -1
}

// applyCRTFilterInto writes a 2x upscaled CRT version of src into dst:
// each input pixel becomes a 2x2 block where the bottom row is halved in
// brightness. dst must have the right dimensions; callers reuse it across
// frames to avoid per-frame allocations.
func applyCRTFilterInto(dst, src *image.RGBA) {
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	for y := 0; y < h; y++ {
		srcRow := src.Pix[y*src.Stride : y*src.Stride+w*4]
		topRow := dst.Pix[(y*2)*dst.Stride : (y*2)*dst.Stride+w*8]
		botRow := dst.Pix[(y*2+1)*dst.Stride : (y*2+1)*dst.Stride+w*8]
		for x := 0; x < w; x++ {
			r := srcRow[x*4]
			g := srcRow[x*4+1]
			b := srcRow[x*4+2]
			a := srcRow[x*4+3]
			topRow[x*8+0] = r
			topRow[x*8+1] = g
			topRow[x*8+2] = b
			topRow[x*8+3] = a
			topRow[x*8+4] = r
			topRow[x*8+5] = g
			topRow[x*8+6] = b
			topRow[x*8+7] = a
			r2, g2, b2 := r/2, g/2, b/2
			botRow[x*8+0] = r2
			botRow[x*8+1] = g2
			botRow[x*8+2] = b2
			botRow[x*8+3] = a
			botRow[x*8+4] = r2
			botRow[x*8+5] = g2
			botRow[x*8+6] = b2
			botRow[x*8+7] = a
		}
	}
}

// userKeymapPath returns the absolute path to the user's keymap override
// file under the platform-appropriate config dir: keymap.json inside
// `<os.UserConfigDir>/zxplay_go/` (= `%AppData%\zxplay_go\keymap.json` on
// Windows, `~/Library/Application Support/zxplay_go/keymap.json` on macOS,
// `$XDG_CONFIG_HOME/zxplay_go/keymap.json` or `~/.config/zxplay_go/keymap.json`
// on Linux). Matches the convention used by `pkg/config/config.go::Path()`
// for `config.json`. Does not create the file or directory; the caller
// decides whether missing files matter.
func userKeymapPath() string {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(cfg, "zxplay_go", "keymap.json")
}

// configureClassicIntTiming sets the maskable frame interrupt to the
// hardware-faithful narrow pulse for 128K-family models, replacing the legacy
// "held for the whole frame" model. The held model re-fires the INT as soon as
// interrupts are re-enabled, so when a game's ISR (or a DI section) spans the
// frame boundary, it takes an interrupt that real hardware MISSES — drifting
// timing-sensitive code (the cause of garbled sprites in Ghouls 'n' Ghosts).
// Pulse/assert values come from next.FrameIntTiming, already validated against
// a reference emulator. The 48K uses the same narrow pulse (32 T-states at
// tstate 58) — required for the level-triggered /INT behaviours the external
// int_skip conformance test pins down. The Next gets the same
// narrow pulse (it boots in +3/128K timing, NR$03 "011") — this is what the
// Machine-menu switch path relies on, since otherwise the Next inherits the
// previous model's INT mode (e.g. 48K held), re-firing the frame INT across
// DI'd ISR boundaries and garbling software sprites in 128K personality.
// Opt out for A/B with ZX_GO_NO_INT_TIMING.
func configureClassicIntTiming(cpu *z80.CPU, model roms.SpectrumModel) {
	if cpu == nil {
		return
	}
	assert, pulse, ok := next.FrameIntTimingForModel(model, false)
	if !ok || os.Getenv("ZX_GO_NO_INT_TIMING") != "" {
		// Machines that drive their own interrupt (ZX80/81, SAM), or
		// an explicit opt-out for A/B comparison.
		cpu.IntAssertTstate, cpu.IntPulseTstates = 0, 0
		return
	}
	cpu.IntAssertTstate = uint64(assert)
	cpu.IntPulseTstates = uint64(pulse)
}

func newEmulator(model roms.SpectrumModel) (*emulator, error) {
	if model == roms.ModelNext {
		return newNextEmulator()
	}
	if isZX8x(model) {
		return newZX8xEmulator(model)
	}
	if model == roms.ModelSAM {
		e, err := newSamEmulator()
		if err != nil {
			return nil, err
		}
		// Enable SAA1099 audio (GUI path only; runSAMHeadless calls
		// newSamEmulator directly and stays silent). --no-sound opts out.
		if cliFlagsActive == nil || !cliFlagsActive.noSound {
			if as, aerr := audio.New(); aerr != nil {
				slog.Warn("sam: audio init failed", "err", aerr)
			} else if serr := as.Start(); serr != nil {
				slog.Warn("sam: audio start failed", "err", serr)
				_ = as.Close()
			} else {
				e.samAudio = as
			}
		}
		return e, nil
	}
	kbd := keyboard.New()
	if path := userKeymapPath(); path != "" {
		if err := kbd.LoadOverrides(path); err != nil {
			slog.Warn("failed to load custom keymap", "err", err)
		}
	}
	mem, err := memory.New("roms", model)
	if err != nil {
		return nil, err
	}
	ula := ula.New(mem, kbd)
	// A Kempston interface is fitted from power-on, so port $1F answers
	// consistently from the guest's very first read.
	//
	// This MUST be decided before the guest runs, not once a game has been
	// seen using the port. Games detect a Kempston by polling $1F in a
	// tight loop and judging whether it reads consistently or as floating
	// garbage — Manic Miner does exactly 256 reads at startup. Attaching
	// the interface partway through that loop answers "absent, absent,
	// absent, present", which such a routine reads as absent, and it then
	// stops polling for good. A consistent answer from read zero is the
	// only one a detection routine can act on.
	//
	// Safe because the decode is A7..A5 low with A4..A0 high; the
	// conventional floating-bus port is $FF, whose A7..A5 are high, so
	// programs sampling the bus do not land here. An unfitted stick and a
	// fitted-but-idle one both read $00, so this is an honest model of a
	// machine with the interface installed and nothing pressed.
	ula.KempstonEnabled = true
	cpu := z80.New(mem, ula)
	// Per-access ULA memory contention. Without it the CPU never pays the
	// hold on $4000-$7FFF during the display window, so a 48K machine
	// executes materially more work per frame than the hardware does and
	// loop-timed games run fast (#189: Manic Miner noticeably, Arkanoid
	// very pronounced). The memory side already models the delay and
	// gates it correctly (contentionDisabled on Pentagon, zero above
	// 3.5 MHz); this switch lets the CPU's access path consult it.
	// ZX_GO_NO_MEM_CONTEND=1 restores the old uncontended model, for
	// bisecting a timing regression against pre-#189 behaviour.
	cpu.MemContend = os.Getenv("ZX_GO_NO_MEM_CONTEND") != "1"
	// Beam-time paper capture: the renderer shows what the ULA fetched
	// as the beam passed each line, not end-of-frame memory — required
	// for beam-racers that erase sprites during the vblank (#194,
	// Arkanoid's bat). The hook self-disables on ModelNext.
	cpu.ScanlineFunc = ula.CaptureScanlines
	configureClassicIntTiming(cpu, model)
	// Tape timing rides the CPU's MONOTONIC reference clock, not the raw
	// counter (which ExecuteFrame wraps to frame-relative every frame — the
	// wrap silently dropped the tape time between frames for sparse-polling
	// loaders, #192). The Next wires mem.RefTstates and needs no hook.
	ula.SetTapeRefClock(cpu.RefTstates)

	// Classic-Spectrum SpecDrum/Covox DAC (both off until enabled from the
	// Peripherals menu). Event-timed and mixed into the beeper by the ULA.
	speccyDAC := audiodac.New()
	ula.SetSpeccyDAC(speccyDAC)

	// Initialize audio unless --no-sound was passed
	if cliFlagsActive == nil || !cliFlagsActive.noSound {
		ula.EnableAudio()
		configureAudioExtras(ula)
	} else {
		slog.Info("--no-sound: audio disabled")
	}

	// Create peripheral manager and wire it to ULA and memory
	pm := peripherals.NewPeripheralManager(mem, "roms")
	ula.SetPeripherals(pm)
	mem.PeripheralRead = pm.HandleMemoryRead
	mem.PeripheralWrite = pm.HandleMemoryWrite
	// Fast-path enablement (#187): the manager's peripherals only
	// intercept the bottom 16K, and enable/disable/insert transitions
	// invalidate the memory's bottom fast path.
	mem.SetPeripheralWriteBottomOnly(true)
	mem.SetBottomOverlayProbe(pm.BottomOverlayPossible)

	// NMI: keyboard goroutine sets a flag, CPU processes it on the emulator
	// goroutine. The NMICallback pages in the Multiface ROM at the exact
	// moment the NMI fires (not before, which would corrupt execution).
	kbd.SetNMICallback(func() {
		if pm.IsMultifaceEnabled() {
			cpu.PendingNMI.Store(true)
		}
	})
	cpu.NMICallback = func() {
		if pm.IsMultifaceEnabled() {
			pm.HandleNMI() // Pages in Multiface ROM
		}
	}

	e := &emulator{
		cpu:          cpu,
		mem:          mem,
		ula:          ula,
		kbd:          kbd,
		peripherals:  pm,
		speccyDAC:    speccyDAC,
		model:        model,
		physicalKeys: make(map[fyne.KeyName]bool),
		keyQueue:     make(chan keyState, 10),
		stopChan:     make(chan struct{}),
	}
	e.paused.Store(true)
	e.fastTape.Store(true) // accelerate tape loading by default
	return e, nil
}

// configureAudioExtras applies post-EnableAudio CLI options: the keep-alive
// dither level override and startup WAV capture.
func configureAudioExtras(u *ula.ULA) {
	if cliFlagsActive != nil && cliFlagsActive.audioKeepAlive >= 0 {
		u.SetAudioKeepAliveLevel(int16(cliFlagsActive.audioKeepAlive))
	}
	if cliFlagsActive != nil {
		u.SetDCBlockEnabled(cliFlagsActive.audioDCBlock)
	}
	maybeStartAudioRecording(u)
}

// maybeStartAudioRecording begins WAV capture at startup when
// --record-audio <path> was supplied. The captured file is the exact
// mixed mono stream we hand to the audio device, so it's ground truth for
// diagnosing clicks/pops that only manifest live.
func maybeStartAudioRecording(u *ula.ULA) {
	if cliFlagsActive == nil || cliFlagsActive.recordAudio == "" {
		return
	}
	if err := u.StartRecording(cliFlagsActive.recordAudio); err != nil {
		slog.Error("--record-audio: failed to start recording", "path", cliFlagsActive.recordAudio, "err", err)
		return
	}
	slog.Info("--record-audio: capturing mixed audio output", "path", cliFlagsActive.recordAudio)
}

// tapeLoadingActive reports whether a tape is mid-load (playing with blocks
// still to load) — the window in which fast-tape turbo applies.
func (e *emulator) tapeLoadingActive() bool {
	if e.ula == nil {
		return false
	}
	tp := e.ula.GetTapePlayer()
	return tp != nil && tp.IsPlaying() && tp.HasMoreBlocks()
}

// tapeAudioMuted reports whether beeper audio should be muted because a
// fast-tape load is in progress. Crucially this is decoupled from the per-tick
// turbo burst: muting spans the WHOLE load — including the brief inter-block
// gaps where the loader isn't reading edges this tick — so the output doesn't
// blip on/off at every block boundary (the "stuttering noise" during a
// multi-block load). When fast-tape is disabled the tape loads at 1x with its
// authentic loading sound, so nothing is muted. Once the loader goes idle and
// the tape auto-pauses, this returns false and the game's music plays.
func (e *emulator) tapeAudioMuted() bool {
	return e.fastTape.Load() && e.tapeLoadingActive()
}

// tapeFrameHook is the per-frame tape bookkeeping shared by EVERY frame loop
// (desktop tick, wasm zxFrame, headless). Call it once after each executed
// frame. It computes that frame's port-$FE read delta, updates the
// loader-activity signal (tapeReadActive — gates fast-tape turbo), and drives
// the loader-activity auto-pause: while the running program is not reading
// tape edges (boot, a multi-load game's menu, inter-block processing) the deck
// is paused so it doesn't advance past content nothing is listening to, then
// resumed the instant a loader starts polling again. Pause/resume is lossless
// (Resume continues from the exact pulse position), which is what makes the
// aggressive pause safe. This became load-bearing for ALL paths once the tape
// clock was made monotonic (#192): previously the frame-wrap clock bug meant
// an unpolled tape barely advanced — an accidental auto-pause that fix
// removed, so the real one must run everywhere. ZX_GO_NO_TAPE_AUTOPAUSE=1
// disables the auto-pause (diagnostic).
// Returns whether the frame saw loader-heavy reads.
func (e *emulator) tapeFrameHook() bool {
	if e.ula == nil {
		return false
	}
	reads := e.ula.FEReadCount()
	delta := reads - e.lastTapeFEReads
	e.lastTapeFEReads = reads
	heavy := delta > tapeLoadReadThreshold
	e.tapeReadActive = heavy
	if os.Getenv("ZX_GO_NO_TAPE_AUTOPAUSE") != "" {
		return heavy
	}
	tp := e.ula.GetTapePlayer()
	if tp == nil || !tp.HasMoreBlocks() {
		return heavy
	}
	if heavy {
		e.tapeIdleTicks = 0
		if !tp.IsPlaying() {
			tp.Resume()
		}
	} else if tp.IsPlaying() {
		e.tapeIdleTicks++
		if e.tapeIdleTicks > tapeAutoPauseFrames {
			tp.Stop()
		}
	}
	return heavy
}

// tapeTurboActive reports whether fast-tape turbo should be compressing time
// RIGHT NOW: fast-tape on and the deck mid-load (playing with blocks left).
// The gate is the deck state, NOT the $FE read rate — with the LD-EDGE trap a
// load's read-free stretches (the ROM's 1 s LD-START settle, decrunch phases)
// are still part of one continuous load, and gating on reads parked the
// turbo at 1x through all of them. The loader-activity auto-pause (which
// stays read-driven) bounds the window: a program that truly stops loading
// has its deck parked within 1.5 s of emulated time, ending the turbo.
func (e *emulator) tapeTurboActive() bool {
	return e.fastTape.Load() && e.tapeLoadingActive()
}

// tapeTurboFrames returns how many emulated frames the CURRENT 50 Hz display
// tick should run: tapeTurboFramesPerTick while a fast-tape load is in
// progress, 1 otherwise. Also applies the whole-load audio mute (see
// tapeAudioMuted). Shared by the desktop tick and the wasm zxFrame path
// (which upgrades the fixed burst to a wall-clock budget).
func (e *emulator) tapeTurboFrames() int {
	if e.ula != nil {
		e.ula.SetFastLoad(e.tapeAudioMuted())
	}
	if e.tapeTurboActive() {
		return tapeTurboFramesPerTick
	}
	return 1
}

func (e *emulator) startKeyProcessor() {
	// Separate goroutine to process keyboard events
	// This prevents any blocking of the UI thread
	go func() {
		for {
			select {
			case ks := <-e.keyQueue:
				// Process the key state change
				if e.sam != nil {
					e.samSetKey(ks.key, ks.pressed)
				} else {
					e.kbd.HandleKeyWithModifiers(ks.key, ks.pressed, false, false, false, false)
				}
			case <-e.stopChan:
				return
			}
		}
	}()
}

func (e *emulator) handleKeyDown(ev *fyne.KeyEvent) {
	// Escape exits fullscreen
	if ev.Name == fyne.KeyEscape && e.window != nil && e.window.FullScreen() {
		e.window.SetFullScreen(false)
		return
	}

	// Quick save (F2) / quick load (F4) state slot.
	switch ev.Name {
	case fyne.KeyF2:
		if err := e.quickSaveState(); err != nil {
			slog.Warn("quick-save failed", "err", err)
		} else {
			slog.Info("quick-saved state", "path", quickSavePath())
		}
		return
	case fyne.KeyF4:
		if err := e.quickLoadState(); err != nil {
			slog.Warn("quick-load failed", "err", err)
		} else {
			slog.Info("quick-loaded state")
		}
		return
	}

	e.keyMutex.Lock()

	// Check if this is a repeat event from the OS
	if e.physicalKeys[ev.Name] {
		e.keyMutex.Unlock()
		return // Ignore repeat
	}
	e.physicalKeys[ev.Name] = true
	e.keyMutex.Unlock()

	// Joystick interception. The arrow keys / right modifiers are routed to
	// whichever joystick interface is currently active and are NOT
	// forwarded to the keyboard matrix in the usual way.
	if e.effectiveJoystick() != JoystickNone {
		idx := joystickKeyForArrow(ev.Name)
		if idx >= 0 {
			e.dispatchJoystick(idx, true)
			return
		}
	}

	// Queue the key event (non-blocking)
	select {
	case e.keyQueue <- keyState{key: ev.Name, pressed: true}:
	default:
		// If queue is full, drop the event (shouldn't happen with normal typing)
	}
}

// effectiveJoystickFor resolves the joystick scheme that should handle arrow
// keys and pad input for a given configured choice and machine model.
//
// An unconfigured (None) joystick falls back to Kempston on EVERY model.
// The Next FPGA always decodes port $1F and nearly all Next software reads
// it; classic machines are given the interface at construction for the same
// reason (see newEmulator), so the fallback is equally true there. Without
// it a fresh user's arrows and gamepad drive nothing at all, and the most
// common interface on the most common games is the one they cannot reach.
//
// Any explicit choice is preserved, including an explicit None — only the
// default means "decide for me".
func effectiveJoystickFor(configured JoystickType, model roms.SpectrumModel) JoystickType {
	if configured == JoystickNone {
		return JoystickKempston
	}
	return configured
}

// effectiveJoystick is effectiveJoystickFor applied to the live model,
func (e *emulator) effectiveJoystick() JoystickType {
	model := roms.Model48K
	if e.mem != nil {
		model = e.mem.GetCurrentModel()
	}
	return effectiveJoystickFor(e.joystickType, model)
}

// applyForcedCPUSpeed enforces the user's "CPU Speed" override (cpuSpeedForce)
// on the live CPU. Called once per executed frame:
//   - Auto (0), no CPU, or a .nex still loading (macro active) -> release any
//     lock so NextZXOS boots/loads at its own (28 MHz) speed and guest NR$07
//     writes apply normally;
//   - otherwise pin the CPU to the chosen speed (1..4 -> selector 0..3), so a
//     game NextZXOS would run too fast at 28 MHz can be played at 3.5 MHz.
//
// Idempotent, so it survives the reboot that File -> Open performs.
func (e *emulator) applyForcedCPUSpeed() {
	if e.cpu == nil {
		return
	}
	if e.cpuSpeedForce <= 0 || e.nexloadMacro != nil {
		e.cpu.UnlockSpeedSelect()
		return
	}
	e.cpu.LockSpeedSelect(byte(e.cpuSpeedForce - 1))
}

// cpuSpeedMenuItem builds the Machine -> "CPU Speed" submenu. NextZXOS runs the
// Next at 28 MHz by default, which makes some games (e.g. RustHawk) run far too
// fast; these options pin the CPU speed — the emulator equivalent of the Next's
// on-screen menu speed selector (left/right arrows) and F8 speed hotkey. "Auto"
// follows whatever the guest/OS selects (NextReg $07). The choice is applied
// once per frame by applyForcedCPUSpeed and survives the File->Open reboot.
func cpuSpeedMenuItem(emu *emulator) *fyne.MenuItem {
	set := func(force int) func() {
		return func() { emu.cpuSpeedForce = force }
	}
	parent := fyne.NewMenuItem("CPU Speed (Next)", nil)
	parent.ChildMenu = fyne.NewMenu("",
		fyne.NewMenuItem("Auto (follow game/OS)", set(0)),
		fyne.NewMenuItem("3.5 MHz", set(1)),
		fyne.NewMenuItem("7 MHz", set(2)),
		fyne.NewMenuItem("14 MHz", set(3)),
		fyne.NewMenuItem("28 MHz", set(4)),
	)
	return parent
}

// dispatchJoystick translates a joystick direction (0=up..4=fire) into the
// appropriate hardware action for the active joystick interface. For
// Kempston this sets/clears a port bit; for Sinclair/Cursor it injects a
// Spectrum key press into the keyboard matrix.
//
// On the Next every scheme rides the pad VECTOR instead: the ULA's
// KempstonState bits ARE i_JOY(4:0), and NR$05 routing decides whether
// the FPGA model presents them on ports $1F/$37 or as membrane
// keypresses (Sinclair/Cursor/User — pkg/ula joymembrane.go), exactly
// like hardware. Frontend key injection would double up on that (and
// bypass the guest-visible NR$05 state), so it is classic-models-only;
// setJoystickType expresses the Next selection as an NR$05 write.
func (e *emulator) dispatchJoystick(direction int, pressed bool) {
	scheme := e.effectiveJoystick()
	if e.mem != nil && e.mem.GetCurrentModel() == roms.ModelNext {
		scheme = JoystickKempston
	}
	switch scheme {
	case JoystickKempston:
		var mask byte
		switch direction {
		case 0:
			mask = ula.KempstonUp
		case 1:
			mask = ula.KempstonDown
		case 2:
			mask = ula.KempstonLeft
		case 3:
			mask = ula.KempstonRight
		case 4:
			mask = ula.KempstonFire
		}
		if mask != 0 && e.ula != nil {
			e.ula.SetKempstonButton(mask, pressed)
		}
	case JoystickSinclair1, JoystickSinclair2, JoystickCursor:
		keys := joystickKeySymbols(scheme)
		key := keys[direction]
		if key == "" {
			return
		}
		e.kbd.HandleKeyWithModifiers(key, pressed, false, false, false, false)
	}
}

// handleTypedRune injects a typed symbol character (e.g. '.', ';', ':') into
// the Spectrum keyboard as a layout-independent SYMBOL-SHIFT combination — so
// symbols type correctly whatever the host keyboard layout (a French AZERTY
// full stop is Shift+';'-key, which the physical key path can't express).
// Letters/digits are ignored here (TypeRune returns false) and keep coming from
// the physical key path so games can hold them. The ZX80/81 use a different
// keyword keyboard, so this is Spectrum/Next-only.
func (e *emulator) handleTypedRune(r rune) {
	if e.paused.Load() {
		return
	}
	// The SAM has its own keyboard with its own symbol layout.
	if e.sam != nil {
		e.sam.Kbd.TypeRune(r)
		return
	}
	if e.kbd == nil || e.zx8x != nil {
		return
	}
	e.kbd.TypeRune(r)
}

func (e *emulator) handleKeyUp(ev *fyne.KeyEvent) {
	e.keyMutex.Lock()
	wasPressed := e.physicalKeys[ev.Name]
	delete(e.physicalKeys, ev.Name)
	e.keyMutex.Unlock()

	// Joystick interception (release). Always release the direction — even if
	// the matching key-down was never recorded (a dropped event, or the
	// key-down arrived while physicalKeys had been cleared). Releasing a
	// direction that isn't held is harmless, and skipping it is exactly what
	// left the Kempston "right" bit stuck (Sonic kept running rightward).
	if e.effectiveJoystick() != JoystickNone {
		idx := joystickKeyForArrow(ev.Name)
		if idx >= 0 {
			e.dispatchJoystick(idx, false)
			return
		}
	}

	// For ordinary matrix keys, only queue a release if we recorded the press
	// (avoids spurious releases for keys we never saw go down).
	if !wasPressed {
		return
	}

	// Queue the key event (non-blocking)
	select {
	case e.keyQueue <- keyState{key: ev.Name, pressed: false}:
	default:
		// If queue is full, drop the event
	}
}

// releaseAllInput lifts every held key and joystick direction. The OS stops
// delivering key-up events when the surface loses focus (or on reboot), so
// anything held would otherwise stick on — e.g. a held Kempston "right" left
// Sonic running rightward after focus returned. Clears the host-key tracking,
// the pending key queue, the Kempston joystick bits, and the keyboard matrix.
func (e *emulator) releaseAllInput() {
	e.keyMutex.Lock()
	e.physicalKeys = make(map[fyne.KeyName]bool)
	e.keyMutex.Unlock()
	for len(e.keyQueue) > 0 {
		<-e.keyQueue
	}
	e.clearJoystickState()
	if e.kbd != nil {
		e.kbd.ReleaseAll()
	}
}

func (e *emulator) reboot() {
	slog.Info("rebooting emulator")
	if e.zx8x != nil {
		e.zx8x.Reset()
		return
	}
	if e.sam != nil {
		e.sam.Reset()
		return
	}
	e.resetBootProgress()
	e.cpu.Reset()
	e.ula.Reset()

	// On ModelNext, drop the NextReg file back to its power-on
	// values BEFORE memory.Reset re-enables the FPGA bootrom. The
	// dispatcher's Reset drives every OnWrite handler so the
	// tilemap layer, Layer 2, MMU8, palette and divMMC pager also
	// fall back to power-on state — otherwise the previous boot's
	// tilemap stays enabled and renders stale bank-5 data over the
	// fresh boot output as vertical-stripe corruption.
	if e.nextRegs != nil {
		e.nextRegs.Reset()
	}
	// The palette bank carries the NR$44 two-byte write latch
	// (pending9/have9). nextRegs.Reset's Phase 1 zero-pass writes a
	// single 0 byte to NR$44 which leaves the latch in "got high,
	// awaiting low" state — the next boot.bin NR$44 write would
	// then commit (high=0, low=guest_val&1) and corrupt every
	// subsequent palette write, producing the all-blue testcard
	// reported on reboot. Reset the latch AFTER nextRegs.Reset so
	// the half-pair set during Phase 1 is cleared.
	if e.nextPalette != nil {
		e.nextPalette.ResetWriteLatches()
	}

	// Restore paging to the model's power-on defaults. Without this,
	// 128K/+2A/+3 reboots inherit whatever banks/ROM the previously
	// running program had selected — e.g. after loading a +3 .dsk the
	// boot ROM index is no longer 0, so the +3 main menu never
	// reappears and BASIC starts up over corrupted system variables.
	// On ModelNext, memory.Reset re-activates the FPGA bootrom (so
	// the loader runs again), then setupNext rewires the 128K-style
	// page map. Both are required to make Reboot reproduce a cold
	// power-on for the Next.
	if err := e.mem.Reset(); err != nil {
		slog.Error("memory reset failed", "err", err)
	}

	// If the DISCiPLE is enabled, page it in so its boot code at
	// ROM 0x0000 runs on the next frame (cold boot).
	if e.peripherals.IsDiscipleEnabled() {
		if disc := e.peripherals.GetDisciple(); disc != nil {
			disc.PageIn()
		}
	}

	// Clear key states on reboot (host keys, queue, joystick, and matrix —
	// see releaseAllInput: a held key/joystick must not survive the reset).
	e.keyMutex.Lock()
	e.physicalKeys = make(map[fyne.KeyName]bool)
	e.keyMutex.Unlock()

	// Drain key queue
	for len(e.keyQueue) > 0 {
		<-e.keyQueue
	}
	e.clearJoystickState()
	if e.kbd != nil {
		e.kbd.ReleaseAll()
	}

	// Re-apply warm-boot on ModelNext if (and ONLY if) the user
	// explicitly opted into the warm-boot debug shortcut. Per the
	// project's "no hacks" rule, the captured-state replay must be
	// opt-in only — see also cmd/zxplay_go/next.go for the parallel
	// gating during initial boot.
	//
	// Triggers (any of):
	//   - --warm-boot CLI flag       (cliFlagsActive.warmBoot)
	//   - $ZX_GO_WARM_BOOT=1         (env var)
	//
	// $ZX_GO_NO_WARM_BOOT=1 still honoured as a force-off override
	// for backward compatibility.
	warmBootOptedIn := os.Getenv("ZX_GO_WARM_BOOT") != "" ||
		(cliFlagsActive != nil && cliFlagsActive.warmBoot)
	if os.Getenv("ZX_GO_NO_WARM_BOOT") != "" {
		warmBootOptedIn = false
	}
	if warmBootOptedIn && e.cpu != nil && e.mem != nil && e.nextRegs != nil &&
		e.mem.GetCurrentModel() == roms.ModelNext {
		if err := applyWarmBoot(e.cpu, e.mem, e.nextRegs); err != nil {
			if !errors.Is(err, install.ErrROMNotInstalled) {
				slog.Warn("warm-boot reapply after reboot failed", "err", err)
			}
		} else {
			slog.Info("warm-boot reapplied after reboot (debug shortcut)")
		}
	}
}

func (e *emulator) togglePause() {
	e.paused.Store(!e.paused.Load())
	if e.paused.Load() {
		slog.Info("emulator paused")
	} else {
		slog.Info("emulator resumed")
	}
}

func (e *emulator) cleanup() {
	slog.Info("cleaning up emulator resources")
	e.paused.Store(true)
	close(e.stopChan)
	if e.ticker != nil {
		e.ticker.Stop()
	}
	// e.ula is nil for the SAM Coupé and ZX80/ZX81 (no Spectrum ULA), so guard
	// the close — otherwise quitting in those modes nil-panics.
	if e.ula != nil {
		e.ula.Close()
	}
	if e.samAudio != nil {
		_ = e.samAudio.Close()
	}
}

// getFormatName returns a human-readable name for the snapshot format
func getFormatName(format snapshot.SnapshotFormat) string {
	switch format {
	case snapshot.FormatSNA:
		return "SNA"
	case snapshot.FormatZ80:
		return "Z80"
	case snapshot.FormatSZX:
		return "SZX"
	default:
		return "Unknown"
	}
}

// fileSubmenu groups a run of menu items under a single labelled
// parent entry (a fyne submenu via ChildMenu). Used to tame the
// otherwise huge flat File menu into a handful of cohesive groups.
func fileSubmenu(label string, items ...*fyne.MenuItem) *fyne.MenuItem {
	mi := fyne.NewMenuItem(label, nil)
	mi.ChildMenu = fyne.NewMenu("", items...)
	return mi
}

// ensureFileExt appends ext to path (and renames the file on disk)
// when path doesn't already end in ext, case-insensitively. Used by
// the save dialogs so a user who types "shot" instead of "shot.png"
// still gets a correctly-named file. If the rename fails (e.g. the
// target already exists) the original path is returned unchanged.
func ensureFileExt(path, ext string) string {
	if strings.HasSuffix(strings.ToLower(path), strings.ToLower(ext)) {
		return path
	}
	withExt := path + ext
	// Don't clobber an unrelated existing file: os.Rename overwrites
	// silently on Unix, so if "shot.png" already exists and the user
	// typed "shot", keep the file at the name they actually chose
	// rather than destroying the other one.
	if _, err := os.Stat(withExt); err == nil {
		return path
	}
	if err := os.Rename(path, withExt); err != nil {
		return path
	}
	return withExt
}

// writeScreenshotPNG renders the current frame and writes it as a
// PNG to w. Works for every machine type: emu.ula.Render() returns
// the composited framebuffer — the classic ULA bitmap for 48K…+3,
// and the full Spectrum Next composite (ULA + Layer 2 + sprites +
// tilemap + LoRes through the active palette and SLU priority) for
// ModelNext, at whatever resolution the active Next video mode
// produces. The pixel data is copied before encode so the PNG write
// can't race the emulator goroutine mutating the framebuffer.
func writeScreenshotPNG(emu *emulator, w io.Writer) error {
	src := emu.renderFrame()
	imgCopy := image.NewRGBA(src.Bounds())
	copy(imgCopy.Pix, src.Pix)
	return png.Encode(w, imgCopy)
}

// flushSDWriteback persists guest SD-image writes to disk when the
// user opted in via --sd-writeback. The previous file is kept as
// .bak (see ImageSource.WriteBackTo). No-op when the flag is off,
// no image is mounted, or the guest never wrote.
func (e *emulator) flushSDWriteback() {
	flat, ok := e.sdImageSrc.(*sdcard.ImageSource)
	if !ok || e.sdImagePath == "" || !flat.Dirty() {
		return
	}
	if err := flat.WriteBackTo(e.sdImagePath); err != nil {
		slog.Error("sd-writeback failed", "path", e.sdImagePath, "err", err)
		return
	}
	slog.Info("sd-writeback complete", "path", e.sdImagePath, "backup", e.sdImagePath+".bak")
}

// applySnapshotToEmulator applies a loaded snapshot to the running emulator.
func applySnapshotToEmulator(emu *emulator, snap *snapshot.Snapshot) error {
	// Pause emulation during snapshot loading
	wasPaused := emu.paused.Load()
	if !emu.paused.Load() {
		emu.togglePause()
	}

	// Apply CPU state
	emu.cpu.A = snap.CPU.A
	emu.cpu.F = snap.CPU.F
	emu.cpu.B = snap.CPU.B
	emu.cpu.C = snap.CPU.C
	emu.cpu.D = snap.CPU.D
	emu.cpu.E = snap.CPU.E
	emu.cpu.H = snap.CPU.H
	emu.cpu.L = snap.CPU.L

	emu.cpu.A_ = snap.CPU.A_
	emu.cpu.F_ = snap.CPU.F_
	emu.cpu.B_ = snap.CPU.B_
	emu.cpu.C_ = snap.CPU.C_
	emu.cpu.D_ = snap.CPU.D_
	emu.cpu.E_ = snap.CPU.E_
	emu.cpu.H_ = snap.CPU.H_
	emu.cpu.L_ = snap.CPU.L_

	emu.cpu.IX = snap.CPU.IX
	emu.cpu.IY = snap.CPU.IY
	emu.cpu.SP = snap.CPU.SP
	emu.cpu.PC = snap.CPU.PC
	emu.cpu.I = snap.CPU.I
	emu.cpu.R = snap.CPU.R
	emu.cpu.IFF1 = snap.CPU.IFF1
	emu.cpu.Halted = snap.CPU.Halted
	emu.cpu.IFF2 = snap.CPU.IFF2
	emu.cpu.IM = snap.CPU.IM

	// Apply memory state
	for i := 0; i < 8; i++ {
		bank := emu.mem.GetPage(i)
		copy(bank, snap.Memory.RAM[i])
	}

	// Apply memory paging for 128K machines
	if snap.Memory.Is128K {
		emu.mem.PageMemory(snap.Memory.Port7FFD)
	}

	// Apply border color
	emu.ula.BorderColour = snap.CPU.BorderColor

	// Resume emulation if it was running before
	if !wasPaused {
		emu.togglePause()
	}

	return nil
}

// createSnapshotFromEmulator creates a snapshot from the current emulator state
func createSnapshotFromEmulator(emu *emulator) (*snapshot.Snapshot, error) {
	snap := snapshot.New()

	// Copy CPU state
	snap.CPU.A = emu.cpu.A
	snap.CPU.F = emu.cpu.F
	snap.CPU.B = emu.cpu.B
	snap.CPU.C = emu.cpu.C
	snap.CPU.D = emu.cpu.D
	snap.CPU.E = emu.cpu.E
	snap.CPU.H = emu.cpu.H
	snap.CPU.L = emu.cpu.L

	snap.CPU.A_ = emu.cpu.A_
	snap.CPU.F_ = emu.cpu.F_
	snap.CPU.B_ = emu.cpu.B_
	snap.CPU.C_ = emu.cpu.C_
	snap.CPU.D_ = emu.cpu.D_
	snap.CPU.E_ = emu.cpu.E_
	snap.CPU.H_ = emu.cpu.H_
	snap.CPU.L_ = emu.cpu.L_

	snap.CPU.IX = emu.cpu.IX
	snap.CPU.IY = emu.cpu.IY
	snap.CPU.SP = emu.cpu.SP
	snap.CPU.PC = emu.cpu.PC
	snap.CPU.I = emu.cpu.I
	snap.CPU.R = emu.cpu.R
	snap.CPU.IFF1 = emu.cpu.IFF1
	snap.CPU.Halted = emu.cpu.Halted
	snap.CPU.IFF2 = emu.cpu.IFF2
	snap.CPU.IM = emu.cpu.IM

	// Copy memory state
	for i := 0; i < 8; i++ {
		bank := emu.mem.GetPage(i)
		copy(snap.Memory.RAM[i], bank)
	}

	// Set memory configuration
	snap.Memory.Is128K = (emu.mem.GetCurrentModel() != roms.Model48K)
	if snap.Memory.Is128K {
		snap.Memory.Port7FFD = 0
	}

	// Copy border color
	snap.CPU.BorderColor = emu.ula.BorderColour

	return snap, nil
}

// withEmulationPaused runs fn with the emulation goroutine paused, then
// restores the previous pause state. Used by RZX start/stop helpers
// that mutate live CPU state and would otherwise race the emulation
// loop. Matches the pattern used by applySnapshotToEmulator.
func (e *emulator) withEmulationPaused(fn func() error) error {
	wasPaused := e.paused.Load()
	if !wasPaused {
		e.paused.Store(true)
	}
	err := fn()
	if !wasPaused {
		e.paused.Store(false)
	}
	return err
}

// startRZXPlayback installs the supplied RZX session as the active
// playback driver. Loads the embedded snapshot, wires the ULA's
// playback hook to the file's IN-byte stream, and switches the main
// loop into per-frame instruction-counted execution mode.
//
// Pauses the emulation goroutine for the duration of the state
// mutation so the CPU can't be mid-frame when the snapshot apply +
// T-state reset happens.
func (e *emulator) startRZXPlayback(file *rzx.File) error {
	if e.rzxRecord.Load() != nil {
		return fmt.Errorf("cannot start playback while recording")
	}
	return e.withEmulationPaused(func() error {
		pb := rzx.NewPlayback(file)
		snapBlock, err := pb.Start(0)
		if err != nil {
			return fmt.Errorf("rzx start playback: %w", err)
		}
		if snapBlock != nil {
			snap, err := rzx.DecodeSnapshot(snapBlock)
			if err != nil {
				return fmt.Errorf("rzx decode initial snapshot: %w", err)
			}
			if err := applySnapshotToEmulator(e, snap); err != nil {
				return fmt.Errorf("rzx apply initial snapshot: %w", err)
			}
		}
		e.cpu.SetTstates(uint64(pb.Tstates()))

		// Wire the ULA hook so every IN read pulls from the
		// recorded stream. Closure over pb avoids any pointer
		// chase on the per-IN hot path.
		e.ula.SetRZXPlaybackHook(func() (byte, bool) {
			b, err := pb.NextByte()
			if err != nil {
				return 0, false
			}
			return b, true
		})

		e.rzxPlayback.Store(pb)
		return nil
	})
}

// stopRZXPlayback tears down an active playback session. Idempotent.
// Safe to call from any goroutine — the atomic.Pointer clear plus the
// ULA hook clear are both lock-free.
func (e *emulator) stopRZXPlayback() {
	if e.rzxPlayback.Swap(nil) == nil {
		return
	}
	e.ula.SetRZXPlaybackHook(nil)
}

// startRZXRecording opens a new recording session that will be saved
// to filename when stopRZXRecording is called. The current emulator
// state is captured as the initial snapshot so playback starts from
// this point. Pauses the emulation goroutine during snapshot capture
// so the CPU state isn't sampled mid-frame.
func (e *emulator) startRZXRecording(filename string, competition bool) error {
	if e.rzxPlayback.Load() != nil {
		return fmt.Errorf("cannot start recording while playback is active")
	}
	return e.withEmulationPaused(func() error {
		rec := rzx.NewRecording()
		rec.AddCreator(&rzx.CreatorBlock{Program: "zxplay_go", Major: 1, Minor: 0})

		snap, err := createSnapshotFromEmulator(e)
		if err != nil {
			return fmt.Errorf("rzx capture snapshot: %w", err)
		}
		block, err := rzx.EncodeSnapshot(snap, rzx.SnapshotFormatSZX, false)
		if err != nil {
			return fmt.Errorf("rzx encode snapshot: %w", err)
		}
		rec.AddSnap(block, false)
		rec.AutosavesEnabled = !competition
		rec.CompetitionMode = competition
		rec.StartInput(uint32(e.cpu.Tstates()))

		e.ula.SetRZXRecordHook(rec.RecordIN)

		e.rzxRecord.Store(rec)
		e.rzxRecordFilename = filename
		return nil
	})
}

// stopRZXRecording finalises the in-progress recording (if any) and
// writes it out. The Recording is cleared even on write failure so the
// user can retry; pauses the emulation goroutine while sampling the
// final snapshot so the CPU state isn't read mid-frame.
func (e *emulator) stopRZXRecording() error {
	rec := e.rzxRecord.Swap(nil)
	if rec == nil {
		return nil
	}
	filename := e.rzxRecordFilename
	e.rzxRecordFilename = ""
	e.ula.SetRZXRecordHook(nil)

	// Embed a final snapshot so post-recording playback can resume
	// from the end (FUSE rzx.c:199, skipped in competition mode).
	if !rec.CompetitionMode {
		err := e.withEmulationPaused(func() error {
			snap, err := createSnapshotFromEmulator(e)
			if err != nil {
				return err
			}
			block, err := rzx.EncodeSnapshot(snap, rzx.SnapshotFormatSZX, false)
			if err != nil {
				return err
			}
			rec.AddSnap(block, false)
			return nil
		})
		if err != nil {
			slog.Error("RZX stop: final snapshot capture failed", "err", err)
		}
	}

	if err := rec.WriteFile(filename, rzx.WriteOptions{Compress: true}); err != nil {
		return fmt.Errorf("rzx write %s: %w", filename, err)
	}
	return nil
}

// enableInterface1 turns on the Interface 1 — pulls the IF1 ROM from
// the ROM manager (which loads it from roms/if1-2.rom or the embedded
// fallback), enables the IF1 in the peripheral manager, and installs
// the per-instruction page-in/page-out hooks on the Z80. Returns an
// error with a user-friendly message if the ROM is missing.
//
// State mutation runs under withEmulationPaused so the emulation
// goroutine isn't reading the CPU's hook fields while the UI thread
// is writing them — same race-avoidance pattern the snapshot loader
// uses.
func (e *emulator) enableInterface1() error {
	rom, ok := e.mem.GetROMManager().GetROM(roms.ROMINTERFACE1)
	if !ok {
		return fmt.Errorf("interface 1 ROM not found — drop if1-2.rom (8KB) into the roms/ directory; available from World of Spectrum and similar archives")
	}
	return e.withEmulationPaused(func() error {
		if err := e.peripherals.EnableInterface1(rom); err != nil {
			return err
		}
		dev := e.peripherals.IF1()
		e.cpu.PreFetchHook = dev.PreFetchHook
		e.cpu.PostFetchHook = dev.PostFetchHook
		return nil
	})
}

// disableInterface1 tears down the Interface 1: removes the Z80 page
// hooks and disables the device in the peripheral manager. Paired
// with enableInterface1's withEmulationPaused so the hook nil-out
// can't race with the emulation goroutine's per-instruction read.
func (e *emulator) disableInterface1() {
	_ = e.withEmulationPaused(func() error {
		e.cpu.PreFetchHook = nil
		e.cpu.PostFetchHook = nil
		e.peripherals.DisableInterface1()
		return nil
	})
}

// rzxRollbackToLastSnapshot truncates the in-progress recording back
// to the most recent snapshot block, restores that snapshot to the
// live emulator, and reopens the input recording window. Bound to the
// "RZX Rollback" menu item.
func (e *emulator) rzxRollbackToLastSnapshot() error {
	rec := e.rzxRecord.Load()
	if rec == nil {
		return fmt.Errorf("no recording in progress")
	}
	snapBlock, err := rec.Rollback()
	if err != nil {
		return fmt.Errorf("rollback: %w", err)
	}
	snap, err := rzx.DecodeSnapshot(snapBlock)
	if err != nil {
		return fmt.Errorf("decode rollback snapshot: %w", err)
	}
	return e.withEmulationPaused(func() error {
		if err := applySnapshotToEmulator(e, snap); err != nil {
			return err
		}
		rec.StartInput(uint32(e.cpu.Tstates()))
		return nil
	})
}

// installTapeTrap installs a fast-load trap on the CPU that intercepts the
// 48K ROM LD-BYTES routine at 0x0556 and synthesises the load directly from
// the next tape block, avoiding the slow real-time pulse decoding.
//
// On entry to LD-BYTES (PC=0x0556) the contract is:
//
//	A          expected flag byte (header=0x00, data=0xFF)
//	F carry    set means LOAD, clear means VERIFY
//	IX         destination address
//	DE         number of bytes to load (excluding flag/checksum)
//
// Note: A/F (not A'/F') — the EX AF,AF' is the routine's *second*
// instruction, so it has not run yet at the trap point.
//
// The routine returns with carry set on success, carry clear on failure.
// We replicate this contract by reading bytes directly from the current
// tape block (which is stored as: flag byte, data bytes..., checksum byte).
// tapeTrapROMActive reports whether the 48 BASIC ROM (the one containing the
// LD-BYTES loader at $0556) is currently paged at $0000 for the active model.
// The fast-load trap may only fire then.
func tapeTrapROMActive(mem *memory.Memory) bool {
	switch mem.GetCurrentModel() {
	case roms.Model48K:
		return true // single ROM, always 48 BASIC
	case roms.Model128K, roms.ModelPlus2, roms.ModelPentagon:
		return mem.GetROMBank() == 1
	case roms.ModelPlus2A, roms.ModelPlus3:
		return mem.GetROMBank() == 3
	default:
		// Next / ZX8x: no classic LD-BYTES flow to trap. NextZXOS ROM3
		// carries the LD-BYTES bytes at $0556 (byte-identical to the 48
		// ROM) but nothing in any Next ROM calls that entry — its rewritten
		// LOAD path enters with a different register contract, and PC passes
		// $0556 during unrelated OS work — so the classic trap would consume
		// tape blocks on phantom entries. Tape-on-Next needs NextZXOS's own
		// .tapein file emulation instead (unproven in zxplay_go so far).
		return false
	}
}

// tapeTrace, when ZX_GO_TAPE_TRACE is set, logs every LD-BYTES trap hit and
// decision to stderr — the diagnostic for tape loads that fail only in a real
// session (which the headless harness can't reproduce).
var tapeTrace = os.Getenv("ZX_GO_TAPE_TRACE") != ""

func installTapeTrap(emu *emulator) {
	emu.cpu.TrapCheck = func(pc uint16) bool {
		// The traps drive the Spectrum ULA tape player; machines without a
		// ULA (SAM Coupé, ZX80/81) share the trap PCs but must never trap.
		if emu.ula == nil {
			return false
		}
		switch pc {
		case 0x0556:
			return tapeTrapLDBytes(emu)
		case 0x05E7:
			return tapeTrapLDEdge(emu)
		}
		return false
	}
}

// tapeTrapLDBytes is the block-level fast-load trap at the LD-BYTES entry
// ($0556) — see the contract documented above installTapeTrap's callers.
func tapeTrapLDBytes(emu *emulator) bool {
	{
		if tapeTrace {
			tp := emu.ula.GetTapePlayer()
			blk, more := -1, false
			if tp != nil {
				blk, more = tp.CurrentBlock(), tp.HasMoreBlocks()
			}
			fmt.Fprintf(os.Stderr, "[tapetrap] @0556 model=%s bank=%d active=%v tp=%v block=%d more=%v A=%02X A'=%02X carry=%v carry'=%v IX=%04X DE=%04X\n",
				roms.GetModelName(emu.mem.GetCurrentModel()), emu.mem.GetROMBank(),
				tapeTrapROMActive(emu.mem), tp != nil, blk, more, emu.cpu.A, emu.cpu.A_,
				emu.cpu.F&z80.FLAG_C != 0, emu.cpu.F_&z80.FLAG_C != 0,
				emu.cpu.IX, uint16(emu.cpu.D)<<8|uint16(emu.cpu.E))
		}
		// Fire only when the 48 BASIC ROM — which holds LD-BYTES at $0556 — is
		// the ROM currently paged at $0000. That's always true on the 48K; on
		// the 128/+2/Pentagon it's ROM bank 1 (the 128 menu's "Tape Loader"
		// pages it in), and on the +2A/+3 it's ROM bank 3. On any other paged
		// ROM, $0556 is unrelated code and must not be trapped. (Previously the
		// trap was 48K-only, so 128K tape loading silently did nothing — the
		// per-frame tape player can't drive the edge-timed ROM loader.)
		if !tapeTrapROMActive(emu.mem) {
			return false
		}
		tp := emu.ula.GetTapePlayer()
		if tp == nil || !tp.HasMoreBlocks() {
			return false
		}

		block := tp.NextBlock()
		if block == nil {
			return false
		}

		expectedFlag := emu.cpu.A
		isLoad := (emu.cpu.F & z80.FLAG_C) != 0

		dst := emu.cpu.IX
		count := uint16(emu.cpu.D)<<8 | uint16(emu.cpu.E)

		success := true
		if len(block) < 1 {
			success = false
		} else if block[0] != expectedFlag {
			// Flag mismatch — emulate failure.
			if tapeTrace {
				fmt.Fprintf(os.Stderr, "[tapetrap] FLAG MISMATCH block %d flag=%02X expected=%02X -> FAIL (R Tape loading error)\n",
					emu.ula.GetTapePlayer().CurrentBlock()-1, block[0], expectedFlag)
			}
			success = false
		} else {
			// Block contains: flag, data..., checksum.
			data := block[1:]
			if len(data) > 0 {
				// Last byte of the block is the checksum.
				data = data[:len(data)-1]
			}
			n := int(count)
			if n > len(data) {
				if tapeTrace {
					fmt.Fprintf(os.Stderr, "[tapetrap] LENGTH MISMATCH want %d bytes but block %d has %d -> FAIL (R Tape loading error)\n",
						n, emu.ula.GetTapePlayer().CurrentBlock()-1, len(data))
				}
				n = len(data)
				success = false
			}
			if isLoad {
				for i := 0; i < n; i++ {
					emu.mem.Write(dst+uint16(i), data[i])
				}
			}
			// Advance IX and zero DE as the real routine would on success.
			emu.cpu.IX = dst + uint16(n)
			emu.cpu.D = 0
			emu.cpu.E = 0
		}

		// Update the carry flag in F (current accumulator's flags).
		if success {
			emu.cpu.F |= z80.FLAG_C
		} else {
			emu.cpu.F &^= z80.FLAG_C
		}

		// Return from LD-BYTES: pop the return address from the stack.
		// LD-BYTES is normally entered via CALL, so the stack holds the
		// caller's return address. We mimic the routine's RET by popping
		// directly into PC.
		low := emu.mem.Read(emu.cpu.SP)
		high := emu.mem.Read(emu.cpu.SP + 1)
		emu.cpu.SP += 2
		emu.cpu.PC = uint16(high)<<8 | uint16(low)

		slog.Debug("tape trap: loaded bytes", "count", count, "addr", fmt.Sprintf("$%04X", dst), "success", success)
		return true
	}
}

// LD-EDGE-1 ($05E7) timing constants, derived from the byte-exact 48 ROM
// routine (pkg/roms/data/48.rom):
//
//	05E7 LD A,$16 / 05E9 DEC A / 05EA JR NZ,05E9 / 05EC AND A
//	05ED LD-SAMPLE: INC B / RET Z / LD A,$7F / IN A,($FE) / RRA / RET NC
//	                / XOR C / AND $20 / JR Z,LD-SAMPLE
//	05FA exit: LD A,C / CPL / LD C,A / AND $07 / OR $08 / OUT ($FE),A / SCF / RET
//
// Settle before the first sample: 7 + 21*(4+12) + (4+7) + 4 = 358 T. A full
// looping sample iteration costs 59 T with the IN completing 27 T in. The
// successful final iteration plus exit tail costs 54 + 51 = 105 T; the
// timeout iteration (INC B wraps, RET Z taken) costs 4 + 11 = 15 T.
const (
	ldEdgeSettleT   = 358
	ldEdgeLoopT     = 59
	ldEdgeSampleOff = 27
	ldEdgeExitT     = 105
	ldEdgeTimeoutT  = 15
)

// tapeTrapLDEdge is the O(1) fast trap for the ROM's edge-sampling routine
// LD-EDGE-1 ($05E7). Custom loaders that the block-level $0556 trap can never
// serve — Exolon enters LD-BYTES mid-routine, Firelord byte-loops in RAM
// calling ROM LD-EDGE (#192) — spend ~95% of their load inside this loop, so
// emulating its contract analytically makes their real-time loads nearly free
// to execute while leaving the EMULATED timeline byte-for-byte and
// T-state-for-T-state equivalent: the trap advances the CPU clock by exactly
// the time the loop would have burned and computes B from the same 59 T
// sample grid the loop would have counted on, so bit discrimination (which IS
// the B count) and loader timing checks are preserved. Trapping $05E7 alone
// also covers LD-EDGE-2 ($05E3): that entry is CALL $05E7 / RET NC / fall
// through into $05E7, so its second edge re-enters the trap point.
//
// Contract on entry: B = timeout counter, C bit 5 = last EAR level (in the
// RRA-shifted position), C bits 0-2 = border colour. Returns via RET with:
// success — carry set, B += samples, C complemented, A = (C&7)|8 written to
// port $FE (border stripe + MIC); timeout (B wrapped) — carry clear, Z set,
// B = 0, A = 0.
func tapeTrapLDEdge(emu *emulator) bool {
	if !tapeTrapROMActive(emu.mem) {
		return false
	}
	if emu.ula.GetTapePlayer() == nil {
		return false
	}
	// Interrupt fidelity: loaders run under DI; with interrupts enabled the
	// real loop could be preempted mid-sample, which O(1) emulation cannot
	// reproduce. No ROM caller runs it with EI — fall back to interpretation.
	if emu.cpu.IFF1 {
		return false
	}
	// BREAK abort: the loop live-reads SPACE (bit 0 of the $7FFE half-row)
	// every sample. Let the real code run while it's held so the abort path
	// stays exact.
	if emu.kbd != nil && emu.kbd.Scan(0x7FFE)&0x01 == 0 {
		return false
	}

	level := emu.ula.TapeTrapSync() // advance the deck to "now"
	expected := emu.cpu.C&0x20 != 0
	b := emu.cpu.B
	nInc := 256 - int(b) // INC B executions until RET Z would fire

	// Find the 1-based sample index k whose IN sees a level different from
	// C bit 5; k = 0 means the loop times out. Sample k reads EAR at
	// settle + (k-1)*59 + 27 T after entry. A paused deck (or tape end)
	// holds the level: instant success if it already differs, else timeout —
	// exactly what the interpreted loop would observe.
	k := 0
	if nInc > 1 {
		if level != expected {
			k = 1
		} else if dt, ok := emu.ula.TapeTstatesToNextEdge(); ok {
			kk := 1
			if first := uint64(ldEdgeSettleT + ldEdgeSampleOff); dt > first {
				kk = int((dt-first+ldEdgeLoopT-1)/ldEdgeLoopT) + 1
			}
			if kk <= nInc-1 {
				k = kk
			}
		}
	}

	var consumed uint64
	samples := k
	if k > 0 {
		consumed = ldEdgeSettleT + uint64(k-1)*ldEdgeLoopT + ldEdgeExitT
	} else {
		consumed = ldEdgeSettleT + uint64(nInc-1)*ldEdgeLoopT + ldEdgeTimeoutT
		samples = nInc - 1
	}
	emu.cpu.SetTstates(emu.cpu.Tstates() + consumed)
	// The absorbed INs each hit port $FE: credit them so the read-rate
	// signals (fast-tape turbo, loader-activity auto-pause) still see an
	// active loader, then move the deck to the exit instant (past the edge
	// on success), which also records the loading-sound transition.
	if samples > 0 {
		emu.ula.CreditTapeReads(uint64(samples))
	}
	emu.ula.TapeTrapSync()

	if k > 0 {
		emu.cpu.B = b + byte(k)
		emu.cpu.C = ^emu.cpu.C
		a := (emu.cpu.C & 0x07) | 0x08
		emu.ula.WritePort(0x00FE, a) // the ROM's OUT: border stripe + MIC
		emu.cpu.A = a
		// Flags: OR $08 set S/Z/P from A (A is 8..15: S=0, Z=0), SCF then
		// sets carry and clears N/H while preserving S/Z/P.
		f := byte(z80.FLAG_C)
		if bits.OnesCount8(a)%2 == 0 {
			f |= z80.FLAG_PV
		}
		emu.cpu.F = f
	} else {
		// Timeout: A holds the last AND $20 result (0); INC B wrapped
		// $FF->$00 setting Z and H (PV clear — no signed overflow), carry
		// clear from that AND.
		emu.cpu.A = 0
		emu.cpu.B = 0
		emu.cpu.F = z80.FLAG_Z | z80.FLAG_H
	}
	// RET.
	low := emu.mem.Read(emu.cpu.SP)
	high := emu.mem.Read(emu.cpu.SP + 1)
	emu.cpu.SP += 2
	emu.cpu.PC = uint16(high)<<8 | uint16(low)
	return true
}

// parsePokes parses a multi-line poke string. Each non-empty, non-comment line
// must contain an address and a value, separated by whitespace, comma, or
// colon. Values are interpreted as hexadecimal. Returns a slice of (addr,val)
// pairs and an error describing the first malformed line.
func parsePokes(text string) ([]struct {
	Addr uint16
	Val  byte
}, error) {
	var result []struct {
		Addr uint16
		Val  byte
	}
	lines := strings.Split(text, "\n")
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		// Replace separators with spaces.
		line = strings.ReplaceAll(line, ",", " ")
		line = strings.ReplaceAll(line, ":", " ")
		fields := strings.Fields(line)
		if len(fields) != 2 {
			return nil, fmt.Errorf("line %d: expected ADDR VALUE, got %q", i+1, raw)
		}
		// Strip optional 0x prefix.
		af := strings.TrimPrefix(strings.TrimPrefix(fields[0], "0x"), "0X")
		vf := strings.TrimPrefix(strings.TrimPrefix(fields[1], "0x"), "0X")
		addr, err := strconv.ParseUint(af, 16, 16)
		if err != nil {
			return nil, fmt.Errorf("line %d: invalid address %q: %w", i+1, fields[0], err)
		}
		val, err := strconv.ParseUint(vf, 16, 8)
		if err != nil {
			return nil, fmt.Errorf("line %d: invalid value %q: %w", i+1, fields[1], err)
		}
		result = append(result, struct {
			Addr uint16
			Val  byte
		}{Addr: uint16(addr), Val: byte(val)})
	}
	return result, nil
}

// aspectRatioLayout centres its single child at a fixed aspect ratio
// within the available space, adding black bars as needed.
type aspectRatioLayout struct {
	ratio float64 // width / height, e.g. 4.0/3.0
}

func (a *aspectRatioLayout) MinSize(objects []fyne.CanvasObject) fyne.Size {
	return fyne.NewSize(320, 240)
}

func (a *aspectRatioLayout) Layout(objects []fyne.CanvasObject, containerSize fyne.Size) {
	if len(objects) == 0 {
		return
	}
	cw := float64(containerSize.Width)
	ch := float64(containerSize.Height)

	// Fit the aspect ratio inside the container
	var w, h float64
	if cw/ch > a.ratio {
		// Container is wider than 4:3 — pillarbox (black bars on sides)
		h = ch
		w = h * a.ratio
	} else {
		// Container is taller than 4:3 — letterbox (black bars top/bottom)
		w = cw
		h = w / a.ratio
	}

	x := (cw - w) / 2
	y := (ch - h) / 2

	objects[0].Move(fyne.NewPos(float32(x), float32(y)))
	objects[0].Resize(fyne.NewSize(float32(w), float32(h)))
}

// modelToConfigString maps a roms.SpectrumModel to its on-disk
// config representation. Stable strings so future renames in the
// roms package don't invalidate existing config files.
func modelToConfigString(m roms.SpectrumModel) string {
	switch m {
	case roms.Model128K:
		return "128K"
	case roms.ModelPlus2:
		return "+2"
	case roms.ModelPlus2A:
		return "+2A"
	case roms.ModelPlus3:
		return "+3"
	case roms.ModelNext:
		return "Next"
	case roms.ModelPentagon:
		return "Pentagon"
	case roms.ModelZX81:
		return "ZX81"
	case roms.ModelZX80:
		return "ZX80"
	}
	return "48K"
}

func joystickToConfigString(j JoystickType) string {
	switch j {
	case JoystickKempston:
		return "Kempston"
	case JoystickSinclair1:
		return "Sinclair1"
	case JoystickSinclair2:
		return "Sinclair2"
	case JoystickCursor:
		return "Cursor"
	}
	return "None"
}

func configStringToJoystick(s string) JoystickType {
	switch s {
	case "Kempston":
		return JoystickKempston
	case "Sinclair1":
		return JoystickSinclair1
	case "Sinclair2":
		return JoystickSinclair2
	case "Cursor":
		return JoystickCursor
	}
	return JoystickNone
}

// multifaceVariantToConfigString maps a multiface variant to its
// stable on-disk representation. Empty string means "no Multiface".
func multifaceVariantToConfigString(v multiface.MultifaceType) string {
	switch v {
	case multiface.Multiface1:
		return "MF1"
	case multiface.Multiface128:
		return "MF128"
	case multiface.Multiface3:
		return "MF3"
	}
	return ""
}

// configStringToMultifaceVariant inverts the above. An unrecognised
// or empty string returns Multiface128 (the package default) — callers
// must gate on cfg.Multiface != "" before calling.
func configStringToMultifaceVariant(s string) multiface.MultifaceType {
	switch s {
	case "MF1":
		return multiface.Multiface1
	case "MF3":
		return multiface.Multiface3
	}
	return multiface.Multiface128
}
