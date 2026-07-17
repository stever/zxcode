// Package palette implements the Spectrum Next's 9-bit-per-entry,
// 256-entry colour palette.
//
// The Next exposes two 256-entry palettes (default and shadow) for
// each of ULA, Layer 2, Sprites and Tilemap, plus the NextReg 0x40 /
// 0x41 / 0x44 access path and the per-layer palette selection (0x43).
//
// 9-bit format on the wire:
//   - NextReg 0x41 — write the high 8 bits (RRRGGGBB) of the 9-bit
//     value. The low blue bit defaults to 0 when this path is used.
//   - NextReg 0x44 — write two bytes: first byte is the same 8-bit
//     value, second byte's bit 0 is the missing low blue bit
//     (alongside priority / layer-2 transparency bits in the high
//     half).
//   - NextReg 0x40 — set the palette-write index (auto-increments
//     on each value byte through 0x41 / 0x44).
package palette

// Palette holds one 256-entry table of 9-bit colour values plus the
// per-entry 2-bit priority (NR$44 bits 7:6, zxnext.vhd:4920). For Layer 2,
// the high priority bit (NR$44 bit 7) promotes the pixel above the lower
// layers (layer2_priority, zxnext.vhd:7039/7123). Colour is stored as
// uint16 (low 9 bits); priority is stored separately so the colour path is
// unchanged.
type Palette struct {
	entries  [256]uint16
	priority [256]byte
}

// New returns a fresh Palette seeded with the RGB332 identity map,
// where each 9-bit entry is the 8-bit index with the low blue bit
// set to the OR of the two blue bits.
//
// Strictly the FPGA's palette BRAMs power up all-ZERO (dpram2.vhd
// defaults to the empty init file; the palette_utm / palette_l2s
// instances at zxnext.vhd:6960/7013 pass no init) — the identity
// and classic contents are installed by the boot firmware before
// any user code can run. Since a real Next is never usable
// pre-firmware, the emulator bakes the booted state in as the
// power-on default: identity for the Layer 2 / sprite / tilemap
// palettes (pinned by the Level2Order conformance test's real-board
// reference, whose Layer 2 never writes a palette) and the classic
// repeating pattern for the ULA first palette (NewULAClassic,
// pinned by the NextReg_defaults board reference).
func New() *Palette {
	p := &Palette{}
	for i := 0; i < 256; i++ {
		lo := uint16(0)
		if i&0x03 != 0 {
			lo = 1
		}
		p.entries[i] = uint16(i)<<1 | lo
	}
	return p
}

// classicRGB333 is the booted machine's default ULA palette pattern:
// the 16 standard Spectrum colours (non-bright components %101,
// bright %111) repeated 16 times across all 256 entries. Pinned by
// the MrKWatkins NextReg_defaults real-board reference (core 3.1.5
// photo): a fresh NR$41 read at index $70 returns $00 (black) and
// index $71 reads $02 (blue %000_000_101 >> 1).
//
// Bright magenta (index 11) is NOT the pure %111'000'111: the boot
// palette gives it a green LSB (%111'001'111, 8-bit projection $E7)
// so a classic bright-magenta screen does not match the default
// NR$14 = $E3 global transparency. Pinned by the MrKWatkins
// ULA/DefaultTransparency test: its board photo shows the magenta
// paper opaque over Layer 2, and the MAME 0.282 / CSpect 2.11.1 /
// ZEsarUX 8.0 captures all render it as RGB (255,36,255).
var classicRGB333 = [16]uint16{
	0x000, 0x005, 0x140, 0x145, 0x028, 0x02D, 0x168, 0x16D,
	0x000, 0x007, 0x1C0, 0x1CF, 0x038, 0x03F, 0x1F8, 0x1FF,
}

// NewULAClassic returns a Palette seeded with the booted machine's
// ULA first-palette default: the classic 16-colour pattern repeated
// (see classicRGB333).
func NewULAClassic() *Palette {
	p := &Palette{}
	for i := 0; i < 256; i++ {
		p.entries[i] = classicRGB333[i&0x0F]
	}
	return p
}

// Set writes a 9-bit value to the given index. Only the low 9 bits
// of val are kept.
func (p *Palette) Set(index byte, val uint16) {
	p.entries[index] = val & 0x01FF
}

// Get returns the 9-bit value at the given index.
func (p *Palette) Get(index byte) uint16 { return p.entries[index] }

// SetPriority stores the 2-bit NR$44 priority (bits 1:0) for the entry.
func (p *Palette) SetPriority(index, prio byte) { p.priority[index] = prio & 0x03 }

