package ula

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/ay"
	"github.com/stever/zxplay_go/pkg/keyboard"
	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/next"
	"github.com/stever/zxplay_go/pkg/next/mouse"
	"github.com/stever/zxplay_go/pkg/next/nextregs"
	"github.com/stever/zxplay_go/pkg/next/palette"
	uartpkg "github.com/stever/zxplay_go/pkg/next/uart"
	"github.com/stever/zxplay_go/pkg/roms"
	"github.com/stever/zxplay_go/pkg/z80"
)

// The Axis 4 port-decode conformance sweep (#158): every I/O port the
// emulator serves on the Next, probed against the FPGA's decode
// predicates (zxnext.vhd:2540-2700) — the canonical address, alias
// addresses the partial decode admits, and near-misses it must reject.
//
// FPGA ports NOT modelled, documented here so the sweep is an honest
// enumeration (each with its catalogue entry):
//
// Every FPGA port is now modelled: the Multiface enable/disable pair
// (TestNextPortDecode_MultifacePorts), the Kempston mouse
// (_KempstonMouse), the +3 floating bus (_P3FloatingBus), the FDC
// iotraps (_FDCIOTrap) and the internal_port_enable gating
// (_InternalPortEnableGating) all landed with the 2026-08 close-out.
func newPortDecodeStack(t *testing.T) (*ULA, *nextregs.Dispatcher, *memory.Memory, *ay.Engine) {
	t.Helper()
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	u := New(mem, keyboard.New())
	cpu := z80.New(mem, u)
	d := nextregs.New()
	u.SetNextRegs(d)
	engine := ay.NewEngine()
	next.Wire(next.WireOpts{
		Dispatcher: d,
		Memory:     mem,
		CPU:        cpu,
		AYEngine:   engine,
		Palette:    palette.NewBank(),
		ULANext:    u,
	})
	ctc := next.WireCTC(d, cpu)
	next.WireIM2(d, cpu, ctc)
	u.SetNextCTC(ctc)
	u.SetNextUART(uartpkg.New())
	u.SetNextAY(engine)
	// Multiface port pair + FDC iotraps — constructor parity
	// (cmd/zxplay_go/next.go / pkg/testharness/next.go).
	mfBlk := next.WireMF(d, mem, cpu, func() byte { return u.BorderColour })
	u.SetNextMF(mfBlk)
	next.WireIOTraps(d, mem, cpu, nil, u, mfBlk.ButtonNMI)
	return u, d, mem, engine
}

// claimStub records claims for the port blocks whose internals have
// their own tests — here only the DECODE routing is under test.
type claimStub struct{ writes, reads int }

func (c *claimStub) WriteCommand(byte)     { c.writes++ }
func (c *claimStub) ReadCommand() byte     { c.reads++; return 0x55 }
func (c *claimStub) SetZilogMode(bool)     {}
func (c *claimStub) WriteSCL(bool)         { c.writes++ }
func (c *claimStub) WriteSDA(bool)         { c.writes++ }
func (c *claimStub) ReadSDA() bool         { c.reads++; return true }
func (c *claimStub) SelectSprite(byte)     {}
func (c *claimStub) SelectSlot(byte)       { c.writes++ }
func (c *claimStub) WritePatternByte(byte) { c.writes++ }
func (c *claimStub) WriteAttr(byte)        { c.writes++ }
func (c *claimStub) ReadStatus() byte      { c.reads++; return 0 }

func TestNextPortDecode_ULAAndTimex(t *testing.T) {
	u, d, _, _ := newPortDecodeStack(t)
	// $FE: every even address is the ULA (a0=0, :2581).
	for _, a := range []uint16{0x00FE, 0xFFFE, 0x1200, 0x0000} {
		if _, handled := u.ReadPort(a); !handled {
			t.Errorf("even address $%04X not claimed by port $FE", a)
		}
	}
	// $FF Timex read: any high byte, low $FF, gated on NR$08 bit 2
	// (:2813). Gate off → the read falls through (floating bus).
	d.WriteReg(0x69, 0x06)
	d.WriteReg(0x08, 0x04)
	if got, handled := u.ReadPort(0x12FF); !handled || got != 0x06 {
		t.Errorf("$12FF with NR$08 bit 2 = ($%02X, %v), want ($06, true)", got, handled)
	}
	d.WriteReg(0x08, 0x00)
	if _, handled := u.ReadPort(0x12FF); handled {
		t.Errorf("$12FF with the NR$08 gate off must fall to the floating bus")
	}
}

