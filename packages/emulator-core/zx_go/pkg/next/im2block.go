package next

import (
	"github.com/conorarmstrong/zx_go/pkg/next/nextregs"
	"github.com/conorarmstrong/zx_go/pkg/z80"
)

// IM2Block integrates the IM2 daisy chain (im2.go, the faithful port of
// device/peripherals.vhd + im2_peripheral.vhd + im2_device.vhd) into the
// machine: the Next's hardware-IM2 vectored interrupt mode, selected by
// NR$C0 bit 0 (nr_c0_int_mode_pulse_0_im2_1).
//
// In pulse mode (bit 0 = 0, the reset default) everything behaves as
// before: the ULA frame/line pulses latch the CPU's IRQPending directly
// and the CTC drives the 32-cycle pulse INT (CTCBlock.IntLine). The
// chain is held reset (im2_reset_n, im2_peripheral.vhd:105).
//
// In hardware-IM2 mode (bit 0 = 1):
//
//   - Interrupt sources feed the daisy chain as level requests latched
//     per source until serviced: line INT (priority/vector 0), CTC
//     channels 0-3 (vectors 3-6; the Next has 8 CTC slots 3-10, we model
//     the 4 real channels), and the ULA frame INT (vector 11). The
//     frame/line pulse leading edges arrive via z80.CPU.RouteIntFunc;
//     CTC ZC/TO pulses via CTCBlock.ConsumeZC (raw, the chain applies
//     its own enables). UART sources (1, 2, 12, 13; #158): uart0 RX =
//     the live RX-avail level (SetUARTSource), TX-empty = constant
//     true (instant transmit — an idle real UART's TX is empty too),
//     uart1 RX never requests (no Pi); enables from NR$C6
//     (zxnext.vhd:1941-1949).
//   - The chain asserts the CPU INT line (o_int_n, only when the Z80 is
//     in IM 2 — im2_device.vhd:150) through the same ExtIntFunc poll the
//     CTC pulse used; the CTC pulse itself is suppressed
//     (o_pulse_en gated by not mode, im2_peripheral.vhd:186).
//   - EXCEPTION: the ULA frame INT still delivers a legacy pulse when
//     the Z80 is NOT in IM 2 (the one EXCEPTION generic bit,
//     zxnext.vhd:1965 "0000100000000000") — RouteIntFunc returns false
//     for that case so the CPU's pulse machinery runs unchanged.
//   - At IM 2 acceptance the chain supplies the vector byte
//     `nr_c0_im2_vector & vector & '0'` (zxnext.vhd:1870/1999) via
//     z80.CPU.IntAckFunc, and the winning device advances REQ→ACK→ISR.
//   - The exact pair ED 4D (z80.CPU.OnRETI) is the end-of-interrupt
//     that releases the in-service device (im2_control.vhd:234).
//   - NR$20 writes inject unqualified requests (software-generated
//     interrupts): bit 7 = line, bit 6 = ULA, bits 3:0 = CTC 3:0
//     (zxnext.vhd:1946-1947).
//   - NR$C8/$C9/$CA expose the sticky per-source status bits with
//     write-1-to-clear (im2_status_clear, zxnext.vhd:1953-1956; $CA's
//     read shape :6254).
//
// Timing granularity: the FPGA clocks the chain per CPU cycle; this
// block ticks it once per CPU instruction (the ExtIntFunc poll), which
// is the same granularity every other INT source in the emulator uses.
type IM2Block struct {
	chain *IM2DaisyChain
	cpu   *z80.CPU
	ctc   *CTCBlock
	disp  *nextregs.Dispatcher

	hwMode  bool // NR$C0 bit 0
	vecBase byte // NR$C0 bits 7:5

	// One-tick pending inputs, consumed by the next chain tick.
	pendReq   [IM2NumPeriph]bool // routed frame/line pulse edges
	pendUnq   [IM2NumPeriph]bool // NR$20 software-generated requests
	pendClear [IM2NumPeriph]bool // NR$C8/$C9/$CA write-1-to-clear

	// chainActive tracks whether any device is out of S_0 or a request
	// latch is set — lets the idle fast path skip ticking.
	chainActive bool

	// uartRx0 is the live uart0 RX-available level (uart.UART.RxAvail),
	// the chain's vector-1 request source (zxnext.vhd:1941-1944). nil =
	// no UART wired; the TX-empty sources (vectors 12/13) are constant
	// true — this UART transmits instantly, and an idle real UART's TX
	// is empty too. uart1 (the Pi) has no RX source.
	uartRx0 func() bool
}

