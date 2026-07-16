package next

import (
	"github.com/conorarmstrong/zx_go/pkg/next/ctc"
)

// CTCBlock integrates the Next's four Z80 CTC channels (device/ctc.vhd,
// instantiated zxnext.vhd:4064-4093) into the machine:
//
//   - CPU ports: a(15:11)="00011" with low byte $3B — $183B/$193B/$1A3B/
//     $1B3B are channels 0-3 (channel select = a(10:8), zxnext.vhd:4077);
//     selects 4-7 ($1C3B-$1F3B) address no channel (NUM_CTC=4) — writes
//     are dropped and reads return 0, matching the FPGA's one-hot select
//     decode (ctc.vhd:128-146).
//   - Clocking: the channels count i_CLK_28 (zxnext.vhd:4072). The block
//     advances them lazily from the CPU's Ref8Tstates clock (the 28 MHz-
//     domain reference timeline) whenever they are observed: a port
//     access, an NR$C5 write, or the per-instruction interrupt poll.
//   - Interrupts: a ZC/TO pulse on a channel whose interrupt-enable bit
//     is set raises the PULSE-mode maskable INT for 32 CPU cycles — the
//     im2_peripheral o_pulse_en = (int_req and i_int_en) path feeding
//     pulse_int_n (im2_peripheral.vhd:186, zxnext.vhd:2014-2043; pulse
//     width 32 CPU clocks on 48K/+3 timing, 36 on 128K/Pentagon). The
//     block exposes IntLine as a z80.CPU.ExtIntFunc.
//   - NR$C5 "INT EN 1" writes set/clear the channels' interrupt-enable
//     control bits directly (the i_int_en_wr back door, zxnext.vhd:
//     4078-4079, ctc_chan.vhd:270-271); NR$C5 reads compose the live
//     bits back (zxnext.vhd:6242).
//
// The hardware-IM2 vectored mode (NR$C0 bit 0) is wired by IM2Block
// (im2block.go), which suppresses this block's pulse line and feeds the
// raw per-channel ZC/TO pulses (ConsumeZC) into the im2 daisy chain
// instead. Not modelled (documented gap): the channel-to-channel ZC/TO
// trigger cascade for COUNTER-mode channels (i_clk_trg chaining,
// zxnext.vhd:4082) — a counter-mode channel currently never sees edges.
type CTCBlock struct {
	ch [4]*ctc.Channel

	// clk28 returns the CLK_28-domain timestamp (z80.CPU.Ref8Tstates).
	clk28 func() uint64
	// speedMult returns the current CPU speed multiplier
	// (z80.CPU.SpeedMultiplier) — CPU clocks per 3.5 MHz reference
	// T-state; converts the CPU-clock pulse width into CLK_28 ticks.
	speedMult func() int

	// last28 is the CLK_28 timestamp the channels are advanced to.
	last28 uint64

	// nextZC28 is the CLK_28 deadline of the earliest scheduled ZC/TO
	// on an int-enabled channel; 0 = none armed.
	nextZC28 uint64

	// pulseUntil28: the pulse-mode INT line is asserted while the
	// CLK_28 clock is below this. Held in the monotonic CLK_28 domain
	// — the CPU T-state counter wraps at every frame boundary
	// (ExecuteFrame's end-of-frame `tstates -= frameEnd`), so a
	// CPU-clock deadline would read as "still asserted" after a wrap.
	pulseUntil28 uint64

	// pulseTstates is the pulse width in CPU cycles (32 for 48K/+3
	// machine timing, 36 for 128K/Pentagon — zxnext.vhd:2035-2043).
	// The FPGA's pulse_count runs on i_CLK_CPU, so the width in
	// CLK_28 ticks is pulseTstates*8/speedMult.
	pulseTstates uint64

	// zcMask accumulates the channels that fired a ZC/TO since the
	// last ConsumeZC — the RAW ctc_zc_to pulses (zxnext.vhd:1938),
	// not gated by the channels' int enables (the im2 daisy chain
	// applies its own i_int_en gating). Bit n = channel n.
	zcMask byte
}

// NewCTCBlock builds the four hard-reset channels. clk28 supplies the
// CLK_28-domain clock (z80.CPU.Ref8Tstates), speedMult the CPU speed
// multiplier (z80.CPU.SpeedMultiplier).
func NewCTCBlock(clk28 func() uint64, speedMult func() int) *CTCBlock {
	b := &CTCBlock{clk28: clk28, speedMult: speedMult, pulseTstates: 32}
	for i := range b.ch {
		b.ch[i] = ctc.New()
	}
	if clk28 != nil {
		b.last28 = clk28()
	}
	return b
}

