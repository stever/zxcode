package main

import (
	"fmt"

	"github.com/stever/zxplay_go/pkg/next/copper"
	"image/png"
	"os"
	"strconv"
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
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
	// Boot-mode divergence forensics (#187 direct-boot black scroll band):
	// dump the FULL NextReg file + Layer 2 render state next to a
	// screenshot so the two boot modes can be diffed at the same game
	// phase. Gated by ZX_GO_ATIC_REGDUMP=1.
	regdump := func(frame int, tag string) {
		if os.Getenv("ZX_GO_ATIC_REGDUMP") == "" {
			return
		}
		var b []byte
		for r := 0; r < 256; r++ {
			b = append(b, fmt.Sprintf("NR%02X=%02X\n", r, emu.nextRegs.Raw(byte(r)))...)
		}
		if l2 := emu.nextLayer2; l2 != nil {
			b = append(b, fmt.Sprintf("L2 enabled=%v active=%02X shadow=%02X res=%d palOff=%d scrollX=%03X scrollY=%02X\n",
				l2.Enabled(), l2.ActiveBank(), l2.ShadowBank(), l2.Resolution(), l2.PaletteOffset(), l2.ScrollX(), l2.ScrollY())...)
			firstY, lastY := -1, -1
			x0, x1 := 0, 0
			for y := 0; y < 256; y++ {
				if a, bx, vis := l2.ClipBounds(y); vis {
					if firstY < 0 {
						firstY = y
						x0, x1 = a, bx
					}
					lastY = y
				}
			}
			b = append(b, fmt.Sprintf("L2 clip visibleRows=[%d,%d] x=[%d,%d]\n", firstY, lastY, x0, x1)...)
		}
		_ = os.WriteFile(fmt.Sprintf("%s/probe_%06d_%s.regs.txt", outDir, frame, tag), b, 0644)
		// ZX_GO_ATIC_L2DUMP=1: also dump the Layer 2 framebuffer banks
		// (active bank + 4 = the full 320x256 column-major buffer) for
		// offline render-hypothesis testing.
		if os.Getenv("ZX_GO_ATIC_L2DUMP") != "" {
			if l2 := emu.nextLayer2; l2 != nil {
				var fb []byte
				for bk := 0; bk < 5; bk++ {
					pg := emu.mem.GetPage(int(l2.ActiveBank()) + bk)
					if pg == nil {
						break
					}
					fb = append(fb, pg...)
				}
				_ = os.WriteFile(fmt.Sprintf("%s/probe_%06d_%s.l2.bin", outDir, frame, tag), fb, 0644)
			}
		}
	}
	// Screenshot window: defaults preserve the direct-boot repro schedule;
	// env overrides let the faithful control run shoot a shifted range
	// (its game timeline lags direct boot by ~200+ frames).
	shotFrom, shotTo, shotEvery := 4300, 5060, 80
	if s := os.Getenv("ZX_GO_ATIC_SHOT_FROM"); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			shotFrom = v
		}
	}
	if s := os.Getenv("ZX_GO_ATIC_SHOT_TO"); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			shotTo = v
		}
	}
	if s := os.Getenv("ZX_GO_ATIC_SHOT_EVERY"); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			shotEvery = v
		}
	}
	bootTag := "dboot"
	if os.Getenv("ZX_GO_NEXT_DIRECT_BOOT") == "" {
		bootTag = "faith"
	}
	// ZX_GO_ATIC_SCROLL_TRACE_FROM/TO: log every video-register write
	// (L2 banks/scroll/res, clip, priority, display control) with the
	// beam position across a frame window — the moon-screen scroll
	// program forensics (#187 black band).
	scrollTraceFrom, scrollTraceTo := -1, -1
	if s := os.Getenv("ZX_GO_ATIC_SCROLL_TRACE_FROM"); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			scrollTraceFrom = v
		}
	}
	if s := os.Getenv("ZX_GO_ATIC_SCROLL_TRACE_TO"); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			scrollTraceTo = v
		}
	}

	// Log every write to the audio-engine gate block: $F996 (event byte),
	// $F9E3/$F9E4 (music position word), $F990 (slow countdown observed at
	// the doors screen). Logical-address hook: fires on every CPU write.
	frame := 0
	var lastPos [2]byte
	// $886F+ byte-queue forensics (#187 doors wedge): ring of every CPU
	// write into the queue page, with producer context (pc, NMI-era or
	// mainline via the divMMC arbiter envelope, ref8 timestamp).
	type qw struct {
		frame  int
		addr   uint16
		val    byte
		pc     uint16
		ref8   uint64
		nmiCtx bool
		sp     uint16
		mmu4   byte
	}
	qRing := make([]qw, 1<<17)
	qIdx := 0
	inFlightNow := func() bool {
		if q, ok := emu.ula.NextDivMMC().(interface{ NMIInFlight() bool }); ok {
			return q.NMIInFlight()
		}
		return false
	}
	// PHYSICAL page-4 write forensics (#187 doors producer hunt): the
	// $8870 scene-record table lives on 8K page 4 (16K bank 2, offsets
	// $0000-$1FFF). The logical $88xx hook below misses writes routed
	// through any other MMU window (e.g. page 4 mapped at slot 2/3/5),
	// so also record every PHYSICAL write into the page.
	type pw struct {
		frame    int
		off      uint16
		val      byte
		pc, sp   uint16
		mmuState [4]byte
	}
	const pRingSz = 1 << 17
	pRing := make([]pw, pRingSz)
	pIdx := 0
	prevRW := emu.mem.GetRAMWriteHook()
	emu.mem.SetRAMWriteHook(func(bank int, addr uint16, val byte) {
		if prevRW != nil {
			prevRW(bank, addr, val)
		}
		if bank == 2 && (addr < 0x2000 || (addr >= 0x2E00 && addr < 0x3100)) && frame >= 3050 {
			pRing[pIdx&(pRingSz-1)] = pw{frame, addr, val, emu.cpu.PC, emu.cpu.SP,
				[4]byte{emu.mem.GetMMU(2), emu.mem.GetMMU(3), emu.mem.GetMMU(4), emu.mem.GetMMU(5)}}
			pIdx++
		}
	})
	dumpPage4 := func(tag string) {
		for _, pg8 := range []int{4, 5} {
			if pg := emu.mem.RAM8KPage(pg8); pg != nil {
				buf := make([]byte, len(pg))
				copy(buf, pg)
				_ = os.WriteFile(fmt.Sprintf("%s/page%d_%s.bin", outDir, pg8, tag), buf, 0644)
			}
		}
	}
	// Scene-record consumer trace ($1385 NEXTREG $54,$04 entry): log the
	// scene id ($F918) and the physical record bytes it is about to pop.
	consLogs := 400
	trackPostLogs := 200
	emu.cpu.AddPreFetchHook("atic-trackpost", func(pc uint16) {
		if pc != 0xC917 && pc != 0xC91B {
			return
		}
		if frame < 3100 || trackPostLogs <= 0 {
			return
		}
		trackPostLogs--
		sp := emu.cpu.SP
		ret := uint16(emu.mem.Read(sp)) | uint16(emu.mem.Read(sp+1))<<8
		t.Logf("frame %6d: TRACKPOST $%04X A=$%02X ret=$%04X sp=$%04X", frame, pc, emu.cpu.A, ret, sp)
	})
	doorsTicks := 0
	doorsTickRets := map[uint16]int{}
	emu.cpu.AddPreFetchHook("atic-doorstick", func(pc uint16) {
		if pc != 0xCF80 || frame < 5140 {
			return
		}
		doorsTicks++
		sp := emu.cpu.SP
		doorsTickRets[uint16(emu.mem.Read(sp))|uint16(emu.mem.Read(sp+1))<<8]++
	})
	emu.cpu.AddPreFetchHook("atic-consumer", func(pc uint16) {
		if pc != 0x1385 || frame < 3100 || consLogs <= 0 {
			return
		}
		consLogs--
		id := emu.mem.Read(0xF918)
		pg := emu.mem.RAM8KPage(4)
		base := 0x0870 + 6*int(id)
		var rec [6]byte
		if pg != nil && base+6 <= len(pg) {
			copy(rec[:], pg[base:base+6])
		}
		t.Logf("frame %6d: CONSUMER $1385 id=$%02X rec@%04X=% x sp=$%04X", frame, id, 0x8870+6*int(id), rec, emu.cpu.SP)
	})
	f9Logs := 400
	sceneLogs := 3000
	objLogs := 2000
	emu.mem.SetAllWriteHook(func(addr uint16, val byte) {
		if addr >= 0x8800 && addr < 0x89C0 && frame >= 3050 {
			qRing[qIdx&(1<<17-1)] = qw{frame, addr, val, emu.cpu.PC, emu.cpu.Ref8Tstates(), inFlightNow(), emu.cpu.SP, emu.nextRegs.Raw(0x54)}
			qIdx++
		}
		// Doors engine state block: the doors main loop's $D7D3 scan
		// gates the whole engine on $F99C-$F9A4 being nonzero. Find
		// every writer (#187 wedge forensics).
		if addr >= 0xF99C && addr <= 0xF9A8 && frame >= 4990 && val != 0 && f9Logs > 0 {
			f9Logs--
			t.Logf("frame %6d: F9-STATE $%04X <- $%02X (pc=$%04X sp=$%04X)",
				frame, addr, val, emu.cpu.PC, emu.cpu.SP)
		}
		// Scene id / doors-timer writes (#187 producer hunt): $F918 is
		// the current scene id (consumer index into the $8870 record
		// table), $F99A the doors auto-toggle countdown, $F9A1/$F9A3
		// the active-door half pointers the $1385 consumer publishes.
		if frame >= 3100 && sceneLogs > 0 {
			switch addr {
			case 0xF918, 0xF919, 0xF99A, 0xF9A1, 0xF9A2, 0xF9A3, 0xF9A4:
				sceneLogs--
				t.Logf("frame %6d: SCENE $%04X <- $%02X (pc=$%04X sp=$%04X)",
					frame, addr, val, emu.cpu.PC, emu.cpu.SP)
			}
		}
		// Object system (#187 doors derail): 4-byte list entries at
		// $F800 (count $F923/$F924); entry word0 = object struct ptr
		// whose +$0A proc pointer the $B001 dispatch CALLs.
		if frame >= 5140 && objLogs > 0 {
			if (addr >= 0xF800 && addr < 0xF830) || addr == 0xF923 || addr == 0xF924 {
				objLogs--
				t.Logf("frame %6d: OBJ $%04X <- $%02X (pc=$%04X sp=$%04X)",
					frame, addr, val, emu.cpu.PC, emu.cpu.SP)
			}
		}
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

	lastNR06 := byte(0xFF)
	nmiInAutomap := 0
	// Count NMI deliveries (PC entering $0066) per snapshot window.
	dumpedC951 := false
	nmiCount := 0
	iyCount := 0
	lastIY := uint16(0)
	nmiTraceLeft := 0
	var nmiTrace []uint16
	inNMI := false
	emu.cpu.AddPreFetchHook("atic-nmi-count", func(pc uint16) {
		if iy := emu.cpu.IY; iy != lastIY {
			iyCount++
			lastIY = iy
		}
		if pc == 0x0066 {
			nmiCount++
			if pg, ok := emu.ula.NextDivMMC().(interface{ IsPagedIn() bool }); ok && pg.IsPagedIn() {
				nmiInAutomap++
			}
			if frame > 5895 && frame < 5905 && nmiTraceLeft > 0 {
				inNMI = true
			}
		}
		if inNMI {
			nmiTrace = append(nmiTrace, pc)
			if len(nmiTrace) > 400 || (len(nmiTrace) > 2 && pc > 0x4000) {
				inNMI = false
				nmiTraceLeft--
				t.Logf("NMI trace (%d PCs): % x", len(nmiTrace), nmiTrace)
				nmiTrace = nmiTrace[:0]
			}
		}
		if pc == 0xD107 {
			t.Logf("frame %6d: STREAM-DESC WRITER $D107 (sp=$%04X)", frame, emu.cpu.SP)
		}
		if pc == 0xC949 && frame > 3200 {
			t.Logf("frame %6d: track_start track=$%02X flags=$%02X seed(DE)=$%04X",
				frame, emu.mem.Read(0xF995), emu.mem.Read(0xF994), emu.cpu.DE())
		}
		if pc == 0xD107 && frame > 4995 && frame < 5012 {
			sp := emu.cpu.SP
			var q [8]uint16
			for i := range q {
				a := sp + uint16(2*i)
				q[i] = uint16(emu.mem.Read(a)) | uint16(emu.mem.Read(a+1))<<8
			}
			t.Logf("frame %6d: $D107 queue-pop SP=$%04X HL=$%04X DE=$%04X q=%04x",
				frame, sp, emu.cpu.HL(), emu.cpu.DE(), q)
		}
		if pc == 0xD131 && frame > 3900 {
			t.Logf("frame %6d: CMD18-issue $D131 (sp=$%04X)", frame, emu.cpu.SP)
		}
		if pc == 0xD610 && frame > 3900 {
			t.Logf("frame %6d: SD-TOKEN TIMEOUT -> $D610 abandon (from $CFE7 wait)", frame)
		}
		if pc == 0xCFF4 && frame > 4990 && frame < 5100 {
			t.Logf("frame %6d: token OK at $CFF4", frame)
		}
		if pc == 0xC949 && frame > 4000 && !dumpedC951 {
			sp := emu.cpu.SP
			retw := uint16(emu.mem.Read(sp)) | uint16(emu.mem.Read(sp+1))<<8
			var low [16]byte
			for i := range low {
				low[i] = emu.mem.Read(uint16(i))
			}
			t.Logf("frame %6d: $C949 entry SP=$%04X (SP)=$%04X slot0-lowbytes=% x",
				frame, sp, retw, low)
		}
		if pc == 0xC951 && !dumpedC951 && frame > 4000 {
			dumpedC951 = true
			var dac0 [0x80]byte
			for i := range dac0 {
				dac0[i] = emu.mem.Read(0xDAC0 + uint16(i))
			}
			var blk [0x90]byte
			for i := range blk {
				blk[i] = emu.mem.Read(0xF970 + uint16(i))
			}
			_ = os.WriteFile(outDir+"/emu_c951_DAC0.bin", dac0[:], 0644)
			_ = os.WriteFile(outDir+"/emu_c951_F970.bin", blk[:], 0644)
			t.Logf("frame %6d: $C951 title track_start — dumped DAC0+F970", frame)
		}
	})

	e3Callers := map[uint16]uint64{}
	tickCallers := map[uint16]uint64{}
	var tickHits uint64
	var pcRing [256]uint16
	var pcRingIdx int
	deathDumped := false
	var deathTrace *os.File
	type traceEnt struct {
		frame          int
		pc, sp, hl, de uint16
		a, op0, op1    byte
	}
	const ring2Sz = 1 << 18
	ring2 := make([]traceEnt, ring2Sz)
	ring2Idx := 0
	ring2Dumped := false
	emu.cpu.AddPreFetchHook("atic-death-trace", func(pc uint16) {
		if ring2Dumped || deathTrace == nil {
			return
		}
		ring2[ring2Idx&(ring2Sz-1)] = traceEnt{frame, pc, emu.cpu.SP, emu.cpu.HL(), emu.cpu.DE(), emu.cpu.A, emu.mem.Read(pc), emu.mem.Read(pc + 1)}
		ring2Idx++
		// Wedge-window force dump: the doors-era queue wedge leaves the
		// machine alive (no crash-orbit trigger fires) — dump the full
		// instruction ring shortly after the expected wedge frame.
		// Trigger on the doors-era derail: the corpse ends up executing
		// DAC-buffer bytes ($E800-$F8FF). No legit code runs there.
		if (frame > 5149 && pc >= 0xE800 && pc < 0xF900) ||
			frame >= 5175 {
			ring2Dumped = true
			for i := 0; i < ring2Sz; i++ {
				e := ring2[(ring2Idx+i)&(ring2Sz-1)]
				fmt.Fprintf(deathTrace, "f%d pc=%04X sp=%04X a=%02X hl=%04X de=%04X op=%02X%02X\n",
					e.frame, e.pc, e.sp, e.a, e.hl, e.de, e.op0, e.op1)
			}
			t.Logf("frame %6d: death ring dumped", frame)
		}
	})
	var wTick, wD107, wD030, wNMI int
	wTickRets := map[uint16]int{}
	wD107SPs := map[uint16]int{}
	ledgerFrame := func(f int) bool {
		return (f >= 5005 && f <= 5035) || (f >= 5120 && f <= 5140)
	}
	emu.cpu.AddPreFetchHook("atic-skip-ledger", func(pc uint16) {
		if !ledgerFrame(frame) {
			return
		}
		switch pc {
		case 0xCF80:
			wTick++
			sp := emu.cpu.SP
			wTickRets[uint16(emu.mem.Read(sp))|uint16(emu.mem.Read(sp+1))<<8]++
		case 0xD107:
			wD107++
			wD107SPs[emu.cpu.SP]++
			if frame >= 5015 && frame <= 5016 {
				t.Logf("frame %d WALK-D107 refT=%d sp=$%04X", frame, emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates(), emu.cpu.SP)
			}
		case 0xD030:
			wD030++
		case 0x0066:
			wNMI++
			if frame >= 5015 && frame <= 5016 {
				sp := emu.cpu.SP
				ipc := uint16(emu.mem.Read(sp)) | uint16(emu.mem.Read(sp+1))<<8
				t.Logf("frame %d NMI refT=%d sp=$%04X intpc=$%04X", frame, emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates(), sp, ipc)
			}
		case 0xD146:
			if frame >= 5015 && frame <= 5016 {
				hl := emu.cpu.HL()
				t.Logf("frame %d CMD18-ARG refT=%d hl=$%04X sp=$%04X arg=[%02X %02X %02X %02X]",
					frame, emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates(), hl, emu.cpu.SP,
					emu.mem.Read(hl), emu.mem.Read(hl-1), emu.mem.Read(hl-2), emu.mem.Read(hl-3))
			}
		}
	})
	var nmiEntryRefT uint64
	var handlerSpans []uint64
	dumpedHandler := false
	emu.cpu.AddPreFetchHook("atic-handler-span", func(pc uint16) {
		if frame >= 4600 && frame <= 4601 && nmiEntryRefT != 0 &&
			emu.mem.Read(pc) == 0xED && emu.mem.Read(pc+1) == 0x45 {
			if len(handlerSpans) < 12 {
				handlerSpans = append(handlerSpans, emu.cpu.RefTstates()-nmiEntryRefT)
			}
			nmiEntryRefT = 0
		}
		if pc == 0x0066 {
			nmiEntryRefT = emu.cpu.RefTstates()
			if !dumpedHandler && frame == 4600 {
				dumpedHandler = true
				h := make([]byte, 0x400)
				for i := range h {
					h[i] = emu.mem.Read(uint16(i))
				}
				_ = os.WriteFile(outDir+"/emu_nmi_handler_low.bin", h, 0644)
				var h2 [0x300]byte
				for i := range h2 {
					h2[i] = emu.mem.Read(0x2800 + uint16(i))
				}
				_ = os.WriteFile(outDir+"/emu_nmi_stub_2800.bin", h2[:], 0644)
			}
		}
	})
	// Pacer delivery + RETN timing forensics (#187 doors wedge): the
	// last delivered pulse's scheduled instant vs its delivery time
	// tells whether the pulse elapsed inside an FPGA-held window (the
	// arbiter's nmi_activated envelope reopens ~6 CPU cycles before
	// RETN's end — zxnext.vhd:2096-2166, im2_control.vhd:236).
	var lastPulseInstant8, lastPulseDeliver8 uint64
	if emu.nextNMIPacer != nil {
		emu.nextNMIPacer.onDeliver = func(instant8 uint64, val byte) {
			lastPulseInstant8 = instant8
			lastPulseDeliver8 = emu.cpu.Ref8Tstates()
		}
	}
	var lastRETNFetch8 uint64
	var lastNMIRefT uint64
	qcLogsLeft := 200
	emu.cpu.AddPreFetchHook("atic-retn-track", func(pc uint16) {
		if frame >= 5100 && frame <= 5200 &&
			emu.mem.Read(pc) == 0xED && emu.mem.Read(pc+1) == 0x45 {
			lastRETNFetch8 = emu.cpu.Ref8Tstates()
		}
		if pc == 0x1397 && frame >= 5130 && frame <= 5250 && qcLogsLeft > 0 {
			sp := emu.cpu.SP
			if sp >= 0x8800 && sp < 0x89C0 {
				qcLogsLeft--
				var q [12]byte
				for i := range q {
					q[i] = emu.mem.Read(sp + uint16(i))
				}
				t.Logf("frame %6d: QCONSUME $1397 sp=$%04X hl=$%04X de=$%04X ref8=%d sinceNMI=%d mmu45=%02X:%02X q[sp..]=% x",
					frame, sp, emu.cpu.HL(), emu.cpu.DE(), emu.cpu.Ref8Tstates(),
					emu.cpu.RefTstates()-lastNMIRefT,
					emu.nextRegs.Raw(0x54), emu.nextRegs.Raw(0x55), q)
			}
		}
	})
	// Sorter execution context (#187 stackless verdict): the doors-era
	// object sorter ($B064) walks its list with SP as cursor. Capture at
	// entry: the divMMC NMI envelope (NMIInFlight — true would mean the
	// sorter runs pre-RETN inside the handler), the stackless-NMI mode
	// (NR$C0 bit 3 / cpu.NMIStackless — true means acceptance pushes
	// never touch RAM on the FPGA), the caller chain and the NMI phase.
	sorterLogs := 40
	emu.cpu.AddPreFetchHook("atic-sorter-ctx", func(pc uint16) {
		if pc != 0xB064 || frame < 5140 || sorterLogs <= 0 {
			return
		}
		sorterLogs--
		sp := emu.cpu.SP
		var chain [4]uint16
		for i := range chain {
			a := sp + uint16(2*i)
			chain[i] = uint16(emu.mem.Read(a)) | uint16(emu.mem.Read(a+1))<<8
		}
		t.Logf("frame %6d: SORTER $B064 nmiInFlight=%v stackless=%v NR06=$%02X NRC0=$%02X sp=$%04X chain=%04x sinceNMI=%d refT=%d cnt=$%02X",
			frame, inFlightNow(), emu.cpu.NMIStackless,
			emu.nextRegs.Raw(0x06), emu.nextRegs.Raw(0xC0), sp, chain,
			emu.cpu.RefTstates()-lastNMIRefT,
			emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates(),
			emu.mem.Read(0xF923))
	})
	emu.cpu.AddPreFetchHook("atic-walk-phase", func(pc uint16) {
		if frame <= 4000 {
			return
		}
		switch pc {
		case 0x26A4:
			since := emu.cpu.RefTstates() - lastNMIRefT
			sp := emu.cpu.SP
			ret := uint16(emu.mem.Read(sp)) | uint16(emu.mem.Read(sp+1))<<8
			t.Logf("frame %6d: WALK $26A4 entry refT=%d sinceNMI=%d sp=$%04X ret=$%04X",
				frame, emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates(), since, sp, ret)
		case 0x1C17:
			since := emu.cpu.RefTstates() - lastNMIRefT
			sp := emu.cpu.SP
			ret := uint16(emu.mem.Read(sp)) | uint16(emu.mem.Read(sp+1))<<8
			t.Logf("frame %6d: RASTERWAIT exit refT=%d sinceNMI=%d line=$%02X ret=$%04X",
				frame, emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates(), since, emu.cpu.A, ret)
		case 0x0066:
			sp := emu.cpu.SP
			if sp >= 0x26D0 && sp < 0x2700 {
				t.Logf("frame %6d: MIDWALK NMI sp=$%04X refT=%d", frame, sp,
					emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates())
			}
			if frame >= 5060 && frame <= 5160 && sp < 0xF000 {
				ipc := uint16(emu.mem.Read(sp)) | uint16(emu.mem.Read(sp+1))<<8
				now8 := emu.cpu.Ref8Tstates()
				t.Logf("frame %6d: NMI-SPANOM sp=$%04X intpc=$%04X refT=%d pulseInstant8=%d deliver8=%d now8=%d sinceRETNfetch8=%d",
					frame, sp, ipc,
					emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates(),
					lastPulseInstant8, lastPulseDeliver8, now8, int64(now8)-int64(lastRETNFetch8))
			}
		}
	})
	emu.cpu.AddPreFetchHook("atic-nmi-gap", func(pc uint16) {
		if pc != 0x0066 {
			return
		}
		t0 := emu.cpu.RefTstates()
		gap := t0 - lastNMIRefT
		lastNMIRefT = t0
		if frame >= 5050 && frame <= 5250 && (gap < 140 || gap > 260) {
			t.Logf("frame %6d: NMI gap %d refT (sp=$%04X)", frame, gap, emu.cpu.SP)
		}
	})
	emu.cpu.AddPreFetchHook("atic-tick-caller", func(pc uint16) {
		pcRing[pcRingIdx&255] = pc
		pcRingIdx++
		if pc == 0xCF80 {
			tickHits++
			sp := emu.cpu.SP
			ret := uint16(emu.mem.Read(sp)) | uint16(emu.mem.Read(sp+1))<<8
			tickCallers[ret]++
			if ret == 0 && !deathDumped && frame > 5000 {
				deathDumped = true
				var ring []string
				for i := 0; i < 256; i++ {
					ring = append(ring, fmt.Sprintf("%04X", pcRing[(pcRingIdx+i)&255]))
				}
				t.Logf("frame %6d: FIRST ret-$0000 tick call. sp=$%04X iy=$%04X", frame, sp, emu.cpu.IY)
				t.Logf("pc ring (oldest first): %v", ring)
				var stk [64]byte
				for i := range stk {
					stk[i] = emu.mem.Read(sp - 16 + uint16(i))
				}
				t.Logf("stack sp-16..sp+48: % x", stk)
				var desc [0x120]byte
				for i := range desc {
					desc[i] = emu.mem.Read(0xA5F0 + uint16(i))
				}
				t.Logf("$A5F0 block: % x", desc)
				var slots [8]byte
				for i := range slots {
					slots[i] = emu.nextRegs.Raw(0x50 + byte(i))
				}
				t.Logf("slots=%v", slots)
			}
		}
	})
	var e3w, e3r uint64
	var e3wLastVal byte
	var e3wLastPC, e3rLastPC uint16
	var e3Bit1Flips uint64
	emu.ula.SetPortTracer(func(addr uint16, val byte, isWrite, handled bool) {
		if addr&0xFF != 0xE3 {
			return
		}
		if isWrite {
			if (val^e3wLastVal)&0x02 != 0 {
				e3Bit1Flips++
			}
			e3w++
			e3wLastVal = val
			e3wLastPC = emu.cpu.PC
		} else {
			e3r++
			e3rLastPC = emu.cpu.PC
			if emu.cpu.PC == 0xCFBC {
				sp := emu.cpu.SP
				ret := uint16(emu.mem.Read(sp)) | uint16(emu.mem.Read(sp+1))<<8
				e3Callers[ret]++
			}
		}
	})

	deathTrace, _ = os.Create(outDir + "/death_trace.txt")
	defer deathTrace.Close()
	maxFrames := 26000
	if s := os.Getenv("ZX_GO_ATIC_PROBE_MAX"); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			maxFrames = v
		}
	}
	importAt := 3000
	// Menu-select frame (SPACE press; released 28 frames later). The
	// menu era's raster-slaved mainline walk makes an IDLE menu
	// deterministically fatal (~frame 5116 era); a human selects
	// promptly. ZX_GO_ATIC_SELECT varies the press frame — each value
	// shifts the doors-era engine passes' NMI-lattice phase classes.
	selectAt := 5060
	if s := os.Getenv("ZX_GO_ATIC_SELECT"); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			selectAt = v
		}
	}
	lastSD := 0
	for frame = 0; frame < maxFrames; frame++ {
		if frame == importAt {
			emu.importAndRunNex("Atic Atac/ATICATAC.NEX", nexData)
		}
		switch frame {
		case 0:
			cop6063 := 0
			emu.nextRegs.SetTracer(func(reg, val byte, write bool) {
				// NR$C0 (stackless NMI / IM2 vector) writes are logged
				// from boot: Atic Atac's NEXTREG $C0,$09/$08 arming is
				// the doors-sorter safety mechanism (#187).
				if write && (reg == 0xC0 || reg == 0xC2 || reg == 0xC3) {
					t.Logf("frame %6d NR$%02X <- $%02X pc=$%04X (stackless ctl)",
						frame, reg, val, emu.cpu.PC)
					return
				}
				if !write || reg < 0x60 || reg > 0x63 {
					return
				}
				if reg == 0x60 || reg == 0x63 {
					cop6063++
					if cop6063 > 12 && cop6063%512 != 0 {
						return
					}
				}
				line, hpos := emu.ula.BeamPosition()
				t.Logf("frame %6d NR$%02X <- $%02X refT=%d beam=(%d,%d) pc=$%04X",
					frame, reg, val, emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates(), line, hpos, emu.cpu.PC)
			})
		case 5010:
			emu.nextRegs.SetTracer(nil)
		case 5040:
			blk := make([]byte, 0x40)
			for i := range blk {
				blk[i] = emu.mem.Read(0x1C00 + uint16(i))
			}
			t.Logf("frame %6d $1C00-$1C40: % x", frame, blk)
			blk2 := make([]byte, 0xA0)
			for i := range blk2 {
				blk2[i] = emu.mem.Read(0x2660 + uint16(i))
			}
			t.Logf("frame %6d $2660-$2700: % x", frame, blk2)
			emu.nextRegs.SetTracer(func(reg, val byte, write bool) {
				// NR$7F: the pacer list's ~140k/frame copper pad MOVEs —
				// logging them blew the log past the disk quota.
				if !write || reg == 0x7F || (reg == 0x02 && (val == 0x00 || val == 0x04)) {
					return
				}
				t.Logf("frame %6d NRW $%02X <- $%02X refT=%d pc=$%04X",
					frame, reg, val, emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates(), emu.cpu.PC)
			})
			if c := emu.nextCopper; c != nil {
				nMove, nNoop, nWait, nHalt, cycles := 0, 0, 0, 0, 0
				var nonNoop []string
				for i := 0; i < copper.MaxInstructions; i++ {
					in := c.Instruction(uint16(i))
					switch in.Op {
					case copper.OpMOVE:
						nMove++
						cycles += 2
						nonNoop = append(nonNoop, fmt.Sprintf("%03X:MOVE NR$%02X,$%02X", i, in.Reg, in.Val))
					case copper.OpWAIT:
						nWait++
						nonNoop = append(nonNoop, fmt.Sprintf("%03X:WAIT line=%d hpos=%d", i, in.Y, in.X))
					case copper.OpHALT:
						nHalt++
						nonNoop = append(nonNoop, fmt.Sprintf("%03X:HALT", i))
					default:
						nNoop++
						cycles++
					}
				}
				t.Logf("frame %6d COPPER LIST: %d MOVE, %d NOOP, %d WAIT, %d HALT, wrap=%d cycles; non-NOOP: %v",
					frame, nMove, nNoop, nWait, nHalt, cycles, nonNoop)
			}
		case 5130:
			emu.nextRegs.SetTracer(nil)
		case 5150:
			// Task-3 evidence (#187): every NR$02/$06/$C0 write in the
			// sorter-death window with pc attribution — is the GAME
			// re-asserting bit 2 (or gating NR$06) around the sort? The
			// pacer's deliveries show up as $02<-$04 at mainline pcs; the
			// IY-wheel stub acks as $02<-$00 at $xx3B-region pcs.
			emu.nextRegs.SetTracer(func(reg, val byte, write bool) {
				if !write || (reg != 0x02 && reg != 0x06 && reg != 0xC0) {
					return
				}
				t.Logf("frame %6d NR02WIN $%02X <- $%02X refT=%d pc=$%04X",
					frame, reg, val, emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates(), emu.cpu.PC)
			})
		case 5161:
			emu.nextRegs.SetTracer(nil)
		}
		switch frame {
		// Menu-select EARLY: the menu era runs a per-frame raster-slaved
		// mainline SP walk ($19FB -> CALL $2674) whose collision phase
		// precesses ~34 refT/frame against the free-running NMI lattice;
		// an idle menu deterministically dies when the sweep enters the
		// ~5-refT fatal band (~frame 5116 in this build). Selecting
		// before then exercises the intended flow (a human would).
		case 5000, 6500:
			kempston(true)
		case 5030, 6530:
			kempston(false)
		case selectAt, 9000, 15000:
			emu.kbd.PressMatrixKey(7, 0x01, true) // SPACE
		case selectAt + 28, 9030, 15030:
			emu.kbd.PressMatrixKey(7, 0x01, false)
		case 12000:
			emu.kbd.PressMatrixKey(6, 0x01, true) // ENTER
		case 12030:
			emu.kbd.PressMatrixKey(6, 0x01, false)
		case 5013:
			if emu.sdCard != nil {
				n := 0
				emu.sdCard.SetLogger(func(cmd byte, arg uint32, isACMD bool) {
					n++
					if n <= 80 {
						t.Logf("frame %6d: SD CMD%d arg=$%08X pc=$%04X", frame, cmd, arg, emu.cpu.PC)
					}
				})
			}
			loop := make([]byte, 0x200)
			for i := range loop {
				loop[i] = emu.mem.Read(0x7E00 + uint16(i))
			}
			_ = os.WriteFile(outDir+"/emu_loader_7E00.bin", loop, 0644)
		case 5014:
			emu.nextRegs.SetTracer(func(reg, val byte, write bool) {
				if write && (reg == 0x02 || reg == 0x06 || reg == 0xC0 || reg == 0xC4 || reg == 0xCC) {
					t.Logf("frame %6d NRWRITE $%02X <- $%02X refT=%d pc=$%04X",
						frame, reg, val, emu.cpu.RefTstates()-emu.cpu.FrameOriginRefTstates(), emu.cpu.PC)
				}
			})
		case 5017:
			emu.nextRegs.SetTracer(nil)
		case 5015:
			blk := make([]byte, 0x180)
			for i := range blk {
				blk[i] = emu.mem.Read(0xD100 + uint16(i))
			}
			_ = os.WriteFile(outDir+"/emu_D100.bin", blk, 0644)
		case 5018:
			if emu.sdCard != nil {
				emu.sdCard.SetLogger(nil)
			}
		case 5090:
			if emu.sdCard != nil {
				emu.sdCard.SetLogger(func(cmd byte, arg uint32, isACMD bool) {
					q, mr := emu.sdCard.DebugLastDispatchState()
					t.Logf("frame %6d: SD CMD%d arg=$%08X pc=$%04X q=%d multiRead=%v",
						frame, cmd, arg, emu.cpu.PC, q, mr)
				})
				emu.sdCard.SetCSLogger(func(val byte, asserted bool) {
					t.Logf("frame %6d: SD CS write $%02X asserted=%v pc=$%04X",
						frame, val, asserted, emu.cpu.PC)
				})
			}
		case 5124:
			if emu.sdCard != nil {
				emu.sdCard.SetByteLogger(func(write bool, val byte) {
					if write {
						t.Logf("frame %6d: SD WR $%02X pc=$%04X", frame, val, emu.cpu.PC)
					}
				})
			}
		case 5200:
			if emu.sdCard != nil {
				emu.sdCard.SetLogger(nil)
				emu.sdCard.SetCSLogger(nil)
				emu.sdCard.SetByteLogger(nil)
			}
		}
		if frame == scrollTraceFrom {
			emu.nextRegs.SetTracer(func(reg, val byte, write bool) {
				if !write {
					return
				}
				switch reg {
				case 0x12, 0x13, 0x15, 0x16, 0x17, 0x18, 0x69, 0x70, 0x71:
				default:
					return
				}
				line, hpos := emu.ula.BeamPosition()
				t.Logf("frame %6d SCRTRACE NR$%02X <- $%02X beam=(%d,%d) pc=$%04X",
					frame, reg, val, line, hpos, emu.cpu.PC)
			})
		}
		if frame == scrollTraceTo {
			emu.nextRegs.SetTracer(nil)
		}
		emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
		if ledgerFrame(frame) {
			t.Logf("frame %d LEDGER: tick=%d rets=%v d107=%d sps=%v d030=%d nmi=%d pcEnd=$%04X F990=$%02X",
				frame, wTick, wTickRets, wD107, wD107SPs, wD030, wNMI, emu.cpu.PC, emu.mem.Read(0xF990))
			wTick, wD107, wD030, wNMI = 0, 0, 0, 0
			for k := range wTickRets {
				delete(wTickRets, k)
			}
			for k := range wD107SPs {
				delete(wD107SPs, k)
			}
		}
		if frame == 4602 && len(handlerSpans) > 0 {
			t.Logf("frame %d: handler spans entry->RETN (refT): %v", frame, handlerSpans)
		}
		if frame >= shotFrom && frame <= shotTo && frame%shotEvery == 0 {
			shot(frame, bootTag)
			regdump(frame, bootTag)
		}
		if frame == 4500 {
			g := emu.mem.NextGeometry()
			t.Logf("frame %d: NR03=%02X NR05=%02X geometry lines=%d tpl=%d frameT=%d", frame,
				emu.nextRegs.Raw(0x03), emu.nextRegs.Raw(0x05), g.Lines, g.TStatesPerLine, g.FrameTStates())
		}
		if frame == 4500 || frame == 5015 {
			t.Logf("frame %d: NR B8=%02X B9=%02X BA=%02X BB=%02X B0=%02X 61=%02X 62=%02X 07=%02X", frame,
				emu.nextRegs.Raw(0xB8), emu.nextRegs.Raw(0xB9), emu.nextRegs.Raw(0xBA), emu.nextRegs.Raw(0xBB), emu.nextRegs.Raw(0xB0),
				emu.nextRegs.Raw(0x61), emu.nextRegs.Raw(0x62), emu.nextRegs.Raw(0x07))
		}
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
			t.Logf("frame %6d: pc=$%04X F996=$%02X F9E3=$%02X%02X F990=$%02X sd+%d nmi+%d iy+%d",
				frame, emu.cpu.PC,
				emu.mem.Read(0xF996),
				emu.mem.Read(0xF9E4), emu.mem.Read(0xF9E3),
				emu.mem.Read(0xF990), sd-lastSD, nmiCount, iyCount)
			lastSD = sd
			nmiCount = 0
			iyCount = 0
			t.Logf("frame %6d: E3 w+%d (last $%02X pc=$%04X, bit1flips %d) r+%d (last pc=$%04X) callers=%v",
				frame, e3w, e3wLastVal, e3wLastPC, e3Bit1Flips, e3r, e3rLastPC, e3Callers)
			e3w, e3r, e3Bit1Flips = 0, 0, 0
			for k := range e3Callers {
				delete(e3Callers, k)
			}
			t.Logf("frame %6d: tick $CF80 hits+%d callers=%v", frame, tickHits, tickCallers)
			tickHits = 0
			for k := range tickCallers {
				delete(tickCallers, k)
			}
			if v := emu.nextRegs.Raw(0x06); v != lastNR06 {
				t.Logf("frame %6d: NR$06 now $%02X (was $%02X)", frame, v, lastNR06)
				lastNR06 = v
			}
			if nmiInAutomap > 0 {
				t.Logf("frame %6d: %d NMIs landed with divMMC automap PAGED IN", frame, nmiInAutomap)
				nmiInAutomap = 0
			}
			if frame == 4000 {
				nmiTraceLeft = 6
			}
		}
		switch frame {
		case 8600:
			low := make([]byte, 0x8000)
			for i := range low {
				low[i] = emu.mem.Read(uint16(i))
			}
			_ = os.WriteFile(outDir+"/emu_low_8500.bin", low, 0644)
			var slots [8]byte
			for i := range slots {
				slots[i] = emu.nextRegs.Raw(0x50 + byte(i))
			}
			t.Logf("frame %6d: slots=%v", frame, slots)
		case 6000:
			var idle [0x100]byte
			for i := range idle {
				idle[i] = emu.mem.Read(0xA600 + uint16(i))
			}
			_ = os.WriteFile(outDir+"/emu_A600.bin", idle[:], 0644)
			var f9 [0x90]byte
			for i := range f9 {
				f9[i] = emu.mem.Read(0xF970 + uint16(i))
			}
			t.Logf("frame 6000 doors state F970: % x", f9[:0x30])
			t.Logf("frame 6000 F990+: % x", f9[0x20:0x40])
		case 4500:
			var seq [0x140]byte
			for i := range seq {
				seq[i] = emu.mem.Read(0xCF80 + uint16(i))
			}
			_ = os.WriteFile(outDir+"/emu_CF80.bin", seq[:], 0644)
			t.Logf("frame %d: dumped $CF80-$D0C0 sequencer region", frame)
		case 5060, 5075, 5090, 5105, 5120, 5135, 5150, 5300, 6100, 7000, 8500, 8650, 8800, 10500, 12000, 14500, 17500, 20000, 25000:
			shot(frame, "stage")
		}
		// Gameplay-progress record (#187 task 4): with the stackless-NMI
		// fix the doors scene should survive — screenshot every 500
		// frames to see how far the attract/game advances.
		if frame >= 5500 && frame%500 == 0 {
			shot(frame, "stage")
		}
		switch frame {
		case 4995, 5059, 5072, 5105, 5146, 5150, 5153, 5155:
			dumpPage4(fmt.Sprintf("%06d", frame))
		}
		if frame >= 5140 && frame <= 5250 {
			t.Logf("frame %6d: DOORS-HEALTH ticks+%d rets=%v pcEnd=$%04X spEnd=$%04X F9E3=$%02X%02X F990=$%02X F918=$%02X F99C..A4=% x",
				frame, doorsTicks, doorsTickRets, emu.cpu.PC, emu.cpu.SP,
				emu.mem.Read(0xF9E4), emu.mem.Read(0xF9E3), emu.mem.Read(0xF990), emu.mem.Read(0xF918),
				[]byte{emu.mem.Read(0xF99C), emu.mem.Read(0xF99D), emu.mem.Read(0xF99E), emu.mem.Read(0xF99F),
					emu.mem.Read(0xF9A0), emu.mem.Read(0xF9A1), emu.mem.Read(0xF9A2), emu.mem.Read(0xF9A3), emu.mem.Read(0xF9A4)})
			doorsTicks = 0
			for k := range doorsTickRets {
				delete(doorsTickRets, k)
			}
		}
		if frame == 5145 {
			full := make([]byte, 0x10000)
			for i := range full {
				full[i] = emu.mem.Read(uint16(i))
			}
			_ = os.WriteFile(outDir+"/emu_full64k_5145.bin", full, 0644)
			var sl [8]byte
			for i := range sl {
				sl[i] = emu.mem.GetMMU(byte(i))
			}
			t.Logf("frame %6d: full 64K dumped, slots=%02X", frame, sl)
		}
		if frame == 5150 {
			fp, err := os.Create(outDir + "/page4_writes.txt")
			if err == nil {
				n := pIdx
				if n > pRingSz {
					n = pRingSz
				}
				for i := 0; i < n; i++ {
					e := pRing[(pIdx-n+i)&(pRingSz-1)]
					fmt.Fprintf(fp, "f%d off=%04X val=%02X pc=%04X sp=%04X mmu2345=%02X:%02X:%02X:%02X\n",
						e.frame, e.off, e.val, e.pc, e.sp, e.mmuState[0], e.mmuState[1], e.mmuState[2], e.mmuState[3])
				}
				fp.Close()
				t.Logf("frame %6d: physical page4 write ring dumped (%d entries, %d total)", frame, n, pIdx)
			}
		}
		if frame == 5155 {
			// Queue-write forensics dump: every write into $8800-$89C0
			// captured since frame 5100, producer pc + NMI-era flag.
			fq, err := os.Create(outDir + "/queue_writes.txt")
			if err == nil {
				n := qIdx
				if n > len(qRing) {
					n = len(qRing)
				}
				for i := 0; i < n; i++ {
					e := qRing[(qIdx-n+i)&(1<<17-1)]
					fmt.Fprintf(fq, "f%d addr=%04X val=%02X pc=%04X sp=%04X ref8=%d nmiCtx=%v mmu4=%02X\n",
						e.frame, e.addr, e.val, e.pc, e.sp, e.ref8, e.nmiCtx, e.mmu4)
				}
				fq.Close()
				t.Logf("frame %6d: queue write ring dumped (%d entries)", frame, n)
			}
		}
	}
	t.Logf("done: screenshots in %s", outDir)
}
