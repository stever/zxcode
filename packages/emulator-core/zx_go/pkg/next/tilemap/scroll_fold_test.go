package tilemap

import "testing"

// scrollFoldMap builds a tilemap whose tile row content encodes the
// source COLUMN, so a rendered pixel's value reveals which scroll-X was
// in force for its row: map all tile 0-15 cycling per column, tiles n =
// all-nibble n... simpler: map row 0..31 all tile 1; tile 1's pixels
// encode nothing horizontally. Instead: map entries cycle 1,2 per
// column pair and tiles 1/2 are solid nibble 1/2 — an 8px scroll
// shifts which tile covers a given x.
func scrollFoldTilemap() (*Tilemap, *fakeBank) {
	data := make([]byte, 16384)
	// Map at offset 0 (strip_flags, 1 byte/entry): row-major 40 cols ×
	// 32 rows, entry = 1 + (col % 2) — vertical stripes of tiles 1/2,
	// 8px wide.
	for row := 0; row < 32; row++ {
		for col := 0; col < 40; col++ {
			data[row*40+col] = byte(1 + col%2)
		}
	}
	// Tiles at offset 0x800: tile 1 all nibble 1, tile 2 all nibble 2.
	for i := 0; i < 32; i++ {
		data[0x800+32+i] = 0x11
		data[0x800+64+i] = 0x22
	}
	f := &fakeBank{data: data}
	tm := New(f)
	tm.SetEnabled(true)
	tm.SetControl(0xA0 & 0x7F) // strip_flags
	tm.SetTileMapBase(0x00)
	tm.SetTilesBase(0x08)
	return tm, f
}

// TestScrollFoldAppliesMidFrameWrites pins the raster-stamped scroll
// fold (#171 follow-up — RAMS band-scrolls the Galaxian player ship
// with mid-frame NR$30 writes): a scroll-X write stamped at raster
// line 150 must shift only the rows scanning at/after line 150 (frame
// row 118), leaving earlier rows at the frame-start scroll — and the
// live registers must win again once a frame passes with no stamps.
func TestScrollFoldAppliesMidFrameWrites(t *testing.T) {
	tm, _ := scrollFoldTilemap()

	pixAt := func(y, x int) byte {
		var dst [Width40]byte
		tm.RenderScanline(y, dst[:])
		return dst[x]
	}

	// No fold: frame row 50, x=0 shows tile 1 (nibble 1).
	if got := pixAt(50, 0); got != 0x01 {
		t.Fatalf("unscrolled pixel = %02X, want 01", got)
	}

	// Simulate a frame: scroll 0 at frame start, write scroll X=8 at
	// raster line 150 (frame row 118), then fold as the render does.
	line := 0
	tm.SetRasterLineSource(func() int { return line })
	line = 150
	tm.SetScrollX(8) // stamped @150
	tm.FoldScrollStamps(false)

	// Frame row 50 (raster 82, before the write): frame-start scroll 0.
	if got := pixAt(50, 0); got != 0x01 {
		t.Errorf("row before the stamp = %02X, want 01 (frame-start scroll)", got)
	}
	// Frame row 200 (raster 232, after the write): scroll 8 → tile 2.
	if got := pixAt(200, 0); got != 0x02 {
		t.Errorf("row after the stamp = %02X, want 02 (scrolled by 8)", got)
	}
	// Boundary: frame row 118 = raster 150 → the write's own line
	// already renders scrolled (applied at <= line).
	if got := pixAt(118, 0); got != 0x02 {
		t.Errorf("row at the stamp line = %02X, want 02", got)
	}

	// A stale re-fold (screenshot path, no execution) replays the same
	// split.
	tm.FoldScrollStamps(true)
	if got := pixAt(50, 0); got != 0x01 {
		t.Errorf("stale re-fold lost the split: row 50 = %02X, want 01", got)
	}

	// Next frame with no scroll writes: the fold deactivates and the
	// live register (scroll X=8, uniform) rules every row.
	tm.FoldScrollStamps(false)
	if got := pixAt(50, 0); got != 0x02 {
		t.Errorf("post-stamp frame row 50 = %02X, want 02 (live scroll 8)", got)
	}
}

// TestScrollFoldInactiveWithoutStamps: no raster source or no writes →
// live registers, exactly the pre-fold behaviour.
func TestScrollFoldInactiveWithoutStamps(t *testing.T) {
	tm, _ := scrollFoldTilemap()
	tm.SetScrollX(8) // no raster source: not stamped
	tm.FoldScrollStamps(false)
	var dst [Width40]byte
	tm.RenderScanline(50, dst[:])
	if dst[0] != 0x02 {
		t.Errorf("live-scroll pixel = %02X, want 02", dst[0])
	}
}

