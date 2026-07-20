//go:build js && wasm

package main

import (
	"os"
	"sort"
	"strconv"
	"strings"
	"syscall/js"
	"time"

	fyne "fyne.io/fyne/v2"

	"github.com/conorarmstrong/zx_go/pkg/audio"
	"github.com/conorarmstrong/zx_go/pkg/next/divmmc"
	"github.com/conorarmstrong/zx_go/pkg/next/install"
	"github.com/conorarmstrong/zx_go/pkg/next/sdcard"
	"github.com/conorarmstrong/zx_go/pkg/roms"
	"github.com/conorarmstrong/zx_go/pkg/snapshot"
)

var wasmEmu *emulator

// In-progress sparse SD ingest (zxSdIngestBegin/Chunk → zxBootNext()).
var (
	sdIngestSrc *sdcard.SparseSource
	sdIngestOff int64
)

// zxFrame execute-vs-render wall-time split (#187 diagnostics): two
// time.Now() deltas per frame summed into these accumulators, drained by
// the zxPerfSplit export (GoEmulator.js's 5s diagnostics line). Wall time
// only — no per-pixel instrumentation, so the render path stays untouched.
var (
	perfExecNs   int64
	perfRenderNs int64
	perfFrames   int64
)

// wasmTapeTraps mirrors the host page's "instant tape loading" toggle: when
// true (the default, matching the site UI) the LD-BYTES fast-load trap is
// installed on every boot; when false tapes load in real time through the
// edge-timed ROM loader.
var wasmTapeTraps = true

// maybeInstallTapeTrap applies the current trap preference to a machine.
func maybeInstallTapeTrap(e *emulator) {
	if wasmTapeTraps {
		installTapeTrap(e)
	} else {
		e.cpu.TrapCheck = nil
	}
}

// bootClassic constructs a non-Next Spectrum (48K/128K/...) in a goroutine — as
// zxBootNext does — so the synchronous js callback returns and audio "ready" can
// resolve. Classic models load embedded ROMs and need no SD image.
func bootClassic(model roms.SpectrumModel) {
	go func() {
		e, err := newEmulator(model)
		if err != nil {
			js.Global().Get("console").Call("error", "zxBoot: "+err.Error())
			return
		}
		maybeInstallTapeTrap(e)
		e.paused.Store(false)
		wasmEmu = e
	}()
}

