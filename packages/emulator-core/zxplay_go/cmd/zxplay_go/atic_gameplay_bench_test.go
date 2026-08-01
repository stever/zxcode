package main

import (
	"os"
	"runtime/pprof"
	"testing"

	"github.com/stever/zxplay_go/pkg/next/copper"
	"github.com/stever/zxplay_go/pkg/roms"
)

// aticGameplayEmulator boots the machine to real Atic Atac GAMEPLAY —
// the #187 browser-performance scenario: 28 MHz CPU, 320×256 Layer 2
// (hi-res wide render path), sprites, and the game's free-running
// ~20 kHz copper NMI pacer list — by replaying the doors probe's input
// schedule (import at frame 3000, fire at 5000 to skip the story crawl,
// SPACE at 5060 to select the Knight, gameplay stable by ~5400).
// Skips when the Next ROMs, SD image or the local ATICATAC.NEX are
// absent, so the full gate is unaffected on machines without them.
func aticGameplayEmulator(tb testing.TB) *emulator {
	tb.Helper()
	nexData, err := os.ReadFile("/home/steve/Downloads/ZX Spectrum Next/Atic Atac/ATICATAC.NEX")
	if err != nil {
		tb.Skipf("no local Atic Atac: %v", err)
	}
	// The probe's boot mode: direct boot reaches the NextZXOS menu by
	// frame 3000 on the prepped card.
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
	for frame := 0; frame < 5400; frame++ {
		if frame == 3000 {
			emu.importAndRunNex("Atic Atac/ATICATAC.NEX", nexData)
		}
		switch frame {
		case 5000:
			emu.ula.SetKempstonButton(0x10, true)
		case 5030:
			emu.ula.SetKempstonButton(0x10, false)
		case 5060:
			emu.kbd.PressMatrixKey(7, 0x01, true) // SPACE — select Knight
		case 5088:
			emu.kbd.PressMatrixKey(7, 0x01, false)
		}
		runOneFrame(emu)
	}
	return emu
}

// runOneFrame advances the machine exactly as the wasm zxFrame export
// does: execute, peripherals, keyboard, macro, render.
func runOneFrame(emu *emulator) {
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
	emu.renderFrame()
	emu.noteBootFrame()
}

// BenchmarkAticGameplayFrame measures one emulated frame during REAL
// Atic Atac gameplay — the render-inclusive #187 browser scenario (the
// BenchmarkNextFrame28MHz fixture idles in the NextZXOS menu with a
// synthetic pacer, which exercises a different render path: no hi-res
// Layer 2, no sprites). "full" is execute+peripherals+render (the
// wasm zxFrame body); "execonly" isolates the CPU loop, so full minus
// execonly reads as the render cost.
func BenchmarkAticGameplayFrame(b *testing.B) {
	for _, cfg := range []struct {
		name   string
		render bool
	}{{"full", true}, {"execonly", false}} {
		b.Run(cfg.name, func(b *testing.B) {
			emu := aticGameplayEmulator(b)
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

// TestAticGameplayRenderAudit (diagnostic, #187): evidence that Atic
// Atac's copper pacer list is classified video-inert during gameplay —
// so the compositor walk keeps the coalesced per-row stride instead of
// the per-half-pixel paced one — and a clean CPU profile of a
// gameplay-era frame loop for attributing the remaining render cost.
// Set ZX_GO_ATIC_PERF=1 to run; ZX_GO_ATIC_PERF_PROFILE=<file> also
// writes a CPU profile of 500 gameplay frames.
func TestAticGameplayRenderAudit(t *testing.T) {
	if os.Getenv("ZX_GO_ATIC_PERF") == "" {
		t.Skip("diagnostic; set ZX_GO_ATIC_PERF=1 to run")
	}
	emu := aticGameplayEmulator(t)
	c := emu.nextCopper
	if c == nil {
		t.Fatal("no copper wired")
	}
	nMove, nNoop, nWait, nHalt := 0, 0, 0, 0
	moveRegs := map[byte]int{}
	for i := 0; i < copper.MaxInstructions; i++ {
		in := c.Instruction(uint16(i))
		switch in.Op {
		case copper.OpMOVE:
			nMove++
			moveRegs[in.Reg]++
		case copper.OpWAIT:
			nWait++
		case copper.OpHALT:
			nHalt++
		default:
			nNoop++
		}
	}
	t.Logf("copper list at gameplay: %d MOVE %d NOOP %d WAIT %d HALT; MOVE targets: %v",
		nMove, nNoop, nWait, nHalt, moveRegs)
	t.Logf("HasVideoMoves() = %v (false = every row takes the coalesced fast stride)", c.HasVideoMoves())
	retire := 0
	for y := 0; y < 192; y++ {
		if c.CanRetireOnLine(uint16(y)) {
			retire++
		}
	}
	t.Logf("CanRetireOnLine true on %d/192 paper lines (irrelevant when HasVideoMoves=false)", retire)
	for _, reg := range []byte{0x02, 0x7F} {
		if moveRegs[reg] == 0 {
			t.Logf("note: expected pacer MOVE target NR$%02X absent", reg)
		}
	}
	if c.HasVideoMoves() {
		t.Errorf("gameplay copper list classified as video-affecting; paced stride would run on every row")
	}
	if f := os.Getenv("ZX_GO_ATIC_PERF_PROFILE"); f != "" {
		fp, err := os.Create(f)
		if err != nil {
			t.Fatal(err)
		}
		defer fp.Close()
		if err := pprof.StartCPUProfile(fp); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 500; i++ {
			runOneFrame(emu)
		}
		pprof.StopCPUProfile()
		t.Logf("cpu profile of 500 gameplay frames written to %s", f)
	}
}