// TestScrollCaptureAppliesCopperRowWrites pins the render-bracket
// capture: scroll writes between FoldScrollStamps and EndScrollCapture
// are the copper's render-time MOVEs — not CPU-stamped, but captured
// per row as the ULA walk announces each raster line, so a band-scoped
// copper scroll (RAMS's Galaxian player ship) renders banded in every
// tilemap pass including the post-walk wide-L2 overpaint.
func TestScrollCaptureAppliesCopperRowWrites(t *testing.T) {
	tm, _ := scrollFoldTilemap()
	line := 0
	tm.SetRasterLineSource(func() int { return line })

	pixAt := func(y, x int) byte {
		var dst [Width40]byte
		tm.RenderScanline(y, dst[:])
		return dst[x]
	}

	// Render bracket opens with scroll 0 everywhere (no CPU stamps).
	tm.FoldScrollStamps(false)

	// Walk rows 0..255 like the ULA does, with "copper MOVEs": scroll 8
	// on entering row 100, back to 0 on entering row 120.
	for y := 0; y < 256; y++ {
		switch y {
		case 100:
			tm.SetScrollX(8) // copper MOVE — inside the bracket
		case 120:
			tm.SetScrollX(0)
		}
		tm.CaptureRowScroll(y + 32)
	}

	// The overpaint pass re-reads rows AFTER the walk: the band must
	// hold — rows <100 unscrolled, 100..119 scrolled, >=120 unscrolled.
	if got := pixAt(50, 0); got != 0x01 {
		t.Errorf("row 50 (before band) = %02X, want 01", got)
	}
	if got := pixAt(110, 0); got != 0x02 {
		t.Errorf("row 110 (inside band) = %02X, want 02 (copper scroll 8)", got)
	}
	if got := pixAt(200, 0); got != 0x01 {
		t.Errorf("row 200 (after band) = %02X, want 01", got)
	}

	// Bracket closed: writes stamp as CPU again.
	tm.EndScrollCapture()
	line = 150
	tm.SetScrollX(8)
	tm.FoldScrollStamps(false)
	if got := pixAt(50, 0); got != 0x01 {
		t.Errorf("post-bracket CPU stamp: row 50 = %02X, want 01", got)
	}
	if got := pixAt(200, 0); got != 0x02 {
		t.Errorf("post-bracket CPU stamp: row 200 = %02X, want 02", got)
	}
}

// TestScrollFoldMapContentSnapshot pins the map-content snapshot taken
// at the frame's first mid-frame CPU scroll stamp (#196, Atic Atac's
// door/trapdoor jitter): a game that pairs a scroll write with a MAP
// REWRITE in the same mid-frame update shows rows above the update
// with the OLD map + OLD scroll on the FPGA (the beam read them before
// the update). Rows above the stamp row must render from the snapshot;
// rows at/after it from the live (rewritten) map. A frame with no
// stamps drops back to live content everywhere.
func TestScrollFoldMapContentSnapshot(t *testing.T) {
	tm, f := scrollFoldTilemap()

	pixAt := func(y, x int) byte {
		var dst [Width40]byte
		tm.RenderScanline(y, dst[:])
		return dst[x]
	}

	line := 0
	tm.SetRasterLineSource(func() int { return line })

	// Mid-frame update at raster line 276 (render row 244, the Atic
	// shape): scroll-Y write, then the map is rewritten — every column
	// becomes tile 2.
	line = 276
	tm.SetScrollY(1) // stamps + snapshots the pre-rewrite map
	for row := 0; row < 32; row++ {
		for col := 0; col < 40; col++ {
			f.data[row*40+col] = 2
		}
	}
	tm.FoldScrollStamps(false)
	defer tm.EndScrollCapture()

	// Row 50 (above the update): pre-rewrite map — column 0 is tile 1.
	// scroll-Y 0 is in force there, so the row content is the old map's.
	if got := pixAt(50, 0); got != 0x01 {
		t.Errorf("row above the update: pixel = %02X, want 01 (snapshot map)", got)
	}
	// Row 250 (at/after the update): live rewritten map — tile 2.
	if got := pixAt(250, 0); got != 0x02 {
		t.Errorf("row after the update: pixel = %02X, want 02 (live map)", got)
	}

	// Next frame writes no scroll: the fold drops the log and the live
	// map shows everywhere again.
	tm.EndScrollCapture()
	tm.FoldScrollStamps(false)
	if got := pixAt(50, 0); got != 0x02 {
		t.Errorf("stamp-free frame: pixel = %02X, want 02 (live map everywhere)", got)
	}
}
