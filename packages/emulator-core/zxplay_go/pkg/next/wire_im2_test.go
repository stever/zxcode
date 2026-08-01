package next

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/next/nextregs"
	"github.com/stever/zxplay_go/pkg/z80"
)

// slideMem is a 64K RAM whose $2000-$3FFF window DISCARDS writes — the
// pre-automap divMMC/ROM mapping TX-1696's install slide deliberately
// pushes through. Reads return the stored bytes everywhere.
type slideMem struct {
	m [65536]byte
}

func (s *slideMem) Read(a uint16) byte { return s.m[a] }
func (s *slideMem) Write(a uint16, v byte) {
	if a >= 0x2000 && a <= 0x3FFF {
		return // ROM window: writes discarded
	}
	s.m[a] = v
}
func (s *slideMem) ContendPortEarly(_ uint16) {}
func (s *slideMem) ContendPortLate(_ uint16)  {}

// im2TestRig wires a CPU + dispatcher + CTC + IM2 block over a slideMem
// programmed with the TX-1696 install shape:
//
//	$5E00-$5FFF: IM2 vector table, $01/$80 byte pairs — every EVEN
//	             hardware-generated vector reads handler $8001, while
//	             the classic open-bus $FF vector (odd) reads the word
//	             at $5EFF/$5F00 = $0080 — a trap at $0080 (HALT) that
//	             the r53 wedge took on the oracle repro.
//	$8001:       the handler: EI / RETI (the game re-arms and returns).
//	$C000+:      a PUSH HL slide (the game's $EDE8 fill).
func im2TestRig(t *testing.T) (*z80.CPU, *nextregs.Dispatcher, *CTCBlock, *slideMem) {
	t.Helper()
	mem := &slideMem{}
	cpu := z80.New(mem, minimalULA{})
	disp := nextregs.New()
	WireCPUSpeed(disp, cpu)
	WireInterruptControl(disp, cpu)
	ctcBlk := WireCTC(disp, cpu)
	WireIM2(disp, cpu, ctcBlk)

	// The real Next wiring always runs the narrow frame-INT pulse
	// (legacy IntPulseTstates==0 latches a frame INT at every frame
	// boundary, which no Next config does).
	assertT, pulseT := FrameIntTiming(0x03, false)
	cpu.IntAssertTstate = uint64(assertT)
	cpu.IntPulseTstates = uint64(pulseT)

	for a := 0x5E00; a < 0x6000; a += 2 {
		mem.m[a] = 0x01
		mem.m[a+1] = 0x80
	}
	mem.m[0x5F00] = 0x00 // classic $FF vector -> $0080
	mem.m[0x0080] = 0x76 // HALT: the wrong-vector trap
	mem.m[0x8001] = 0xFB // EI
	mem.m[0x8002] = 0xED // RETI (exact ED 4D — the chain's EOI)
	mem.m[0x8003] = 0x4D
	for a := 0xC000; a < 0xF000; a++ {
		mem.m[a] = 0xE5 // PUSH HL
	}
	return cpu, disp, ctcBlk, mem
}

func nrWrite(d *nextregs.Dispatcher, reg, val byte) {
	d.Select(reg)
	d.WriteData(val)
}

// TestWireIM2VectoredCTCCatchesSlide replays TX-1696's install on the
// wired machine: hardware-IM2 mode (NR$C0 bit 0, vector base 101), CTC
// ch0 armed exactly like the game ($85 + TC=7 ≈ 250 kHz), IM 2 with
// I=$5E, then a PUSH slide entered with SP INSIDE the write-discarded
// ROM window. Measured on real silicon (work item #169, 2026-07-16):
// the CTC interrupt catches the slide and the generated vector
// (%101 & 0011 & 0 = $A6) reaches the $8001 handler. The r53 emulator
// instead accepted with the classic $FF vector -> the $0080 trap.
func TestWireIM2VectoredCTCCatchesSlide(t *testing.T) {
	cpu, disp, ctcBlk, _ := im2TestRig(t)

	nrWrite(disp, 0xC0, 0xA1) // vector base %101, hw-IM2 mode
	ctcBlk.WritePort(0x183B, 0x85)
	ctcBlk.WritePort(0x183B, 7)
	cpu.FrameIntDisabled = true // the game masks the frame INT (NR$22=$06)

	cpu.PC = 0xC000
	cpu.SP = 0x3010 // mid-window, like the slide's tail
	cpu.IM = 2
	cpu.I = 0x5E
	cpu.IFF1, cpu.IFF2 = true, true

	var spAtHandler uint16
	for i := 0; i < 5000; i++ {
		cpu.StepInstructionWithIRQ()
		if cpu.PC == 0x8001 || cpu.PC == 0x8002 {
			spAtHandler = cpu.SP
			break
		}
		if cpu.Halted {
			t.Fatalf("hit the wrong-vector trap (HALT at $0080): classic $FF vector used, PC=$%04X", cpu.PC)
		}
	}
	if spAtHandler == 0 {
		t.Fatalf("CTC hardware-IM2 interrupt never caught the slide (PC=$%04X SP=$%04X)", cpu.PC, cpu.SP)
	}
	// The acceptance push happened with SP in the discarded window.
	if spAtHandler >= 0x4000 {
		t.Fatalf("handler entered with SP=$%04X, want inside/below the ROM window", spAtHandler)
	}
}