func TestNextPortDecode_PagingAliases(t *testing.T) {
	u, _, mem, _ := newPortDecodeStack(t)
	u2, _, mem2, _ := newPortDecodeStack(t)

	// $7FFD (:2594): a15=0, a14=1 (+3 timing), a1:0=01 → $4001 aliases it.
	u2.WritePort(0x4001, 0x03)
	if p7, _, _ := mem2.GetPortState(); p7&0x07 != 0x03 {
		t.Errorf("$4001 write: 7FFD bank = %d, want 3 (alias of $7FFD)", p7&0x07)
	}
	// $1FFD (:2599): a15:14=00, a13:12=01, fd → $1001 aliases it.
	u2.WritePort(0x1001, 0x04) // +3 special-mode off, ROM high bit
	if _, p1, _ := mem2.GetPortState(); p1 != 0x04 {
		t.Errorf("$1001 write: 1FFD = $%02X, want $04 (alias of $1FFD)", p1)
	}
	// Near-miss: $2001 is the FDC-trap range (a13:12=10), NOT $7FFD/$1FFD.
	u.WritePort(0x2001, 0x07)
	if p7, p1, _ := mem.GetPortState(); p7 != 0 || p1 != 0 {
		t.Errorf("$2001 write leaked into paging: 7FFD=$%02X 1FFD=$%02X", p7, p1)
	}
	// $DFFD (:2597): a15:12=1101, fd → $D001 aliases it.
	u.WritePort(0xD001, 0x01)
	if got := mem.GetMMU(6); got != 0x10 {
		t.Errorf("$D001 write: MMU6 = $%02X, want $10 (DFFD high-bank alias)", got)
	}
}

func TestNextPortDecode_AYRequiresA2(t *testing.T) {
	u, _, _, _ := newPortDecodeStack(t)
	// $FFFD (a2=1) claims; alias $C005 (a15:14=11, a2=1, a1:0=01) claims.
	if _, handled := u.ReadPort(0xFFFD); !handled {
		t.Errorf("$FFFD read not claimed by the AY")
	}
	if _, handled := u.ReadPort(0xC005); !handled {
		t.Errorf("$C005 read not claimed (AY alias: a15:14=11, a2=1, fd — :2646)")
	}
	// $C001 has a2=0: NOT an AY port on the Next (:2646) — falls through.
	if _, handled := u.ReadPort(0xC001); handled {
		t.Errorf("$C001 read claimed — the Next's AY decode requires A2=1 (:2646)")
	}
	// Write side: selecting a register via $C001 must not reach the AY.
	u.WritePort(0xFFFD, 0x07)
	u.WritePort(0xC001, 0x02) // would select reg 2 if mis-decoded
	u.WritePort(0xBFFD, 0xAA) // write to the SELECTED register
	u.WritePort(0xFFFD, 0x07)
	if got, _ := u.ReadPort(0xFFFD); got != 0xAA {
		t.Errorf("register 7 = $%02X, want $AA ($C001 select leaked into the AY)", got)
	}
	// $BFFD data alias $8005 (a15:14=10, a2=1, fd — :2647). Register 0
	// (tone A fine) holds a full 8 bits.
	u.WritePort(0xFFFD, 0x00)
	u.WritePort(0x8005, 0x3C)
	if got, _ := u.ReadPort(0xFFFD); got != 0x3C {
		t.Errorf("register 0 = $%02X, want $3C ($8005 must alias $BFFD)", got)
	}
	// $8001 (a2=0): not the AY data port on the Next.
	u.WritePort(0x8001, 0x55)
	if got, _ := u.ReadPort(0xFFFD); got != 0x3C {
		t.Errorf("register 0 = $%02X, want $3C ($8001 must NOT alias $BFFD)", got)
	}
}