// Priority returns the 2-bit NR$44 priority for the entry.
func (p *Palette) Priority(index byte) byte { return p.priority[index] }

// HasPriority reports whether the Layer 2 priority bit (NR$44 bit 7, the
// high priority bit) is set — i.e. this pixel is promoted above the lower
// layers regardless of the NR$15 priority mode.
func (p *Palette) HasPriority(index byte) bool { return p.priority[index]&0x02 != 0 }

// RGB returns the (red, green, blue) channels for the entry at
// index, each expanded from its 3-bit packed form to a full 8-bit
// channel value via the standard bit-replication pattern (3-bit
// 'abc' becomes 8-bit 'abcabcab'). This matches the SpecNext
// analogue-VGA output reference.
//
// The 9-bit storage format packs RRR|GGG|BBB into bits 8..0; only
// 8 of those bits arrive via NextReg 0x41 (the low blue bit is
// forced to 0 there). The two-byte NextReg 0x44 sequence delivers
// all 9 bits, but RGB expansion here uses the 3-bit blue directly —
// the low blue bit only matters for the very darkest values where
// 8-bit replication and 9-bit-plus-half-step diverge by one unit.
func (p *Palette) RGB(index byte) (r, g, b byte) {
	v := p.entries[index]
	r3 := byte((v >> 6) & 0x07)
	g3 := byte((v >> 3) & 0x07)
	b3 := byte(v & 0x07)
	r = (r3 << 5) | (r3 << 2) | (r3 >> 1)
	g = (g3 << 5) | (g3 << 2) | (g3 >> 1)
	b = (b3 << 5) | (b3 << 2) | (b3 >> 1)
	return r, g, b
}

// Bank holds the four palettes a Spectrum Next exposes — two for
// ULA / LoRes, two for Layer 2, two for Sprites, two for Tilemap.
// NextReg 0x43 selects which palette read-write path 0x40 / 0x41 /
// 0x44 access.
//
// Selected (write-target) and ActiveX (per-layer render-target)
// are independent. NextReg 0x43 bits 1-2 (sometimes 1-3) pick the
// write target; bits 4-7 pick the per-layer active palette. Real
// hardware lets a guest upload palette entries into the "second"
// table while continuing to render through the "first" — Sprint 7
// cleanup adds that decoupling.
type Bank struct {
	palettes      [8]*Palette // slot mapping per the Palette* consts
	selected      byte        // 0..7 — write target
	index         byte        // current write cursor
	activeULA     byte        // 0 = first, 1 = second
	activeLayer2  byte
	activeSprites byte
	activeTilemap byte

	// Two-byte latch for the NR$44 9-bit palette write protocol: pending9
	// holds the high byte (first write) until the second write arrives and
	// commits both. Stored here (not in the wire-layer closure) so
	// ResetWriteLatches can clear a half-completed pair across a reboot.
	pending9 byte
	have9    bool

	// autoIncDisable mirrors NextReg $43 bit 7 (nr_43_palette_autoinc_disable,
	// zxnext.vhd:5389). When set, an NR$41/$44 palette write does NOT advance
	// the index (zxnext.vhd:5379-5381 / 5399-5401 gate the increment on this
	// bit) — the guest writes the same entry repeatedly.
	autoIncDisable bool

	// Raster-stamped content-write log. On the FPGA a palette BRAM write
	// (nr_palette_we, zxnext.vhd:4919-4930) is visible to the video fetch
	// on the very next pixel, so a CPU rewriting an entry mid-frame
	// recolours the scene from that raster position (the MrKWatkins
	// ScanlineReadingAndInterrupt test paints its target-line marker
	// exactly this way: one-line palette flashes timed off NR$1F). The
	// emulator renders at end of frame, so each mid-frame write is logged
	// with its raster line here and the ULA render replays the log row by
	// row (Begin/ReplayThrough/Rewind/EndReplay), the same fold the border
	// colour and NR$43-select changes already get. rasterLine is nil until
	// wired (WirePalette) — no logging, no overhead for classic machines.
	rasterLine     func() int
	writes         []stampedWrite
	replayCursor   int
	replayActive   bool // suspends logging while the render replays/copper runs
	writeOverflow  bool
	writesConsumed bool // log already replayed; retained for stale re-renders
}

// stampedWrite is one logged palette-entry mutation: enough to undo
// (old) and redo (new) the write during the render's per-row replay.
type stampedWrite struct {
	line     int
	pal      byte // palette slot 0..7
	idx      byte
	old, new uint16
	oldPrio  byte
	newPrio  byte
	hasPrio  bool
}

