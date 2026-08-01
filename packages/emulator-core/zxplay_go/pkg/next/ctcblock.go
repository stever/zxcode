package next

import (
	"github.com/stever/zxplay_go/pkg/next/ctc"
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
// instead. The channel-to-channel ZC/TO trigger cascade is modelled
// (#158 Axis 5): channel N's CLK/TRG input is channel (N-1) mod 4's
// ZC/TO pulse (zxnext.vhd:4082 i_clk_trg <= ctc_zc_to(2:0) &
// ctc_zc_to(3)), fed in catchUp — a COUNTER-mode channel divides its
// upstream neighbour (timer chains longer than 8 bits), and a
// waiting-on-trigger timer starts on the upstream's pulse.
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

	// rescheduleNotify, if non-nil, fires whenever the block's INT
	// schedule may have changed (every reschedule/Reset). Wired to
	// z80.CPU.KickExtIntDeadline so the CPU's gated ExtIntFunc poll
	// (armed from NextAssertRef8) re-samples after any CTC
	// reprogramming (#187).
	rescheduleNotify func()

	// zcConsumer, if non-nil (hw-im2 mode, IM2Block), is invoked by
	// the CPU-visible access paths (port/NR$C5 writes and reads) when
	// a catch-up banked fresh ZC pulses, BEFORE the access mutates the
	// channel — so the daisy chain latches each pulse under the
	// int-enable state in force when it FIRED. Without this, the
	// deadline-gated poll (#208) could leave a disabled channel's ZC
	// in zcMask until after a later enable write, latching a request
	// the hardware never would have.
	zcConsumer func()
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
	if b.rescheduleNotify != nil {
		b.rescheduleNotify()
	}
}

// Channel exposes channel n (tests / debugger).
func (b *CTCBlock) Channel(n int) *ctc.Channel { return b.ch[n&3] }

// catchUp advances every channel to the current CLK_28 time and
// returns true if any int-enabled channel fired a ZC in the window.
// After the idle advance it feeds the channel-to-channel ZC/TO
// cascade: channel N's CLK/TRG input is channel (N-1) mod 4's ZC/TO
// pulse (zxnext.vhd:4082 i_clk_trg <= ctc_zc_to(2:0) & ctc_zc_to(3)),
// so a COUNTER-mode channel divides its upstream neighbour and a
// waiting timer starts on it. The ring is iterated until no new
// pulses appear, so a multi-stage divider chain settles within the
// window (each stage divides, so the pass count is bounded).
func (b *CTCBlock) catchUp() bool {
	now := b.clk28()
	if now <= b.last28 {
		return false
	}
	d := now - b.last28
	b.last28 = now
	fired := false
	record := func(i int, zcs uint64) {
		if zcs > 0 {
			b.zcMask |= 1 << uint(i)
			if b.ch[i].IntEnabled() {
				fired = true
			}
		}
	}
	// pending[i]: upstream pulses produced for channel i, not yet fed.
	var pending [4]uint64
	for i, c := range b.ch {
		zcs := c.AdvanceIdle(d)
		record(i, zcs)
		pending[(i+1)&3] += zcs
	}
	for pass := 0; pass < 8; pass++ {
		progressed := false
		for i, c := range b.ch {
			k := pending[i]
			if k == 0 {
				continue
			}
			pending[i] = 0
			if !c.TriggerSensitive() {
				continue // a running timer ignores its trigger
			}
			progressed = true
			var zcs uint64
			for ; k > 0; k-- {
				zcs += c.PulseTrigger()
			}
			record(i, zcs)
			pending[(i+1)&3] += zcs
		}
		if !progressed {
			break
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

// reschedule recomputes the earliest int-enabled ZC deadline. A
// cascade-fed channel (int-enabled, trigger-sensitive, with a
// running-timer upstream neighbour) arms a CONSERVATIVE deadline at
// the upstream's next ZC — IntLine catches up there and the cascade
// feed in catchUp decides whether the downstream actually fired.
func (b *CTCBlock) reschedule() {
	b.nextZC28 = 0
	arm := func(ticks uint64) {
		at := b.last28 + ticks
		if b.nextZC28 == 0 || at < b.nextZC28 {
			b.nextZC28 = at
		}
	}
	for i, c := range b.ch {
		if !c.IntEnabled() {
			continue
		}
		if ticks, ok := c.TicksToNextZC(); ok {
			arm(ticks)
			continue
		}
		if c.TriggerSensitive() {
			if ticks, ok := b.ch[(i+3)&3].TicksToNextZC(); ok {
				arm(ticks)
			}
		}
	}
	if b.rescheduleNotify != nil {
		b.rescheduleNotify()
	}
}

// SetRescheduleNotify installs the schedule-change callback (see the
// rescheduleNotify field docs). Pass nil to disable.
func (b *CTCBlock) SetRescheduleNotify(fn func()) { b.rescheduleNotify = fn }

// SetZCConsumer installs the eager ZC drain (see the zcConsumer field
// docs). Pass nil to disable.
func (b *CTCBlock) SetZCConsumer(fn func()) { b.zcConsumer = fn }

// drainZC hands any banked ZC pulses to the installed consumer. Called
// after a catch-up and before the calling access mutates channel state;
// the consumer's own ConsumeZC re-runs catchUp as a no-op (time has not
// advanced) so the recursion terminates immediately.
func (b *CTCBlock) drainZC() {
	if b.zcMask != 0 && b.zcConsumer != nil {
		b.zcConsumer()
	}
}

// NextAssertRef8 is the z80.CPU.ExtIntDeadlineFunc: the earliest
// Ref8Tstates instant at which IntLine could next return true. 0 =
// poll now (pulse currently asserted, or a scheduled ZC already due);
// ^uint64(0) = nothing armed (park until a reschedule kicks the CPU);
// otherwise the exact nextZC28 deadline — before which every IntLine
// call provably returns false with no side effects, so skipping the
// polls is delivery-identical.
func (b *CTCBlock) NextAssertRef8() uint64 {
	now := b.clk28()
	if now < b.pulseUntil28 {
		return 0
	}
	if b.nextZC28 == 0 {
		return ^uint64(0)
	}
	if now >= b.nextZC28 {
		return 0
	}
	return b.nextZC28
}

// ClaimsPort reports whether addr decodes to a CTC channel port:
// a(15:11) = "00011" and low byte $3B (zxnext.vhd:2690).
func (b *CTCBlock) ClaimsPort(addr uint16) bool {
	return addr>>11 == 0x03 && addr&0xFF == 0x3B
}

// WritePort performs a CPU write to a CTC channel port.
func (b *CTCBlock) WritePort(addr uint16, val byte) {
	b.catchUp()
	b.drainZC() // latch pre-write pulses under pre-write enables (#208)
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
	b.drainZC()
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
	b.drainZC() // latch pre-write pulses under pre-write enables (#208)
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
		fired := b.catchUp()
		b.reschedule()
		// Cascade deadlines are conservative (armed at the UPSTREAM's
		// next ZC) — assert the pulse only if an int-enabled channel
		// actually fired in the window.
		if fired {
			b.pulseUntil28 = now + b.pulseTstates*8/uint64(b.speedMult())
			return true
		}
	}
	return now < b.pulseUntil28
}