func TestNextPortDecode_3BBlocks(t *testing.T) {
	u, d, _, _ := newPortDecodeStack(t)
	stub := &claimStub{}
	u.SetNextI2C(stub)
	u.SetNextDMA(stub)
	u.SetNextSpritePort(stub)

	// NextReg select/data: exact $243B/$253B (:2626-2627); $263B is nobody.
	d.WriteReg(0x07, 0x02)
	u.WritePort(0x243B, 0x07)
	if got, handled := u.ReadPort(0x253B); !handled || got != 0x22 {
		t.Errorf("$243B/$253B select+read = ($%02X, %v), want ($22, true)", got, handled)
	}
	if got, handled := u.ReadPort(0x243B); !handled || got != 0x07 {
		t.Errorf("$243B read-back = ($%02X, %v), want ($07, true)", got, handled)
	}
	if _, handled := u.ReadPort(0x263B); handled {
		t.Errorf("$263B claimed — nothing decodes there")
	}

	// i2c $103B (SCL) / $113B (SDA) — :2632-2633.
	u.WritePort(0x103B, 1)
	u.WritePort(0x113B, 1)
	if stub.writes != 2 {
		t.Errorf("i2c ports: %d writes routed, want 2", stub.writes)
	}
	if got, handled := u.ReadPort(0x113B); !handled || got != 0xFF {
		t.Errorf("$113B SDA read = ($%02X, %v), want ($FF, true — open-drain float + SDA 1)", got, handled)
	}

	// UART $133B-$163B claim; $173B is nobody's (uart needs
	// a10 xor (a9 and a8) = 1, :2639; CTC needs a15:11=00011, :2690).
	for _, a := range []uint16{0x133B, 0x143B, 0x153B, 0x163B} {
		if _, handled := u.ReadPort(a); !handled {
			t.Errorf("UART port $%04X not claimed", a)
		}
	}
	if _, handled := u.ReadPort(0x173B); handled {
		t.Errorf("$173B claimed — outside both the UART and CTC decodes")
	}

	// CTC $183B-$1F3B (:2690).
	for _, a := range []uint16{0x183B, 0x1F3B} {
		if _, handled := u.ReadPort(a); !handled {
			t.Errorf("CTC port $%04X not claimed", a)
		}
	}
	if _, handled := u.ReadPort(0x203B); handled {
		t.Errorf("$203B claimed — beyond the CTC block")
	}

	// Layer 2 $123B (:2636).
	if _, handled := u.ReadPort(0x123B); !handled {
		t.Errorf("$123B not claimed")
	}

	// Sprites: $303B exact (:2684); $57/$5B on the low byte alone
	// (:2682-2683 — the OTIR upload loops vary the high byte).
	u.WritePort(0x303B, 0)
	u.WritePort(0x0057, 0)
	u.WritePort(0xFF57, 0)
	u.WritePort(0x125B, 0)
	if stub.writes != 2+4 {
		t.Errorf("sprite ports: %d writes routed, want 4 more after i2c's 2", stub.writes)
	}

	// DMA $6B/$0B on the low byte alone (:2643).
	u.WritePort(0xAA6B, 0)
	u.WritePort(0x000B, 0)
	if stub.writes != 6+2 {
		t.Errorf("DMA ports: %d writes routed, want 2 more", stub.writes)
	}
}

func TestNextPortDecode_JoystickLowByte(t *testing.T) {
	u, _, _, _ := newPortDecodeStack(t)
	// $1F/$37 decode on the low byte alone and always answer (:2546-2547,
	// idle $00 from the port mux, :2829-2830).
	for _, a := range []uint16{0x001F, 0xFF1F, 0x0037, 0xAB37} {
		if got, handled := u.ReadPort(a); !handled || got != 0 {
			t.Errorf("joystick port $%04X = ($%02X, %v), want ($00, true)", a, got, handled)
		}
	}
}

