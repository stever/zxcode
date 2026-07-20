package main

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/install"
)

// TestWOTEF206Probe (diagnostic, #206): "Way Of The Exploding Fist may
// need 60 Hz to work properly". Mirrors the browser's game-zip flow:
// every file of the local game folder is staged onto the card under
// "Way Of The Exploding Fist/" via putSDFile, then WOTEF.nex is
// Browser-launched under its original folder + filename. Instruments
// screenshots, NR $03/$05/$07 traffic (the 50/60 Hz selection the game
// may read or write), live frame-geometry changes, DAC write volume
// and SD read volume so the failure mode is visible from the log.
// Set ZX_GO_WOTEF_PROBE=1 to run. Env:
//
//	ZX_GO_WOTEF_ROOT        game folder (default ~/Documents/... library)
//	ZX_GO_WOTEF_FRAMES      total frames (default 20000)
//	ZX_GO_WOTEF_DIR         screenshot/output directory
//	ZX_GO_WOTEF_SHOT_EVERY  screenshot cadence from launch (default 250)
//	ZX_GO_WOTEF_INPUTS      frame:key list (space/enter/1/2/o/p/q/a/m)
//	ZX_GO_WOTEF_60HZ        set NR$05 bit 2 (60 Hz) before launch
func TestWOTEF206Probe(t *testing.T) {
	if os.Getenv("ZX_GO_WOTEF_PROBE") == "" {
		t.Skip("diagnostic probe; set ZX_GO_WOTEF_PROBE=1 to run")
	}
	gameRoot := os.Getenv("ZX_GO_WOTEF_ROOT")
	if gameRoot == "" {
		gameRoot = os.Getenv("HOME") +
			"/Documents/ZX Spectrum/ZX Spectrum Next/Way Of The Exploding Fist"
	}
	nexData, err := os.ReadFile(gameRoot + "/WOTEF.nex")
	if err != nil {
		t.Skipf("no local WOTEF (set ZX_GO_WOTEF_ROOT): %v", err)
	}
	t.Setenv("ZX_GO_NO_FPGA_BOOTROM", "1")
	t.Setenv("ZX_GO_NEXT_DIRECT_BOOT", "1")
	t.Setenv("ZX_GO_RTC_FIXED", "2026-07-01T12:00:00Z")
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

	outDir := os.Getenv("ZX_GO_WOTEF_DIR")
	if outDir == "" {
		outDir = t.TempDir()
	} else if err := os.MkdirAll(outDir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", outDir, err)
	}
	t.Logf("output -> %s", outDir)
	shotImg := func(frame int, tag string, img image.Image) {
		fp, err := os.Create(fmt.Sprintf("%s/f%06d_%s.png", outDir, frame, tag))
		if err != nil {
			return
		}
		defer fp.Close()
		_ = png.Encode(fp, img)
	}
	shot := func(frame int, tag string) {
		shotImg(frame, tag, emu.renderFrame())
	}

	totalFrames := 20000
	if s := os.Getenv("ZX_GO_WOTEF_FRAMES"); s != "" {
		fmt.Sscanf(s, "%d", &totalFrames)
	}
	shotEvery := 250
	if s := os.Getenv("ZX_GO_WOTEF_SHOT_EVERY"); s != "" {
		fmt.Sscanf(s, "%d", &shotEvery)
	}

	type inputEv struct {
		frame int
		key   string
	}
	var events []inputEv
	if s := os.Getenv("ZX_GO_WOTEF_INPUTS"); s != "" {
		for _, part := range splitCSV(s) {
			var f int
			var k string
			if _, err := fmt.Sscanf(part, "%d:%s", &f, &k); err == nil {
				events = append(events, inputEv{f, k})
			}
		}
	}
	// Spectrum matrix (row, bitmask) per supported key name.
	matrixFor := func(key string) (int, byte, bool) {
		switch key {
		case "space":
			return 7, 0x01, true
		case "enter":
			return 6, 0x01, true
		case "1":
			return 3, 0x01, true
		case "2":
			return 3, 0x02, true
		case "o":
			return 5, 0x02, true
		case "p":
			return 5, 0x01, true
		case "q":
			return 2, 0x01, true
		case "a":
			return 1, 0x01, true
		case "m":
			return 7, 0x04, true
		}
		return 0, 0, false
	}

	frameNow := 0

	// NR traffic of interest: $05 (bit 2 = 50/60 Hz), $03 (machine
	// timing), $07 (CPU speed). Reads of $05 show the game's frequency
	// detection; writes show it switching the display itself. Armed
	// from launch (NextZXOS itself polls NR$05 constantly), deduped
	// per (reg,val,dir,pc) site.
	nrSeen := map[string]int{}
	armNRTrace := func() {
		emu.nextRegs.SetTracer(func(reg, val byte, isWrite bool) {
			switch reg {
			case 0x03, 0x05, 0x07, 0xC0, 0xC5, 0xC6:
				dir := "read"
				if isWrite {
					dir = "write"
				}
				key := fmt.Sprintf("NR $%02X %s $%02X (pc=$%04X)", reg, dir, val, emu.cpu.PC)
				nrSeen[key]++
				if nrSeen[key] <= 3 {
					t.Logf("frame %6d: %s", frameNow, key)
				}
			}
		})
	}

	// DAC write census per window (music path is DAC-streamed).
	dacPortCounts := map[byte]int{}
	dacWritesWindow := 0
	tap := &dacTap{bank: emu.nextDAC, onWrite: func(port uint16, val byte) {
		dacPortCounts[byte(port&0xFF)]++
		dacWritesWindow++
	}}
	emu.ula.SetNextDAC(tap)

	// SD read volume per window: music streams from the card.
	sdReadsWindow := 0
	emu.sdCard.SetLogger(func(cmd byte, arg uint32, isACMD bool) {
		if !isACMD && (cmd == 17 || cmd == 18) {
			sdReadsWindow++
		}
	})

	const gameDir = "Way Of The Exploding Fist"
	stageAndLaunch := func() {
		staged, failed := 0, 0
		err := filepath.Walk(gameRoot, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(gameRoot, path)
			rel = filepath.ToSlash(rel)
			if rel == "WOTEF.nex" {
				return nil // importAndRunNex stages the .nex itself
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if perr := emu.putSDFile(gameDir+"/"+rel, data); perr != nil {
				failed++
				t.Logf("putSDFile %s/%s: %v", gameDir, rel, perr)
			} else {
				staged++
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", gameRoot, err)
		}
		t.Logf("staged %d files (%d failed) under %s/", staged, failed, gameDir)
		if os.Getenv("ZX_GO_WOTEF_60HZ") != "" {
			// The zip route reboots the machine, so a NR$05 poke is
			// wiped — flip the card's config.ini to 60 Hz instead
			// (what a real user's 60 Hz Next boots with).
			mod := strings.ReplaceAll(install.DefaultNextConfigINI, "50_60hz=0", "50_60hz=1")
			if perr := emu.putSDFile("machines/next/config.ini", []byte(mod)); perr != nil {
				t.Fatalf("putSDFile config.ini: %v", perr)
			}
			t.Logf("card config.ini flipped to 50_60hz=1 (60 Hz boot)")
		}
		emu.importAndRunNex(gameDir+"/WOTEF.nex", nexData)
		if emu.nexloadMacro == nil {
			t.Fatal("importAndRunNex did not arm the Browser launch macro")
		}
		armNRTrace()
	}

	launchFrame := 3000
	lastGeom := 0
	// 60 Hz simulation: direct boot stamps the NR seed table (NR$05
	// bit 2 clear) regardless of config.ini, so flip the bit AFTER the
	// OS is up but BEFORE the game's own NR$05 read at .nex start —
	// what a real 60 Hz machine's boot leaves behind.
	pokeFrame := -1
	if os.Getenv("ZX_GO_WOTEF_60HZ") != "" {
		pokeFrame = launchFrame + 300
	}
	for frame := 0; frame <= totalFrames; frame++ {
		frameNow = frame
		if frame == launchFrame {
			shot(frame, "prelaunch")
			stageAndLaunch()
		}
		if frame == pokeFrame {
			emu.nextRegs.WriteReg(0x05, emu.nextRegs.Raw(0x05)|0x04)
			t.Logf("frame %6d: poked NR$05 |= 4 (60 Hz); NR$05=$%02X",
				frame, emu.nextRegs.Raw(0x05))
		}
		for _, ev := range events {
			row, mask, ok := matrixFor(ev.key)
			if !ok {
				continue
			}
			if frame == ev.frame {
				emu.kbd.PressMatrixKey(row, mask, true)
			} else if frame == ev.frame+28 {
				emu.kbd.PressMatrixKey(row, mask, false)
			}
		}
		ft := emu.frameTStates()
		if ft != lastGeom {
			t.Logf("frame %6d: frame geometry -> %d T-states (lines=%d, NR$05=$%02X NR$03=$%02X)",
				frame, ft, emu.mem.NextGeometry().Lines,
				emu.nextRegs.Raw(0x05), emu.nextRegs.Raw(0x03))
			lastGeom = ft
		}
		emu.cpu.ExecuteFrame(ft)
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		if emu.kbd != nil {
			emu.kbd.Tick()
		}
		if emu.nexloadMacro != nil && emu.nexloadMacro.tick(emu) {
			emu.nexloadMacro = nil
		}
		emu.noteBootFrame()
		if frame >= launchFrame && (frame-launchFrame)%shotEvery == 0 {
			shotImg(frame, "shot", emu.renderFrame())
			t.Logf("frame %6d: pc=$%04X sdReads(win)=%d dacWrites(win)=%d NR$C0=$%02X NR$C5=$%02X NR$C6=$%02X NR$22=$%02X",
				frame, emu.cpu.PC, sdReadsWindow, dacWritesWindow,
				emu.nextRegs.Raw(0xC0), emu.nextRegs.Raw(0xC5),
				emu.nextRegs.Raw(0xC6), emu.nextRegs.Raw(0x22))
			sdReadsWindow = 0
			dacWritesWindow = 0
		}
	}
	var sb strings.Builder
	for port, n := range dacPortCounts {
		fmt.Fprintf(&sb, " $%02X:%d", port, n)
	}
	t.Logf("DAC port totals:%s", sb.String())
	shot(totalFrames, "final")
}
