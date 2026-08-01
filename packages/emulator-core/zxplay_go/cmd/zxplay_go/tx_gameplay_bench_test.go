package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime/pprof"
	"strings"
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
)

// txGameplayEmulator boots the machine to real TX-1696 GAMEPLAY — the
// #208 browser-performance scenario: 28 MHz CPU, the game's per-band
// copper list (stop → ~512-byte re-upload → start EVERY frame, #205),
// tilemap HUD strip, sprites, and the ~22 kHz CTC/IM2-driven $DF DAC
// sample engine — by replaying the #205 probe's flow (stage the local
// game folder via putSDFile, Browser-launch TX-1696/main.nex at frame
// 3000) and the menu input schedule discovered there: SPACE at 6000
// (story crawl → title menu), 8200 (PLAY → level select), 9500 (start
// level; gameplay stable well before 11000).
// Skips when the Next ROMs, SD image or the local TX-1696 folder are
// absent, so the full gate is unaffected on machines without them.
func txGameplayEmulator(tb testing.TB) *emulator {
	tb.Helper()
	const gameRoot = "/home/steve/Downloads/ZX Spectrum Next/TX-1696"
	nexData, err := os.ReadFile(gameRoot + "/main.nex")
	if err != nil {
		tb.Skipf("no local TX-1696: %v", err)
	}
	tb.Setenv("ZX_GO_NO_FPGA_BOOTROM", "1")
	tb.Setenv("ZX_GO_NEXT_DIRECT_BOOT", "1")
	tb.Setenv("ZX_GO_RTC_FIXED", "2026-07-01T12:00:00Z")
	prev := cliFlagsActive
	nf := cliFlags{}
	if prev != nil {
		nf = *prev
	}
	nf.noSound = true
	cliFlagsActive = &nf
	tb.Cleanup(func() { cliFlagsActive = prev })
	emu, err := newNextEmulator()
	if err != nil {
		tb.Skipf("Next ROMs not installed: %v", err)
	}
	if emu.sdImageSrc == nil {
		tb.Skip("no SD image mounted (set ZX_GO_NEXT_SD_IMG)")
	}
	stageAndLaunch := func() {
		err := filepath.Walk(gameRoot, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(gameRoot, path)
			rel = filepath.ToSlash(rel)
			if rel == "main.nex" {
				return nil // importAndRunNex stages the .nex itself
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			return emu.putSDFile("TX-1696/"+rel, data)
		})
		if err != nil {
			tb.Fatalf("stage %s: %v", gameRoot, err)
		}
		emu.importAndRunNex("TX-1696/main.nex", nexData)
		if emu.nexloadMacro == nil {
			tb.Fatal("importAndRunNex did not arm the Browser launch macro")
		}
	}
	for frame := 0; frame < 11500; frame++ {
		if frame == 3000 {
			stageAndLaunch()
		}
		switch frame {
		case 6000, 8200, 9500:
			emu.kbd.PressMatrixKey(7, 0x01, true) // SPACE
		case 6028, 8228, 9528:
			emu.kbd.PressMatrixKey(7, 0x01, false)
		}
		runOneFrame(emu)
	}
	return emu
}

// BenchmarkTXGameplayFrame measures one emulated frame during REAL
// TX-1696 gameplay — the #208 browser scenario (28 fps in wasm: exec
// ~17 ms + render ~18.6 ms per frame at r90). Unlike Atic Atac's
// video-inert NMI pacer list, TX-1696's copper program is per-band
// VIDEO writes, so the render pass takes the paced per-half-pixel
// stride — the suspected render cost. "full" is
// execute+peripherals+render (the wasm zxFrame body); "execonly"
// isolates the CPU loop, so full minus execonly reads as render cost.
func BenchmarkTXGameplayFrame(b *testing.B) {
	for _, cfg := range []struct {
		name   string
		render bool
	}{{"full", true}, {"execonly", false}} {
		b.Run(cfg.name, func(b *testing.B) {
			emu := txGameplayEmulator(b)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
				if emu.peripherals != nil {
					emu.peripherals.Frame()
				}
				if cfg.render {
					emu.renderFrame()
				}
			}
		})
	}
}

// TestTXGameplayAudit (diagnostic, #208): the gameplay-era copper list
// and per-line stride classification — which rows the render pass paces
// per half-pixel and why — plus an optional CPU profile of gameplay
// frames for attributing exec/render cost.
// Set ZX_GO_TX_PERF=1 to run; ZX_GO_TX_PERF_PROFILE=<file> also writes
// a CPU profile of 300 gameplay frames.
func TestTXGameplayAudit(t *testing.T) {
	if os.Getenv("ZX_GO_TX_PERF") == "" {
		t.Skip("diagnostic; set ZX_GO_TX_PERF=1 to run")
	}
	emu := txGameplayEmulator(t)
	c := emu.nextCopper
	if c == nil {
		t.Fatal("no copper wired")
	}
	d := &remoteDebugger{emu: emu}
	// Compact disasm: skip NOOP runs (the list pads with them).
	var sb, run strings.Builder
	noops := 0
	for _, line := range strings.Split(d.cmdCopperDisasm(), "\n") {
		if strings.HasSuffix(strings.TrimSpace(line), "NOOP") {
			noops++
			continue
		}
		if noops > 0 {
			fmt.Fprintf(&run, "          ... %d x NOOP\n", noops)
			sb.WriteString(run.String())
			run.Reset()
			noops = 0
		}
		sb.WriteString(line)
		sb.WriteByte('\n')
	}
	if noops > 0 {
		fmt.Fprintf(&sb, "          ... %d x NOOP\n", noops)
	}
	t.Logf("copper list at gameplay (NOOP runs elided):\n%s", sb.String())
	t.Logf("HasVideoMoves() = %v", c.HasVideoMoves())
	retire := 0
	for y := 0; y < 192; y++ {
		if c.CanRetireOnLine(uint16(y)) {
			retire++
		}
	}
	t.Logf("CanRetireOnLine true on %d/192 paper lines (static, end-of-frame pc)", retire)
	// Walk-time truth: one live frame, then the walk's stride census.
	runOneFrame(emu)
	paced, half, borderEv := emu.ula.DebugStrideCounts()
	t.Logf("live-frame stride census: paced=%d half=%d (of 192 paper rows) borderEvented=%d",
		paced, half, borderEv)
	if f := os.Getenv("ZX_GO_TX_PERF_PROFILE"); f != "" {
		fp, err := os.Create(f)
		if err != nil {
			t.Fatal(err)
		}
		defer fp.Close()
		if err := pprof.StartCPUProfile(fp); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 300; i++ {
			runOneFrame(emu)
		}
		pprof.StopCPUProfile()
		t.Logf("cpu profile of 300 gameplay frames written to %s", f)
	}
}