// The internal/expansion-bus port-enable gating (NR$82-$89,
// zxnext.vhd:2392-2443): internal_port_enable = NR$85..$82, ANDed with
// NR$89..$86 while the expansion bus is enabled (NR$80 bit 7). A
// cleared bit removes that device's decode entirely — the access falls
// through as if the device were absent. Power-on defaults are
// all-enabled ($FF/$8F), so nothing changes until software clears a
// bit (NextZXOS leaves them on).
func TestNextPortDecode_InternalPortEnableGating(t *testing.T) {
	u, d, mem, _ := newPortDecodeStack(t)
	stub := &claimStub{}
	u.SetNextI2C(stub)
	u.SetNextDMA(stub)
	u.SetNextSpritePort(stub)

	// bit 0 — port $FF Timex read (with its NR$08 bit-2 gate on).
	d.WriteReg(0x69, 0x06)
	d.WriteReg(0x08, 0x04)
	if _, handled := u.ReadPort(0x12FF); !handled {
		t.Fatalf("$FF read not claimed with all enables on")
	}
	d.WriteReg(0x82, 0xFE)
	if _, handled := u.ReadPort(0x12FF); handled {
		t.Errorf("$FF read claimed with internal_port_enable(0) clear")
	}
	d.WriteReg(0x82, 0xFF)

	// bit 1 — $7FFD paging write becomes inert.
	d.WriteReg(0x82, 0xFD)
	u.WritePort(0x7FFD, 0x03)
	if p7, _, _ := mem.GetPortState(); p7&0x07 != 0 {
		t.Errorf("$7FFD write paged with enable(1) clear: bank %d", p7&0x07)
	}
	d.WriteReg(0x82, 0xFF)
	u.WritePort(0x7FFD, 0x03)
	if p7, _, _ := mem.GetPortState(); p7&0x07 != 3 {
		t.Errorf("$7FFD dead after enable restore: bank %d", p7&0x07)
	}

	// bit 3 — $1FFD.
	d.WriteReg(0x82, 0xF7)
	u.WritePort(0x1FFD, 0x04)
	if _, p1, _ := mem.GetPortState(); p1 != 0 {
		t.Errorf("$1FFD write acted with enable(3) clear: $%02X", p1)
	}
	d.WriteReg(0x82, 0xFF)

	// bits 5 / 25 — the two DMA ports gate independently.
	base := stub.writes
	d.WriteReg(0x82, 0xDF) // clear bit 5 ($6B)
	u.WritePort(0xAA6B, 0)
	u.WritePort(0x000B, 0)
	if stub.writes != base+1 {
		t.Errorf("with $6B disabled: %d DMA writes routed, want 1 ($0B only)", stub.writes-base)
	}
	d.WriteReg(0x82, 0xFF)
	d.WriteReg(0x85, 0x0D) // clear bit 25 ($0B)
	u.WritePort(0x000B, 0)
	if stub.writes != base+1 {
		t.Errorf("$0B routed with enable(25) clear")
	}
	d.WriteReg(0x85, 0x0F)

	// bit 6 — Kempston $1F (probe $FF1F: outside the classic-path mask).
	if _, handled := u.ReadPort(0xFF1F); !handled {
		t.Fatalf("$1F not claimed with enables on")
	}
	d.WriteReg(0x82, 0xBF)
	if _, handled := u.ReadPort(0xFF1F); handled {
		t.Errorf("$1F claimed with enable(6) clear")
	}
	d.WriteReg(0x82, 0xFF)

	// bit 10 — i2c pair.
	d.WriteReg(0x83, 0xFB)
	if _, handled := u.ReadPort(0x113B); handled {
		t.Errorf("$113B claimed with enable(10) clear")
	}
	wBefore := stub.writes
	u.WritePort(0x103B, 1)
	if stub.writes != wBefore {
		t.Errorf("$103B write routed with enable(10) clear")
	}
	d.WriteReg(0x83, 0xFF)

	// bit 12 — UART block.
	d.WriteReg(0x83, 0xEF)
	if _, handled := u.ReadPort(0x133B); handled {
		t.Errorf("$133B claimed with enable(12) clear")
	}
	d.WriteReg(0x83, 0xFF)

	// bit 14 — sprites ($303B status read + $57 upload write).
	d.WriteReg(0x83, 0xBF)
	if _, handled := u.ReadPort(0x303B); handled {
		t.Errorf("$303B claimed with enable(14) clear")
	}
	wBefore = stub.writes
	u.WritePort(0x0057, 0)
	if stub.writes != wBefore {
		t.Errorf("$57 write routed with enable(14) clear")
	}
	d.WriteReg(0x83, 0xFF)

	// bit 15 — Layer 2 $123B.
	d.WriteReg(0x83, 0x7F)
	if _, handled := u.ReadPort(0x123B); handled {
		t.Errorf("$123B claimed with enable(15) clear")
	}
	d.WriteReg(0x83, 0xFF)

	// bit 16 — AY.
	d.WriteReg(0x84, 0xFE)
	if _, handled := u.ReadPort(0xFFFD); handled {
		t.Errorf("$FFFD claimed with enable(16) clear")
	}
	d.WriteReg(0x84, 0xFF)

	// bit 24 — ULA+ pair.
	d.WriteReg(0x85, 0x0E)
	if _, handled := u.ReadPort(0xFF3B); handled {
		t.Errorf("$FF3B claimed with enable(24) clear")
	}
	d.WriteReg(0x85, 0x0F)

	// bit 27 — CTC block.
	d.WriteReg(0x85, 0x07)
	if _, handled := u.ReadPort(0x183B); handled {
		t.Errorf("$183B claimed with enable(27) clear")
	}
	d.WriteReg(0x85, 0x0F)

	// Expansion bus AND (zxnext.vhd:2393): NR$86 masks only while
	// NR$80 bit 7 is set.
	d.WriteReg(0x86, 0xFE) // clear bit 0 on the BUS mask
	if _, handled := u.ReadPort(0x12FF); !handled {
		t.Errorf("$FF read lost to the bus mask with the expansion bus disabled")
	}
	d.WriteReg(0x80, 0x80)
	if _, handled := u.ReadPort(0x12FF); handled {
		t.Errorf("$FF read claimed: expbus enabled and NR$86 bit 0 clear must gate it")
	}
	d.WriteReg(0x80, 0x00)
	d.WriteReg(0x86, 0xFF)
}