// setupWasmExports wires the browser-facing API the iframe host (zxnext-iframe.html)
// calls. Audio: on js pkg/audio creates no oto player; the page drains the
// mixed stream through zxPullAudio and plays it via an AudioWorklet.
func setupWasmExports() {
	g := js.Global()

	// No usable filesystem on wasm: make install.LoadROM skip disk and treat
	// non-injected ROMs as not-installed (optional ones then get skipped).
	install.DiskDisabled = true

	// The FPGA loader is GPLv3 and embedded in the binary; pre-inject it so
	// LoadROM never reaches for a filesystem that wasm doesn't have.
	if emb, err := roms.ReadEmbeddedROM(install.FPGABootROM); err == nil && len(emb) > 0 {
		install.InjectROM(install.FPGABootROM, emb)
	}

	// zxRegisterROM(name, Uint8Array) — stage a licensed ROM before boot.
	g.Set("zxRegisterROM", js.FuncOf(func(_ js.Value, a []js.Value) any {
		name := a[0].String()
		buf := make([]byte, a[1].Get("length").Int())
		js.CopyBytesToGo(buf, a[1])
		install.InjectROM(name, buf)
		return nil
	}))

	// zxSdIngestBegin(virtualSizeBytes) -> "" | error. Starts a streamed,
	// SPARSE card ingest: the page feeds the (zip-inflated) image in
	// chunks via zxSdIngestChunk and never materialises the flat image —
	// all-zero spans allocate nothing, so a mostly-empty multi-hundred-MB
	// card costs only its real bytes in RAM. Chunks are written
	// sequentially from offset 0. zxBootNext() with no argument then
	// mounts the ingested card.
	g.Set("zxSdIngestBegin", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if len(a) < 1 {
			return "zxSdIngestBegin: missing size"
		}
		src, err := sdcard.NewSparseSource(int64(a[0].Float()))
		if err != nil {
			return "zxSdIngestBegin: " + err.Error()
		}
		sdIngestSrc, sdIngestOff = src, 0
		return ""
	}))
	g.Set("zxSdIngestChunk", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if sdIngestSrc == nil {
			return "zxSdIngestChunk: no ingest in progress"
		}
		if len(a) < 1 || a[0].IsUndefined() || a[0].IsNull() {
			return "zxSdIngestChunk: missing data"
		}
		buf := make([]byte, a[0].Get("length").Int())
		js.CopyBytesToGo(buf, a[0])
		sdIngestSrc.WriteAt(buf, sdIngestOff)
		sdIngestOff += int64(len(buf))
		return ""
	}))

	// zxSdPrepDistro() -> "" | error. Normalise the just-ingested OFFICIAL
	// distro card between the last zxSdIngestChunk and zxBootNext(): drop
	// the first-boot welcome pager (nextzxos/autoexec.1st, re-shown every
	// boot until disabled — it stalls the menu-driving macros) and seed
	// machines/next/config.ini when absent so the faithful firmware path
	// boots to the menu instead of the first-run wizard (distro_prep.go).
	// The page calls this ONLY for cards it sourced from the official
	// specnext.com distro — staged/user images are mounted untouched.
	g.Set("zxSdPrepDistro", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		if sdIngestSrc == nil {
			return "zxSdPrepDistro: no ingest in progress"
		}
		deletedWelcome, seededConfig, err := prepDistroCard(sdIngestSrc)
		if err != nil {
			return "zxSdPrepDistro: " + err.Error()
		}
		js.Global().Get("console").Call("log",
			"zxSdPrepDistro: welcome deleted:", deletedWelcome, "config seeded:", seededConfig)
		return ""
	}))

	// zxBootNext(sd? Uint8Array) -> "". With an argument, mounts the flat
	// image (legacy path); with none, mounts the card streamed in through
	// zxSdIngestBegin/Chunk. Construction calls audio.New(), which
	// blocks on oto's Web Audio "ready" channel; that channel only fires when
	// the JS event loop turns, so the boot must run in a goroutine and let the
	// synchronous js callback return. wasmEmu is set when the machine is up;
	// zxFrame reports {0,0} until then.
	g.Set("zxBootNext", js.FuncOf(func(_ js.Value, a []js.Value) any {
		var sd []byte
		if len(a) > 0 && !a[0].IsUndefined() && !a[0].IsNull() {
			sd = make([]byte, a[0].Get("length").Int())
			js.CopyBytesToGo(sd, a[0])
		}
		ingest := sdIngestSrc
		sdIngestSrc, sdIngestOff = nil, 0
		go func() {
			e, err := newNextEmulator()
			if err != nil {
				js.Global().Get("console").Call("error", "zxBootNext: "+err.Error())
				return
			}
			// next.go's disk SD auto-load is skipped on wasm (SDCardImage()==""),
			// so mount the passed image here, mirroring next.go's mount sequence.
			var src sdImageStore
			if sd != nil {
				if is, serr := sdcard.NewImageSource(sd, false); serr == nil {
					src = is
				} else {
					js.Global().Get("console").Call("error", "zxBootNext sd: "+serr.Error())
				}
			} else if ingest != nil {
				js.Global().Get("console").Call("log",
					"zxBootNext: sparse SD card mounted, resident bytes:", ingest.ResidentBytes())
				src = ingest
			}
			if src != nil {
				e.sdImageSrc = src
				card := sdcard.NewCard(src)
				// Default to SDHC (block-addressed), matching next.go's
				// desktop mounts: real Next cards are SDHC, and games
				// that probe the card class refuse SDSC outright (Atic
				// Atac's "SDHC OR BETTER REQUIRED", #167). Same
				// $ZX_GO_NEXT_SDSC escape hatch, settable via go.env.
				if os.Getenv("ZX_GO_NEXT_SDSC") == "" {
					card.SetSDHC(true)
				}
				e.sdCard = card
				if p, ok := e.ula.NextDivMMC().(*divmmc.Pager); ok {
					p.SetCard(card)
				}
			}
			wasmEmu = e
		}()
		return ""
	}))

	// zxBoot48() / zxBoot128() -> "". Boot a classic Spectrum from embedded ROMs
	// (no SD image). The machine auto-runs its ROM to the 48K BASIC prompt or the
	// 128 menu. A CPU LD-BYTES trap is installed so .tap fast-load works.
	g.Set("zxBoot48", js.FuncOf(func(_ js.Value, _ []js.Value) any { bootClassic(roms.Model48K); return "" }))
	g.Set("zxBoot128", js.FuncOf(func(_ js.Value, _ []js.Value) any { bootClassic(roms.Model128K); return "" }))

	// zxLoadTap(Uint8Array) -> "" | errorString. Mount a .tap and auto-run it
	// (LOAD "" on 48K, Tape Loader on 128K).
	g.Set("zxLoadTap", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if wasmEmu == nil {
			return "not booted"
		}
		if len(a) < 1 || a[0].IsNull() || a[0].IsUndefined() {
			return "zxLoadTap: missing tape data"
		}
		data := make([]byte, a[0].Get("length").Int())
		js.CopyBytesToGo(data, a[0])
		if err := wasmEmu.loadAndRunTape(data); err != nil {
			return err.Error()
		}
		return ""
	}))

	// zxBoot(model) -> "" | errorString. Boot (or hot-switch to) a machine by
	// name: "48" | "128". The Next needs its SD image, so it keeps its own
	// entry point (zxBootNext) and is rejected here with guidance.
	g.Set("zxBoot", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if len(a) < 1 {
			return "zxBoot: missing model"
		}
		switch a[0].String() {
		case "48":
			bootClassic(roms.Model48K)
		case "128":
			bootClassic(roms.Model128K)
		case "next":
			return "zxBoot: boot the Next with zxBootNext(sdImage)"
		default:
			return "zxBoot: unknown model " + a[0].String()
		}
		return ""
	}))

	// zxTapeInsert(Uint8Array) -> "" | errorString. Insert a .tap/.tzx into the
	// deck (container sniffed by signature) WITHOUT rebooting or starting
	// playback — the site's plain "insert" semantics; playback is driven by
	// zxTapePlay/zxTapeStop or the guest's own loader plus the fast-load trap.
	g.Set("zxTapeInsert", js.FuncOf(func(_ js.Value, a []js.Value) any {
		e := wasmEmu
		if e == nil || e.ula == nil {
			return "not booted"
		}
		if len(a) < 1 || a[0].IsNull() || a[0].IsUndefined() {
			return "zxTapeInsert: missing tape data"
		}
		data := make([]byte, a[0].Get("length").Int())
		js.CopyBytesToGo(data, a[0])
		tp, err := newTapePlayerFromBytes(data)
		if err != nil {
			return err.Error()
		}
		e.ula.SetTapePlayer(tp)
		return ""
	}))

	// zxTapePlay() / zxTapeStop() -> "" | errorString. Motor control for the
	// inserted tape.
	g.Set("zxTapePlay", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		e := wasmEmu
		if e == nil || e.ula == nil {
			return "not booted"
		}
		tp := e.ula.GetTapePlayer()
		if tp == nil {
			return "no tape inserted"
		}
		tp.Play()
		return ""
	}))
	g.Set("zxTapeStop", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		e := wasmEmu
		if e == nil || e.ula == nil {
			return "not booted"
		}
		tp := e.ula.GetTapePlayer()
		if tp == nil {
			return "no tape inserted"
		}
		tp.Stop()
		return ""
	}))

	// zxTapeStatus() -> {inserted, playing, block, blocks}. Polled by the host
	// each frame to derive the playingTape/stoppedTape events. The return
	// object is CACHED and mutated field-by-field on change: a fresh
	// js.ValueOf(map[...]) per poll costs a Go map allocation plus an
	// Object construction and four syscall/js property writes, 50 times a
	// second, and the host reads the fields synchronously without
	// retaining the object.
	tapeRet := js.ValueOf(map[string]any{"inserted": false, "playing": false, "block": 0, "blocks": 0})
	var tapeInserted, tapePlaying bool
	var tapeBlock, tapeBlocks int
	setTapeRet := func(inserted, playing bool, block, blocks int) js.Value {
		if tapeInserted != inserted {
			tapeInserted = inserted
			tapeRet.Set("inserted", inserted)
		}
		if tapePlaying != playing {
			tapePlaying = playing
			tapeRet.Set("playing", playing)
		}
		if tapeBlock != block {
			tapeBlock = block
			tapeRet.Set("block", block)
		}
		if tapeBlocks != blocks {
			tapeBlocks = blocks
			tapeRet.Set("blocks", blocks)
		}
		return tapeRet
	}
	g.Set("zxTapeStatus", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		e := wasmEmu
		if e == nil || e.ula == nil {
			return setTapeRet(false, false, 0, 0)
		}
		tp := e.ula.GetTapePlayer()
		if tp == nil {
			return setTapeRet(false, false, 0, 0)
		}
		return setTapeRet(true, tp.IsPlaying(), tp.CurrentBlock(), tp.BlockCount())
	}))

	// zxTapeTraps(bool). Toggle the LD-BYTES fast-load trap ("instant tape
	// loading"); applies to the running machine and to subsequent boots.
	g.Set("zxTapeTraps", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if len(a) < 1 {
			return nil
		}
		wasmTapeTraps = a[0].Bool()
		if e := wasmEmu; e != nil && e.cpu != nil {
			maybeInstallTapeTrap(e)
		}
		return nil
	}))

	// zxLoadSnapshot(Uint8Array, ext) -> "48" | "128" | errorString. Load a
	// Z80/SNA/SZX snapshot. ext names the format ("z80" | "sna" | "szx") since
	// SNA has no magic to sniff. Boots the model the snapshot needs (128K
	// images on a 48K and vice versa) before applying, mirroring the desktop's
	// ensureModelForSnapshot; construction runs in a goroutine like the boots.
	// On success the return value is the model the snapshot targets, so the
	// host can update its machine indicator; anything else is an error message
	// (model names are never error text).
	g.Set("zxLoadSnapshot", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if len(a) < 2 || a[0].IsNull() || a[0].IsUndefined() {
			return "zxLoadSnapshot: missing data or format"
		}
		data := make([]byte, a[0].Get("length").Int())
		js.CopyBytesToGo(data, a[0])
		var format snapshot.SnapshotFormat
		switch strings.TrimPrefix(strings.ToLower(a[1].String()), ".") {
		case "z80":
			format = snapshot.FormatZ80
		case "sna":
			format = snapshot.FormatSNA
		case "szx":
			format = snapshot.FormatSZX
		default:
			return "zxLoadSnapshot: unsupported format " + a[1].String()
		}
		snap := snapshot.New()
		if err := snap.LoadBytes(data, format); err != nil {
			return "zxLoadSnapshot: " + err.Error()
		}
		target, targetName := roms.Model48K, "48"
		if snap.Memory.Is128K {
			target, targetName = roms.Model128K, "128"
		}
		go func() {
			e := wasmEmu
			if e == nil || e.model != target {
				ne, err := newEmulator(target)
				if err != nil {
					js.Global().Get("console").Call("error", "zxLoadSnapshot boot: "+err.Error())
					return
				}
				maybeInstallTapeTrap(ne)
				e = ne
			}
			if err := applySnapshotToEmulator(e, snap); err != nil {
				js.Global().Get("console").Call("error", "zxLoadSnapshot apply: "+err.Error())
				return
			}
			e.paused.Store(false)
			wasmEmu = e
		}()
		return targetName
	}))

	// zxMatrixKey(row, mask, down). Direct Spectrum keyboard-matrix poke —
	// the site's KeyboardHandler (and its virtual keyboard) already speaks
	// row/mask, so this is a 1:1 transport.
	g.Set("zxMatrixKey", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if wasmEmu == nil || wasmEmu.kbd == nil || len(a) < 3 {
			return nil
		}
		wasmEmu.kbd.PressMatrixKey(a[0].Int(), byte(a[1].Int()), a[2].Bool())
		return nil
	}))

	// zxJoystickType(name) -> "" | errorString. Selects the joystick
	// interface the host pad drives: "None", "Kempston", "Sinclair1",
	// "Sinclair2" or "Cursor" (the pkg/config spellings). Anything held on
	// the previous interface is released, so switching mid-game can't latch
	// a direction on.
	g.Set("zxJoystickType", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if wasmEmu == nil {
			return "not booted"
		}
		if len(a) < 1 {
			return "missing joystick type"
		}
		t, ok := joystickTypeFromName(a[0].String())
		if !ok {
			return "unknown joystick type: " + a[0].String()
		}
		wasmEmu.setJoystickType(t)
		return ""
	}))

	// zxJoystickState(bits). The whole pad as the FPGA's 12-bit i_JOY
	// vector, active high, bits 11..0 = MODE X Z Y START A C B U D L R.
	// State-based, not edge-based: the host polls its gamepad and hands us
	// the snapshot each frame, and we dispatch the difference. A dropped
	// poll therefore can't strand a held direction, which is the classic
	// way pad input sticks. Buttons above bit 4 are Megadrive-only and
	// reach the guest through NR $B2 and the MD modes of ports $1F/$37.
	g.Set("zxJoystickState", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if wasmEmu == nil || len(a) < 1 {
			return nil
		}
		wasmEmu.SetJoystickState(uint16(a[0].Int()))
		return nil
	}))

	// zxJoystickDebug() -> {type, effective, kempstonEnabled, state,
	// kempstonPortReads}. Splits the three ways pad input can appear to do
	// nothing, which are indistinguishable from the outside:
	//   state == 0          -> the host isn't delivering input
	//   kempstonEnabled off -> the interface didn't arm (a machine switch
	//                          rebuilds the emulator and drops it)
	//   portReads == 0      -> the game never reads the Kempston port, so
	//                          it wants a different interface entirely
	g.Set("zxJoystickDebug", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		e := wasmEmu
		if e == nil {
			return nil
		}
		out := map[string]any{
			"type":         joystickToConfigString(e.joystickType),
			"effective":    joystickToConfigString(e.effectiveJoystick()),
			"state":        int(e.joyState),
			// Cumulative: these survive letting go of the pad, so they
			// answer "did input EVER arrive?" rather than "is a button
			// down right now?".
			"bitsSeen":     int(e.joyBitsSeen),
			"nonZeroCount": int(e.joyNonZeroCount),
		}
		if e.ula != nil {
			out["kempstonStateSeen"] = int(e.joyBitsSeen & 0x1F)
		}
		if e.ula != nil {
			out["kempstonEnabled"] = e.ula.KempstonEnabled
			out["kempstonState"] = int(e.ula.KempstonState)
			out["kempstonPortReads"] = int(e.ula.KempstonPortReads)
			out["kempstonReadsWhileHeld"] = int(e.ula.KempstonReadsWhileHeld)
			// The ports the guest read that nothing answered, busiest
			// first. A game whose joystick "does nothing" is usually
			// polling one of these — and whether its low byte has A5
			// clear says whether a real Kempston interface would have
			// answered where we did not.
			tally := e.ula.UnattachedPortReads()
			type portCount struct {
				port byte
				n    uint64
			}
			var busy []portCount
			for p, n := range tally {
				if n > 0 {
					busy = append(busy, portCount{byte(p), n})
				}
			}
			sort.Slice(busy, func(i, j int) bool { return busy[i].n > busy[j].n })
			if len(busy) > 8 {
				busy = busy[:8]
			}
			top := []any{}
			for _, b := range busy {
				top = append(top, map[string]any{
					"port":   "0x" + strconv.FormatUint(uint64(b.port), 16),
					"reads":  int(b.n),
					// A real Kempston decodes on A5 low; if this is
					// true, hardware would have answered where we did not.
					"a5low": b.port&0x20 == 0,
				})
			}
			out["unattachedPorts"] = top
		}
		return js.ValueOf(out)
	}))

	// zxReset() -> "". Reboot the current machine (cold reset): 48K/128K return
	// to their boot ROM, Next to the welcome screen.
	g.Set("zxReset", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		if wasmEmu == nil {
			return "not booted"
		}
		wasmEmu.reboot()
		return ""
	}))

	// zxRunNex(name, Uint8Array) -> "" | errorString
	g.Set("zxRunNex", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if wasmEmu == nil {
			return "not booted"
		}
		data := make([]byte, a[1].Get("length").Int())
		js.CopyBytesToGo(data, a[1])
		wasmEmu.importAndRunNex(a[0].String(), data)
		return ""
	}))

	// zxRunBas(name, Uint8Array) -> "" | errorString. data is a PLUS3DOS-headered
	// NextBASIC program with an autostart line (the page's txt2bas emits this);
	// it's written to nextzxos/autoexec.bas and NextZXOS runs it on reboot.
	g.Set("zxRunBas", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if wasmEmu == nil {
			return "not booted"
		}
		if len(a) < 2 || a[1].IsNull() || a[1].IsUndefined() {
			return "run_bas: missing program data"
		}
		data := make([]byte, a[1].Get("length").Int())
		js.CopyBytesToGo(data, a[1])
		if err := wasmEmu.importAndRunBas(data); err != nil {
			return err.Error()
		}
		return ""
	}))

	// zxPutFile(path, Uint8Array) -> "" | errorString. Writes (or overwrites) a
	// file at path relative to the SD card root, creating directories as
	// needed, so a program delivered via zxRunBas can LOAD project assets
	// (sprite files etc.) at runtime by the same relative path — matching the
	// project ZIP's layout unzipped onto a real card. Every path segment must
	// fit FAT 8.3 — the program references the path literally. Call before
	// zxRunBas: its reboot re-reads the card, so files staged first are
	// visible to the program.
	g.Set("zxPutFile", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if wasmEmu == nil {
			return "not booted"
		}
		if len(a) < 2 || a[1].IsNull() || a[1].IsUndefined() {
			return "put_file: missing data"
		}
		data := make([]byte, a[1].Get("length").Int())
		js.CopyBytesToGo(data, a[1])
		if err := wasmEmu.putSDFile(a[0].String(), data); err != nil {
			return err.Error()
		}
		return ""
	}))

	// zxFrame(optional Uint8Array dst) -> {w,h,debug,paused,pc}. Advances one
	// frame and, if dst is given, copies the RGBA framebuffer into it. While a
	// debug session (wasm_debug_js.go) holds the machine paused, execution is
	// skipped and only the framebuffer is (re)rendered, so the page can keep
	// repainting after register/memory pokes; the debug fields let the frame
	// loop observe pause transitions (breakpoint hits, step-over landings).
	// The return object is CACHED and mutated field-by-field on change —
	// this is the hottest export (50+ calls/s, more during catch-up bursts
	// and the boot fast-forward), and a fresh js.ValueOf(map[...]) per call
	// costs a Go map allocation plus an Object construction and per-key
	// syscall/js writes. Every consumer (GoEmulator.js loop/debugRender,
	// gif-service runFrame) reads the fields synchronously within its own
	// tick and never retains the object. debug/paused/pc are now always
	// present (false/0 when no session is attached) — consumers truth-test
	// d.debug, so the shape change is invisible to them.
	frameRet := js.ValueOf(map[string]any{"w": 0, "h": 0, "debug": false, "paused": false, "pc": 0})
	var frameW, frameH, framePC int
	var frameDebug, framePaused bool
	setFrameDims := func(w, h int) {
		if frameW != w {
			frameW = w
			frameRet.Set("w", w)
		}
		if frameH != h {
			frameH = h
			frameRet.Set("h", h)
		}
	}
	g.Set("zxFrame", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if wasmEmu == nil {
			setFrameDims(0, 0)
			return frameRet
		}
		e := wasmEmu
		dbgPaused := wasmDebugPaused(e)
		if !dbgPaused {
			t0 := time.Now()
			e.cpu.ExecuteFrame(e.frameTStates())
			if e.peripherals != nil {
				e.peripherals.Frame()
			}
			if e.kbd != nil {
				e.kbd.Tick()
			}
			if e.nexloadMacro != nil && e.nexloadMacro.tick(e) {
				e.nexloadMacro = nil
			}
			e.noteBootFrame()
			perfExecNs += int64(time.Since(t0))
			// A breakpoint / watchpoint / one-shot may have fired mid-frame.
			dbgPaused = wasmDebugPaused(e)
		}
		t1 := time.Now()
		img := e.renderFrame() // *image.RGBA
		perfRenderNs += int64(time.Since(t1))
		perfFrames++
		// Guard null as well as undefined: CopyBytesToJS panics on a null
		// destination, and a panic in a js.FuncOf callback kills the whole
		// Go program ("Go program has already exited" on every later call).
		if len(a) > 0 && !a[0].IsUndefined() && !a[0].IsNull() {
			js.CopyBytesToJS(a[0], img.Pix)
		}
		b := img.Bounds()
		setFrameDims(b.Dx(), b.Dy())
		dbg := wasmDebugAttached(e)
		if frameDebug != dbg {
			frameDebug = dbg
			frameRet.Set("debug", dbg)
		}
		if dbg {
			if framePaused != dbgPaused {
				framePaused = dbgPaused
				frameRet.Set("paused", dbgPaused)
			}
			if pc := int(e.cpu.PC); framePC != pc {
				framePC = pc
				frameRet.Set("pc", pc)
			}
		}
		return frameRet
	}))

	// zxPerfSplit() -> {execMs, renderMs, frames}. Drains the zxFrame
	// execute-vs-render wall-time accumulators (totals since the last
	// call; divide by frames for per-frame ms). Polled by GoEmulator.js's
	// once-per-second FPS tally, so the fresh js.ValueOf map here is off
	// the hot path.
	g.Set("zxPerfSplit", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		ret := js.ValueOf(map[string]any{
			"execMs":   float64(perfExecNs) / 1e6,
			"renderMs": float64(perfRenderNs) / 1e6,
			"frames":   perfFrames,
		})
		perfExecNs, perfRenderNs, perfFrames = 0, 0, 0
		return ret
	}))

	// zxType — printable runes via TypeRune. Named keys deferred (boot and .nex
	// run without them).
	g.Set("zxType", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if wasmEmu != nil && wasmEmu.kbd != nil && len(a) > 0 {
			wasmEmu.kbd.TypeRune(rune(a[0].Int()))
		}
		return nil
	}))
	// zxKeyName(name, down, shift) — the iframe sends fyne key-name strings
	// (Return, Space, Up, A..Z, 0..9, ...); reuse the desktop's exact matrix
	// mapping so letters, digits, Enter, Space and arrows all work.
	g.Set("zxKeyName", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if wasmEmu == nil || wasmEmu.kbd == nil || len(a) < 2 {
			return nil
		}
		name := fyne.KeyName(a[0].String())
		down := a[1].Bool()
		shift := len(a) > 2 && a[2].Bool()
		wasmEmu.kbd.HandleKeyWithModifiers(name, down, shift, false, false, false)
		return nil
	}))

	// zxPullAudio(dst Uint8Array) -> n. Drains up to len(dst)/2 mixed mono
	// int16 samples (44.1kHz LE) from the audio ring into dst, returning the
	// sample count — no underrun padding, so n can be 0. The iframe calls this
	// once per displayed frame and posts the chunk to its AudioWorklet, which
	// owns buffering policy on the audio render thread.
	var pullSamples []int16
	var pullBytes []byte
	g.Set("zxPullAudio", js.FuncOf(func(_ js.Value, a []js.Value) any {
		e := wasmEmu
		if e == nil || e.ula == nil || len(a) < 1 {
			return 0
		}
		as := e.ula.Audio()
		if as == nil {
			return 0
		}
		want := a[0].Get("length").Int() / 2
		if want <= 0 {
			return 0
		}
		if cap(pullSamples) < want {
			pullSamples = make([]int16, want)
			pullBytes = make([]byte, want*2)
		}
		n := as.PullMono(pullSamples[:want])
		if n == 0 {
			return 0
		}
		for i := 0; i < n; i++ {
			v := uint16(pullSamples[i])
			pullBytes[2*i] = byte(v)
			pullBytes[2*i+1] = byte(v >> 8)
		}
		js.CopyBytesToJS(a[0], pullBytes[:n*2])
		return n
	}))

	// zxTmDebug() -> JSON of the tilemap raster-stamp fold diagnostics
	// (#205 browser-garble investigation): fold/capture flags, stamp
	// counts and a sample of the folded per-line scroll table.
	g.Set("zxTmDebug", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		e := wasmEmu
		if e == nil || e.nextTilemap == nil {
			return "{}"
		}
		st := e.nextTilemap.DebugFoldState()
		keys := make([]string, 0, len(st))
		for k := range st {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var sb strings.Builder
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			sb.WriteString(`"` + k + `":` + strconv.Itoa(st[k]))
		}
		sb.WriteByte('}')
		return sb.String()
	}))

	// zxModel() -> "" | model name (e.g. "ZX Spectrum 48K", "ZX Spectrum Next").
	// Empty until a machine has finished constructing — boots run in
	// goroutines, so the host polls this to know when a model switch landed
	// (e.g. before zxRunNex, which silently no-ops on a classic machine).
	g.Set("zxModel", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		e := wasmEmu
		if e == nil {
			return ""
		}
		return roms.GetModelName(e.model)
	}))

	// zxMacroActive() -> bool. True while a keystroke macro (nexload / BASIC
	// load / tape auto-run) is still driving the machine. Headless renderers
	// (gif-service) use it to skip the boot-and-typing dead time and start
	// capturing at the program's own first frames.
	g.Set("zxMacroActive", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		e := wasmEmu
		return e != nil && e.nexloadMacro != nil
	}))

	// zxMacroProgress() -> 0..1 fraction of the active keystroke macro's
	// script, or -1 when no macro is driving. The page's loading indicator
	// fills its ring with this through the launch (boot + menu + Browser
	// navigation); condition-driven steps report against nominal durations,
	// so it is an estimate that never runs backwards.
	g.Set("zxMacroProgress", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		e := wasmEmu
		if e == nil || e.nexloadMacro == nil {
			return -1.0
		}
		return e.nexloadMacro.progress()
	}))

	// zxFastBoot() -> bool. True while the Spectrum Next is still booting
	// (or a load macro is still typing) and the page should fast-forward:
	// run extra zxFrame calls per displayed frame and discard the audio.
	// See fastboot.go for the exact conditions and rationale.
	g.Set("zxFastBoot", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		e := wasmEmu
		return e != nil && e.bootFastForwardActive()
	}))

	// zxAudioDebug() -> {events, mult, speaker} (diagnostic).
	g.Set("zxAudioDebug", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		e := wasmEmu
		if e == nil || e.ula == nil {
			return js.ValueOf(map[string]any{"events": -1, "mult": -1, "speaker": false})
		}
		mult := 1
		if e.cpu != nil {
			mult = e.cpu.SpeedMultiplier()
		}
		return js.ValueOf(map[string]any{
			"events":  e.ula.LastAudioEventCount,
			"mult":    mult,
			"speaker": e.ula.Speaker,
		})
	}))

	// zxAudioLevel() -> peak |beeper sample| since last call (diagnostic).
	g.Set("zxAudioLevel", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		return int(audio.LastPeak())
	}))

	setupWasmDebugExports(g)

	g.Set("zxReady", js.ValueOf(true))
}
