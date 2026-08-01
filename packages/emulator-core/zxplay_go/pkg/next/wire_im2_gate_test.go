package next

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/z80"
)

// TestWireIM2DeadlineGateDeliveryIdentical pins the #208 hw-im2 poll
// gate: deadline-gating the per-instruction ExtIntFunc poll on the CTC
// ZC schedule must be DELIVERY-IDENTICAL to polling every sample point.
// Two identical rigs run the same NOP loop with the same armed CTC
// channel; one keeps the gate (ExtIntDeadlineFunc), the other has it
// stripped (nil = re-poll every instruction, the pre-#208 behaviour).
// Interrupt count and every acceptance instant must match exactly.
func TestWireIM2DeadlineGateDeliveryIdentical(t *testing.T) {
	type run struct {
		accepts []int // step indices where the handler was entered
	}
	exec := func(gated bool) run {
		cpu, disp, ctcBlk, mem := im2TestRig(t)
		if !gated {
			cpu.ExtIntDeadlineFunc = nil // poll every sample point
		}
		nrWrite(disp, 0xC0, 0xA1) // vector base %101, hw-IM2 mode
		ctcBlk.WritePort(0x183B, 0x85)
		ctcBlk.WritePort(0x183B, 7)
		cpu.FrameIntDisabled = true

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

		var r run
		last := z80.IntFireCount
		for i := 0; i < 20000; i++ {
			cpu.StepInstructionWithIRQ()
			if z80.IntFireCount != last {
				last = z80.IntFireCount
				r.accepts = append(r.accepts, i)
			}
			if cpu.Halted {
				t.Fatalf("wrong-vector trap hit (gated=%v)", gated)
			}
		}
		return r
	}
	gated := exec(true)
	ungated := exec(false)
	if len(gated.accepts) == 0 {
		t.Fatal("no interrupts delivered at all")
	}
	if len(gated.accepts) != len(ungated.accepts) {
		t.Fatalf("interrupt count diverged: gated %d, ungated %d",
			len(gated.accepts), len(ungated.accepts))
	}
	for i := range gated.accepts {
		if gated.accepts[i] != ungated.accepts[i] {
			t.Fatalf("acceptance %d diverged: gated step %d, ungated step %d",
				i, gated.accepts[i], ungated.accepts[i])
		}
	}
}

// TestWireIM2ISRParkedGateStaysClosed pins the #206 half of the poll
// gate: a device parked in S_ISR holds its im2_int_req latch through
// the WHOLE in-service window (cleared only by the RETI transition),
// and counting that latch as "chain active" reopened the
// per-instruction poll for the entire ISR body — a machine spending
// most of each interrupt period inside a fat ISR (WOTEF's ~23 kHz
// music engine) paid the full 14-device chain Tick per instruction,
// ~30% of exec. The gated run must stay DELIVERY-IDENTICAL to the
// ungated run (same acceptance instants) with a LONG ISR, while its
// ExtIntFunc poll count stays O(interrupts), not O(instructions).
func TestWireIM2ISRParkedGateStaysClosed(t *testing.T) {
	type run struct {
		accepts []int
		polls   int
		steps   int
	}
	exec := func(gated bool) run {
		cpu, disp, ctcBlk, mem := im2TestRig(t)
		if !gated {
			cpu.ExtIntDeadlineFunc = nil // poll every sample point
		}
		var r run
		orig := cpu.ExtIntFunc
		cpu.ExtIntFunc = func(ts uint64) bool {
			r.polls++
			return orig(ts)
		}
		nrWrite(disp, 0xC0, 0xA1) // vector base %101, hw-IM2 mode
		// CTC ch0, prescaler 16, TC=200: period 3200 CLK_28 ≈ 400
		// T-states — the ISR below fills most of it.
		ctcBlk.WritePort(0x183B, 0x85)
		ctcBlk.WritePort(0x183B, 200)
		cpu.FrameIntDisabled = true

		// Long ISR at $8100: ~60 NOPs (240 T ≈ 60% of the period),
		// then EI + RETI. Repoint every vector-table entry at it.
		for a := 0x5E00; a < 0x6000; a += 2 {
			mem.m[a] = 0x00
			mem.m[a+1] = 0x81
		}
		for a := 0x8100; a < 0x813C; a++ {
			mem.m[a] = 0x00 // NOP
		}
		mem.m[0x813C] = 0xFB // EI
		mem.m[0x813D] = 0xED // RETI
		mem.m[0x813E] = 0x4D

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

		last := z80.IntFireCount
		for i := 0; i < 30000; i++ {
			cpu.StepInstructionWithIRQ()
			if z80.IntFireCount != last {
				last = z80.IntFireCount
				r.accepts = append(r.accepts, i)
			}
			if cpu.Halted {
				t.Fatalf("wrong-vector trap hit (gated=%v)", gated)
			}
		}
		r.steps = 30000
		return r
	}
	gated := exec(true)
	ungated := exec(false)
	if len(gated.accepts) < 10 {
		t.Fatalf("too few interrupts delivered: %d", len(gated.accepts))
	}
	if len(gated.accepts) != len(ungated.accepts) {
		t.Fatalf("interrupt count diverged: gated %d, ungated %d",
			len(gated.accepts), len(ungated.accepts))
	}
	for i := range gated.accepts {
		if gated.accepts[i] != ungated.accepts[i] {
			t.Fatalf("acceptance %d diverged: gated step %d, ungated step %d",
				i, gated.accepts[i], ungated.accepts[i])
		}
	}
	// The ungated run polls every instruction. The gated run may poll a
	// small constant number of times around each interrupt (latch tick,
	// fall tick, REQ->ACK window) but must NOT poll through ISR bodies.
	if maxPolls := len(gated.accepts) * 20; gated.polls > maxPolls {
		t.Fatalf("gated run polled %d times for %d interrupts (> %d): ISR bodies are being polled per instruction",
			gated.polls, len(gated.accepts), maxPolls)
	}
	if gated.polls*4 > ungated.polls {
		t.Fatalf("gated %d vs ungated %d polls: gate not effective",
			gated.polls, ungated.polls)
	}
}

