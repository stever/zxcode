package main

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// benchNextEmulator builds the same headless Next fixture the pacer
// test uses, optionally programs an Atic Atac-style copper NMI pacer
// list (1024 entries, final MOVE NR$02,$04, free-running mode %01),
// forces 28 MHz (NR$07=3 — Atic Atac's speed), and runs warm-up frames
// so the benchmark loop measures a settled machine rather than the
// cold-boot transient.
func benchNextEmulator(b *testing.B, pacer bool) *emulator {
	b.Helper()
	prev := cliFlagsActive
	nf := cliFlags{}
	if prev != nil {
		nf = *prev
	}
	nf.noSound = true
	cliFlagsActive = &nf
	b.Cleanup(func() { cliFlagsActive = prev })

	emu, err := newNextEmulator()
	if err != nil {
		b.Skipf("Next ROMs not installed: %v", err)
	}
	d := emu.nextRegs
	if pacer {
		d.WriteReg(0x06, d.Raw(0x06)|0x10)
		writeWord := func(i int, w uint16) {
			d.WriteReg(0x61, byte((i*2)&0xFF))
			d.WriteReg(0x62, byte((i*2)>>8&0x07))
			d.WriteReg(0x63, byte(w>>8))
			d.WriteReg(0x63, byte(w))
		}
		for i := 0; i < 687; i++ {
			writeWord(i, 0x0000)
		}
		for i := 687; i < 1023; i++ {
			writeWord(i, 0x7F00)
		}
		writeWord(1023, 0x0204)
		d.WriteReg(0x62, 0x40)
	}
	// Atic Atac runs the CPU at 28 MHz: ~567k T-states per frame.
	d.WriteReg(0x07, 0x03)
	for i := 0; i < 100; i++ {
		emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		emu.renderFrame()
	}
	return emu
}

// BenchmarkNextFrame28MHz measures one emulated frame (CPU +
// peripherals + render) at 28 MHz with and without an Atic Atac-style
// copper NMI pacer list armed — the browser's per-frame budget is 20 ms
// (50 fps), so ns/op here reads directly as native headroom.
func BenchmarkNextFrame28MHz(b *testing.B) {
	for _, cfg := range []struct {
		name  string
		pacer bool
	}{{"pacer", true}, {"nopacer", false}} {
		b.Run(cfg.name, func(b *testing.B) {
			emu := benchNextEmulator(b, cfg.pacer)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
				if emu.peripherals != nil {
					emu.peripherals.Frame()
				}
				emu.renderFrame()
			}
		})
	}
}

// BenchmarkNextExecuteFrame28MHz isolates the CPU loop (no render, no
// peripheral tick): the ExtNMIFunc/ExtIntFunc per-instruction dispatch
// overhead lives here.
func BenchmarkNextExecuteFrame28MHz(b *testing.B) {
	for _, cfg := range []struct {
		name  string
		pacer bool
	}{{"pacer", true}, {"nopacer", false}} {
		b.Run(cfg.name, func(b *testing.B) {
			emu := benchNextEmulator(b, cfg.pacer)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
			}
		})
	}
}