// maxStampedWrites bounds the per-frame log; a frame writing more than
// this (bulk palette uploads) degrades to today's end-of-frame
// resolution instead of growing without limit.
const maxStampedWrites = 4096

// SetRasterLineSource wires the raster-line clock (the ULA's
// BeamPosition line, 0 = frame INT) that stamps each palette content
// write. Nil disables logging.
func (b *Bank) SetRasterLineSource(fn func() int) { b.rasterLine = fn }

// logWrite records one entry mutation with the current raster stamp.
// Must be called BEFORE the mutation lands so old captures the prior
// value. No-op while the render replay owns the bank (render-time
// copper writes are already raster-paced) or when no clock is wired.
func (b *Bank) logWrite(idx byte, new uint16, newPrio byte, hasPrio bool) {
	if b.rasterLine == nil || b.replayActive {
		return
	}
	// First write of a new execution frame: drop the previous frame's
	// consumed log.
	if b.writesConsumed {
		b.writes = b.writes[:0]
		b.writesConsumed = false
		b.writeOverflow = false
	}
	if len(b.writes) >= maxStampedWrites {
		b.writeOverflow = true
		return
	}
	pal := b.palettes[b.selected]
	b.writes = append(b.writes, stampedWrite{
		line:    b.rasterLine(),
		pal:     b.selected,
		idx:     idx,
		old:     pal.Get(idx),
		new:     new,
		oldPrio: pal.Priority(idx),
		newPrio: newPrio,
		hasPrio: hasPrio,
	})
}

// BeginReplay suspends write logging and rewinds every logged write (in
// reverse) so the bank holds the frame-start palette state. Returns
// whether any stamped writes exist to replay; on overflow the log is
// dropped and the bank keeps its live (end-of-frame) state — today's
// resolution — rather than replaying a truncated history.
func (b *Bank) BeginReplay(stale bool) bool {
	b.replayActive = true
	// A fresh (non-stale) render whose log was already consumed by a
	// previous render means the execution frame since then wrote no
	// palette entries — drop the old log rather than replaying last
	// frame's flashes again. A STALE render (no execution since the
	// last render, e.g. the harness screenshot path) keeps the consumed
	// log and replays it identically.
	if !stale && b.writesConsumed {
		b.writes = b.writes[:0]
		b.writesConsumed = false
	}
	if b.writeOverflow || len(b.writes) == 0 {
		b.writes = b.writes[:0]
		b.writeOverflow = false
		b.replayCursor = 0
		return false
	}
	// Every logged write is live at this point, so rewinding "the
	// applied prefix" means rewinding the whole log.
	b.replayCursor = len(b.writes)
	b.RewindReplay()
	return true
}

// ReplayThrough applies, in order, every logged write stamped at or
// before line that the cursor has not yet passed. Call with
// monotonically increasing lines during the render's row walk.
func (b *Bank) ReplayThrough(line int) {
	for b.replayCursor < len(b.writes) && b.writes[b.replayCursor].line <= line {
		w := b.writes[b.replayCursor]
		b.palettes[w.pal].Set(w.idx, w.new)
		if w.hasPrio {
			b.palettes[w.pal].SetPriority(w.idx, w.newPrio)
		}
		b.replayCursor++
	}
}

// RewindReplay rewinds the applied writes back to the frame-start
// state so a second raster pass (the render's top-border sweep, whose
// rows scan BEFORE the paper) can replay from the beginning.
func (b *Bank) RewindReplay() {
	for i := b.replayCursor - 1; i >= 0; i-- {
		w := b.writes[i]
		b.palettes[w.pal].Set(w.idx, w.old)
		if w.hasPrio {
			b.palettes[w.pal].SetPriority(w.idx, w.oldPrio)
		}
	}
	b.replayCursor = 0
}

// EndReplay applies any writes the row walk never reached (restoring
// the live end-of-frame palette state), marks the log consumed — it is
// RETAINED so a stale re-render can replay it identically; the next
// fresh render or the next logged write drops it — and resumes logging.
func (b *Bank) EndReplay() {
	b.ReplayThrough(int(^uint(0) >> 1))
	b.writesConsumed = true
	b.replayCursor = 0
	b.replayActive = false
}

// SetAutoIncDisable sets the NR$43 bit-7 palette auto-increment-disable latch.
// When true, Write8/Write9 leave the index unchanged after a write.
func (b *Bank) SetAutoIncDisable(on bool) { b.autoIncDisable = on }

// Layer identifies one of the four NextReg-palette layers.
type Layer int

const (
	LayerULA Layer = iota
	LayerLayer2
	LayerSprites
	LayerTilemap
)

