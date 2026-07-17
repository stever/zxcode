package ula

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/ay"
	"github.com/conorarmstrong/zx_go/pkg/keyboard"
	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/next"
	"github.com/conorarmstrong/zx_go/pkg/next/nextregs"
	"github.com/conorarmstrong/zx_go/pkg/next/palette"
	uartpkg "github.com/conorarmstrong/zx_go/pkg/next/uart"
	"github.com/conorarmstrong/zx_go/pkg/roms"
	"github.com/conorarmstrong/zx_go/pkg/z80"
)

// The Axis 4 port-decode conformance sweep (#158): every I/O port the
// emulator serves on the Next, probed against the FPGA's decode
// predicates (zxnext.vhd:2540-2700) — the canonical address, alias
// addresses the partial decode admits, and near-misses it must reject.
//
// FPGA ports NOT modelled, documented here so the sweep is an honest
// enumeration (each with its catalogue entry):
//
//   - Multiface enable/disable ports (low byte $3F/$9F/$BF pairs by
//     NR$0A mf_type, :2612-2616): MF paging is NMI-driven in our
//     model; only the $7F3F/$1F3F paging read-back is served
//     (known-gaps.md "Multiface paging readback").
//   - Kempston mouse $FADF/$FBDF/$FFDF (:2673-2675): no mouse device
//     (known-gaps NR$0A DPI note).
//   - +3 floating-bus port ($0xxD reads, :2589): floating bus reads
//     $FF on +2A/+3/Next — known-gaps "Floating bus".
//   - FDC iotrap ports $2FFD/$3FFD (:2601-2602, gated NR$D8): the
//     iotrap mechanism is deferred (known-gaps NR$02 bit 4 row).
//   - internal_port_enable gating (NR$82-$89, :2400-2430): the enable
//     registers store and read back faithfully but the decode is not
//     gated on them — deferred (known-gaps row).
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