// SetUARTSource installs the uart0 RX-available level source. Called
// by the machine constructor after WireIM2 (the same place the UART's
// ports are wired via ULA.SetNextUART).
func (b *IM2Block) SetUARTSource(rxAvail func() bool) { b.uartRx0 = rxAvail }

// NewIM2Block builds the block around a fresh daisy chain.
func NewIM2Block(cpu *z80.CPU, ctc *CTCBlock, disp *nextregs.Dispatcher) *IM2Block {
	return &IM2Block{
		chain: NewIM2DaisyChain(),
		cpu:   cpu,
		ctc:   ctc,
		disp:  disp,
	}
}

// SetControl applies an NR$C0 write: bit 0 = hardware-IM2 mode enable,
// bits 7:5 = the programmable upper IM2 vector bits.
func (b *IM2Block) SetControl(val byte) {
	wasHW := b.hwMode
	b.hwMode = val&0x01 != 0
	b.vecBase = val & 0xE0
	if wasHW && !b.hwMode {
		// Leaving hw mode holds the chain reset (im2_reset_n) — flush
		// once so no stale in-service/request state survives.
		b.chain.Tick(IM2Inputs{HWIM2: false})
		b.chainActive = false
		b.clearPending()
	}
	// The mode switch changes what NextAssertRef8 predicts — force the
	// CPU's gated ExtIntFunc poll to re-sample (#187).
	b.cpu.KickExtIntDeadline()
}

// HWMode reports whether hardware-IM2 vectored mode is active.
func (b *IM2Block) HWMode() bool { return b.hwMode }

// Reset is the NR$02 machine-reset hook (nr_c0 fields reset to 0,
// zxnext.vhd:5092).
func (b *IM2Block) Reset() {
	b.hwMode = false
	b.vecBase = 0
	b.chain.Tick(IM2Inputs{HWIM2: false, Reset: true})
	b.chainActive = false
	b.clearPending()
	b.cpu.KickExtIntDeadline()
}

func (b *IM2Block) clearPending() {
	b.pendReq = [IM2NumPeriph]bool{}
	b.pendUnq = [IM2NumPeriph]bool{}
	b.pendClear = [IM2NumPeriph]bool{}
}

// RouteInt is the z80.CPU.RouteIntFunc: it receives frame/line pulse
// leading edges. Returns true when the event is consumed by the chain.
func (b *IM2Block) RouteInt(source int) bool {
	if !b.hwMode {
		return false
	}
	switch source {
	case z80.IntSourceFrame:
		if b.cpu.IM != 2 {
			// The ULA exception: hw-im2 mode but the Z80 is not in
			// IM 2 — deliver the legacy pulse (im2_peripheral.vhd:192).
			return false
		}
		b.pendReq[11] = true
	case z80.IntSourceLine:
		// No exception for the line INT: in hw mode it only ever
		// reaches the CPU through the chain (and the chain only
		// asserts in IM 2).
		b.pendReq[0] = true
	default:
		return false
	}
	return true
}

// Unq applies an NR$20 write: unqualified (enable-bypassing) requests.
// bit 7 = line (source 0), bit 6 = ULA (source 11), bits 3:0 = CTC 3:0
// (sources 3-6) — zxnext.vhd:1946-1947.
func (b *IM2Block) Unq(val byte) {
	if !b.hwMode {
		return
	}
	if val&0x80 != 0 {
		b.pendUnq[0] = true
	}
	if val&0x40 != 0 {
		b.pendUnq[11] = true
	}
	for ch := 0; ch < 4; ch++ {
		if val&(1<<uint(ch)) != 0 {
			b.pendUnq[3+ch] = true
		}
	}
}

