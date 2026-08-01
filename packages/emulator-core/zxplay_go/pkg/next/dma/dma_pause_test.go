package dma

import "testing"

// The dma-delay condition (zxnext.vhd:2005-2008 im2_dma_delay →
// dma.vhd:269/427 dma_delay_i): an NR$CC-$CE-enabled interrupt source
// outside its idle state — or an outstanding NMI with NR$CC bit 7 —
// holds the DMA off the bus between byte transfers. These tests drive
// the injected pauseFn directly; the chain/NMI composition is
// next.WireDMAPause's and is pinned by pkg/next/wire_dmaint_test.go.

// pauseSrcFill seeds an 8-byte source block.
func pauseSrcFill(mem memMap) {
	for i := uint16(0); i < 8; i++ {
		mem[0x4000+i] = byte(i + 1)
	}
}

// TestPauseParksContinuousAtStart: ENABLE while the condition holds
// moves nothing (the FPGA waits in START_DMA, dma.vhd:269); the block
// resumes from Step the moment the condition clears, charging only the
// bytes actually moved.
func TestPauseParksContinuousAtStart(t *testing.T) {
	mem := memMap{}
	pauseSrcFill(mem)
	d := New(mem)
	now := uint64(1000)
	d.SetClock(func() uint64 { return now })
	var charged uint64
	d.SetCycleSink(func(n uint64) { charged += n })
	paused := true
	d.SetPauseFunc(func(uint64) (bool, uint64) { return paused, 0 })

	feed(d, transferCmd(0x4000, 0x8000, 8, addrIncrement, addrIncrement, true))

	if !d.Suspended() {
		t.Fatal("ENABLE under an active dma-delay did not park the block")
	}
	if mem[0x8000] != 0 {
		t.Fatalf("byte moved while paused: dst[0]=%02X", mem[0x8000])
	}
	if charged != 0 {
		t.Fatalf("charged %d T-states while paused", charged)
	}
	now += 50
	d.Step(now)
	if !d.Suspended() {
		t.Fatal("resumed while the pause condition still holds")
	}
	paused = false
	now += 50
	d.Step(now)
	if d.Suspended() {
		t.Fatal("still suspended after the pause cleared")
	}
	for i := uint16(0); i < 8; i++ {
		if mem[0x8000+i] != byte(i+1) {
			t.Fatalf("dst[%d]=%02X, want %02X", i, mem[0x8000+i], byte(i+1))
		}
	}
	if want := uint64(8) * d.perByteCycles(); charged != want {
		t.Fatalf("resume charged %d T-states, want %d", charged, want)
	}
}

// TestPauseSplitsContinuousAtDeadline: a pause that begins mid-block
// splits the transfer at the recheck deadline — bytes before it move
// and charge, the rest park until the condition clears.
func TestPauseSplitsContinuousAtDeadline(t *testing.T) {
	mem := memMap{}
	pauseSrcFill(mem)
	d := New(mem)
	now := uint64(100)
	d.SetClock(func() uint64 { return now })
	var charged uint64
	d.SetCycleSink(func(n uint64) { charged += n })
	// Per-byte cost is 4 CPU T (2+2 cycle lengths) at turbo 0 → 4
	// reference T per byte. Deadline 18 ref-T in: bytes at projected
	// offsets 0,4,8,12,16 move (5 bytes), the check at offset 20 pauses.
	deadline := now + 18
	blocked := true
	d.SetPauseFunc(func(ref uint64) (bool, uint64) {
		if ref >= deadline && blocked {
			return true, 0
		}
		return false, deadline
	})

	feed(d, transferCmd(0x4000, 0x8000, 8, addrIncrement, addrIncrement, true))

	if !d.Suspended() {
		t.Fatal("mid-block pause did not park the remainder")
	}
	movedFirst := 0
	for i := uint16(0); i < 8; i++ {
		if mem[0x8000+i] != 0 {
			movedFirst++
		}
	}
	if movedFirst != 5 {
		t.Fatalf("first chunk moved %d bytes, want 5 (split at the deadline)", movedFirst)
	}
	if want := uint64(5) * d.perByteCycles(); charged != want {
		t.Fatalf("first chunk charged %d, want %d", charged, want)
	}
	blocked = false
	now += 200
	d.Step(now)
	if d.Suspended() {
		t.Fatal("remainder did not resume after the pause cleared")
	}
	for i := uint16(0); i < 8; i++ {
		if mem[0x8000+i] != byte(i+1) {
			t.Fatalf("dst[%d]=%02X, want %02X", i, mem[0x8000+i], byte(i+1))
		}
	}
	if want := uint64(8) * d.perByteCycles(); charged != want {
		t.Fatalf("total charged %d, want %d", charged, want)
	}
}

// TestPauseHoldsBurstSchedule: an interleaved burst yields while the
// condition holds and resumes pacing FROM THE UNPAUSE INSTANT — delayed
// bytes do not catch up in a backlog burst (the FPGA re-enters
// START_DMA and paces from there).
func TestPauseHoldsBurstSchedule(t *testing.T) {
	mem := memMap{}
	pauseSrcFill(mem)
	d := New(mem)
	var now uint64
	d.SetClock(func() uint64 { return now })
	paused := false
	d.SetPauseFunc(func(uint64) (bool, uint64) { return paused, 0 })

	// Burst mode, prescaler 20 → one byte per 20/2 = 10 reference
	// T-states (perByteClockUnits).
	feed(d, burstStream(0x4000, 0x8000, 8, 20))

	now = 0
	d.Step(now) // first byte due immediately
	if mem[0x8000] != 1 {
		t.Fatalf("burst first byte not moved: %02X", mem[0x8000])
	}
	paused = true
	now = 30 // three due times pass while paused
	d.Step(now)
	if mem[0x8001] != 0 {
		t.Fatal("burst byte moved while paused")
	}
	paused = false
	now = 40
	d.Step(now)
	if mem[0x8001] != 2 {
		t.Fatal("burst did not resume after unpause")
	}
	if mem[0x8002] != 0 {
		t.Fatal("burst caught up in a backlog burst; schedule must restart at the unpause instant")
	}
	now = 50
	d.Step(now)
	if mem[0x8002] != 3 {
		t.Fatal("resumed burst not pacing at the prescaler interval")
	}
}