// FDC iotrap ports (zxnext.vhd:2601-2602 decode, :3835-3895 machinery):
// with NR$D8 bit 0 set, $2FFD reads / $3FFD reads / $3FFD writes fire a
// Multiface-class NMI, latch the cause into NR$DA (read back in NR$02
// bit 4) and a $3FFD write's byte into NR$D9. $2FFD writes claim the
// bus but have no write arm. NR$DA has no software write path.
func TestNextPortDecode_FDCIOTrap(t *testing.T) {
	u, d, mem, _ := newPortDecodeStack(t)

	// Trap disabled (the NR$D8 reset default): the ports don't exist.
	if _, handled := u.ReadPort(0x2FFD); handled {
		t.Fatalf("$2FFD claimed with NR$D8 clear")
	}
	d.WriteReg(0x06, 0x08) // MF button/M1 NMI enable — gates the trap NMI
	d.WriteReg(0xD8, 0x01)

	// $2FFD read: claimed ($00 — no read-data source), cause 01,
	// NR$02 bit 4 set, MF NMI fired (MF paged in for the $0066 vector).
	if got, handled := u.ReadPort(0x2FFD); !handled || got != 0 {
		t.Fatalf("$2FFD read = ($%02X, %v), want ($00, true)", got, handled)
	}
	if got := d.ReadReg(0xDA); got != 0x01 {
		t.Errorf("NR$DA after $2FFD read = %02X, want 01", got)
	}
	if got := d.ReadReg(0x02); got&0x10 == 0 {
		t.Errorf("NR$02 bit 4 clear after an iotrap (got %02X)", got)
	}
	if !mem.MultifaceActive() {
		t.Errorf("iotrap did not fire the MF NMI (MF not paged in)")
	}

	// While the NMI is in flight (MF active), a further trap must NOT
	// re-latch the cause (nmi_accept_cause).
	u.WritePort(0x3FFD, 0xAB)
	if got := d.ReadReg(0xDA); got != 0x01 {
		t.Errorf("cause re-latched mid-NMI: NR$DA = %02X, want 01", got)
	}

	// NMI window closes (RETN equivalent): a $3FFD write traps with
	// cause 11 and latches the byte into NR$D9.
	mem.SetMultifaceActive(false)
	u.WritePort(0x3FFD, 0xAB)
	if got := d.ReadReg(0xDA); got != 0x03 {
		t.Errorf("NR$DA after $3FFD write = %02X, want 03", got)
	}
	if got := d.ReadReg(0xD9); got != 0xAB {
		t.Errorf("NR$D9 = %02X, want AB (the trapped write byte)", got)
	}

	// $3FFD read → cause 10.
	mem.SetMultifaceActive(false)
	if _, handled := u.ReadPort(0x3FFD); !handled {
		t.Fatalf("$3FFD read not claimed")
	}
	if got := d.ReadReg(0xDA); got != 0x02 {
		t.Errorf("NR$DA after $3FFD read = %02X, want 02", got)
	}

	// NR$DA software writes do not alter the cause (no write arm).
	d.WriteReg(0xDA, 0x03)
	if got := d.ReadReg(0xDA); got != 0x02 {
		t.Errorf("NR$DA software write changed the cause: %02X", got)
	}

	// NR$02 write with bit 4 = 0 clears the cause.
	d.WriteReg(0x02, 0x00)
	if got := d.ReadReg(0xDA); got != 0 {
		t.Errorf("NR$DA after the NR$02 clear = %02X, want 0", got)
	}
	if got := d.ReadReg(0x02); got&0x10 != 0 {
		t.Errorf("NR$02 bit 4 still set after the clear (got %02X)", got)
	}

	// Alias: a(11:2) are don't-care — $2001 reads as $2FFD while
	// trapped (the PagingAliases near-miss test runs with the trap
	// off, where $2001 is nobody's).
	mem.SetMultifaceActive(false)
	if _, handled := u.ReadPort(0x2001); !handled {
		t.Errorf("$2001 not claimed with the trap enabled (a11:2 don't-care)")
	}
	d.WriteReg(0xD8, 0x00)
	if _, handled := u.ReadPort(0x2FFD); handled {
		t.Errorf("$2FFD still claimed after NR$D8 cleared")
	}
}