// Reset hard-resets all channels (i_reset, machine reset).
func (b *CTCBlock) Reset() {
	for _, c := range b.ch {
		c.HardReset()
	}
	b.nextZC28 = 0
	b.pulseUntil28 = 0
	if b.clk28 != nil {
		b.last28 = b.clk28()
	}
}

// Channel exposes channel n (tests / debugger).
func (b *CTCBlock) Channel(n int) *ctc.Channel { return b.ch[n&3] }

// catchUp advances every channel to the current CLK_28 time and
// returns true if any int-enabled channel fired a ZC in the window.
func (b *CTCBlock) catchUp() bool {
	now := b.clk28()
	if now <= b.last28 {
		return false
	}
	d := now - b.last28
	b.last28 = now
	fired := false
	for i, c := range b.ch {
		zcs := c.AdvanceIdle(d)
		if zcs > 0 {
			b.zcMask |= 1 << uint(i)
			if c.IntEnabled() {
				fired = true
			}
		}
	}
	return fired
}

// ConsumeZC advances the channels to now and returns-and-clears the
// mask of channels that fired a ZC/TO since the last consume (raw
// pulses, bit n = channel n). The hardware-IM2 block polls this per
// instruction to feed the im2 daisy chain's CTC request inputs.
func (b *CTCBlock) ConsumeZC() byte {
	b.catchUp()
	m := b.zcMask
	b.zcMask = 0
	if m != 0 {
		b.reschedule()
	}
	return m
}

// reschedule recomputes the earliest int-enabled ZC deadline.
func (b *CTCBlock) reschedule() {
	b.nextZC28 = 0
	for _, c := range b.ch {
		if !c.IntEnabled() {
			continue
		}
		if ticks, ok := c.TicksToNextZC(); ok {
			at := b.last28 + ticks
			if b.nextZC28 == 0 || at < b.nextZC28 {
				b.nextZC28 = at
			}
		}
	}
}

// ClaimsPort reports whether addr decodes to a CTC channel port:
// a(15:11) = "00011" and low byte $3B (zxnext.vhd:2690).
func (b *CTCBlock) ClaimsPort(addr uint16) bool {
	return addr>>11 == 0x03 && addr&0xFF == 0x3B
}

// WritePort performs a CPU write to a CTC channel port.
func (b *CTCBlock) WritePort(addr uint16, val byte) {
	b.catchUp()
	sel := int(addr>>8) & 0x07
	if sel < len(b.ch) {
		b.ch[sel].Write(val)
	}
	b.reschedule()
}

// ReadPort reads a CTC channel port: the live down-counter
// (ctc_chan.vhd:168 o_cpu_d). Unmapped selects (4-7) read 0 — the
// FPGA's read mux ORs one-hot selected outputs (ctc.vhd).
func (b *CTCBlock) ReadPort(addr uint16) byte {
	b.catchUp()
	b.reschedule()
	sel := int(addr>>8) & 0x07
	if sel < len(b.ch) {
		return b.ch[sel].Count()
	}
	return 0
}

// WriteIntEnable applies an NR$C5 write: bit n = channel n interrupt
// enable (zxnext.vhd:4078-4079; upper 4 bits unused, NUM_CTC=4).
func (b *CTCBlock) WriteIntEnable(mask byte) {
	b.catchUp()
	for i, c := range b.ch {
		c.WriteIntEnable(mask&(1<<uint(i)) != 0)
	}
	b.reschedule()
}

// ReadIntEnable composes the NR$C5 readback from the live channel
// interrupt-enable bits (zxnext.vhd:6242 port_253b_dat <= ctc_int_en).
func (b *CTCBlock) ReadIntEnable() byte {
	var v byte
	for i, c := range b.ch {
		if c.IntEnabled() {
			v |= 1 << uint(i)
		}
	}
	return v
}

// IntLine is the z80.CPU.ExtIntFunc: polled per instruction, it
// reports whether the CTC pulse-mode INT line is asserted. A ZC/TO on
// an int-enabled channel asserts the line for pulseTstates CPU cycles
// (zxnext.vhd:2014-2043), tracked as a CLK_28 deadline (the CPU
// T-state argument wraps per frame, so it cannot anchor the pulse).
// Cost when idle: one clock read + one uint64 compare.
func (b *CTCBlock) IntLine(_ uint64) bool {
	now := b.clk28()
	if b.nextZC28 != 0 && now >= b.nextZC28 {
		b.catchUp()
		b.reschedule()
		b.pulseUntil28 = now + b.pulseTstates*8/uint64(b.speedMult())
		return true
	}
	return now < b.pulseUntil28
}