// TestWireIM2RetiReleasesInService pins the end-of-interrupt: after the
// $8001 handler's EI/RETI, the SAME channel must interrupt again (the
// in-service device releases on the exact pair ED 4D and its next ZC
// re-latches). A chain stuck in S_ISR would deliver exactly one.
func TestWireIM2RetiReleasesInService(t *testing.T) {
	cpu, disp, ctcBlk, mem := im2TestRig(t)

	nrWrite(disp, 0xC0, 0xA1)
	ctcBlk.WritePort(0x183B, 0x85)
	ctcBlk.WritePort(0x183B, 7)
	cpu.FrameIntDisabled = true

	// Looping NOP field with a safe stack: the handler returns into it
	// and the next ZC interrupts again.
	for a := 0x9000; a < 0xBF00; a++ {
		mem.m[a] = 0x00
	}
	mem.m[0xBF00] = 0xC3 // JP $9000
	mem.m[0xBF01] = 0x00
	mem.m[0xBF02] = 0x90
	cpu.PC = 0x9000
	cpu.SP = 0xFF00
	cpu.IM = 2
	cpu.I = 0x5E
	cpu.IFF1, cpu.IFF2 = true, true

	before := z80.IntFireCount
	for i := 0; i < 20000; i++ {
		cpu.StepInstructionWithIRQ()
		if cpu.PC >= 0xC000 {
			t.Fatalf("ran into the slide field, PC=$%04X", cpu.PC)
		}
	}
	taken := z80.IntFireCount - before
	if taken < 10 {
		t.Fatalf("vectored CTC interrupts taken %d times, want a stream (>=10) — RETI not releasing the in-service device?", taken)
	}
}

// TestWireIM2ULAExceptionWhenNotIM2 pins the one EXCEPTION source: in
// hardware-IM2 mode the ULA frame INT still delivers a legacy pulse
// when the Z80 is NOT in IM 2 (im2_peripheral.vhd:190-194,
// zxnext.vhd:1965) — NextZXOS keeps running under IM 1 with the mode
// bit set. The line INT has no exception.
func TestWireIM2ULAExceptionWhenNotIM2(t *testing.T) {
	cpu, disp, _, mem := im2TestRig(t)

	nrWrite(disp, 0xC0, 0xA1) // hw-IM2 mode ON
	// Frame INT pulse configured as the 128K machine timing does.
	assertT, pulseT := FrameIntTiming(0x02, false)
	cpu.IntAssertTstate = uint64(assertT)
	cpu.IntPulseTstates = uint64(pulseT)

	for a := 0x9000; a < 0xA000; a++ {
		mem.m[a] = 0x00
	}
	mem.m[0x0038] = 0x76 // IM1 vector: HALT marks delivery
	cpu.PC = 0x9000
	cpu.SP = 0xFF00
	cpu.IM = 1
	cpu.IFF1, cpu.IFF2 = true, true

	before := z80.IntFireCount
	cpu.ExecuteFrame(70908)
	if z80.IntFireCount == before {
		t.Fatal("ULA frame INT not delivered under IM 1 with hw-IM2 mode on (the ULA exception)")
	}
	if cpu.PC != 0x0039 && !cpu.Halted {
		t.Fatalf("expected the IM1 $0038 handler, PC=$%04X", cpu.PC)
	}
}

// TestWireIM2ULAVectoredWhenIM2 pins the same source through the chain:
// with the Z80 in IM 2, the frame INT arrives vectored — source 11,
// vector %101 & 1011 & 0 = $B6 — reaching the $8001 handler via the
// table, not the classic $FF path.
func TestWireIM2ULAVectoredWhenIM2(t *testing.T) {
	cpu, disp, _, mem := im2TestRig(t)

	nrWrite(disp, 0xC0, 0xA1)
	assertT, pulseT := FrameIntTiming(0x02, false)
	cpu.IntAssertTstate = uint64(assertT)
	cpu.IntPulseTstates = uint64(pulseT)

	for a := 0x9000; a < 0xA000; a++ {
		mem.m[a] = 0x00
	}
	cpu.PC = 0x9000
	cpu.SP = 0xFF00
	cpu.IM = 2
	cpu.I = 0x5E
	cpu.IFF1, cpu.IFF2 = true, true

	before := z80.IntFireCount
	cpu.ExecuteFrame(70908)
	if z80.IntFireCount == before {
		t.Fatal("frame INT not delivered through the chain under IM 2")
	}
	if cpu.Halted {
		t.Fatal("hit the wrong-vector trap: frame INT used the classic $FF vector in hw-IM2 mode")
	}
}

// TestWireIM2PulseModeUnchanged: with NR$C0 bit 0 clear (reset default)
// the CTC keeps its legacy pulse behaviour and IM 2 acceptance uses the
// classic $FF open-bus vector — the pre-hardware-IM2 world stays
// bit-identical.
func TestWireIM2PulseModeUnchanged(t *testing.T) {
	cpu, disp, ctcBlk, mem := im2TestRig(t)

	nrWrite(disp, 0xC0, 0x00) // pulse mode
	ctcBlk.WritePort(0x183B, 0x85)
	ctcBlk.WritePort(0x183B, 7)
	cpu.FrameIntDisabled = true // isolate the CTC pulse path

	for a := 0x9000; a < 0xA000; a++ {
		mem.m[a] = 0x00
	}
	// In pulse mode the classic $FF vector applies: table word at
	// $5EFF/$5F00 = $0080 -> the HALT there is now the EXPECTED target.
	cpu.PC = 0x9000
	cpu.SP = 0xFF00
	cpu.IM = 2
	cpu.I = 0x5E
	cpu.IFF1, cpu.IFF2 = true, true

	for i := 0; i < 5000 && !cpu.Halted; i++ {
		cpu.StepInstructionWithIRQ()
	}
	if !cpu.Halted {
		t.Fatal("pulse-mode CTC interrupt not delivered via the classic $FF vector")
	}
}
