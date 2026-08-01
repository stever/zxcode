package main

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stever/zxplay_go/pkg/next/palette"
	"github.com/stever/zxplay_go/pkg/roms"
)

// TestTX205Probe (diagnostic, #205): reproduce "TX-1696 doesn't start and
// no music is played" headlessly. Mirrors the browser's game-zip flow
// (GoEmulator.openNexGameZip): every file of the local game folder is
// staged onto the card under TX-1696/ via putSDFile, then main.nex is
// Browser-launched as TX-1696/main.nex (the launch identity the game
// requires, #178). Instruments screenshots, PC samples, SD read volume,
// DAC port writes and CTC/NR configuration writes so the failure mode
// (exit-to-menu vs hang vs silent title) is visible from the log.
// Set ZX_GO_TX_PROBE=1 to run. Env:
//
//	ZX_GO_TX205_FRAMES      total frames (default 20000)
//	ZX_GO_TX205_DIR         screenshot/output directory
//	ZX_GO_TX205_SHOT_EVERY  screenshot cadence from launch (default 250)
//	ZX_GO_TX205_INPUTS      frame:key list (fire/space/up/down/left/right)
func TestTX205Probe(t *testing.T) {
	if os.Getenv("ZX_GO_TX_PROBE") == "" {
		t.Skip("diagnostic probe; set ZX_GO_TX_PROBE=1 to run")
	}
	const gameRoot = "/home/steve/Downloads/ZX Spectrum Next/TX-1696"
	nexData, err := os.ReadFile(gameRoot + "/main.nex")
	if err != nil {
		t.Skipf("no local TX-1696: %v", err)
	}
	t.Setenv("ZX_GO_NO_FPGA_BOOTROM", "1")
	t.Setenv("ZX_GO_NEXT_DIRECT_BOOT", "1")
	t.Setenv("ZX_GO_RTC_FIXED", "2026-07-01T12:00:00Z")
	prev := cliFlagsActive
	nf := cliFlags{}
	if prev != nil {
		nf = *prev
	}
	// ZX_GO_TX205_SOUND=1 keeps the audio pipeline live (the browser
	// condition); default noSound like the other headless probes.
	nf.noSound = os.Getenv("ZX_GO_TX205_SOUND") == ""
	cliFlagsActive = &nf
	t.Cleanup(func() { cliFlagsActive = prev })
	emu, err := newNextEmulator()
	if err != nil {
		t.Skipf("Next ROMs not installed: %v", err)
	}
	if emu.sdImageSrc == nil {
		t.Skip("no SD image mounted (set ZX_GO_NEXT_SD_IMG)")
	}

	outDir := os.Getenv("ZX_GO_TX205_DIR")
	if outDir == "" {
		outDir = t.TempDir()
	} else if err := os.MkdirAll(outDir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", outDir, err)
	}
	t.Logf("output -> %s", outDir)
	// shotImg encodes a GIVEN image; shot re-renders (a STALE re-render —
	// no execution since the frame's own render). The distinction is the
	// crux of the #205 garble: the browser canvas shows the frame's FIRST
	// (live) render, so gameplay screenshots must use shotImg with the
	// image runOneFrame's render produced, not a second render.
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
	if s := os.Getenv("ZX_GO_TX205_FRAMES"); s != "" {
		fmt.Sscanf(s, "%d", &totalFrames)
	}
	shotEvery := 250
	if s := os.Getenv("ZX_GO_TX205_SHOT_EVERY"); s != "" {
		fmt.Sscanf(s, "%d", &shotEvery)
	}
	skipRender := 0
	if s := os.Getenv("ZX_GO_TX205_SKIP_RENDER"); s != "" {
		fmt.Sscanf(s, "%d", &skipRender)
	}

	type inputEv struct {
		frame int
		key   string
	}
	var events []inputEv
	if s := os.Getenv("ZX_GO_TX205_INPUTS"); s != "" {
		for _, part := range splitCSV(s) {
			var f int
			var k string
			if _, err := fmt.Sscanf(part, "%d:%s", &f, &k); err == nil {
				events = append(events, inputEv{f, k})
			}
		}
	}

	frameNow := 0

	// DAC write census: TX-1696 streams sampled music; the per-port counts
	// show whether the audio engine produces output at all and which
	// ports it drives (#207 fixed the mono $DF decode — this checks
	// whether the "no music" half is that same class).
	dacPortCounts := map[byte]int{}
	dacWritesWindow := 0
	tap := &dacTap{bank: emu.nextDAC, onWrite: func(port uint16, val byte) {
		dacPortCounts[byte(port&0xFF)]++
		dacWritesWindow++
	}}
	emu.ula.SetNextDAC(tap)

	// NR writes of interest: $C0/$C5 (hardware-IM2 + CTC int enables —
	// the audio install's signature, #169), $22 (INT mask), $07 (CPU speed).
	nrLogBudget := 60
	emu.nextRegs.SetTracer(func(reg, val byte, isWrite bool) {
		if !isWrite || nrLogBudget <= 0 {
			return
		}
		switch reg {
		case 0xC0, 0xC5, 0x22, 0x07:
			nrLogBudget--
			t.Logf("frame %6d: NR $%02X <- $%02X (pc=$%04X)", frameNow, reg, val, emu.cpu.PC)
		}
	})

	// CTC channel port writes (decode low byte $3B, channel in a(10:8)).
	ctcWrites := 0
	ctcLogBudget := 20
	emu.ula.SetPortTracer(func(addr uint16, val byte, isWrite, handled bool) {
		if !isWrite || addr&0xFF != 0x3B {
			return
		}
		ctcWrites++
		if ctcLogBudget > 0 {
			ctcLogBudget--
			t.Logf("frame %6d: CTC port $%04X <- $%02X (pc=$%04X)", frameNow, addr, val, emu.cpu.PC)
		}
	})

	// SD read volume per window: the game streams audio from the card, so
	// sustained CMD17/18 traffic during gameplay = the streamer is alive.
	sdReadsWindow := 0
	emu.sdCard.SetLogger(func(cmd byte, arg uint32, isACMD bool) {
		if !isACMD && (cmd == 17 || cmd == 18) {
			sdReadsWindow++
		}
	})

	stageAndLaunch := func() {
		staged, failed := 0, 0
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
			if perr := emu.putSDFile("TX-1696/"+rel, data); perr != nil {
				failed++
				t.Logf("putSDFile TX-1696/%s: %v", rel, perr)
			} else {
				staged++
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", gameRoot, err)
		}
		t.Logf("staged %d files (%d failed) under TX-1696/", staged, failed)
		emu.importAndRunNex("TX-1696/main.nex", nexData)
		if emu.nexloadMacro == nil {
			t.Fatal("importAndRunNex did not arm the Browser launch macro")
		}
	}

	// Black-screen forensics: decoded layer state + raw NextRegs at
	// chosen frames (default: one story-crawl frame, one black frame).
	dumpFrames := map[int]bool{5000: true, 7500: true}
	if s := os.Getenv("ZX_GO_TX205_DUMP_FRAMES"); s != "" {
		dumpFrames = map[int]bool{}
		for _, part := range splitCSV(s) {
			var f int
			if _, err := fmt.Sscanf(part, "%d", &f); err == nil {
				dumpFrames[f] = true
			}
		}
	}
	dumpState := func(frame int) {
		t.Logf("frame %6d: %s", frame,
			strings.ReplaceAll(formatLayerState(emu.nextRegs.Raw), "\r\n", " | "))
		regs := []byte{0x05, 0x07, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
			0x18, 0x19, 0x1A, 0x1B, 0x32, 0x33,
			0x40, 0x41, 0x42, 0x43, 0x44, 0x4A, 0x68, 0x69, 0x6A, 0x6B,
			0x6C, 0x6E, 0x6F, 0x70, 0x71}
		var sb strings.Builder
		for _, r := range regs {
			fmt.Fprintf(&sb, " $%02X=$%02X", r, emu.nextRegs.Raw(r))
		}
		t.Logf("frame %6d: NR%s", frame, sb.String())
		// Tilemap forensics: map + defs RAM occupancy in bank 5, and the
		// active tilemap palette's first rows.
		bank5 := emu.mem.GetPage(5)
		mapBase := int(emu.nextRegs.Raw(0x6E)&0x3F) << 8
		defBase := int(emu.nextRegs.Raw(0x6F)&0x3F) << 8
		nz := func(off, n int) int {
			c := 0
			for i := off; i < off+n && i < len(bank5); i++ {
				if bank5[i] != 0 {
					c++
				}
			}
			return c
		}
		t.Logf("frame %6d: tilemap map@$%04X nonzero=%d/2560 defs@$%04X nonzero=%d/8192 head=% X",
			frame, mapBase, nz(mapBase, 2560), defBase, nz(defBase, 8192),
			bank5[mapBase:mapBase+32])
		if emu.nextPalette != nil {
			which := emu.nextPalette.ActiveSelector(palette.LayerTilemap)
			tm := emu.nextPalette.Palette(3 + 4*int(which))
			t.Logf("frame %6d: tilemap palette (active=%d):\n%s", frame, which,
				formatPaletteDump(tm, 32))
		}
		d := &remoteDebugger{emu: emu}
		t.Logf("frame %6d: copper:\n%s", frame, d.cmdCopperDisasm())
		t.Logf("frame %6d: frameTStates live=%d model=%d lines=%d", frame,
			emu.frameTStates(), frameTStatesForModel(roms.ModelNext),
			emu.mem.NextGeometry().Lines)
	}

	launchFrame := 3000
	lastWindowFrame := 0
	for frame := 0; frame <= totalFrames; frame++ {
		frameNow = frame
		if frame == launchFrame {
			shot(frame, "prelaunch")
			stageAndLaunch()
		}
		if dumpFrames[frame] {
			dumpState(frame)
		}
		for _, ev := range events {
			kemp := byte(0)
			switch ev.key {
			case "right":
				kemp = 0x01
			case "left":
				kemp = 0x02
			case "down":
				kemp = 0x04
			case "up":
				kemp = 0x08
			}
			switch {
			case ev.key == "fire" && frame == ev.frame:
				emu.ula.SetKempstonButton(0x10, true)
			case ev.key == "fire" && frame == ev.frame+30:
				emu.ula.SetKempstonButton(0x10, false)
			case ev.key == "space" && frame == ev.frame:
				emu.kbd.PressMatrixKey(7, 0x01, true)
			case ev.key == "space" && frame == ev.frame+28:
				emu.kbd.PressMatrixKey(7, 0x01, false)
			case kemp != 0 && frame == ev.frame:
				emu.ula.SetKempstonButton(kemp, true)
			case kemp != 0 && frame == ev.frame+120:
				emu.ula.SetKempstonButton(kemp, false)
			}
		}
		if skipRender > 1 && frame > launchFrame && frame%skipRender != 0 {
			// Execute-without-render: emulate a frontend that drops
			// renders (browser under load). Matches runOneFrame minus
			// renderFrame.
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
			emu.noteBootFrame()
		} else {
			// runOneFrame inlined so the frame's OWN (live) render image
			// is capturable — a shot() re-render is a stale pass and can
			// mask live-render bugs (see shotImg).
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
			traceClip := frame == 10000
			passTag := ""
			if frame == 9999 || traceClip {
				n60 := 0
				emu.nextRegs.SetTracer(func(reg, val byte, isWrite bool) {
					if !isWrite {
						return
					}
					switch reg {
					case 0x1B, 0x1C, 0x32, 0x33, 0x4C, 0x61, 0x62:
						t.Logf("frame %6d [%s]: NR $%02X <- $%02X (pc=$%04X)",
							frameNow, passTag, reg, val, emu.cpu.PC)
					case 0x60:
						n60++
						if n60 <= 4 || n60%512 == 0 {
							t.Logf("frame %6d [%s]: NR $60 <- $%02X (write #%d, pc=$%04X)",
								frameNow, passTag, val, n60, emu.cpu.PC)
						}
					}
				})
				passTag = "LIVE"
				if frame == 9999 {
					passTag = "EXEC"
				}
			}
			if frame >= 9990 && frame < 10005 && emu.nextCopper != nil {
				p, r := emu.nextCopper.DebugPair()
				st, pr, sa := emu.nextCopper.DebugArms()
				t.Logf("frame %6d: PRE-RENDER copper pair pause=%d resume=%d stops=%d pairs=%d starts=%d",
					frame, p, r, st, pr, sa)
			}
			if frame == 10000 && emu.nextRegs != nil {
				cur := emu.nextRegs.Raw(0x15)
				emu.nextRegs.WriteReg(0x15, cur&0x7F)
				shotImg(frame, "nolores", emu.renderFrame())
				emu.nextRegs.WriteReg(0x15, cur)
				emu.nextTilemap.SetEnabled(false)
				shotImg(frame, "notm", emu.renderFrame())
				emu.nextTilemap.SetEnabled(true)
				emu.nextTilemap.SetFoldDisabled(true)
				shotImg(frame, "nofold", emu.renderFrame())
				emu.nextTilemap.SetFoldDisabled(false)
			}
			liveImg := emu.renderFrame()
			if frame >= launchFrame && frame%shotEvery == 0 {
				shotImg(frame, "live", liveImg)
				if emu.nextTilemap != nil {
					x1, x2, y1, y2 := emu.nextTilemap.DebugClip()
					t.Logf("frame %6d: post-LIVE  clip x=[%d,%d] y=[%d,%d]", frame, x1, x2, y1, y2)
					passTag = "STALE"
					shotImg(frame, "stale", emu.renderFrame())
					x1, x2, y1, y2 = emu.nextTilemap.DebugClip()
					t.Logf("frame %6d: post-STALE clip x=[%d,%d] y=[%d,%d]", frame, x1, x2, y1, y2)
				}
			}
			if traceClip {
				passTag = "EXEC-NEXT"
			}
			emu.noteBootFrame()
		}
		if frame == 10002 {
			emu.nextRegs.SetTracer(nil)
		}
		if frame >= 9500 && frame%100 == 0 && emu.nextTilemap != nil {
			t.Logf("frame %6d: tmfold %v", frame, emu.nextTilemap.DebugFoldState())
			if emu.nextCopper != nil {
				p, r := emu.nextCopper.DebugPair()
				t.Logf("frame %6d: copper pair pause=%d resume=%d (lines %d/%d)",
					frame, p, r, p/1824, r/1824)
			}
		}
		if frame > launchFrame && frame-lastWindowFrame >= 500 {
			t.Logf("frame %6d (t=%6.1fs): pc=$%04X sd_reads=%d dac_writes=%d ctc_writes=%d macro_done=%v",
				frame, float64(frame-launchFrame)/50.0, emu.cpu.PC,
				sdReadsWindow, dacWritesWindow, ctcWrites, emu.nexloadMacro == nil)
			sdReadsWindow = 0
			dacWritesWindow = 0
			lastWindowFrame = frame
		}
		if frame >= launchFrame && frame%shotEvery == 0 {
			shot(frame, "tx205")
		}
	}
	shot(totalFrames, "final")

	if len(dacPortCounts) > 0 {
		ports := make([]int, 0, len(dacPortCounts))
		for p := range dacPortCounts {
			ports = append(ports, int(p))
		}
		sort.Ints(ports)
		var sb strings.Builder
		for _, p := range ports {
			fmt.Fprintf(&sb, " $%02X:%d", p, dacPortCounts[byte(p)])
		}
		t.Logf("DAC port write totals:%s", sb.String())
	} else {
		t.Logf("DAC port write totals: NONE")
	}
}
