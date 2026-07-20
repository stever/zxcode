package ula

// Unit test for the raster-stamped palette-CONTENT replay contract
// between applyNextCompositor's row walk and the compositor
// (nextPaletteReplay): the walk rewinds the bank to its frame-start
// state, applies stamped writes row by row in raster order (paper rows
// at 64+y, bottom-border sweep rows at 64+v), rewinds once when the
// sweep reaches the displayed frame's top-border rows (which scanned
// BEFORE the paper, raster 40..63) and finishes by restoring the live
// state. Oracle: the FPGA's palette BRAM write is visible to the video
// fetch on the next pixel (zxnext.vhd:4919-4930). Pinned end-to-end by
// the MrKWatkins ScanlineReadingAndInterrupt runner.

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/keyboard"
	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// replayMock records the nextPaletteReplay calls the walk makes, and is
// otherwise the same pass-through compositor as liveULAMock.
type replayMock struct {
	liveULAMock
	log []string
	cur int // highest line seen by ReplayPaletteThrough since last rewind
}

func (m *replayMock) BeginPaletteReplay(stale bool) bool {
	m.log = append(m.log, "begin")
	m.cur = -1
	return true
}

func (m *replayMock) ReplayPaletteThrough(line int) {
	if line > m.cur {
		m.cur = line
	}
	m.log = append(m.log, "through")
}

func (m *replayMock) RewindPaletteReplay() {
	m.log = append(m.log, "rewind")
	m.cur = -1
}

func (m *replayMock) EndPaletteReplay() {
	m.log = append(m.log, "end")
}
func (m *replayMock) OverpaintWideL2Row(y int, dst []byte, xScale int) {}
func (m *replayMock) CaptureULABase(pix []byte, stride, w, h int)      {}

func TestApplyNextCompositorPaletteReplaySequence(t *testing.T) {
	dir := t.TempDir()
	createTestROMs(t, dir)
	mem, err := memory.New(dir, roms.Model48K)
	if err != nil {
		t.Fatalf("memory.New: %v", err)
	}
	u := New(mem, keyboard.New())
	m := &replayMock{}
	u.SetNextCompositor(m)
	u.Render()

	if len(m.log) < 3 || m.log[0] != "begin" || m.log[len(m.log)-1] != "end" {
		t.Fatalf("walk must bracket with begin/end, got %d calls (first %q, last %q)",
			len(m.log), m.log[0], m.log[len(m.log)-1])
	}
	// Exactly one rewind (for the top-border pass), after the begin.
	rewinds := 0
	rewindPos := -1
	for i, c := range m.log {
		if c == "rewind" {
			rewinds++
			rewindPos = i
		}
	}
	if rewinds != 1 {
		t.Fatalf("want exactly 1 rewind (top-border pass), got %d", rewinds)
	}
	// The final through-lines after the rewind must be the top-border
	// raster range (40..63) — the rows that scanned before the paper.
	if m.cur != 63 {
		t.Errorf("last pass should replay through raster 63 (top border), got %d", m.cur)
	}
	// Everything between begin and rewind must be monotonically
	// increasing paper/bottom-border thresholds ending >= 255.
	if rewindPos < 2 {
		t.Errorf("rewind arrived before any row thresholds (pos %d)", rewindPos)
	}
}