// +3-timing floating bus (zxnext.vhd:2589): a(15:12)=0000 with the $FD
// low-byte pattern, live only under +3 machine timing and
// internal_port_enable(4). Value: the ULA fetch byte with bit 0 forced
// (zxula.vhd:573), $FF when 7FFD paging is locked (:4517), $FF idle.
func TestNextPortDecode_P3FloatingBus(t *testing.T) {
	u, d, mem, _ := newPortDecodeStack(t)

	// The wired boot default is +3 timing (Wire seeds the mirror), so
	// the port is live; under 128K timing it is dead (p3_timing_hw_en
	// is machine_timing_p3 alone).
	if _, handled := u.ReadPort(0x0FFD); !handled {
		t.Fatalf("$0FFD not claimed under the boot +3 timing")
	}
	mem.SetNextMachineTiming(2)
	if _, handled := u.ReadPort(0x0FFD); handled {
		t.Fatalf("$0FFD claimed under 128K timing")
	}
	mem.SetNextMachineTiming(3)
	// $1FFD is the paging port, not the float (a13:12 must be 00).
	// (Write side: still paging. Read side: unclaimed.)
	if _, handled := u.ReadPort(0x1FFD); handled {
		t.Errorf("$1FFD read claimed — the float needs a(13:12)=00")
	}

	// Fetch slot: bitmap byte of paper row 0, column 0, bit 0 forced.
	page := mem.GetPage(5)
	page[0] = 0x54
	g := mem.NextGeometry()
	*mem.TStates = uint64(g.PaperStartT + 1 + 2) // t%8 = 2 → bitmap[col]
	if got, handled := u.ReadPort(0x0FFD); !handled || got != 0x55 {
		t.Errorf("$0FFD in the bitmap slot = ($%02X, %v), want ($55, true — $54|1)", got, handled)
	}
	// Idle slot within the line.
	*mem.TStates = uint64(g.PaperStartT + 1 + 6)
	if got, _ := u.ReadPort(0x0FFD); got != 0xFF {
		t.Errorf("idle slot = $%02X, want $FF", got)
	}
	// 7FFD lock: reads $FF regardless (zxnext.vhd:4517).
	*mem.TStates = uint64(g.PaperStartT + 1 + 2)
	mem.PageMemory(0x20)
	if got, handled := u.ReadPort(0x0FFD); !handled || got != 0xFF {
		t.Errorf("locked paging float = ($%02X, %v), want ($FF, true)", got, handled)
	}
	// internal_port_enable(4) gate.
	d.WriteReg(0x82, 0xEF)
	if _, handled := u.ReadPort(0x0FFD); handled {
		t.Errorf("$0FFD claimed with enable(4) clear")
	}
	d.WriteReg(0x82, 0xFF)
}

