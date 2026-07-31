package tilemap

import "strconv"

// BankReader is the minimum the tilemap needs from the memory bus:
// fetch one 16 KB RAM bank by index. pkg/memory.Memory's GetPage
// satisfies this — same contract as pkg/next/layer2.
type BankReader interface {
	GetPage(bank int) []byte
}

// Width / Height fix the visible-area pixel dimensions in the
// only mode this v1 supports (40x32 character cells, 8x8 pixels
// per tile = 320 wide). The compositor clips to ULA's 256 for now;
// the extra 64 pixels on each side are out of view.
const (
	TilesPerRow40 = 40
	TilesPerCol   = 32
	TileWidth     = 8
	TileHeight    = 8
	Width40       = TilesPerRow40 * TileWidth // 320
	Height        = TilesPerCol * TileHeight  // 256
)

// Tilemap is the Sprint-N Spectrum Next tilemap layer. Backed by
// one or two 16 KB Spectrum RAM banks (bank 5 by default; bank 7
// when NR$6E/$6F bit 7 is set). Per FPGA verilog
// (cores/zxnext/src/video/tilemap.vhd) the addressing is:
//
//	tile_map_base  ($6E)  — 7 bits: bit 7 = bank select, bits 5:0
//	                       = 256-byte offset within bank
//	tile_defs_base ($6F)  — same encoding as $6E
//	control         ($6B)  — bit 7 enable, bit 6 mode (0=40x32,
//	                        1=80x32), bit 5 strip_flags, bit 3
//	                        textmode, bit 1 mode_512, bit 0 on_top
//	default_attr    ($6C) — used when strip_flags=1
//
// Sprint N covers the path NextZXOS Browser exercises during boot:
// 40x32 mode with strip_flags=1 (no per-tile attribute), 4bpp tile
// definitions, no scroll, no clipping, no mirror/rotate. Extras
// are TODO; the structure leaves room.
type Tilemap struct {
	mem BankReader

	enabled     bool
	control     byte // mirror of NR$6B
	defaultAttr byte // NR$6C
	mapBase     byte // NR$6E
	tilesBase   byte // NR$6F
	scrollX     int  // NR$2F:$30 (10-bit pixel scroll X)
	scrollY     int  // NR$31 (8-bit pixel scroll Y)

	// Raster-stamped mid-frame scroll (see logScroll/FoldScrollStamps):
	// the per-line fold lets the render apply scroll writes from their
	// raster row, the way the FPGA's combinational registers do.
	rasterLine     func() int
	scrollStamps   []scrollStamp
	scrollOverflow bool
	scrollConsumed bool
	foldActive     bool
	scrollXLine    [frameRasterLines]int
	scrollYLine    [frameRasterLines]int
	// captureActive marks the render bracket (FoldScrollStamps →
	// EndScrollCapture): scroll writes inside it are the COPPER's
	// render-time MOVEs — not stamped as CPU writes, but captured
	// per row into the table by CaptureRowScroll once dirty.
	captureActive bool
	captureDirty  bool
	// Map-content snapshot at the frame's FIRST CPU scroll stamp (#196):
	// a game that pans by pairing a scroll-register write with a map
	// REWRITE in the same mid-frame update (Atic Atac: NR$31 at raster
	// ~276, then the whole 2560-byte map) must not have rows above the
	// update rendered from the folded OLD register but the NEW map — on
	// tile-boundary wrap frames that mismatch displaces those rows by a
	// full tile row (the door/trapdoor jitter). The FPGA reads the map
	// per beam row, so rows before the update show the OLD map with the
	// OLD register. logScroll snapshots the whole map bank page at the
	// first stamp (content still pre-rewrite there — the register write
	// leads the map rewrite); the fold arms per-row source selection:
	// rows before the stamp row read the snapshot, rows at/after it the
	// live page. Games that never write tilemap scroll mid-frame take
	// none of this (no snapshot, no cost); a game that rewrites the map
	// WITHOUT a scroll write keeps today's end-of-frame content (no
	// coherence signal to split on — documented residue).
	// carryX/Y: the previous fresh fold's post-stamp final scroll — the
	// raster frame-top baseline for the next fold (see FoldScrollStamps).
	carryX     int
	carryY     int
	carryValid bool
	// baseX/Y: the baseline the current fold actually used — a stale
	// replay (same frame re-rendered) must reuse it, not the carry.
	baseX     int
	baseY     int
	baseValid bool
	// foldDisabled: diagnostic bypass (SetFoldDisabled, #205).
	foldDisabled bool
	mapSnap       []byte
	mapSnapBank   int
	mapSnapValid  bool
	mapSnapRow    int // first render row that reads LIVE content
	mapSnapActive bool
	clipX1        byte // NR$1B clip window: visible X is [clipX1*2, clipX2*2+1]
	clipX2        byte
	clipY1        byte // visible Y is [clipY1, clipY2]
	clipY2        byte

	// gen counts render-input mutations (registers, scroll, clip, the
	// per-line scroll tables) — every mutator bumps it. Consumers (the
	// compositor's per-render row cache, #187 performance) use it to
	// prove a row rendered earlier in the same render pass is still
	// exact: RenderScanlineWithBelow is a pure function of (y, tilemap
	// state, RAM), and RAM cannot change inside a render bracket.
	gen uint32
}