// Pre-defined NextReg 0x43 palette selectors. Bit 6 of 0x43
// distinguishes "first" vs "second" palette within a layer.
const (
	PaletteULAFirst byte = iota
	PaletteULASecond
	PaletteLayer2First
	PaletteLayer2Second
	PaletteSpritesFirst
	PaletteSpritesSecond
	PaletteTilemapFirst
	PaletteTilemapSecond
)

// NewBank constructs a Bank with all eight palettes initialised to
// the booted machine's defaults: RGB332 identity everywhere except
// the ULA first palette, which holds the classic repeating pattern
// (see New / NewULAClassic for the provenance).
func NewBank() *Bank {
	b := &Bank{}
	for i := range b.palettes {
		b.palettes[i] = New()
	}
	b.palettes[PaletteULAFirst] = NewULAClassic()
	return b
}

// Select sets the active palette per the NextReg 0x43 layout: bit 0
// toggles first/second, bits 1-2 select layer. A NR$43 write also
// resets the NR$44 two-write sequence (nr_palette_sub_idx <= '0',
// zxnext.vhd:5395).
func (b *Bank) Select(val byte) {
	b.selected = val & 0x07
	b.have9 = false
}

// Selected returns the currently-selected palette index (0..7).
func (b *Bank) Selected() byte { return b.selected }

// SetIndex installs the palette-write cursor (NextReg 0x40 write).
// Subsequent value writes auto-increment from here. A NR$40 write
// also resets the NR$44 two-write sequence (nr_palette_sub_idx <=
// '0', zxnext.vhd:5376) — guests rely on this to re-sync after a
// routine deliberately leaves a dangling half-pair (WOTEF's palette
// clear ends NR$40=$80 + one NR$44 byte, then the next upload's
// NR$40 write must start a fresh pair or every entry lands one byte
// out of phase, #165).
func (b *Bank) SetIndex(i byte) {
	b.index = i
	b.have9 = false
}

// Index returns the current write cursor.
func (b *Bank) Index() byte { return b.index }

// Active returns the currently-selected Palette so layer code can
// read entries directly.
func (b *Bank) Active() *Palette { return b.palettes[b.selected] }

// Palette returns a specific palette by index (0..7), or nil for
// out-of-range.
func (b *Bank) Palette(i int) *Palette {
	if i < 0 || i >= 8 {
		return nil
	}
	return b.palettes[i]
}

// SetActive selects which palette (first=0, second=1) the given
// layer uses for rendering. Only the low bit of which is honoured.
// This lets render code use the per-layer active selection without
// peeking at the write-target selector.
func (b *Bank) SetActive(layer Layer, which byte) {
	switch layer {
	case LayerULA:
		b.activeULA = which & 1
	case LayerLayer2:
		b.activeLayer2 = which & 1
	case LayerSprites:
		b.activeSprites = which & 1
	case LayerTilemap:
		b.activeTilemap = which & 1
	}
}

// ActiveSelector returns the current first/second selection for
// the given layer (0 = first, 1 = second). Distinct from Active()
// which returns the write-target palette.
func (b *Bank) ActiveSelector(layer Layer) byte {
	switch layer {
	case LayerULA:
		return b.activeULA
	case LayerLayer2:
		return b.activeLayer2
	case LayerSprites:
		return b.activeSprites
	case LayerTilemap:
		return b.activeTilemap
	}
	return 0
}

// PaletteForLayer returns the currently-active palette for the
// given layer, honouring the per-layer first/second selection
// (independent of the write-target Selected()).
func (b *Bank) PaletteForLayer(layer Layer) *Palette {
	base := byte(layer) * 2
	return b.palettes[base+b.ActiveSelector(layer)]
}

// Write8 stores an 8-bit palette value (NextReg 0x41 write
// behaviour: high 8 of 9 bits, low blue bit forced to 0) at the
// current index, then advances the index by 1.
func (b *Bank) Write8(val byte) {
	// 9th bit (low blue) = written byte's bit1 OR bit0, per zxnext.vhd:4919
	// (nr_palette_value <= nr_wr_dat & (nr_wr_dat(1) or nr_wr_dat(0))) —
	// NOT forced to 0. NextReg $44 read-back returns this bit, and
	// NextZXOS's palette read-back loop diverges if it's wrong.
	v := uint16(val) << 1
	if val&0x03 != 0 {
		v |= 1
	}
	b.logWrite(b.index, v, 0, false)
	b.palettes[b.selected].Set(b.index, v)
	if !b.autoIncDisable {
		b.index++
	}
	// A NR$41 write also resets the NR$44 two-write sequence
	// (nr_palette_sub_idx <= '0', zxnext.vhd:5382).
	b.have9 = false
}

