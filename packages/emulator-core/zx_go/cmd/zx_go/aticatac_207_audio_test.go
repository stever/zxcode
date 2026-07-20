package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image/png"
	"os"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/dac"
)

// dacTap wraps the Next DAC bank so a test can observe every DAC port
// write (the #187 SD-streamed sample engine's output) without audio
// hardware. Delegates to the real bank so channel levels stay live.
type dacTap struct {
	bank    *dac.Bank
	onWrite func(port uint16, val byte)
}

func (d *dacTap) WritePort(port uint16, val byte) bool {
	handled := d.bank.WritePort(port, val)
	if handled && d.onWrite != nil {
		d.onWrite(port, val)
	}
	return handled
}

// TestAtic207Audio (diagnostic, #207): reconstruct the game's DAC output
// as a WAV headlessly and log the audio engine's track-start calls while
// driving Atic Atac to a player death, to establish whether the death /
// reincarnation jingles are produced by the emulated machine at all.
// Set ZX_GO_ATIC_PROBE=1 to run. Env:
//
//	ZX_GO_ATIC_INPUTS      frame:key list (fire/space/up/down/left/right)
//	ZX_GO_ATIC207_FRAMES   total frames to run (default 46000)
//	ZX_GO_ATIC207_WAV      output WAV path (default <probe dir>/atic207.wav)
//	ZX_GO_ATIC_PROBE_DIR   screenshot + wav directory
//	ZX_GO_ATIC207_SHOT_EVERY  screenshot cadence from frame 5000 (default 250)
func TestAtic207Audio(t *testing.T) {
	if os.Getenv("ZX_GO_ATIC_PROBE") == "" {
		t.Skip("diagnostic probe; set ZX_GO_ATIC_PROBE=1 to run")
	}
	nexData, err := os.ReadFile("/home/steve/Downloads/ZX Spectrum Next/Atic Atac/ATICATAC.NEX")
	if err != nil {
		t.Skipf("no local Atic Atac: %v", err)
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

	outDir := os.Getenv("ZX_GO_ATIC_PROBE_DIR")
	if outDir == "" {
		outDir = t.TempDir()
	} else if err := os.MkdirAll(outDir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", outDir, err)
	}
	t.Logf("output -> %s", outDir)
	shot := func(frame int, tag string) {
		fp, err := os.Create(fmt.Sprintf("%s/f%06d_%s.png", outDir, frame, tag))
		if err != nil {
			return
		}
		defer fp.Close()
		_ = png.Encode(fp, emu.renderFrame())
	}

	totalFrames := 46000
	if s := os.Getenv("ZX_GO_ATIC207_FRAMES"); s != "" {
		fmt.Sscanf(s, "%d", &totalFrames)
	}
	shotEvery := 250
	if s := os.Getenv("ZX_GO_ATIC207_SHOT_EVERY"); s != "" {
		fmt.Sscanf(s, "%d", &shotEvery)
	}

	type inputEv struct {
		frame int
		key   string
	}
	var events []inputEv
	if s := os.Getenv("ZX_GO_ATIC_INPUTS"); s != "" {
		for _, part := range splitCSV(s) {
			var f int
			var k string
			if _, err := fmt.Sscanf(part, "%d:%s", &f, &k); err == nil {
				events = append(events, inputEv{f, k})
			}
		}
	} else {
		// The #187 progression schedule: fire skips the cinematic,
		// space selects the Knight on the menu.
		events = []inputEv{{5000, "fire"}, {5060, "space"}}
	}

	// DAC waveform capture: zero-order-hold resample of the mixed DAC
	// level onto a fixed 44.1kHz grid using the 28 MHz reference clock.
	const wavRate = 44100
	const ref8Hz = 28000000
	captureFromFrame := 3000
	var wav []int16
	var capStartRef uint64
	capturing := false
	frameNow := 0
	lastLevel := byte(0)
	dacWritesThisSec := 0
	appendTo := func(ref8 uint64) {
		want := int((ref8 - capStartRef) * wavRate / ref8Hz)
		s := (int16(lastLevel) - 128) * 64
		for len(wav) < want {
			wav = append(wav, s)
		}
	}
	// Raw-stream forensics: per-port write counts, plus a dump of the
	// first trackDumpLen write values (per port) following each
	// track_start — these are the PCM bytes as the game streamed them,
	// searchable verbatim in the .NEX to identify which file region a
	// track plays from.
	const trackDumpLen = 8192
	portCounts := map[byte]int{}
	trackDump := map[byte][]byte{}
	trackDumpTag := ""
	startTrackDump := func(tag string) {
		if trackDumpTag != "" {
			return
		}
		trackDumpTag = tag
		trackDump = map[byte][]byte{}
	}
	flushTrackDump := func() {
		for p, b := range trackDump {
			_ = os.WriteFile(fmt.Sprintf("%s/track_%s_p%02X.bin", outDir, trackDumpTag, p), b, 0644)
		}
		trackDumpTag = ""
	}
	tap := &dacTap{bank: emu.nextDAC, onWrite: func(port uint16, val byte) {
		if !capturing {
			return
		}
		appendTo(emu.cpu.Ref8Tstates())
		lastLevel = emu.nextDAC.MixedLevel()
		dacWritesThisSec++
		portCounts[byte(port&0xFF)]++
		if trackDumpTag != "" {
			b := trackDump[byte(port&0xFF)]
			if len(b) < trackDumpLen {
				trackDump[byte(port&0xFF)] = append(b, val)
			} else {
				done := true
				for _, ob := range trackDump {
					if len(ob) < trackDumpLen {
						done = false
						break
					}
				}
				if done {
					flushTrackDump()
				}
			}
		}
	}}
	emu.ula.SetNextDAC(tap)

	// Track-start log: $C949 is the audio engine's track_start entry
	// (#187 forensics); $F995 holds the track id, $F994 its flags.
	// $F996 is the event byte the game posts scene/track events through.
	// NextReg + port write census across the first $0D jingle window:
	// voice 2's samples never reach the DAC bank's ports, so find where
	// they DO go (NR $2C-$2E SounDrive mirrors are unwired suspects).
	nrCensus := map[byte]int{}
	nrValDump := map[byte][]byte{}
	portCensus := map[uint16]int{}
	portUnhandled := map[uint16]int{}
	censusUntil := -1
	emu.nextRegs.SetTracer(func(reg, val byte, isWrite bool) {
		if !isWrite || frameNow > censusUntil || censusUntil < 0 {
			return
		}
		nrCensus[reg]++
		if reg >= 0x2C && reg <= 0x2E && len(nrValDump[reg]) < 16384 {
			nrValDump[reg] = append(nrValDump[reg], val)
		}
	})
	emu.ula.SetPortTracer(func(addr uint16, val byte, isWrite, handled bool) {
		if !isWrite || frameNow > censusUntil || censusUntil < 0 {
			return
		}
		portCensus[addr&0xFF]++
		if !handled {
			portUnhandled[addr&0xFF]++
		}
	})

	emu.cpu.AddPreFetchHook("atic207-trackstart", func(pc uint16) {
		if pc == 0xC949 && frameNow > 3200 {
			track := emu.mem.Read(0xF995)
			t.Logf("frame %6d (t=%6.2fs): track_start track=$%02X flags=$%02X",
				frameNow, float64(frameNow-captureFromFrame)/50.0,
				track, emu.mem.Read(0xF994))
			startTrackDump(fmt.Sprintf("f%06d_t%02X", frameNow, track))
			if track == 0x0D && censusUntil < 0 {
				censusUntil = frameNow + 250
			}
		}
	})
	// SD read-seek trace: the sample streamer reads the .NEX with CMD17/18
	// in ascending LBA runs; a backwards/far jump is a SEEK — i.e. the
	// engine switching to a different track's data. Resolved to .NEX file
	// offsets after the run (block-content match against nexData).
	type sdSeek struct {
		frame int
		lba   uint32
		prev  uint32
	}
	var sdSeeks []sdSeek
	lastLBA := uint32(0)
	emu.sdCard.SetLogger(func(cmd byte, arg uint32, isACMD bool) {
		if isACMD || (cmd != 17 && cmd != 18) {
			return
		}
		if frameNow >= 3200 && (arg < lastLBA || arg > lastLBA+64) {
			sdSeeks = append(sdSeeks, sdSeek{frameNow, arg, lastLBA})
		}
		lastLBA = arg
	})

	eventLogs := 500
	trackWriteLogs := 400
	emu.mem.SetAllWriteHook(func(addr uint16, val byte) {
		if addr == 0xF996 && val != 0 && frameNow > 3200 && eventLogs > 0 {
			eventLogs--
			t.Logf("frame %6d (t=%6.2fs): EVENT $F996 <- $%02X (pc=$%04X)",
				frameNow, float64(frameNow-captureFromFrame)/50.0, val, emu.cpu.PC)
		}
		// Track request writes: who posts the track id/flags the engine's
		// track_start ($C949) consumes.
		if (addr == 0xF994 || addr == 0xF995) && frameNow > 3200 && trackWriteLogs > 0 {
			trackWriteLogs--
			t.Logf("frame %6d (t=%6.2fs): TRACKREQ $%04X <- $%02X (pc=$%04X sp=$%04X)",
				frameNow, float64(frameNow-captureFromFrame)/50.0, addr, val, emu.cpu.PC, emu.cpu.SP)
		}
	})

	// Per-frame engine state CSV: music position word ($F9E3/E4), the slow
	// countdown ($F990), track id/flags ($F995/$F994), scene id ($F918).
	stateCSV, _ := os.Create(outDir + "/state.csv")
	if stateCSV != nil {
		fmt.Fprintln(stateCSV, "frame,posLo,posHi,f990,f994,f995,f996,f918")
		defer stateCSV.Close()
	}

	lastRateLogFrame := 0
	for frame := 0; frame <= totalFrames; frame++ {
		frameNow = frame
		if frame == 3000 {
			emu.importAndRunNex("Atic Atac/ATICATAC.NEX", nexData)
		}
		if frame == captureFromFrame {
			capturing = true
			capStartRef = emu.cpu.Ref8Tstates()
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
		runOneFrame(emu)
		if stateCSV != nil && frame >= 3200 {
			fmt.Fprintf(stateCSV, "%d,%d,%d,%d,%d,%d,%d,%d\n", frame,
				emu.mem.Read(0xF9E3), emu.mem.Read(0xF9E4), emu.mem.Read(0xF990),
				emu.mem.Read(0xF994), emu.mem.Read(0xF995), emu.mem.Read(0xF996), emu.mem.Read(0xF918))
		}
		if capturing && frame-lastRateLogFrame >= 500 {
			t.Logf("frame %6d (t=%6.2fs): %d DAC writes in last %d frames, wav samples=%d",
				frame, float64(frame-captureFromFrame)/50.0,
				dacWritesThisSec, frame-lastRateLogFrame, len(wav))
			dacWritesThisSec = 0
			lastRateLogFrame = frame
		}
		if frame >= 5000 && frame%shotEvery == 0 {
			shot(frame, "a207")
		}
	}
	if capturing {
		appendTo(emu.cpu.Ref8Tstates())
	}
	if trackDumpTag != "" {
		flushTrackDump()
	}
	for p, n := range portCounts {
		t.Logf("DAC port $%02X: %d writes", p, n)
	}
	for r, n := range nrCensus {
		if n > 100 {
			t.Logf("NR census (jingle window): NR$%02X %d writes", r, n)
		}
	}
	for r, b := range nrValDump {
		_ = os.WriteFile(fmt.Sprintf("%s/nr%02X.bin", outDir, r), b, 0644)
		t.Logf("NR$%02X value dump: %d bytes", r, len(b))
	}
	for p, n := range portCensus {
		if n > 100 {
			t.Logf("port census (jingle window): $%02X %d writes (%d unhandled)", p, n, portUnhandled[p])
		}
	}

	// Resolve SD seeks to .NEX offsets: read each seek target block from
	// the card and locate its content in the game file.
	resolve := func(lba uint32) int {
		var blk [512]byte
		if err := emu.sdImageSrc.ReadBlock(lba, blk[:]); err != nil {
			return -2
		}
		// A constant block (silence / zeros) matches everywhere; skip.
		allSame := true
		for _, b := range blk {
			if b != blk[0] {
				allSame = false
				break
			}
		}
		if allSame {
			return -3
		}
		return bytes.Index(nexData, blk[:])
	}
	for _, s := range sdSeeks {
		t.Logf("frame %6d (t=%6.2fs): SD SEEK lba $%08X (prev $%08X) -> nex offset %d",
			s.frame, float64(s.frame-captureFromFrame)/50.0, s.lba, s.prev, resolve(s.lba))
	}

	wavPath := os.Getenv("ZX_GO_ATIC207_WAV")
	if wavPath == "" {
		wavPath = outDir + "/atic207.wav"
	}
	if err := writeWAV16Mono(wavPath, wavRate, wav); err != nil {
		t.Fatalf("write wav: %v", err)
	}
	t.Logf("wav written: %s (%d samples, %.1fs)", wavPath, len(wav), float64(len(wav))/wavRate)
}

// writeWAV16Mono writes a 16-bit mono PCM WAV file.
func writeWAV16Mono(path string, rate int, samples []int16) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	dataLen := len(samples) * 2
	hdr := make([]byte, 44)
	copy(hdr[0:], "RIFF")
	binary.LittleEndian.PutUint32(hdr[4:], uint32(36+dataLen))
	copy(hdr[8:], "WAVE")
	copy(hdr[12:], "fmt ")
	binary.LittleEndian.PutUint32(hdr[16:], 16)
	binary.LittleEndian.PutUint16(hdr[20:], 1)
	binary.LittleEndian.PutUint16(hdr[22:], 1)
	binary.LittleEndian.PutUint32(hdr[24:], uint32(rate))
	binary.LittleEndian.PutUint32(hdr[28:], uint32(rate*2))
	binary.LittleEndian.PutUint16(hdr[32:], 2)
	binary.LittleEndian.PutUint16(hdr[34:], 16)
	copy(hdr[36:], "data")
	binary.LittleEndian.PutUint32(hdr[40:], uint32(dataLen))
	if _, err := f.Write(hdr); err != nil {
		return err
	}
	buf := make([]byte, dataLen)
	for i, s := range samples {
		binary.LittleEndian.PutUint16(buf[2*i:], uint16(s))
	}
	_, err = f.Write(buf)
	return err
}