// Gen returns the render-input mutation counter (see the gen field).
func (t *Tilemap) Gen() uint32 { return t.gen }

// New constructs a tilemap reader. Disabled by default; clip window
// defaults to the full area ({0, 0x9F, 0, 0xFF} per the FPGA reset). The
// dispatcher writes NR$6B bit 7 to flip enabled on / off.
func New(mem BankReader) *Tilemap {
	return &Tilemap{mem: mem, clipX2: 0x9F, clipY2: 0xFF}
}

// SetEnabled toggles tilemap rendering (NR$6B bit 7).
func (t *Tilemap) SetEnabled(on bool) { t.enabled = on; t.gen++ }

// Enabled reports current state.
func (t *Tilemap) Enabled() bool { return t.enabled }

// SetControl writes NR$6B low 7 bits (the enable bit is handled
// separately by SetEnabled, but in practice the wire layer
// decomposes the byte and calls both).
func (t *Tilemap) SetControl(v byte) { t.control = v & 0x7F; t.gen++ }

// SetMode40 is a convenience for tests: clears the 80-col bit.
func (t *Tilemap) SetMode40() { t.control &^= 1 << 6; t.gen++ }

// SetMode80 is the dual.
func (t *Tilemap) SetMode80() { t.control |= 1 << 6; t.gen++ }

// SetStripFlags toggles NR$6B bit 5 — when set, the per-tile flag
// byte is omitted from the map and defaultAttr is used.
func (t *Tilemap) SetStripFlags(on bool) {
	if on {
		t.control |= 1 << 5
	} else {
		t.control &^= 1 << 5
	}
	t.gen++
}

// SetDefaultAttr writes NR$6C (used when StripFlags is set).
func (t *Tilemap) SetDefaultAttr(v byte) { t.defaultAttr = v; t.gen++ }

// SetTileMapBase writes NR$6E.
func (t *Tilemap) SetTileMapBase(v byte) { t.mapBase = v; t.gen++ }

// SetTilesBase writes NR$6F.
func (t *Tilemap) SetTilesBase(v byte) { t.tilesBase = v; t.gen++ }

// OnTop reports whether NR$6B bit 0 (tm_on_top) is set. When on,
// the FPGA renders the tilemap as ALWAYS opaque over every layer
// below — even nibble-0 pixels produce palette[0] rather than
// letting ULA / Layer 2 show through. The compositor uses this to
// switch its transparency check off so palette[0] is honoured (the
// testcard sets palette[0] = black + uses tile $01 = all-nibble-0
// as the "background" tile; without OnTop honoured, the inner
// screen ate the ULA garbage that sits in bank 5 alongside the
// tile data and showed solid black via the colour-zero attribute
// byte, instead of the testcard's intended palette colour).
func (t *Tilemap) OnTop() bool { return t.control&0x01 != 0 }

