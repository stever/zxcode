package main

import (
	"image/png"
	"os"
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
)

// TestAticAtacStagingProbe (diagnostic, #187): find the control-flow
// window around the game's engine-staging write (16K bank 3 offset
// $11DD ← $18, the $D1DD streamer byte) so a real-hardware breakpoint
// can be planted post-staging. Dumps the PC ring before the write and
// the execution trail after it.
func TestAticAtacStagingProbe(t *testing.T) {
	if os.Getenv("ZX_GO_ATIC_PROBE") == "" {
		t.Skip("diagnostic probe; set ZX_GO_ATIC_PROBE=1 to run")
	}
	nexData, err := os.ReadFile("/home/steve/Downloads/ZX Spectrum Next/Atic Atac/ATICATAC.NEX")
	if err != nil {
		t.Skipf("no local Atic Atac: %v", err)
	}
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
		t.Skip("no SD image mounted")
	}

	// Record control TRANSFERS (non-sequential PC steps) — raw PCs
	// drown in the loader's unrolled LDI slabs.
	type xfer struct {
		from, to, sp uint16
		frame        int32
	}
	const ringSize = 32768
	ring := make([]xfer, ringSize)
	ri := 0
	lastPC := uint16(0)
	sampleN := 0
	staged := false
	post := 0
	firstD1DD := false
	frame := 0

	prevHook := emu.mem.GetRAMWriteHook()
	emu.mem.SetRAMWriteHook(func(bank int, addr uint16, val byte) {
		if prevHook != nil {
			prevHook(bank, addr, val)
		}
		if !staged && bank == 3 && addr == 0x11DD && val == 0x18 && frame > 3000 {
			staged = true
			slots := make([]byte, 8)
			for i := byte(0); i < 8; i++ {
				slots[i] = emu.mem.GetMMU(i)
			}
			t.Logf("STAGING WRITE at frame %d, pc=$%04X mmu=%02X", frame, emu.cpu.PC, slots)
			t.Logf("last 60 transfers:")
			for i := ringSize - 60; i < ringSize; i++ {
				x := ring[(ri+i)%ringSize]
				t.Logf("  $%04X -> $%04X (sp=$%04X)", x.from, x.to, x.sp)
			}
		}
	})
	emu.cpu.AddPreFetchHook("stage-probe", func(pc uint16) {
		if frame >= 5020 && frame <= 5023 {
			sampleN++
			if sampleN%700 == 0 {
				t.Logf("s f%d pc=%04X sp=%04X iy=%04X", frame, pc, emu.cpu.SP, emu.cpu.IY)
			}
		}
		if frame == 5020 && sampleN == 1 {
			var m [0x80]byte
			for i := range m {
				m[i] = emu.mem.Read(0x1C00 + uint16(i))
			}
			t.Logf("code1C00: % x", m)
			for i := range m {
				m[i] = emu.mem.Read(0x2680 + uint16(i))
			}
			t.Logf("stack2680: % x", m)
		}
		d := pc - lastPC
		if d > 4 && d < 0xFFF0 && emu.mem.Read(pc) != 0 && pc != 0x0066 && lastPC != 0x0066 { // structural: skip tight loops + NMI
			ring[ri] = xfer{from: lastPC, to: pc, sp: emu.cpu.SP, frame: int32(frame)}
			ri = (ri + 1) % ringSize
			if staged && lastPC >= 0xE000 && pc < 0xE000 {
				post++
				t.Logf("exitE+%03d $%04X -> $%04X (sp=$%04X, frame %d)", post, lastPC, pc, emu.cpu.SP, frame)
			}
		}
		if frame > 5050 && pc >= 0xA600 && pc < 0xA700 && !firstD1DD {
			firstD1DD = true
			t.Logf("FIRST idle-loop entry ($%04X) at frame %d — dumping %d transfers", pc, frame, ringSize)
			// Compress: log only transfers NOT part of the NMI rhythm
			// (from/to $0066 pairs), plus the first few per frame.
			perFrame := map[int32]int{}
			for i := 0; i < ringSize; i++ {
				x := ring[(ri+i)%ringSize]
				if x.from == 0 && x.to == 0 {
					continue
				}
				isNMI := x.to == 0x0066 || x.from == 0x0066 ||
					(x.to&0xFF00) < 0x4000 && x.from > 0x8000
				if isNMI {
					if perFrame[x.frame] > 2 {
						continue
					}
					perFrame[x.frame]++
				}
				t.Logf("x f%d %04X->%04X sp=%04X", x.frame, x.from, x.to, x.sp)
			}
			var m [0x40]byte
			for i := range m {
				m[i] = emu.mem.Read(0xDAC0 + uint16(i))
			}
			t.Logf("DAC0: % x", m)
			for i := range m {
				m[i] = emu.mem.Read(0xDCA2 + uint16(i))
			}
			t.Logf("DCA2: % x", m)
			var sl [8]byte
			for i := byte(0); i < 8; i++ {
				sl[i] = emu.mem.GetMMU(i)
			}
			t.Logf("slots: %02X  IY=%04X SP=%04X", sl, emu.cpu.IY, emu.cpu.SP)
		}
		lastPC = pc
	})

	for frame = 0; frame < 8000 && !firstD1DD; frame++ {
		if frame == 3000 {
			emu.importAndRunNex("Atic Atac/ATICATAC.NEX", nexData)
		}
		switch frame {
		case 5000:
			emu.ula.SetKempstonButton(0x10, true)
		case 5030:
			emu.ula.SetKempstonButton(0x10, false)
		}
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
		if frame == 7000 {
			fp, _ := os.Create(os.Getenv("ZX_GO_ATIC_PROBE_DIR") + "/stage_7000.png")
			if fp != nil {
				_ = png.Encode(fp, emu.renderFrame())
				fp.Close()
			}
		}
		emu.renderFrame()
		emu.noteBootFrame()
	}
	if !staged {
		t.Fatal("staging write never observed")
	}
}

func appendPC(b []byte, pc uint16) []byte {
	const hex = "0123456789ABCDEF"
	if len(b) > 0 {
		b = append(b, ' ')
	}
	return append(b, hex[pc>>12], hex[pc>>8&0xF], hex[pc>>4&0xF], hex[pc&0xF])
}