// TestWireIM2StaleDisabledZCNotLatchedOnEnable pins the #208 eager ZC
// drain: ZC/TO pulses fired while a channel's interrupt enable was OFF
// must never latch a chain request retroactively when the enable is
// later turned on (NR$C5). Without the drain, the deadline-gated poll
// leaves the disabled channel's pulses banked in the CTC's zcMask; the
// enable write's own catch-up would then hand them to the chain under
// the NEW enable — an interrupt real hardware never delivers. The
// first interrupt after the enable must come from a ZC that fires
// AFTER it — about one full channel period later, not immediately.
func TestWireIM2StaleDisabledZCNotLatchedOnEnable(t *testing.T) {
	cpu, disp, ctcBlk, mem := im2TestRig(t)

	nrWrite(disp, 0xC0, 0xA1) // hw-IM2 mode
	// Channel 0: control word WITHOUT bit 7 (int disabled), prescaler
	// 256 (bit 5), TC follows; TC=255 — a long period so several
	// instruction batches elapse per ZC and the post-enable gap is
	// measurable in T-states.
	ctcBlk.WritePort(0x183B, 0x25)
	ctcBlk.WritePort(0x183B, 0)
	cpu.FrameIntDisabled = true

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

	// Let WELL over one period elapse with ints disabled: period =
	// 256 * 256 = 65536 CLK_28 ticks. At 3.5 MHz (multiplier 8) one
	// T-state = 8 ticks, so ~8192 T-states per period; run ~10 periods
	// of NOPs (4 T each).
	before := z80.IntFireCount
	for i := 0; i < 20000; i++ {
		cpu.StepInstructionWithIRQ()
	}
	if z80.IntFireCount != before {
		t.Fatal("interrupt delivered while channel ints disabled")
	}

	// Enable ch0 ints via NR$C5. The elapsed (stale) ZCs must NOT
	// deliver an interrupt now; the next REAL ZC is up to one period
	// (~8192 T) away.
	enableAt := cpu.Ref8Tstates()
	nrWrite(disp, 0xC5, 0x01)
	var acceptAt uint64
	for i := 0; i < 40000; i++ {
		cpu.StepInstructionWithIRQ()
		if z80.IntFireCount != before {
			acceptAt = cpu.Ref8Tstates()
			break
		}
	}
	if acceptAt == 0 {
		t.Fatal("no interrupt after enabling channel ints")
	}
	// A stale-ZC latch accepts within a few instructions of the enable
	// (< ~500 CLK_28 ticks). A genuine post-enable ZC is scheduled on
	// the counter's own phase — with the counter free-running from its
	// last reload, allow anything beyond a few instructions but flag
	// the immediate window.
	if gap := acceptAt - enableAt; gap < 2000 {
		t.Fatalf("interrupt accepted %d CLK_28 ticks after enable — stale disabled-period ZC latched", gap)
	}
}