// Textmode reports NR$6B bit 3 — 1bpp text-mode tiles. The blend path
// feeds it to the mixer (tm_transparent includes an RGB-vs-NR$14 test
// only in textmode, zxnext.vhd:7107).
func (t *Tilemap) Textmode() bool { return t.control&(1<<3) != 0 }

// Is80Col reports whether NR$6B bit 6 (80-column mode) is set. In that
// mode the tilemap is 80 tiles × 8px = 640 pixels wide, so the caller
// must render it through a 640-pixel buffer (the 320-pixel display path
// would only cover the left 40 columns).
func (t *Tilemap) Is80Col() bool { return t.control&(1<<6) != 0 }

// SetScrollX / SetScrollY set the tilemap pixel scroll offsets (NR$2F:$30
// = X, 10-bit; NR$31 = Y, 8-bit per FPGA nr_30_tm_scrollx/nr_31). The
// tilemap wraps as a torus. When a raster-line source is wired
// (SetRasterLineSource) each write is stamped with the beam line so
// FoldScrollStamps can apply mid-frame changes from their raster row.
func (t *Tilemap) SetScrollX(v int) { t.logScroll(false, t.scrollX, v); t.scrollX = v; t.gen++ }
func (t *Tilemap) SetScrollY(v int) { t.logScroll(true, t.scrollY, v); t.scrollY = v; t.gen++ }

// scrollStamp is one raster-stamped mid-frame scroll write.
type scrollStamp struct {
	line   int // raw raster line (paper top = 64, BeamPosition convention)
	isY    bool
	oldVal int
	newVal int
}

// frameRasterLines bounds the per-line scroll fold: the largest frame
// any NR$03/$05 timing produces (Pentagon's 320; 311 on the boot
// 128K/+3 timing, 312 on 48K, 264 at 60 Hz — zxula_timing.vhd
// c_max_vc+1).
const frameRasterLines = 320

// maxScrollStamps caps the per-frame log; overflow degrades that frame
// to today's end-of-frame scroll resolution instead of growing without
// limit.
const maxScrollStamps = 512

// SetRasterLineSource wires the raster-line clock (the ULA's
// BeamPosition line) that stamps each scroll write. Nil disables
// stamping — SetScrollX/Y then behave exactly as before.
func (t *Tilemap) SetRasterLineSource(fn func() int) { t.rasterLine = fn }

// logScroll records a scroll write with the current raster stamp. The
// FPGA's scroll registers feed the pixel pipeline combinationally
// (tm_scroll_x_i/tm_scroll_y_i into tm_abs_y_s, tilemap.vhd:326), so a
// mid-frame write re-anchors the tilemap from the next scanline — RAMS
// emulates the Galaxian cabinet's per-band scroll this way (scroll =
// player X across the ship's scanline band, restored elsewhere).
func (t *Tilemap) logScroll(isY bool, old, new int) {
	if t.rasterLine == nil || old == new {
		return
	}
	// Render-time (copper MOVE) write: no CPU stamp — the walk captures
	// the live value per row from here on (CaptureRowScroll).
	if t.captureActive {
		t.captureDirty = true
		return
	}
	// First write after a fold consumed the log: start a fresh frame.
	if t.scrollConsumed {
		t.scrollStamps = t.scrollStamps[:0]
		t.scrollConsumed = false
		t.scrollOverflow = false
	}
	if len(t.scrollStamps) >= maxScrollStamps {
		t.scrollOverflow = true
		return
	}
	// The frame's first stamp: snapshot the map bank's content as of
	// this instant (see the mapSnap field docs — the pre-rewrite map
	// for the rows above this raster line).
	if len(t.scrollStamps) == 0 {
		t.snapshotMapBank()
	}
	t.scrollStamps = append(t.scrollStamps, scrollStamp{
		line: t.rasterLine(), isY: isY, oldVal: old, newVal: new,
	})
}