// inputs assembles a chain tick's stimulus from live machine state.
func (b *IM2Block) inputs() IM2Inputs {
	in := IM2Inputs{
		HWIM2: b.hwMode,
		IM2:   b.cpu.IM == 2,
	}
	// Enables (im2_int_en, zxnext.vhd:1948-1950): line = the NR$22
	// line-int enable, ULA = NOT the shared frame-int disable latch,
	// CTC = the channels' live control-word int-enable bits.
	in.IntEn[0] = b.disp.Raw(0x22)&0x02 != 0
	in.IntEn[11] = !b.cpu.FrameIntDisabled
	ctcEn := b.ctc.ReadIntEnable()
	for ch := 0; ch < 4; ch++ {
		in.IntEn[3+ch] = ctcEn&(1<<uint(ch)) != 0
	}
	// UART sources (zxnext.vhd:1941-1949). Enables from NR$C6: vector 1
	// (uart0 rx) = bits 1|0, vector 2 (uart1 rx) = bits 5|4, vector 12
	// (uart0 tx) = bit 2, vector 13 (uart1 tx) = bit 6. Requests: the
	// rx source is near-full OR (rx-avail AND NOT the near-full-only
	// enable bit) — our FIFO never reports near-full, so it reduces to
	// rx-avail gated on the near-full-only bit being clear. TX-empty is
	// a constant-true level (instant transmit; an idle real UART's TX
	// is empty too). uart1 has no RX source.
	c6 := b.disp.Raw(0xC6)
	in.IntEn[1] = c6&0x03 != 0
	in.IntEn[2] = c6&0x30 != 0
	in.IntEn[12] = c6&0x04 != 0
	in.IntEn[13] = c6&0x40 != 0
	if b.uartRx0 != nil {
		in.IntReq[1] = b.uartRx0() && c6&0x02 == 0
	}
	in.IntReq[12] = true
	in.IntReq[13] = true
	return in
}

// NextAssertRef8 is the z80.CPU.ExtIntDeadlineFunc. In pulse mode the
// prediction is the CTC block's; in hw-im2 mode the chain is a
// stateful machine fed by pend* events (RouteInt/Unq/uart levels), so
// it declines to predict (0 = poll every sample point — exactly the
// pre-gate behaviour). Mode flips kick the CPU gate (SetControl), so
// an armed pulse-mode deadline never outlives the mode it was
// computed under.
func (b *IM2Block) NextAssertRef8() uint64 {
	if b.hwMode {
		return 0
	}
	return b.ctc.NextAssertRef8()
}

// IntLine is the z80.CPU.ExtIntFunc. In pulse mode it defers to the
// CTC pulse line unchanged; in hw-im2 mode it feeds the chain and
// reports the chain's INT line level.
func (b *IM2Block) IntLine(t uint64) bool {
	if !b.hwMode {
		return b.ctc.IntLine(t)
	}
	in := b.inputs()
	zc := b.ctc.ConsumeZC()
	any := zc != 0
	// The UART sources are LEVELS (not routed pulses): an enabled,
	// asserted level must wake the chain to latch its request, or the
	// idle fast path below would never see it.
	for _, src := range [...]int{1, 2, 12, 13} {
		if in.IntReq[src] && in.IntEn[src] {
			any = true
		}
	}
	for ch := 0; ch < 4; ch++ {
		if zc&(1<<uint(ch)) != 0 {
			in.IntReq[3+ch] = true
		}
	}
	for i := 0; i < IM2NumPeriph; i++ {
		if b.pendReq[i] {
			in.IntReq[i] = true
			any = true
		}
		if b.pendUnq[i] {
			in.IntUnq[i] = true
			any = true
		}
		if b.pendClear[i] {
			in.StatusClear[i] = true
			any = true
		}
	}
	b.pendReq = [IM2NumPeriph]bool{}
	b.pendUnq = [IM2NumPeriph]bool{}
	b.pendClear = [IM2NumPeriph]bool{}
	if !any && !b.chainActive {
		return false // idle fast path: nothing to latch, nothing in flight
	}
	b.chain.Tick(in)
	b.updateActive()
	return b.chain.IntAsserted()
}

// updateActive recomputes the idle fast-path flag: the chain needs
// ticking while any device is out of S_0 or holds a latched request.
func (b *IM2Block) updateActive() {
	active := false
	for i := range b.chain.per {
		if b.chain.per[i].state != im2S0 || b.chain.per[i].im2IntReq {
			active = true
			break
		}
	}
	b.chainActive = active
}

