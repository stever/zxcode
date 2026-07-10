//go:build js && wasm

package main

import (
	"strings"
	"syscall/js"

	fyne "fyne.io/fyne/v2"

	"github.com/conorarmstrong/zx_go/pkg/audio"
	"github.com/conorarmstrong/zx_go/pkg/next/divmmc"
	"github.com/conorarmstrong/zx_go/pkg/next/install"
	"github.com/conorarmstrong/zx_go/pkg/next/sdcard"
	"github.com/conorarmstrong/zx_go/pkg/roms"
	"github.com/conorarmstrong/zx_go/pkg/snapshot"
)

var wasmEmu *emulator

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

	// zxBootNext(sd Uint8Array) -> "". Construction calls audio.New(), which
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
		go func() {
			e, err := newNextEmulator()
			if err != nil {
				js.Global().Get("console").Call("error", "zxBootNext: "+err.Error())
				return
			}
			// next.go's disk SD auto-load is skipped on wasm (SDCardImage()==""),
			// so mount the passed image here, mirroring next.go's mount sequence.
			if sd != nil {
				if src, serr := sdcard.NewImageSource(sd, false); serr == nil {
					e.sdImageSrc = src
					card := sdcard.NewCard(src)
					if p, ok := e.ula.NextDivMMC().(*divmmc.Pager); ok {
						p.SetCard(card)
					}
				} else {
					js.Global().Get("console").Call("error", "zxBootNext sd: "+serr.Error())
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
	// each frame to derive the playingTape/stoppedTape events.
	g.Set("zxTapeStatus", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		e := wasmEmu
		if e == nil || e.ula == nil {
			return js.ValueOf(map[string]any{"inserted": false, "playing": false, "block": 0, "blocks": 0})
		}
		tp := e.ula.GetTapePlayer()
		if tp == nil {
			return js.ValueOf(map[string]any{"inserted": false, "playing": false, "block": 0, "blocks": 0})
		}
		return js.ValueOf(map[string]any{
			"inserted": true,
			"playing":  tp.IsPlaying(),
			"block":    tp.CurrentBlock(),
			"blocks":   tp.BlockCount(),
		})
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

	// zxFrame(optional Uint8Array dst) -> {w,h[,debug,paused,pc]}. Advances one
	// frame and, if dst is given, copies the RGBA framebuffer into it. While a
	// debug session (wasm_debug_js.go) holds the machine paused, execution is
	// skipped and only the framebuffer is (re)rendered, so the page can keep
	// repainting after register/memory pokes; the debug fields let the frame
	// loop observe pause transitions (breakpoint hits, step-over landings).
	g.Set("zxFrame", js.FuncOf(func(_ js.Value, a []js.Value) any {
		if wasmEmu == nil {
			return js.ValueOf(map[string]any{"w": 0, "h": 0})
		}
		e := wasmEmu
		dbgPaused := wasmDebugPaused(e)
		if !dbgPaused {
			e.cpu.ExecuteFrame(frameTStatesForModel(e.model))
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
			// A breakpoint / watchpoint / one-shot may have fired mid-frame.
			dbgPaused = wasmDebugPaused(e)
		}
		img := e.renderFrame() // *image.RGBA
		// Guard null as well as undefined: CopyBytesToJS panics on a null
		// destination, and a panic in a js.FuncOf callback kills the whole
		// Go program ("Go program has already exited" on every later call).
		if len(a) > 0 && !a[0].IsUndefined() && !a[0].IsNull() {
			js.CopyBytesToJS(a[0], img.Pix)
		}
		b := img.Bounds()
		ret := map[string]any{"w": b.Dx(), "h": b.Dy()}
		if wasmDebugAttached(e) {
			ret["debug"] = true
			ret["paused"] = dbgPaused
			ret["pc"] = int(e.cpu.PC)
		}
		return js.ValueOf(ret)
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