// snapshotMapBank copies the tilemap map bank's 16K page (see the
// mapSnap field docs). Runs at most once per execution frame, and only
// for frames with mid-frame CPU scroll writes.
func (t *Tilemap) snapshotMapBank() {
	t.mapSnapValid = false
	if t.mem == nil {
		return
	}
	bank := 5
	if t.mapBase&0x80 != 0 {
		bank = 7
	}
	pg := t.mem.GetPage(bank)
	if len(pg) < 0x4000 {
		return
	}
	if cap(t.mapSnap) < 0x4000 {
		t.mapSnap = make([]byte, 0x4000)
	}
	t.mapSnap = t.mapSnap[:0x4000]
	copy(t.mapSnap, pg[:0x4000])
	t.mapSnapBank = bank
	t.mapSnapValid = true
}

// SetFoldDisabled is a diagnostic switch (#205): when set, folds
// behave as if no CPU stamps existed — live registers everywhere, no
// map snapshot — isolating the fold machinery in A/B renders.
func (t *Tilemap) SetFoldDisabled(b bool) { t.foldDisabled = b; t.gen++ }

// FoldScrollStamps builds the per-raster-line scroll table from the
// frame's stamped writes, activating per-row scroll for the render
// passes. With no stamps (the common case) the fold deactivates and
// RenderScanline uses the live registers — zero cost, identical to the
// pre-stamp behaviour. A STALE fold (no execution since the last
// render — the harness screenshot path) replays the consumed log
// identically; a fresh fold with an already-consumed log means the
// frame wrote no scroll — the log is dropped.
func (t *Tilemap) FoldScrollStamps(stale bool) {
	t.gen++
	t.foldActive = false
	if t.rasterLine == nil {
		return
	}
	// Open the render bracket: scroll writes from here to
	// EndScrollCapture are the copper's render-time MOVEs.
	t.captureActive = true
	t.captureDirty = false
	if !stale && t.scrollConsumed {
		t.scrollStamps = t.scrollStamps[:0]
		t.scrollConsumed = false
		t.scrollOverflow = false
	}
	if t.foldDisabled || t.scrollOverflow || len(t.scrollStamps) == 0 {
		t.scrollStamps = t.scrollStamps[:0]
		t.scrollOverflow = false
		t.mapSnapActive = false
		// No CPU stamps this frame: the live registers are the frame
		// value and the carry would go stale — drop it so the next
		// stamped frame falls back to the oldVal derivation.
		if !stale {
			t.carryValid = false
		}
		// No CPU stamps: prefill the table with the live scroll so
		// per-row copper captures overlay a correct baseline (rows
		// before the copper's first write keep the frame value).
		for line := 0; line < frameRasterLines; line++ {
			t.scrollXLine[line], t.scrollYLine[line] = t.scrollX, t.scrollY
		}
		return
	}
	// Arm the per-row map source split (see mapSnap): rows before the
	// first stamp's row read the snapshot taken at that instant. A
	// mid-frame NR$6E bank move invalidates it (different page).
	t.mapSnapActive = false
	if t.mapSnapValid {
		bank := 5
		if t.mapBase&0x80 != 0 {
			bank = 7
		}
		if bank == t.mapSnapBank {
			t.mapSnapRow = t.scrollStamps[0].line - 32
			t.mapSnapActive = t.mapSnapRow > 0
		}
	}
	// Frame-start values. For a CPU-only writer the first stamp per axis
	// carries the frame-start state in its replaced value. But when the
	// COPPER also writes the register at render time (TX-1696's per-band
	// engine), the CPU stamp's oldVal is the copper's LAST band value —
	// not the raster frame-top state, which on the FPGA is the previous
	// frame's final CPU write surviving across the VBL. So the fold
	// carries its own post-stamp final value into the next frame's
	// baseline (identical to the oldVal derivation when nothing else
	// writes the register, since prev-frame-final == this-frame-old):
	// without the carry, TX-1696's score-strip rows (above its ~line 257
	// CPU scroll write) rendered at the last band's scroll — a blank
	// map region — instead of the strip (#205).
	x, y := t.scrollX, t.scrollY
	seenX, seenY := false, false
	for _, s := range t.scrollStamps {
		if s.isY && !seenY {
			y, seenY = s.oldVal, true
		}
		if !s.isY && !seenX {
			x, seenX = s.oldVal, true
		}
	}
	if stale && t.baseValid {
		// A stale replay re-renders the SAME frame: reuse the baseline
		// the fresh fold used (the carry has already advanced past it).
		x, y = t.baseX, t.baseY
	} else if t.carryValid {
		x, y = t.carryX, t.carryY
	}
	t.baseX, t.baseY, t.baseValid = x, y, true
	idx := 0
	for line := 0; line < frameRasterLines; line++ {
		for idx < len(t.scrollStamps) && t.scrollStamps[idx].line <= line {
			if t.scrollStamps[idx].isY {
				y = t.scrollStamps[idx].newVal
			} else {
				x = t.scrollStamps[idx].newVal
			}
			idx++
		}
		t.scrollXLine[line], t.scrollYLine[line] = x, y
	}
	// Bank the post-stamp final value as the NEXT frame's raster
	// frame-top baseline (see the frame-start comment above). Only a
	// fresh (non-stale) fold advances it — a stale replay re-renders
	// the same frame.
	if !stale {
		t.carryX, t.carryY = x, y
		t.carryValid = true
	}
	t.scrollConsumed = true
	t.foldActive = true
}

