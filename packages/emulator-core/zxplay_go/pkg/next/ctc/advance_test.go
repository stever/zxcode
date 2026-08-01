package ctc

import "testing"

// TestAdvanceIdleMatchesTick pins the O(1) fast-forward against the
// golden-tested per-tick model: for a spread of control words, time
// constants, phases and batch sizes, AdvanceIdle(n) must leave the
// channel in exactly the state n bare Tick() calls produce, and must
// report exactly the ZC/TO pulses those ticks fired.
func TestAdvanceIdleMatchesTick(t *testing.T) {
	controls := []uint8{
		0x85, // int en, timer, /16, auto trigger, TC follows — TX-1696 ch0
		0x05, // timer, /16, auto, TC follows
		0x25, // timer, /256, auto, TC follows
		0x0D, // timer, /16, WAIT trigger, TC follows (never starts)
		0x45, // counter mode, TC follows (no idle counting)
	}
	tcs := []uint8{1, 3, 7, 16, 255, 0} // 0 = 256
	batches := []uint64{1, 2, 15, 16, 17, 111, 112, 113, 500, 4096}

	for _, cw := range controls {
		for _, tc := range tcs {
			// Reference channel driven tick-by-tick; probe channel
			// advanced in batches. Both get the same programming.
			ref, probe := New(), New()
			ref.Write(cw)
			ref.Write(tc)
			probe.Write(cw)
			probe.Write(tc)

			// A few warm-up ticks so batch boundaries land mid-phase.
			for i := 0; i < 5; i++ {
				ref.Tick()
			}
			warmZCs := probe.AdvanceIdle(5)
			_ = warmZCs

			for _, n := range batches {
				var refZCs uint64
				for i := uint64(0); i < n; i++ {
					ref.Tick()
					if ref.ZCTO() {
						refZCs++
					}
				}
				gotZCs := probe.AdvanceIdle(n)
				if gotZCs != refZCs {
					t.Fatalf("cw=%02X tc=%d n=%d: AdvanceIdle ZCs=%d, tick-by-tick=%d",
						cw, tc, n, gotZCs, refZCs)
				}
				if probe.Count() != ref.Count() {
					t.Fatalf("cw=%02X tc=%d n=%d: Count=%d, want %d",
						cw, tc, n, probe.Count(), ref.Count())
				}
				if probe.ZCTO() != ref.ZCTO() {
					t.Fatalf("cw=%02X tc=%d n=%d: ZCTO=%v, want %v",
						cw, tc, n, probe.ZCTO(), ref.ZCTO())
				}
				if probe.state != ref.state {
					t.Fatalf("cw=%02X tc=%d n=%d: state=%d, want %d",
						cw, tc, n, probe.state, ref.state)
				}
				if probe.pCount != ref.pCount {
					t.Fatalf("cw=%02X tc=%d n=%d: pCount=%d, want %d",
						cw, tc, n, probe.pCount, ref.pCount)
				}
			}
		}
	}
}

// TestTicksToNextZC pins the scheduler against tick-by-tick reality
// for the TX-1696 configuration: control $85, TC=7, /16 prescale —
// the first ZC 1+16*7 ticks after programming, then every 112.
func TestTicksToNextZC(t *testing.T) {
	c := New()
	c.Write(0x85)
	c.Write(7)

	ticks, ok := c.TicksToNextZC()
	if !ok {
		t.Fatal("TicksToNextZC not scheduled after arming")
	}
	var n uint64
	for {
		c.Tick()
		n++
		if c.ZCTO() {
			break
		}
		if n > 10000 {
			t.Fatal("no ZC within 10000 ticks")
		}
	}
	if ticks != n {
		t.Fatalf("TicksToNextZC=%d, first ZC actually at %d", ticks, n)
	}

	// Steady state: next ZC every prescale*TC = 112 ticks.
	ticks, ok = c.TicksToNextZC()
	if !ok || ticks != 112 {
		t.Fatalf("steady-state TicksToNextZC=%d ok=%v, want 112", ticks, ok)
	}
}
