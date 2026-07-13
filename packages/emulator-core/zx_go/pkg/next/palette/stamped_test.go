package palette

// Unit tests for the raster-stamped palette-content write log
// (Bank.logWrite / BeginReplay / ReplayThrough / RewindReplay /
// EndReplay). Oracle: on the FPGA a palette BRAM write
// (nr_palette_we, zxnext.vhd:4919-4930) is visible to the video fetch
// on the next pixel, so mid-frame CPU rewrites recolour the scene from
// their raster position; the ULA render reproduces that by replaying
// this log row by row. Exercised end-to-end by the MrKWatkins
// ScanlineReadingAndInterrupt runner (TestNexttestsScanlineIRQ).

import "testing"

func stampedBank(line *int) *Bank {
	b := NewBank()
	b.SetRasterLineSource(func() int { return *line })
	return b
}

func TestStampedWritesReplayProgressively(t *testing.T) {
	line := 0
	b := stampedBank(&line)
	b.Select(PaletteULAFirst)
	b.SetAutoIncDisable(true)
	b.SetIndex(23)
	base := b.Palette(int(PaletteULAFirst)).Get(23)

	line = 100
	b.Write8(0x0C) // green flash
	green := b.Palette(int(PaletteULAFirst)).Get(23)
	line = 101
	b.Write8(0xB6) // white restore
	white := b.Palette(int(PaletteULAFirst)).Get(23)

	if !b.BeginReplay(false) {
		t.Fatal("BeginReplay should report stamped writes")
	}
	if got := b.Palette(int(PaletteULAFirst)).Get(23); got != base {
		t.Errorf("after BeginReplay entry = %03X, want frame-start %03X", got, base)
	}
	b.ReplayThrough(99)
	if got := b.Palette(int(PaletteULAFirst)).Get(23); got != base {
		t.Errorf("through line 99 entry = %03X, want %03X (write is stamped 100)", got, base)
	}
	b.ReplayThrough(100)
	if got := b.Palette(int(PaletteULAFirst)).Get(23); got != green {
		t.Errorf("through line 100 entry = %03X, want green %03X", got, green)
	}
	b.ReplayThrough(101)
	if got := b.Palette(int(PaletteULAFirst)).Get(23); got != white {
		t.Errorf("through line 101 entry = %03X, want white %03X", got, white)
	}
	// Rewind for a second raster pass (the render's top-border rows).
	b.RewindReplay()
	if got := b.Palette(int(PaletteULAFirst)).Get(23); got != base {
		t.Errorf("after RewindReplay entry = %03X, want %03X", got, base)
	}
	b.EndReplay()
	if got := b.Palette(int(PaletteULAFirst)).Get(23); got != white {
		t.Errorf("after EndReplay entry = %03X, want live state %03X", got, white)
	}
}

func TestStampedWritesStaleRenderReplaysConsumedLog(t *testing.T) {
	line := 50
	b := stampedBank(&line)
	b.Select(PaletteULAFirst)
	b.SetAutoIncDisable(true)
	b.SetIndex(7)
	base := b.Palette(int(PaletteULAFirst)).Get(7)
	b.Write8(0x1C)

	// First (fresh) render consumes the log but retains it.
	b.BeginReplay(false)
	b.EndReplay()
	// A stale re-render (screenshot with no execution) replays it again.
	if !b.BeginReplay(true) {
		t.Fatal("stale BeginReplay should replay the retained log")
	}
	if got := b.Palette(int(PaletteULAFirst)).Get(7); got != base {
		t.Errorf("stale BeginReplay entry = %03X, want frame-start %03X", got, base)
	}
	b.EndReplay()
	// A fresh render after a frame with NO palette writes must NOT
	// replay last frame's flashes.
	if b.BeginReplay(false) {
		t.Error("fresh BeginReplay after consumed log should have nothing to replay")
	}
	b.EndReplay()
}

func TestStampedWritesNewFrameDropsConsumedLog(t *testing.T) {
	line := 10
	b := stampedBank(&line)
	b.Select(PaletteULAFirst)
	b.SetAutoIncDisable(true)
	b.SetIndex(3)
	b.Write8(0x11)
	b.BeginReplay(false)
	b.EndReplay()

	// First write of the next execution frame drops the consumed log.
	line = 200
	b.Write8(0x22)
	b.BeginReplay(false)
	b.ReplayThrough(10)
	// The line-10 write from the previous frame must be gone: at
	// line 10 the entry still holds the new frame's START state, which
	// is the previous frame's final value (the $11 write, stored as
	// $023 with the derived low blue bit — zxnext.vhd:4919).
	if got := b.Palette(int(PaletteULAFirst)).Get(3); got != 0x023 {
		t.Errorf("through line 10 entry = %03X, want %03X (old frame's log dropped)", got, 0x023)
	}
	b.ReplayThrough(200)
	if got := b.Palette(int(PaletteULAFirst)).Get(3); got != 0x045 {
		t.Errorf("through line 200 entry = %03X, want %03X", got, 0x045)
	}
	b.EndReplay()
}

func TestStampedWritesSuspendedDuringReplay(t *testing.T) {
	line := 5
	b := stampedBank(&line)
	b.Select(PaletteULAFirst)
	b.SetAutoIncDisable(true)
	b.SetIndex(9)
	b.Write8(0x30)
	b.BeginReplay(false)
	// A write landing during the render walk (the copper interleave)
	// must not be logged — and must survive EndReplay's remainder pass
	// only as the live value it already set... EndReplay re-applies the
	// logged CPU write on top, restoring the live end-of-frame state.
	b.Write8(0x55)
	b.EndReplay()
	if b.BeginReplay(false) {
		t.Error("render-time write must not be stamped into the next replay log")
	}
	b.EndReplay()
}

func TestStampedWritesOverflowDegradesToFinalState(t *testing.T) {
	line := 42
	b := stampedBank(&line)
	b.Select(PaletteULAFirst)
	b.SetAutoIncDisable(true)
	b.SetIndex(1)
	for i := 0; i < maxStampedWrites+10; i++ {
		b.Write8(byte(i))
	}
	final := b.Palette(int(PaletteULAFirst)).Get(1)
	if b.BeginReplay(false) {
		t.Error("overflowed log should degrade to no replay")
	}
	if got := b.Palette(int(PaletteULAFirst)).Get(1); got != final {
		t.Errorf("overflow must keep the live state, got %03X want %03X", got, final)
	}
	b.EndReplay()
}

func TestStampedWritesWrite9RestoresPriority(t *testing.T) {
	line := 60
	b := stampedBank(&line)
	b.Select(PaletteLayer2First)
	b.SetAutoIncDisable(true)
	b.SetIndex(4)
	p := b.Palette(int(PaletteLayer2First))
	baseVal, basePrio := p.Get(4), p.Priority(4)
	b.Write9(0xFF, 0x81) // 9-bit value + priority bits 7:6 = 10
	if p.Priority(4) != 0x02 {
		t.Fatalf("Write9 priority = %d, want 2", p.Priority(4))
	}
	b.BeginReplay(false)
	if p.Get(4) != baseVal || p.Priority(4) != basePrio {
		t.Errorf("rewind should restore value+priority: got %03X/%d want %03X/%d",
			p.Get(4), p.Priority(4), baseVal, basePrio)
	}
	b.EndReplay()
	if p.Get(4) != 0x1FF || p.Priority(4) != 0x02 {
		t.Errorf("EndReplay should restore live value+priority, got %03X/%d", p.Get(4), p.Priority(4))
	}
}