// CaptureRowScroll snapshots the LIVE scroll into the per-line table
// for one raster line, once a render-time (copper) scroll write made
// the live registers diverge from the fold. Called by the ULA's walk
// after the copper ran for each row, in raster order — rows before the
// copper's first write keep their folded/prefilled values, rows at and
// after it track the copper's per-line values, and the post-walk
// wide-L2 overpaint re-renders every row with the same table.
func (t *Tilemap) CaptureRowScroll(rasterLine int) {
	if !t.captureActive || !t.captureDirty {
		return
	}
	if rasterLine < 0 || rasterLine >= frameRasterLines {
		return
	}
	t.scrollXLine[rasterLine], t.scrollYLine[rasterLine] = t.scrollX, t.scrollY
	t.foldActive = true
	t.gen++
}

// EndScrollCapture closes the render bracket: scroll writes are CPU
// (execution-time) writes again and get raster-stamped.
func (t *Tilemap) EndScrollCapture() { t.captureActive = false }

// scrollForRow returns the scroll pair for visible frame row y
// (0..255): the folded per-raster-line value when mid-frame writes
// were stamped this frame, else the live registers. Frame row 0 is
// raster line 32 (paper top = frame row 32 = raster 64 — the same
// convention as the palette replay and borderChanges folds).
func (t *Tilemap) scrollForRow(y int) (int, int) {
	if !t.foldActive {
		return t.scrollX, t.scrollY
	}
	r := y + 32
	if r < 0 || r >= frameRasterLines {
		return t.scrollX, t.scrollY
	}
	return t.scrollXLine[r], t.scrollYLine[r]
}

// SetClip sets the tilemap clip window (NR$1B). Visible pixels are X in
// [x1*2, x2*2+1] (in 40-col 2-pixel units; the bounds double in 80-col so
// the default still covers the full 640) and Y in [y1, y2]. Per FPGA
// tilemap.vhd:416-419. The power-on default {0, 0x9F, 0, 0xFF} is the
// full tilemap.
func (t *Tilemap) SetClip(x1, x2, y1, y2 byte) {
	t.clipX1, t.clipX2, t.clipY1, t.clipY2 = x1, x2, y1, y2
	t.gen++
}

