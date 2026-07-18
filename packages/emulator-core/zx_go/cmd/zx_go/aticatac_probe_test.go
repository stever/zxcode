package main

import (
	"fmt"
	"image/png"
	"os"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// TestAticAtacDoorsProbe is a DIAGNOSTIC harness for work item #187, not a
// regression test: it drives the real Atic Atac release (local file, never
// committed) through title → cinematic-skip → menu-select and then watches
// the audio engine's scene-gate state at the "doors" screen, where the game
// waits for its music-position counter ($F9E3) to reach a threshold before
// posting scene-advance event $16 to $F996. Skips unless the game file and
// an SD image are present. Run with -run TestAticAtacDoorsProbe -v.
func TestAticAtacDoorsProbe(t *testing.T) {
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
		t.Skip("no SD image mounted (set ZX_GO_NEXT_SD_IMG)")
	}

	outDir := os.Getenv("ZX_GO_ATIC_PROBE_DIR")
	if outDir == "" {
		outDir = t.TempDir()
	}
	shot := func(frame int, tag string) {
		fp, err := os.Create(fmt.Sprintf("%s/probe_%06d_%s.png", outDir, frame, tag))
		if err != nil {
			return
		}
		defer fp.Close()
		_ = png.Encode(fp, emu.renderFrame())
	}

	// Log every write to the audio-engine gate block: $F996 (event byte),
	// $F9E3/$F9E4 (music position word), $F990 (slow countdown observed at
	// the doors screen). Logical-address hook: fires on every CPU write.
	frame := 0
	var lastPos [2]byte
	emu.mem.SetAllWriteHook(func(addr uint16, val byte) {
		switch addr {
		case 0xF996:
			if val != 0 {
				t.Logf("frame %6d: EVENT $F996 <- $%02X (pc=$%04X)", frame, val, emu.cpu.PC)
			}
		case 0xF9E3:
			if val != lastPos[0] {
				lastPos[0] = val
				t.Logf("frame %6d: POS.lo $F9E3 <- $%02X (pc=$%04X)", frame, val, emu.cpu.PC)
			}
		case 0xF9E4:
			if val != lastPos[1] {
				lastPos[1] = val
				t.Logf("frame %6d: POS.hi $F9E4 <- $%02X (pc=$%04X)", frame, val, emu.cpu.PC)
			}
		case 0xF990:
			t.Logf("frame %6d: CNT $F990 <- $%02X (pc=$%04X)", frame, val, emu.cpu.PC)
		}
	})

	kempston := func(down bool) {
		emu.ula.SetKempstonButton(0x10, down)
	}

	// Count NMI deliveries (PC entering $0066) per snapshot window.
	nmiCount := 0
	emu.cpu.AddPreFetchHook("atic-nmi-count", func(pc uint16) {
		if pc == 0x0066 {
			nmiCount++
		}
	})

	const maxFrames = 26000
	importAt := 3000
	lastSD := 0
	for frame = 0; frame < maxFrames; frame++ {
		if frame == importAt {
			emu.importAndRunNex("Atic Atac/ATICATAC.NEX", nexData)
		}
		switch frame {
		case 5000, 6500, 8000, 10000:
			kempston(true)
		case 5030, 6530, 8030, 10030:
			kempston(false)
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
		emu.renderFrame()
		emu.noteBootFrame()

		if frame%1000 == 0 {
			sd := 0
			if emu.sdCard != nil {
				sd = int(emu.sdCard.DataBlocksRead())
			}
			t.Logf("frame %6d: pc=$%04X F996=$%02X F9E3=$%02X%02X F990=$%02X sd+%d nmi+%d",
				frame, emu.cpu.PC,
				emu.mem.Read(0xF996),
				emu.mem.Read(0xF9E4), emu.mem.Read(0xF9E3),
				emu.mem.Read(0xF990), sd-lastSD, nmiCount)
			lastSD = sd
			nmiCount = 0
		}
		switch frame {
		case 5500, 7000, 8500, 10500, 12000, 14500, 17500, 20000, 25000:
			shot(frame, "stage")
		}
	}
	t.Logf("done: screenshots in %s", outDir)
}