// Ack is the z80.CPU.IntAckFunc: the IM 2 acceptance vector fetch. When
// the chain is asserting, it walks the winning device through the INT
// acknowledge M1 cycle (S_REQ→S_ACK, vector on the bus, then →S_ISR as
// M1 releases) and returns the generated vector byte.
func (b *IM2Block) Ack() (byte, bool) {
	if !b.hwMode || !b.chain.IntAsserted() {
		return 0, false
	}
	in := b.inputs()
	in.M1, in.IORQ = true, true
	b.chain.Tick(in) // S_REQ -> S_ACK (vector valid)
	vec := b.chain.VectorByte(b.vecBase)
	in = b.inputs()  // M1/IORQ released
	b.chain.Tick(in) // S_ACK -> S_ISR
	b.updateActive()
	return vec, true
}

// Reti is the z80.CPU.OnRETI hook (exact ED 4D): the end-of-interrupt
// releasing the in-service device (im2_control.vhd o_reti_decode +
// o_reti_seen driving im2_device.vhd:124).
func (b *IM2Block) Reti() {
	if !b.hwMode || !b.chainActive {
		return
	}
	in := b.inputs()
	in.RetiDecode, in.RetiSeen = true, true
	b.chain.Tick(in)
	b.updateActive()
}

// StatusC8 composes the NR$C8 read: bit 0 = ULA (source 11), bit 1 =
// line (source 0).
func (b *IM2Block) StatusC8() byte {
	st := b.chain.Status()
	var v byte
	if st[11] {
		v |= 0x01
	}
	if st[0] {
		v |= 0x02
	}
	return v
}

// StatusC9 composes the NR$C9 read: bit n = CTC channel n (sources 3+n).
func (b *IM2Block) StatusC9() byte {
	st := b.chain.Status()
	var v byte
	for ch := 0; ch < 8 && 3+ch < IM2NumPeriph; ch++ {
		if st[3+ch] {
			v |= 1 << uint(ch)
		}
	}
	return v
}

// Status20 composes the NR$20 read (zxnext.vhd:5989:
// im2_int_status(0) & im2_int_status(11) & "00" & im2_int_status(6:3)):
// bit 7 = line INT (source 0), bit 6 = ULA frame (source 11),
// bits 3:0 = CTC channels 3:0 (sources 6:3).
func (b *IM2Block) Status20() byte {
	st := b.chain.Status()
	var v byte
	if st[0] {
		v |= 0x80
	}
	if st[11] {
		v |= 0x40
	}
	for ch := 0; ch < 4; ch++ {
		if st[3+ch] {
			v |= 1 << uint(ch)
		}
	}
	return v
}

// ClearC8 applies an NR$C8 write-1-to-clear: bit 0 clears ULA, bit 1
// clears line (im2_status_clear, zxnext.vhd:1953-1956). Applied with an
// immediate chain tick so a following read sees the cleared bit.
func (b *IM2Block) ClearC8(val byte) {
	if val&0x01 != 0 {
		b.pendClear[11] = true
	}
	if val&0x02 != 0 {
		b.pendClear[0] = true
	}
	b.IntLine(0)
}

// ClearC9 applies an NR$C9 write-1-to-clear: bit n clears CTC channel n.
func (b *IM2Block) ClearC9(val byte) {
	for ch := 0; ch < 8 && 3+ch < IM2NumPeriph; ch++ {
		if val&(1<<uint(ch)) != 0 {
			b.pendClear[3+ch] = true
		}
	}
	b.IntLine(0)
}

// StatusCA composes the NR$CA read (zxnext.vhd:6254: '0' & st(13) &
// st(2) & st(2) & '0' & st(12) & st(1) & st(1)) — the sticky UART
// source states, each RX bit mirrored into two positions.
func (b *IM2Block) StatusCA() byte {
	st := b.chain.Status()
	var v byte
	if st[13] {
		v |= 0x40
	}
	if st[2] {
		v |= 0x30
	}
	if st[12] {
		v |= 0x04
	}
	if st[1] {
		v |= 0x03
	}
	return v
}

// ClearCA applies an NR$CA write-1-to-clear (im2_status_clear,
// zxnext.vhd:1953-1956): bit 6 clears uart1 tx (13), bit 2 uart0 tx
// (12), bits 5|4 uart1 rx (2), bits 1|0 uart0 rx (1).
func (b *IM2Block) ClearCA(val byte) {
	if val&0x40 != 0 {
		b.pendClear[13] = true
	}
	if val&0x04 != 0 {
		b.pendClear[12] = true
	}
	if val&0x30 != 0 {
		b.pendClear[2] = true
	}
	if val&0x03 != 0 {
		b.pendClear[1] = true
	}
	b.IntLine(0)
}