// RenderScanline writes len(dst) palette-indexed bytes for visible
// row y. Caller controls dst length; we read at most that many
// pixels and stop. Out-of-mode / disabled returns all zeros so the
// compositor's transparency-or-replace path works correctly.
func (t *Tilemap) RenderScanline(y int, dst []byte) {
	t.RenderScanlineWithBelow(y, dst, nil)
}

// RenderScanlineWithBelow renders like RenderScanline and, when below
// is non-nil (same length as dst), fills each pixel's LIVE tm_below
// bit — the FPGA's per-pixel line-buffer bit 8 (tilemap.vhd:388):
//
//	below = (attr_bit0 OR mode_512) AND NOT tm_on_top
//
// i.e. per-TILE (attribute bit 0 = "ULA over tilemap"), with 512-tile
// mode forcing below (the attr bit is the tile-index MSB there) and
// NR$6B bit 0 (tm_on_top) forcing on-top globally. The consumer
// (zxnext.vhd:7116) yields a below pixel to an OPAQUE ULA pixel only.
func (t *Tilemap) RenderScanlineWithBelow(y int, dst, below []byte) {
	for i := range dst {
		dst[i] = 0
	}
	for i := range below {
		below[i] = 0
	}
	if !t.enabled || t.mem == nil {
		return
	}
	if y < 0 || y >= Height {
		return
	}
	// Clip window (NR$1B): rows outside [clipY1, clipY2] are transparent.
	if y < int(t.clipY1) || y > int(t.clipY2) {
		return
	}

	// Bank select: bit 7 of NR$6E/$6F selects bank 7 (vs bank 5).
	//
	// The FPGA stores NR$6E as two pieces (zxnext.vhd 5468-5469):
	//
	//	nr_6e_tilemap_base_7 <= nr_wr_dat(7);
	//	nr_6e_tilemap_base   <= nr_wr_dat(5 downto 0);
	//
	// then concatenates them as `bank7 & offset6` to form the 7-bit
	// tm_map_base_i. Inside tilemap.vhd "bit 6 of tm_map_base" maps
	// back to the original CPU-write bit 7 — bit 6 of the CPU byte
	// is discarded entirely. NextZXOS Browser writes $40 expecting
	// bit 7=0 → bank 5 (the classic 7FFD screen page) with offset
	// bits 5:0 = 0 → base $0000 in bank 5.
	mapBank := 5
	if t.mapBase&0x80 != 0 {
		mapBank = 7
	}
	tilesBank := 5
	if t.tilesBase&0x80 != 0 {
		tilesBank = 7
	}
	mapBuf := t.mem.GetPage(mapBank)
	tilesBuf := t.mem.GetPage(tilesBank)
	if len(mapBuf) < 0x4000 || len(tilesBuf) < 0x4000 {
		return
	}
	// Rows above the frame's first mid-frame scroll stamp read the map
	// content captured AT that stamp — the pre-rewrite map the FPGA's
	// beam saw for those rows (see the mapSnap field docs, #196). Tile
	// DEFINITIONS in the same bank take the snapshot too (content
	// coherence); a tiles bank distinct from the map bank stays live.
	if t.mapSnapActive && y < t.mapSnapRow && mapBank == t.mapSnapBank {
		mapBuf = t.mapSnap
		if tilesBank == mapBank {
			tilesBuf = t.mapSnap
		}
	}

	mapOffsetBase := int(t.mapBase&0x3F) << 8
	tilesOffsetBase := int(t.tilesBase&0x3F) << 8

	// 40-col mode: 1 byte per tile (strip_flags=1) or 2 bytes
	// (strip_flags=0, tile + flag pair). Sprint N supports both —
	// the flag is currently ignored beyond reading it.
	tilesPerRow := TilesPerRow40
	if t.control&(1<<6) != 0 {
		tilesPerRow = 80
	}
	// Clip window X bounds (NR$1B): 2-pixel units in 40-col, doubled in
	// 80-col so the default {0, 0x9F} still spans the full width.
	xscale := 1
	if tilesPerRow == 80 {
		xscale = 2
	}
	clipXStart := int(t.clipX1) * 2 * xscale
	clipXEnd := (int(t.clipX2)*2+1)*xscale + (xscale - 1)
	stripFlags := t.control&(1<<5) != 0
	bytesPerTile := 2
	if stripFlags {
		bytesPerTile = 1
	}

	// Pixel scroll (NR$2F:$30 / $31): offset the source coords and wrap
	// the tilemap as a torus.
	rowScrollX, rowScrollY := t.scrollForRow(y)
	absY := y + rowScrollY
	tileY := (absY / TileHeight) % TilesPerCol
	pixelRow := absY % TileHeight

	// Textmode (NR$6B bit 3): tile definitions are 1bpp (8 bytes/tile)
	// rather than 4bpp (32 bytes/tile). NextZXOS dot-command viewers
	// (e.g. NextGuide) use it for text.
	textmode := t.control&(1<<3) != 0
	// 512-tile mode (NR$6B bit 1): the per-tile attribute byte's bit 0 is
	// the tile index's 9th bit, extending the map from 256 to 512 tiles.
	// Sonic's options/text screen relies on this (its font lives in tiles
	// 256+, addressed via attr bit 0); ignoring it renders tile 0 everywhere.
	mode512 := t.control&(1<<1) != 0

	// Per-TILE-run walk (#187 performance): every pixel of a run shares
	// its tile's map entry, attribute and (in textmode) definition byte,
	// so those are fetched once per run instead of once per pixel. A run
	// is the span of consecutive x values mapping into one tile — up to
	// 8 pixels, shorter at the clip/scroll boundaries. Pixel-level
	// results are computed exactly as the per-pixel walk did.
	x0 := clipXStart
	if x0 < 0 {
		x0 = 0
	}
	x1 := clipXEnd
	if x1 > len(dst)-1 {
		x1 = len(dst) - 1
	}
	onTop := t.control&0x01 != 0
	for x := x0; x <= x1; {
		absX := x + rowScrollX
		tileX := (absX / TileWidth) % tilesPerRow
		pixelInTile := absX % TileWidth
		run := TileWidth - pixelInTile
		if x+run-1 > x1 {
			run = x1 - x + 1
		}
		mapEntry := mapOffsetBase + (tileY*tilesPerRow+tileX)*bytesPerTile
		mapEntry &= 0x3FFF
		// Per-tile attribute, or the global default_attr when
		// strip_flags eliminates the attribute byte.
		attr := t.defaultAttr
		if !stripFlags {
			attr = mapBuf[(mapEntry+1)&0x3FFF]
		}
		tileIdx := int(mapBuf[mapEntry])
		if mode512 {
			tileIdx |= int(attr&0x01) << 8
		}
		// Per-pixel tm_below (tilemap.vhd:388): attr bit 0 ("ULA over
		// tilemap") OR 512-mode, unless tm_on_top forces on-top. The
		// same formula applies in textmode (:388 is unconditional).
		if below != nil && (attr&0x01 != 0 || mode512) && !onTop {
			for i := x; i < x+run && i < len(below); i++ {
				below[i] = 1
			}
		}

		if textmode {
			// 1bpp tile: 8 bytes/tile, one byte per row, MSB-first.
			// The FPGA (tilemap.vhd) forms the pixel's palette index
			// as attr(7:1) & tile_bit — "extend palette offset to 7
			// bits" — i.e. (attr & 0xFE) | bit. Index 0 stays the
			// transparent slot so the compositor falls through to ULA.
			defAddr := (tilesOffsetBase + int(tileIdx)*8 + pixelRow) & 0x3FFF
			db := tilesBuf[defAddr]
			base := attr & 0xFE
			for i := 0; i < run; i++ {
				bit := (db >> (7 - uint(pixelInTile+i))) & 1
				dst[x+i] = base | bit
			}
			x += run
			continue
		}

		// Per-tile transform (FPGA tilemap.vhd:320-324): attr bit 3 = X
		// mirror, bit 2 = Y mirror, bit 1 = rotate (swaps X/Y, and a
		// rotation also inverts the X mirror). textmode (above) skips it.
		xMirror := (attr>>3)&1 != (attr>>1)&1 // effective X mirror
		ty := pixelRow
		if attr&0x04 != 0 { // Y mirror
			ty = (TileHeight - 1) - ty
		}
		rotate := attr&0x02 != 0
		// Standard 4bpp tile defs: 32 bytes per tile (8 rows × 4
		// bytes); attr bits 7:4 are the palette offset, the pixel is a
		// nibble. ty selects the 4-byte row, tx the pixel within it.
		paletteOffset := (attr >> 4) & 0x0F
		tileBase := tilesOffsetBase + int(tileIdx)*32
		for i := 0; i < run; i++ {
			tx, tty := pixelInTile+i, ty
			if xMirror {
				tx = (TileWidth - 1) - tx
			}
			if rotate { // rotate: exchange X and Y
				tx, tty = tty, tx
			}
			b := tilesBuf[((tileBase+tty*4)&0x3FFF)+tx/2]
			var nibble byte
			if tx&1 == 0 {
				nibble = (b >> 4) & 0x0F
			} else {
				nibble = b & 0x0F
			}
			if nibble == 0 {
				// Index 0 is the standard transparent slot — pass through.
				dst[x+i] = 0
			} else {
				dst[x+i] = (paletteOffset << 4) | nibble
			}
		}
		x += run
	}
}