// Kempston mouse decode (zxnext.vhd:2668-2670): low byte $DF with
// a(11:8) = $A (buttons), $B (X), $F (Y); a(15:12) are don't-care.
// Gated by internal_port_enable(13). Other a(11:8) values fall through
// (with the mouse enabled the $DF joystick alias is dead — :2674).
func TestNextPortDecode_KempstonMouse(t *testing.T) {
	u, d, _, _ := newPortDecodeStack(t)
	m := mouse.New()
	m.SetControlSource(func() (bool, byte) {
		v := d.ReadReg(0x0A)
		return v&0x08 != 0, v & 0x03
	})
	u.SetNextMouse(m)

	m.Move(7, 0)
	m.SetButtons(true, false, false)
	if got, handled := u.ReadPort(0xFBDF); !handled || got != 7 {
		t.Errorf("$FBDF (X) = ($%02X, %v), want ($07, true)", got, handled)
	}
	if got, handled := u.ReadPort(0xFFDF); !handled || got != 0 {
		t.Errorf("$FFDF (Y) = ($%02X, %v), want ($00, true)", got, handled)
	}
	if got, handled := u.ReadPort(0xFADF); !handled || got != 0x0D {
		t.Errorf("$FADF (buttons) = ($%02X, %v), want ($0D, true — left active-low)", got, handled)
	}
	// a(15:12) don't-care: $0BDF aliases $FBDF.
	if got, handled := u.ReadPort(0x0BDF); !handled || got != 7 {
		t.Errorf("$0BDF = ($%02X, %v), want the X counter (a15:12 don't-care)", got, handled)
	}
	// a(11:8) outside A/B/F: nobody's (mouse enabled → the joystick
	// $DF alias is dead too).
	if _, handled := u.ReadPort(0x12DF); handled {
		t.Errorf("$12DF claimed — a(11:8)=2 is not a mouse port")
	}
	// internal_port_enable(13) gate: the mouse counters vanish — and
	// every $xxDF read (the mouse addresses included) becomes the
	// Kempston joystick alias instead (port_1f's $DF term, :2674).
	d.WriteReg(0x83, 0xDF)
	if got, handled := u.ReadPort(0xFBDF); !handled || got != 0 {
		t.Errorf("$FBDF with mouse decode off = ($%02X, %v), want the joystick byte ($00, true)", got, handled)
	}
	if got, handled := u.ReadPort(0x12DF); !handled || got != 0 {
		t.Errorf("$12DF with mouse off = ($%02X, %v), want the joystick byte", got, handled)
	}
	d.WriteReg(0x83, 0xFF)
}

// port_1f's $DF alias (zxnext.vhd:2674): with the SpecDrum $DF DAC
// decode enabled and the MOUSE decode DISABLED, reads of any $xxDF
// serve the Kempston $1F byte. At power-on the mouse decode is
// enabled, so the alias is dormant.
func TestNextPortDecode_DFJoystickAlias(t *testing.T) {
	u, d, _, _ := newPortDecodeStack(t)
	d.WriteReg(0x83, 0xDF) // clear bit 13 (mouse decode)
	if got, handled := u.ReadPort(0x12DF); !handled || got != 0 {
		t.Errorf("$12DF with mouse decode off = ($%02X, %v), want the $1F joystick byte ($00, true)", got, handled)
	}
	d.WriteReg(0x83, 0xFF)
}

