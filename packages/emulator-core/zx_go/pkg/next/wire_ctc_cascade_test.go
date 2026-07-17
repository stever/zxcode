package next

// CTC channel-to-channel ZC/TO cascade (#158 Axis 5). FPGA truth:
// zxnext.vhd:4082 wires the ctc module's i_clk_trg to
// ctc_zc_to(2:0) & ctc_zc_to(3) — channel N's CLK/TRG input is
// channel (N-1) mod 4's ZC/TO pulse. A COUNTER-mode channel therefore
// divides its upstream neighbour (the classic Z80-CTC long-timer
// chain), and a timer parked waiting on its trigger (control word
// bit 0) starts when the upstream fires.

import (
	"testing"
)

// cascadeClock is a controllable CLK_28 source.
type cascadeClock struct{ now uint64 }

func (c *cascadeClock) clk() uint64 { return c.now }

func newCascadeBlock() (*CTCBlock, *cascadeClock) {
	clk := &cascadeClock{}
	b := NewCTCBlock(clk.clk, func() int { return 1 })
	return b, clk
}

// TestCTCCascadeCounterDividesUpstreamTimer: ch0 timer (prescaler 16,
// TC 4 → ZC every 64 clocks) cascades into ch1 in COUNTER mode with
// TC 3 — ch1 must ZC once per THREE ch0 pulses (192 clocks), the
// divider chain zxnext.vhd:4082 exists for.
func TestCTCCascadeCounterDividesUpstreamTimer(t *testing.T) {
	b, clk := newCascadeBlock()

	// ch1 first: counter mode (D6), TC follows (D2), reset (D1),
	// control word (D0) → $47; TC 3.
	b.WritePort(0x193B, 0x47)
	b.WritePort(0x193B, 3)
	// ch0: timer mode, prescaler 16, TC follows, reset, CW → $07; TC 4.
	b.WritePort(0x183B, 0x07)
	b.WritePort(0x183B, 4)

	// Run ~13 ch0 periods: 13*64 clocks. ch0 fires 13 ZCs; ch1 (÷3)
	// fires on pulses 3, 6, 9, 12 → 4 ZCs.
	clk.now += 13 * 64
	got := b.ConsumeZC()
	if got&0x01 == 0 {
		t.Errorf("ch0 ZC mask bit clear after 13 periods")
	}
	if got&0x02 == 0 {
		t.Errorf("ch1 ZC mask bit clear — the cascade did not feed the counter (vhd:4082)")
	}
	// The counter's residual count pins the division: 13 pulses into a
	// ÷3 counter → 13 mod 3 = 1 consumed since the last reload →
	// count = 3-1 = 2.
	if got := b.Channel(1).Count(); got != 2 {
		t.Errorf("ch1 count after 13 upstream pulses = %d, want 2 (÷3 chain)", got)
	}
}

// TestCTCCascadeDoesNotFeedRunningTimer: a RUNNING timer ignores its
// trigger input — upstream pulses must not disturb it.
func TestCTCCascadeDoesNotFeedRunningTimer(t *testing.T) {
	b, clk := newCascadeBlock()

	// ch0: fast timer (16×1 = 16 clocks/ZC).
	b.WritePort(0x183B, 0x07)
	b.WritePort(0x183B, 1)
	// ch1: auto-start timer, prescaler 256, TC 10 (CW $27).
	b.WritePort(0x193B, 0x27)
	b.WritePort(0x193B, 10)

	// One full ch1 period = 2560 clocks; ch0 fires 160 pulses in it.
	clk.now += 2560
	b.ConsumeZC()
	// ch1 should have completed exactly its own period (count back at
	// reload), unperturbed by the 160 upstream pulses.
	if got := b.Channel(1).Count(); got != 10 {
		t.Errorf("running timer count = %d, want 10 (trigger input must be ignored)", got)
	}
}

// TestCTCCascadeStartsWaitingTimer: a timer with the wait-on-trigger
// bit set parks until its CLK/TRG edge — the upstream's ZC/TO pulse —
// then runs.
func TestCTCCascadeStartsWaitingTimer(t *testing.T) {
	b, clk := newCascadeBlock()

	// ch1: timer, prescaler 16, wait-on-trigger (D3), TC follows,
	// reset, CW → $0F; TC 5.
	b.WritePort(0x193B, 0x0F)
	b.WritePort(0x193B, 5)
	// With no trigger, the channel must stay parked.
	clk.now += 1000
	b.ConsumeZC()
	if got := b.Channel(1).Count(); got != 5 {
		t.Errorf("waiting timer advanced without a trigger: count %d, want 5", got)
	}

	// ch0: timer that fires once per 64 clocks — its first ZC starts ch1.
	b.WritePort(0x183B, 0x07)
	b.WritePort(0x183B, 4)
	// Window 1 delivers the upstream pulse (the cascade feed runs at
	// the end of the window, so the started timer counts from the NEXT
	// observation — the block's documented lazy-advance granularity;
	// real callers observe per instruction).
	clk.now += 64 + 4
	b.ConsumeZC()
	if got := b.Channel(1).Count(); got != 5 {
		t.Errorf("ch1 count after the starting pulse = %d, want 5 (started, not yet counted)", got)
	}
	// Window 2: a full ch1 period after the start.
	clk.now += 16*5 + 16
	got := b.ConsumeZC()
	if got&0x02 == 0 {
		t.Errorf("ch1 never fired — the upstream pulse did not start the waiting timer")
	}
}