// DebugFoldState reports the raster-stamp fold / capture machinery's
// live state plus a sample of the folded per-line scroll table —
// the diagnostic surface for the #205 browser-garble investigation.
func (t *Tilemap) DebugFoldState() map[string]int {
	b2i := func(b bool) int {
		if b {
			return 1
		}
		return 0
	}
	m := map[string]int{
		"foldActive":    b2i(t.foldActive),
		"mapSnapActive": b2i(t.mapSnapActive),
		"mapSnapRow":    t.mapSnapRow,
		"captureActive": b2i(t.captureActive),
		"captureDirty":  b2i(t.captureDirty),
		"stamps":        len(t.scrollStamps),
		"consumed":      b2i(t.scrollConsumed),
		"overflow":      b2i(t.scrollOverflow),
		"scrollX":       t.scrollX,
		"scrollY":       t.scrollY,
	}
	for _, line := range []int{40, 80, 120, 160, 200, 240} {
		m["y"+strconv.Itoa(line)] = t.scrollYLine[line]
		m["x"+strconv.Itoa(line)] = t.scrollXLine[line]
	}
	// Snapshot-vs-live map occupancy over the 2560-byte 40x32 map.
	base := int(t.mapBase&0x3F) << 8
	nz := func(b []byte) int {
		c := 0
		for i := base; i < base+2560 && i < len(b); i++ {
			if b[i] != 0 {
				c++
			}
		}
		return c
	}
	if t.mapSnapValid {
		m["snapNZ"] = nz(t.mapSnap)
	}
	if t.mem != nil {
		bank := 5
		if t.mapBase&0x80 != 0 {
			bank = 7
		}
		m["liveNZ"] = nz(t.mem.GetPage(bank))
	}
	return m
}

// DebugClip reports the live clip window (#205 diagnostics).
func (t *Tilemap) DebugClip() (x1, x2, y1, y2 byte) {
	return t.clipX1, t.clipX2, t.clipY1, t.clipY2
}
