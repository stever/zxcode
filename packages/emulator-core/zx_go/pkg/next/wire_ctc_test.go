package next

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/nextregs"
	"github.com/conorarmstrong/zx_go/pkg/z80"
)

// TestWireCTCPulseInterrupt drives the full CTC interrupt chain the way
// TX-1696's install hook does: program channel 0 with control word $85
// (interrupt enable, timer mode, /16 prescale, TC follows) and TC=7 via
// port $183B, EI in IM 1, and let the CPU run. The channel counts
// CLK_28 (zxnext.vhd:4072), so a ZC/TO fires every 16×7 = 112 CLK_28
// cycles ≈ 250 kHz, each asserting the pulse-mode INT
// (im2_peripheral.vhd:186 → zxnext.vhd:2014-2043). Expect the guest's
// IM1 handler to run at that rate — hundreds of times per frame — where
// an unwired CTC delivers only the single ULA frame INT.
func TestWireCTCPulseInterrupt(t *testing.T) {
	cpu := z80.New(minimalMem{}, minimalULA{})
	disp := nextregs.New()
	WireCPUSpeed(disp, cpu)
	block := WireCTC(disp, cpu)

	// Program ch0 exactly as the game does (via the block's port face;
	// the ULA routing to WritePort is one line of dispatch covered by
	// the ula package).
	block.WritePort(0x183B, 0x85)
	block.WritePort(0x183B, 7)

	if got := block.ReadIntEnable(); got != 0x01 {
		t.Fatalf("NR$C5 readback after control-word int-enable = %02X, want 01", got)
	}

	// Run one frame's worth of instructions with IFF1 on and count
	// taken interrupts via the IM1 vector.
	cpu.IFF1, cpu.IFF2 = true, true
	cpu.IM = 1
	before := z80.IntFireCount
	cpu.ExecuteFrame(70908) // one 128K-timing frame at 3.5 MHz
	taken := z80.IntFireCount - before

	// One frame = 70908 ref T-states = 567,264 CLK_28 cycles → ~5064
	// ZCs. Each taken INT re-runs after the handler; the exact count
	// depends on handler length (minimalMem serves NOPs — the IM1
	// vector at $0038 runs NOP-slide, EI never re-runs...). IFF1
	// clears on the first acceptance, so with no EI in the "handler"
	// exactly ONE interrupt is taken — but the LINE must have been
	// asserted, which is the wiring under test.
	if taken == 0 {
		t.Fatalf("no interrupt taken with CTC ch0 armed (int enable + TC=7)")
	}
}

// TestWireCTCIntLineReasserts pins the pulse cadence: with ch0 armed at
// TC=7/16 the INT line must assert repeatedly (each ZC opens a fresh
// 32-CPU-cycle pulse window), so a guest that keeps re-enabling
// interrupts sees a ~250 kHz stream, not a one-shot.
func TestWireCTCIntLineReasserts(t *testing.T) {
	cpu := z80.New(minimalMem{}, minimalULA{})
	disp := nextregs.New()
	WireCPUSpeed(disp, cpu)
	block := WireCTC(disp, cpu)

	block.WritePort(0x183B, 0x85)
	block.WritePort(0x183B, 7)

	cpu.IFF1, cpu.IFF2 = true, true
	cpu.IM = 1
	before := z80.IntFireCount
	// Step instructions with the IRQ path, re-enabling interrupts after
	// each acceptance (the game's IM2 handler does EI/RETI).
	for i := 0; i < 20000; i++ {
		cpu.StepInstructionWithIRQ()
		cpu.IFF1, cpu.IFF2 = true, true
	}
	taken := z80.IntFireCount - before
	// 20000 NOPs ≈ 80000 CPU T-states at 3.5 MHz = 640,000 CLK_28 →
	// ~5700 ZC pulses. Far more than one must be taken.
	if taken < 100 {
		t.Fatalf("CTC pulse INT taken %d times over 20000 instructions, want ≥100", taken)
	}
}

// TestCTCPulseDeassertsAndStaysLowAfterDisarm pins the pulse-window
// bookkeeping to the monotonic CLK_28 domain. Regression: the deadline
// was held in CPU T-states, which ExecuteFrame wraps every frame
// (tstates -= frameEnd) — a channel disarmed after a pulse left a
// stale deadline that read as an asserted INT line from every frame
// origin until the counter regrew past it.
func TestCTCPulseDeassertsAndStaysLowAfterDisarm(t *testing.T) {
	var now28 uint64
	b := NewCTCBlock(func() uint64 { return now28 }, func() int { return 1 })

	// Arm ch0 like TX-1696: $85 (int en, timer, /16), TC=7 → first ZC
	// 1+112 CLK_28 ticks after programming.
	b.WritePort(0x183B, 0x85)
	b.WritePort(0x183B, 7)

	now28 += 200 // past the first ZC deadline
	if !b.IntLine(0) {
		t.Fatal("INT line not asserted after a scheduled ZC elapsed")
	}

	// Disarm before the pulse window closes (32 CPU cycles at
	// multiplier 1 = 256 CLK_28 ticks from the assert).
	b.WriteIntEnable(0)
	if !b.IntLine(0) {
		t.Fatal("pulse must stay asserted for its full width after disarm")
	}

	// Past the pulse width: the line must drop and STAY low, however
	// far the clock advances (the CPU counter may wrap many times in
	// this span — irrelevant now, the deadline is CLK_28-domain).
	now28 += 256
	for i := 0; i < 4; i++ {
		if b.IntLine(0) {
			t.Fatalf("INT line still asserted %d ticks past the ZC with channel disarmed", now28-200)
		}
		now28 += 70908 * 8 // one 3.5 MHz frame in CLK_28 ticks
	}
}

// TestWireCTCNR02ResetClearsChannels: a machine reset through NR$02
// hard-resets the channels so a stale armed timer cannot storm the
// freshly booting OS with interrupts.
func TestWireCTCNR02ResetClearsChannels(t *testing.T) {
	cpu := z80.New(minimalMem{}, minimalULA{})
	disp := nextregs.New()
	WireCPUSpeed(disp, cpu)
	// WireReset installs the NR$02 handler WireCTC chains onto. Use a
	// minimal stand-in: a plain Store handler.
	disp.SetOnWrite(0x02, func(d *nextregs.Dispatcher, v byte) { d.Store(0x02, v) })
	block := WireCTC(disp, cpu)

	block.WritePort(0x183B, 0x85)
	block.WritePort(0x183B, 7)
	if block.ReadIntEnable() == 0 {
		t.Fatal("precondition: ch0 int enable set")
	}
	disp.Select(0x02)
	disp.WriteData(0x01) // soft reset
	if got := block.ReadIntEnable(); got != 0 {
		t.Fatalf("after NR$02 soft reset: int enables = %02X, want 0", got)
	}
}