// Multiface enable/disable pair (zxnext.vhd:2612-2616; state machine
// device/multiface.vhd via the GHDL-golden pkg/multiface.Core). Boot
// personality is MF+3 (NR$0A bits 7:6 = 00): enable $3F, disable $BF,
// low-byte decode. The enable-port read pages the MF in and serves the
// paging shadow ONLY when visible (invisible clears on the first MF
// NMI); the disable-port read pages it out.
func TestNextPortDecode_MultifacePorts(t *testing.T) {
	u, d, mem, _ := newPortDecodeStack(t)

	// Power-on: invisible — the pair claims the bus (idle $00), no
	// data, no paging.
	if got, handled := u.ReadPort(0x7F3F); !handled || got != 0 {
		t.Fatalf("$7F3F at power-on = ($%02X, %v), want ($00, true — claimed, hidden)", got, handled)
	}
	if mem.MultifaceActive() {
		t.Fatalf("enable-port read paged the MF in while invisible")
	}

	// MF NMI (NR$06 bit 3 + NR$02 bit 3): pages in, clears invisible.
	d.WriteReg(0x06, 0x08)
	d.WriteReg(0x02, 0x08)
	if !mem.MultifaceActive() {
		t.Fatalf("NR$02 bit 3 did not fire the MF NMI")
	}

	// Visible now: the enable port serves the paging shadow.
	u.WritePort(0x7FFD, 0x17) // bank 7, shadow screen, ROM1
	if got, handled := u.ReadPort(0x7F3F); !handled || got != 0x17 {
		t.Errorf("$7F3F = ($%02X, %v), want ($17, true — live 7FFD)", got, handled)
	}
	u.WritePort(0x1FFD, 0x04)
	if got, _ := u.ReadPort(0x1F3F); got != 0x04 {
		t.Errorf("$1F3F = $%02X, want $04 (1FFD low nibble)", got)
	}
	// Default arm: border bits.
	u.WritePort(0x00FE, 0x05)
	if got, _ := u.ReadPort(0x203F); got != 0x05 {
		t.Errorf("$203F = $%02X, want $05 (border)", got)
	}

	// Disable-port read pages the MF out (and, on the +3 personality,
	// releases the NMI hold).
	if _, handled := u.ReadPort(0x12BF); !handled {
		t.Fatalf("$12BF (disable) not claimed")
	}
	if mem.MultifaceActive() {
		t.Errorf("disable-port read did not page the MF out")
	}

	// Still visible: an enable-port read pages it back IN without any
	// NMI (the MF128-style software re-entry).
	if got, _ := u.ReadPort(0x7F3F); got != 0x17 {
		t.Errorf("$7F3F after page-out = $%02X, want $17 (still visible)", got)
	}
	if !mem.MultifaceActive() {
		t.Errorf("enable-port read did not page the MF back in")
	}

	// Enable-port WRITE (+3 personality) sets the invisible latch; the
	// paging state is untouched by writes.
	u.WritePort(0x003F, 0x00)
	if !mem.MultifaceActive() {
		t.Errorf("enable-port write must not change paging")
	}
	u.ReadPort(0x12BF) // page out
	if got, handled := u.ReadPort(0x7F3F); !handled || got != 0 {
		t.Errorf("$7F3F after hide = ($%02X, %v), want ($00, true — hidden again)", got, handled)
	}
	if mem.MultifaceActive() {
		t.Errorf("hidden enable-port read paged the MF in")
	}

	// internal_port_enable(9) gate removes the pair.
	d.WriteReg(0x83, 0xFD)
	if _, handled := u.ReadPort(0x7F3F); handled {
		t.Errorf("$7F3F claimed with the MF decode disabled")
	}
	d.WriteReg(0x83, 0xFF)
}