// Read8 returns the NextReg $41 read-back: the 8 most-significant bits
// (8:1) of the 9-bit palette value at the current index in the selected
// (write-target) palette. Per zxnext.vhd:6038
// (port_253b_dat <= nr_palette_dat(8 downto 1)). Reading does NOT
// auto-increment the index — only writes do (zxnext.vhd:5380/:5401),
// unlike Write8/Write9.
func (b *Bank) Read8() byte {
	return byte((b.palettes[b.selected].Get(b.index) >> 1) & 0xFF)
}

// ReadNR44 returns the NextReg $44 read-back. Per zxnext.vhd:6047
// (nr_palette_dat(10 downto 9) & "00000" & nr_palette_dat(0)): bits 7:6 are
// the 2-bit priority, bit 0 is the palette value's LSB. No auto-increment
// on read.
func (b *Bank) ReadNR44() byte {
	pal := b.palettes[b.selected]
	return pal.Priority(b.index)<<6 | byte(pal.Get(b.index)&0x01)
}

// Write9 stores both bytes of a 9-bit palette value (NextReg 0x44
// behaviour: two consecutive writes — first the high 8 bits, then
// the second byte carrying the low blue bit). The dispatcher
// arranges the two writes via a small two-step state machine
// (NextReg 0x44 is auto-increment after the SECOND write only).
//
// Sprint 6 implements Write9 as a single call taking both bytes;
// the dispatcher-level state machine for splitting the two
// register writes can be added when there's a real caller.
func (b *Bank) Write9(hi, lo byte) {
	v := (uint16(hi) << 1) | uint16(lo&0x01)
	b.logWrite(b.index, v, (lo>>6)&0x03, true)
	b.palettes[b.selected].Set(b.index, v)
	// lo bits 7:6 carry the 2-bit priority (NR$44 protocol, zxnext.vhd:4920).
	b.palettes[b.selected].SetPriority(b.index, (lo>>6)&0x03)
	if !b.autoIncDisable {
		b.index++
	}
}

// WriteNR44 implements the NextReg 0x44 two-byte protocol against
// the Bank's internal latch (pending9/have9). The first call
// stashes val and arms the latch; the second call combines latched
// high byte + val low bit into a 9-bit palette entry, commits via
// Write9, and disarms the latch. Replaces a closure-held latch in
// the wire layer that survived nextRegs.Reset and corrupted the
// first NR$44 write of the post-reboot session.
func (b *Bank) WriteNR44(val byte) {
	if !b.have9 {
		b.pending9 = val
		b.have9 = true
		return
	}
	b.Write9(b.pending9, val)
	b.have9 = false
}

// WriteEntry stores a 9-bit value directly into palette pal at index —
// the ULA+ data port's write path ($FF3B routed through the NextReg
// stream as register $FF, zxnext.vhd:4741/:6958). Bypasses the cursor,
// auto-increment and the per-frame raster write log (a mid-frame ULA+
// recolour resolves at end-of-frame — same precision class as the
// hi-res palette rows).
func (b *Bank) WriteEntry(pal, index byte, value uint16) {
	b.palettes[pal&0x07].Set(index, value)
}

// StoredPaletteValue returns the FPGA's nr_stored_palette_value — the
// byte last staged by an NR$44 first-half write (zxnext.vhd:5398-5399).
// NR$28's read mux exposes it verbatim (zxnext.vhd:6004).
func (b *Bank) StoredPaletteValue() byte { return b.pending9 }

// SubIdx returns the FPGA's nr_palette_sub_idx — '1' while an NR$44
// pair is half-written (set by the first $44 byte, cleared by the
// second and by $40/$41/$43 writes, zxnext.vhd:5376-5403). NR$03's
// read mux exposes it as bit 7 (zxnext.vhd:5894).
func (b *Bank) SubIdx() bool { return b.have9 }

// ResetWriteLatches drops the half-completed NR$44 pending-pair
// state. Called from the emulator's Reboot path so a stale half-
// pair from the previous boot doesn't redirect the first NR$44
// write of the new boot into the wrong palette slot.
func (b *Bank) ResetWriteLatches() {
	b.pending9 = 0
	b.have9 = false
	// Drop the frame's stamped-write log too: a reboot's palette state
	// is a fresh baseline, not something to rewind through.
	b.writes = b.writes[:0]
	b.writeOverflow = false
	b.replayCursor = 0
	b.replayActive = false
}
