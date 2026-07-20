// Package sprite implements the Spectrum Next's hardware-sprite
// engine — 128 sprite slots backed by a 16 KB shared pattern RAM.
//
// 16×16 patterns in 4bpp or 8bpp, X / Y (9-bit) / palette-offset /
// visible attributes, X/Y mirror, 90° rotate, scale (1/2/4/8×), and the
// pattern N6 high bit, all via the 5-byte attribute record. Per-scanline
// render emits sprite pixels with transparency against the NR$4B
// transparency colour (raw pattern value, pre-palette-offset).
// Collision detection and the per-line bandwidth limit (the two $303B
// status bits) and anchor groups (composite + unified relative
// sprites) are modelled.
package sprite

// MaxSprites is the count of independently-positioned sprite slots
// (matches real hardware).
const MaxSprites = 128

// PatternRAMSize is the size in bytes of the shared sprite-pattern
// storage. Real hardware fits 64 8-bit patterns (256 bytes each)
// or 128 4-bit patterns (128 bytes each) here, addressed byte-linear
// from offset 0.
const PatternRAMSize = 16384

// SpriteSize is the per-side dimension of an unscaled sprite.
const SpriteSize = 16

// Attr is one sprite's attribute record: real hardware uses 4 or 5
// bytes per sprite over the AY-style register file. The 5th byte
// (present when Extended is set) carries scale, mirror/rotate
// inheritance, the 8bpp/4bpp select and the pattern N6 bit.
type Attr struct {
	X        int16 // signed; off-screen positions allowed (clipped at render)
	Y        int16
	Pattern  byte // pattern index (0..127 in 4bpp)
	Palette  byte // 4-bit palette offset
	Visible  bool
	XMirror  bool // attribute byte 2 bit 3
	YMirror  bool // attribute byte 2 bit 2
	Rotate   bool // attribute byte 2 bit 1 (90°; swaps X/Y, inverts X mirror)
	Extended bool // attribute byte 3 bit 6: a 5th byte (Byte4) is present
	Byte4    byte // attribute byte 4 (used only when Extended): bit 7 = 4bpp,
	// bit 6 = pattern N6, bits 4:3 = X scale, bits 2:1 = Y scale, bit 0 = Y MSB
}

// Engine holds the sprite-bank state: 128 attribute slots, a
// 16 KB pattern RAM, plus the sprite-index cursors and the
// pattern-RAM write cursor.
type Engine struct {
	attrs   [MaxSprites]Attr
	pattern [PatternRAMSize]byte
	// The FPGA keeps TWO sprite indexes (sprites.vhd:591-655):
	// attr_index — the IO-port cursor driving the port-$57 attribute
	// stream (sprite number + byte 0..4), set by a port-$303B write —
	// and mirror_sprite_q — the NR$34 "NextReg mirror" targeted by the
	// NR$35-$39/$75-$79 attribute registers. NR$09 bit 4 ("lockstep",
	// reset 0) ties them: a sprite-number change on either side copies
	// to the other (zxnext.vhd:5187, sprites.vhd:60).
	ioSprite   byte // port cursor: sprite 0..127
	ioByte     int  // port cursor: attribute byte 0..4
	ioExtended bool // latched byte-3 bit 6 of the in-flight port record
	// mirrorSprite keeps all 8 bits: bits 6:0 are the NR$34 sprite
	// number; bit 7 tracks the pattern half ("wear helmet",
	// sprites.vhd:609) and seeds the pattern cursor's half bit when a
	// tied NR$34 selection rewrites it.
	mirrorSprite byte
	tie          bool   // NR$09 bit 4
	selPattAddr  uint16 // pattern-RAM write cursor
	enabled      bool
	// transpColour is the sprite transparency colour (NextReg $4B, reset
	// $E3 per zxnext.vhd:5016). A pixel is transparent when its RAW
	// pattern value — before the palette offset is applied — equals this
	// byte (8bpp) or its low nibble (4bpp): sprites.vhd:971 compares
	// spr_pat_data against transp_colour_i, spr_nibble_data against
	// transp_colour_i(3:0).
	transpColour byte
	// collided latches the sprite-collision flag (two opaque sprite
	// pixels coincide). Sticky across the frame; cleared when the $303B
	// status port is read (FPGA sprites.vhd:975 bit 0).
	collided bool
	// overtime latches the "max sprites per line" flag ($303B bit 1):
	// the render state machine ran out of line budget before finishing
	// the sprite list (sprites.vhd:977 — state /= S_IDLE at line reset).
	// Sticky until the status port reads it, like collided.
	overtime bool
	// lineCovered tracks which display pixels an opaque sprite has
	// already painted in the current RenderScanline pass, to detect
	// collisions. Reused across scanlines.
	lineCovered []bool

	// zeroOnTop mirrors NextReg $15 bit 6 ("sprite_priority", sprites.vhd:73).
	// When set, the LOWEST-numbered sprite is drawn in front (sprite 0 on top);
	// the painted pixel is locked in and higher-numbered sprites do not
	// overwrite it. When clear (reset default), later (higher-numbered) sprites
	// paint over earlier ones.
	zeroOnTop bool

	// Sprite clip window (NextReg $19 via the $1C index). clipSet gates the
	// whole clip so an un-wired engine clips nothing. How the window maps to
	// screen bounds depends on overBorder/borderClip (NextReg $15 bits 1/5),
	// per sprites.vhd:1043-1066 — see effectiveClip.
	clipX1, clipX2, clipY1, clipY2 byte
	clipSet                        bool

	// overBorder mirrors NextReg $15 bit 1 ("sprites over border") and
	// borderClip bit 5 ("border clip enable"). With overBorder off the clip
	// window is shifted into the central 256x192 paper area (so Y<32 / X<32 in
	// the 320x256 frame is hidden); with it on, the window applies directly
	// (in 2-px X units) only when borderClip is set, else there is no clip.
	overBorder bool
	borderClip bool

	// gen counts render-input mutations (attributes, patterns, clip,
	// control bits) — every exported mutator bumps it. Consumers (the
	// compositor's per-render row cache, #187 performance) use it to
	// prove a row rendered earlier in the same render pass is still
	// exact: RenderScanline is a pure function of (y, engine state),
	// and an unchanged gen means unchanged state.
	gen uint32

	// attrObserver, when non-nil, sees every attribute byte landed on a
	// sprite slot (diagnostics; see SetAttrWriteObserver).
	attrObserver func(sprite, byteIdx int, val byte)
}

// Gen returns the render-input mutation counter (see the gen field).
func (e *Engine) Gen() uint32 { return e.gen }

// SetAttrWriteObserver installs a callback invoked on every attribute
// byte write (any route: port $57 stream, NR$35-$39/$75-$79 mirror).
// Diagnostic use only; pass nil to remove.
func (e *Engine) SetAttrWriteObserver(fn func(sprite, byteIdx int, val byte)) {
	e.attrObserver = fn
}

// SetOverBorder sets NextReg $15 bit 1 ("sprites over border").
func (e *Engine) SetOverBorder(on bool) { e.overBorder = on; e.gen++ }

// SetBorderClip sets NextReg $15 bit 5 ("border clip enable").
func (e *Engine) SetBorderClip(on bool) { e.borderClip = on; e.gen++ }

// effectiveClip resolves the active clip window to inclusive screen bounds
// [xs..xe] x [ys..ye] in 320x256 frame coordinates, following sprites.vhd:
//
//	over_border=1, border_clip=0 -> 0..319 x 0..255 (no clip)
//	over_border=1, border_clip=1 -> x1*2..x2*2+1, y1..y2
//	over_border=0                -> window shifted +32 into the paper area
func (e *Engine) effectiveClip() (xs, xe, ys, ye int) {
	x1, x2, y1, y2 := int(e.clipX1), int(e.clipX2), int(e.clipY1), int(e.clipY2)
	if e.overBorder {
		if !e.borderClip {
			return 0, 319, 0, 255
		}
		return x1 * 2, x2*2 + 1, y1, y2
	}
	shift := func(c int) int { return (((c>>5)+1)<<5 | (c & 0x1F)) }
	return shift(x1), shift(x2), shift(y1), shift(y2)
}

// SetClip installs the sprite clip window (NextReg $19 coords X1,X2,Y1,Y2).
// X is in 2-pixel units (matching the FPGA), Y in 1-pixel units.
func (e *Engine) SetClip(x1, x2, y1, y2 byte) {
	e.clipX1, e.clipX2, e.clipY1, e.clipY2 = x1, x2, y1, y2
	e.clipSet = true
	e.gen++
}

// Clip returns the current clip window (x1,x2,y1,y2) and whether it is set.
func (e *Engine) Clip() (x1, x2, y1, y2 byte, set bool) {
	return e.clipX1, e.clipX2, e.clipY1, e.clipY2, e.clipSet
}

// New returns a fresh Engine with all sprites invisible, the
// pattern RAM zero and the transparency colour at its $E3 reset value.
func New() *Engine { return &Engine{transpColour: 0xE3} }

// SetTransparencyColour installs the sprite transparency colour
// (NextReg $4B). See the transpColour field for the comparison rule.
func (e *Engine) SetTransparencyColour(v byte) { e.transpColour = v; e.gen++ }

// TransparencyColour returns the current NR$4B transparency colour.
func (e *Engine) TransparencyColour() byte { return e.transpColour }

// LineCoverage returns the per-pixel coverage of the most recent
// RenderScanline call: true where an opaque sprite pixel was rendered.
// The compositor uses this to decide sprite-pixel presence — dst values
// alone cannot, since palette index 0 is a legitimately drawable colour
// (transparency is the raw pattern value vs NR$4B, not index 0). The
// slice is reused by the next RenderScanline call.
func (e *Engine) LineCoverage() []bool { return e.lineCovered }

// SetEnabled toggles the sprite layer.
func (e *Engine) SetEnabled(on bool) { e.enabled = on; e.gen++ }

// SetZeroOnTop sets the NextReg $15 bit 6 "sprite_priority" mode: when true the
// lowest-numbered sprite is drawn in front of higher-numbered overlapping ones.
func (e *Engine) SetZeroOnTop(on bool) { e.zeroOnTop = on; e.gen++ }

// ZeroOnTop reports the NextReg $15 bit 6 "sprite_priority" mode.
func (e *Engine) ZeroOnTop() bool { return e.zeroOnTop }

// Enabled reports whether sprites render at all.
func (e *Engine) Enabled() bool { return e.enabled }

// SetIndexTie sets NR$09 bit 4 ("sprite id lockstep", zxnext.vhd:5187,
// reset 0): when tied, a sprite-number change on either the NR$34 mirror
// or the IO-port cursor copies to the other side (sprites.vhd:607/653).
func (e *Engine) SetIndexTie(on bool) { e.tie = on; e.gen++ }

// MirrorSprite returns the NR$34 mirror sprite number (bits 6:0 — the
// value NR$34 reads back as '0' & sprite_mirror_id, zxnext.vhd:6033).
func (e *Engine) MirrorSprite() byte { return e.mirrorSprite & 0x7F }

// mirrorPatternAddr is the pattern-cursor value a tied mirror change
// installs: mirror[5:0] selects the 256-byte slot, mirror bit 7 the
// 128-byte half (sprites.vhd:733-734).
func (e *Engine) mirrorPatternAddr() uint16 {
	addr := uint16(e.mirrorSprite&0x3F) * 256
	if e.mirrorSprite&0x80 != 0 {
		addr += 128
	}
	return addr
}

// mirrorChanged propagates a mirror sprite-number change to the tied IO
// cursor + pattern cursor (sprites.vhd:653-654/733-734).
func (e *Engine) mirrorChanged() {
	if !e.tie {
		return
	}
	e.ioSprite = e.mirrorSprite & 0x7F
	e.ioByte = 0
	e.ioExtended = false
	e.selPattAddr = e.mirrorPatternAddr()
}

// ioSpriteChanged propagates an IO-cursor sprite-number change to the
// tied mirror (sprites.vhd:607-609: sprite bits from the cursor, bit 7
// from the pattern cursor's half bit).
func (e *Engine) ioSpriteChanged() {
	if !e.tie {
		return
	}
	e.mirrorSprite = e.ioSprite&0x7F | byte(e.selPattAddr>>7)&1<<7
}

// SelectSprite installs the NR$34 mirror sprite index that subsequent
// NextReg attribute writes (NR$35-$39 / $75-$79) target. All 8 bits are
// stored (sprites.vhd:601 keeps bit 7 as the pattern-half tracker);
// the sprite number is bits 6:0. When the NR$09 lockstep tie is on the
// IO-port cursor and pattern cursor follow the selection.
func (e *Engine) SelectSprite(v byte) {
	e.mirrorSprite = v
	e.mirrorChanged()
}

// IncMirrorSprite advances the NR$34 mirror sprite number by one — the
// auto-increment the NR$75-$79 attribute aliases perform (zxnext.vhd:4916).
// Bit 7 refreshes from the pattern cursor's half bit (sprites.vhd:604-605).
func (e *Engine) IncMirrorSprite() {
	e.mirrorSprite = (e.mirrorSprite+1)&0x7F | byte(e.selPattAddr>>7)&1<<7
	e.mirrorChanged()
}

// ApplyAttrByte decodes attribute byte idx (0..4) into the NR$34 mirror
// sprite — the NR$35-$39/$75-$79 write path (sprites.vhd:704-715, the
// mirror_served mux). The port-$57 stream shares the byte layout via
// applyAttr.
//
//	byte 0: X LSB
//	byte 1: Y LSB
//	byte 2: palette offset (7:4) + X/Y mirror + rotate (3:1) + X8 (0)
//	byte 3: visible (7) + extended-5th-byte (6) + pattern[5:0]
//	byte 4: scale / N6 / 8bpp / Y-MSB (decoded in RenderScanline when Extended)
func (e *Engine) ApplyAttrByte(idx int, val byte) {
	e.applyAttr(int(e.mirrorSprite&0x7F), idx, val)
}

func (e *Engine) applyAttr(sprite, idx int, val byte) {
	s := e.Sprite(sprite)
	if s == nil {
		return
	}
	if e.attrObserver != nil {
		e.attrObserver(sprite, idx, val)
	}
	e.gen++
	switch idx {
	case 0:
		s.X = (s.X & 0x100) | int16(val)
	case 1:
		s.Y = int16(val)
	case 2:
		s.Palette = (val >> 4) & 0x0F
		if val&0x01 != 0 {
			s.X |= 0x100
		} else {
			s.X &^= 0x100
		}
		s.XMirror = val&0x08 != 0
		s.YMirror = val&0x04 != 0
		s.Rotate = val&0x02 != 0
	case 3:
		s.Visible = val&0x80 != 0
		s.Extended = val&0x40 != 0
		s.Pattern = val & 0x3F
	case 4:
		s.Byte4 = val
	}
}

// WriteAttr streams one attribute byte to the IO cursor's sprite (port
// $57, "Sprite Attribute Upload", ports.txt 0x57). Each sprite takes 4
// bytes, or 5 when its byte 3 bit 6 (the "5th byte present" flag) is
// set; once the sprite's bytes are all written the cursor auto-advances
// to the next sprite, wrapping 127->0 (sprites.vhd:639 —
// index_inc_attr_by_8), so guest code can upload every sprite each
// frame without re-selecting between them. A sprite advance follows the
// NR$09 lockstep tie into the NR$34 mirror.
func (e *Engine) WriteAttr(val byte) {
	e.applyAttr(int(e.ioSprite), e.ioByte, val)
	if e.ioByte == 3 {
		e.ioExtended = val&0x40 != 0
	}
	e.ioByte++
	count := 4
	if e.ioExtended {
		count = 5
	}
	if e.ioByte >= count {
		e.ioSprite = (e.ioSprite + 1) & 0x7F
		e.ioByte = 0
		e.ioExtended = false
		e.ioSpriteChanged()
	}
}

// SelectedSprite returns the IO-port cursor's sprite number.
func (e *Engine) SelectedSprite() byte { return e.ioSprite }

// SelectSlot applies a port $303B write (ports.txt 0x303B): bits 6:0 select
// the IO cursor's sprite (the port-$57 target), while bits 5:0 select the
// pattern index — each pattern is 256 bytes, so the pattern-RAM upload cursor
// is set to (index*256). Bit 7 adds a 128-byte half-offset, addressing the
// second 4bpp pattern packed in the same 256-byte slot. The $5B pattern-write
// port (WritePatternByte) streams from this cursor. With the NR$09 lockstep
// tie on, the NR$34 mirror follows (sprites.vhd:607-609).
func (e *Engine) SelectSlot(v byte) {
	e.ioSprite = v & 0x7F
	e.ioByte = 0
	e.ioExtended = false
	addr := uint16(v&0x3F) * 256
	if v&0x80 != 0 {
		addr += 128
	}
	e.selPattAddr = addr
	e.ioSpriteChanged()
}

// cover marks display pixel sx as painted by an opaque sprite in the
// current line, latching the collision flag if another sprite already
// painted it this line.
func (e *Engine) cover(sx int) {
	if e.lineCovered[sx] {
		e.collided = true
	} else {
		e.lineCovered[sx] = true
	}
}

// ReadStatus returns the sprite status byte (port $303B read, FPGA
// sprites.vhd:975): bit 0 = collision (two opaque sprites overlapped
// since the last read), bit 1 = max-sprites-per-line (the per-line
// render budget ran out — see renderCyclesPerLine). Reading CLEARS
// both latched flags (sprites.vhd:987-988).
func (e *Engine) ReadStatus() byte {
	var s byte
	if e.collided {
		s |= 0x01
	}
	if e.overtime {
		s |= 0x02
	}
	e.collided = false
	e.overtime = false
	return s
}

// anchorState holds the latched attributes of the most-recent non-relative
// sprite, used to position and (in unified mode) transform relative sprites
// (FPGA sprites.vhd anchor_* signals).
type anchorState struct {
	x, y                     int  // 9-bit absolute position
	paloff                   byte // palette offset
	pattern                  int  // 7-bit pattern number
	vis                      bool
	h                        bool // anchor H (byte-4 bit 7) — relative depth + N6 gate
	relType                  bool // byte-4 bit 5: 1 = unified, 0 = composite
	rotate, xmirror, ymirror bool
	xscaleBits, yscaleBits   uint // 0..3 → ×1/2/4/8
}

// latchAnchor updates the anchor state from a non-relative sprite.
func latchAnchor(anc *anchorState, raw *Attr) {
	anc.x = int(raw.X)
	y := int(raw.Y)
	pat := int(raw.Pattern) & 0x3F
	if raw.Extended {
		if raw.Byte4&0x01 != 0 {
			y |= 0x100
		}
		if raw.Byte4&0x40 != 0 {
			pat |= 0x40
		}
	}
	anc.y = y
	anc.pattern = pat
	anc.paloff = raw.Palette
	anc.vis = raw.Visible
	anc.h = raw.Extended && raw.Byte4&0x80 != 0
	anc.relType = raw.Extended && raw.Byte4&0x20 != 0
	// The anchor shares its transform/scale with relative sprites only in
	// unified mode (byte-4 bit 5); otherwise relative offsets are raw.
	if anc.relType {
		anc.rotate = raw.Rotate
		anc.xmirror = raw.XMirror
		anc.ymirror = raw.YMirror
		anc.xscaleBits = uint((raw.Byte4 >> 3) & 0x03)
		anc.yscaleBits = uint((raw.Byte4 >> 1) & 0x03)
	} else {
		anc.rotate, anc.xmirror, anc.ymirror = false, false, false
		anc.xscaleBits, anc.yscaleBits = 0, 0
	}
}

// resolveRelative computes a relative sprite's effective attributes from
// its anchor (FPGA sprites.vhd:758-783), encoded back into a synthetic Attr
// so RenderScanline can draw it with the normal path.
func resolveRelative(raw *Attr, anc *anchorState) Attr {
	// 8-bit signed relative offsets (the low bytes of X/Y).
	rx0 := int(int8(byte(raw.X)))
	ry0 := int(int8(byte(raw.Y)))
	if anc.rotate {
		rx0, ry0 = ry0, rx0
	}
	rx1, ry1 := rx0, ry0
	if anc.rotate != anc.xmirror {
		rx1 = -rx0
	}
	if anc.ymirror {
		ry1 = -ry0
	}
	effX := (anc.x + (rx1 << anc.xscaleBits)) & 0x1FF
	effY := (anc.y + (ry1 << anc.yscaleBits)) & 0x1FF

	var eff Attr
	eff.Extended = true
	eff.Visible = anc.vis && raw.Visible
	eff.X = int16(effX)
	eff.Y = int16(effY & 0xFF)
	var b4 byte
	if effY&0x100 != 0 {
		b4 |= 0x01 // Y MSB
	}
	if anc.h {
		b4 |= 0x80 // depth follows the anchor (4bpp)
	}

	// Palette: byte-2 bit 0 (stored in raw.X bit 8) → palette offset
	// relative to the anchor's.
	if raw.X&0x100 != 0 {
		eff.Palette = (anc.paloff + raw.Palette) & 0x0F
	} else {
		eff.Palette = raw.Palette
	}

	// Pattern: for a relative sprite N6 is byte-4 bit 5 (bit 6 is the
	// relative marker), gated by the anchor H; byte-4 bit 0 selects a
	// pattern number relative to the anchor's.
	pat := int(raw.Pattern) & 0x3F
	if anc.h && raw.Byte4&0x20 != 0 {
		pat |= 0x40
	}
	if raw.Byte4&0x01 != 0 {
		pat = (pat + anc.pattern) & 0x7F
	}
	eff.Pattern = byte(pat & 0x3F)
	if pat&0x40 != 0 {
		b4 |= 0x40
	}

	if !anc.relType {
		// Composite: the relative sprite keeps its own transform + scale.
		eff.XMirror = raw.XMirror
		eff.YMirror = raw.YMirror
		eff.Rotate = raw.Rotate
		b4 |= raw.Byte4 & 0x1E // own scale bits 4:1
	} else {
		// Unified: inherit the anchor's transform (XOR-combined) + scale.
		xm, ym := raw.XMirror, raw.YMirror
		if anc.rotate {
			xm = raw.YMirror != raw.Rotate
			ym = raw.XMirror != raw.Rotate
		}
		eff.XMirror = anc.xmirror != xm
		eff.YMirror = anc.ymirror != ym
		eff.Rotate = anc.rotate != raw.Rotate
		b4 |= byte(anc.xscaleBits)<<3 | byte(anc.yscaleBits)<<1
	}
	eff.Byte4 = b4
	return eff
}

// Attr returns a pointer to the sprite at idx so callers can read
// or directly mutate attributes. nil for out-of-range.
func (e *Engine) Sprite(idx int) *Attr {
	if idx < 0 || idx >= MaxSprites {
		return nil
	}
	return &e.attrs[idx]
}

// Set installs an attribute record at the given slot.
func (e *Engine) Set(idx int, a Attr) {
	if idx < 0 || idx >= MaxSprites {
		return
	}
	e.attrs[idx] = a
	e.gen++
}

// SetPatternAddr installs the pattern-RAM write cursor directly,
// bypassing the port $303B addressing (see SelectSlot) so callers
// (mainly tests) can target a specific offset without the full
// port-routing dance.
func (e *Engine) SetPatternAddr(addr uint16) {
	if int(addr) >= PatternRAMSize {
		addr = PatternRAMSize - 1
	}
	e.selPattAddr = addr
}

// WritePatternByte stores one byte into the pattern RAM at the
// current cursor, then advances the cursor by 1.
func (e *Engine) WritePatternByte(b byte) {
	e.pattern[e.selPattAddr] = b
	e.selPattAddr = (e.selPattAddr + 1) % PatternRAMSize
	e.gen++
}

// PatternByte returns the byte at the given pattern-RAM offset.
// Useful for tests; out-of-range returns 0.
func (e *Engine) PatternByte(addr uint16) byte {
	if int(addr) >= PatternRAMSize {
		return 0
	}
	return e.pattern[addr]
}

// RenderScanline writes the sprite layer's contribution to one
// row of the active display region. dst is Width bytes of
// palette indices; the function overwrites pixels that any
// visible sprite covers (excluding transparency: raw pattern
// value == the NR$4B transparency colour). dst must already hold
// the "below-sprite" content; callers distinguish covered pixels
// via LineCoverage, since palette index 0 is a drawable colour.
//
// Supports 4bpp/8bpp patterns, scale, mirror, rotate, collision
// detection, anchor/relative sprites, the 9-bit X wrap onto the left
// edge and the per-line render budget (sprites past the budget drop
// off the line and the $303B bit-1 flag latches).
//
// y is the display-scanline-index (0..191 for the active region).
// Width is exposed as a parameter to avoid coupling to the
// compositor's constants.
func (e *Engine) RenderScanline(y int, dst []byte, width int) {
	if !e.enabled {
		return
	}
	// Reset the per-line coverage map (collision detection + the
	// compositor's LineCoverage view) BEFORE any early return, so a
	// clipped-out row reports no coverage rather than the previous
	// line's. The collided flag itself is sticky across the frame until
	// the status port reads it.
	if cap(e.lineCovered) < width {
		e.lineCovered = make([]bool, width)
	}
	e.lineCovered = e.lineCovered[:width]
	for i := range e.lineCovered {
		e.lineCovered[i] = false
	}
	// Sprite clip window (NextReg $19), resolved through the over-border /
	// border-clip mode (NR$15 bits 1/5; sprites.vhd:1043-1066). With
	// over-border OFF the window is shifted into the paper area, so the whole
	// top-border band (Y<32 of the 320x256 frame) is hidden. The extra
	// "y<224" gate matches the FPGA's (over_border or vcounter<224) term.
	clipXs, clipXe := 0, width-1
	if e.clipSet {
		xs, xe, ys, ye := e.effectiveClip()
		if y < ys || y > ye || (!e.overBorder && y >= 224) {
			return
		}
		clipXs, clipXe = xs, xe
	}
	// Per-line render budget (the "max sprites per line" bandwidth
	// limit). The FPGA renders a line's sprites during exactly one
	// raster line: the FSM restarts at line reset (whc wrap,
	// sprites.vhd:518/831) and one line is 448 7MHz counts
	// (zxula_timing.vhd whc: -16..431) = 1792 cycles of the 28MHz
	// clock_master the FSM steps on. Costs: 1 cycle per sprite
	// qualified (S_QUALIFY), 1 per rendered pixel column (S_PROCESS)
	// — matching the upstream ScanlineDelay ReadMe's "about 1600+
	// pixels per line available" (1792 - 128 qualifies). When the
	// budget runs out mid-list, rendering stops (later sprites drop
	// off that line) and the $303B bit-1 flag latches
	// (sprites.vhd:977 sprites_overtime).
	const renderCyclesPerLine = 448 * 4
	cycles := 1 // S_START
	var anchor anchorState
	for i := 0; i < MaxSprites; i++ {
		if cycles >= renderCyclesPerLine {
			e.overtime = true
			return
		}
		cycles++ // S_QUALIFY
		raw := &e.attrs[i]
		a := raw
		// Anchor / relative sprites (FPGA sprites.vhd:756-944): a sprite
		// with the 5th byte present and byte-4 bits 7:6 == "01" is a
		// RELATIVE sprite, positioned (and optionally scaled/mirrored)
		// against the most-recent non-relative "anchor" sprite. Every
		// non-relative sprite updates the anchor state; relative sprites
		// resolve to a synthetic Attr so the render body is unchanged.
		if raw.Extended && raw.Byte4&0xC0 == 0x40 {
			eff := resolveRelative(raw, &anchor)
			a = &eff
		} else {
			latchAnchor(&anchor, raw)
		}
		if !a.Visible {
			continue
		}
		// Effective byte-4 fields, used only when Extended (attribute
		// byte 3 bit 6), per FPGA sprites.vhd:437.
		scaleX, scaleY := 1, 1
		slot := int(a.Pattern) & 0x3F // 256-byte pattern slot (0-63)
		sy := int(a.Y)
		// A sprite is 8bpp by default. 4bpp requires the 5th attribute byte
		// (byte 3 bit 6 set) with byte 4 bit 7 set — FPGA sprites.vhd:437,931
		// gate the 4-bit "H" on attr_4(7) AND attr_3(6). So a 4-byte
		// (non-extended) sprite is always 8bpp.
		eightBit := true
		n6 := false
		if a.Extended {
			scaleX = 1 << ((a.Byte4 >> 3) & 0x03) // bits 4:3: 1/2/4/8×
			scaleY = 1 << ((a.Byte4 >> 1) & 0x03) // bits 2:1
			n6 = a.Byte4&0x40 != 0                // bit 6: selects the 128-byte half of a 4bpp slot
			if a.Byte4&0x01 != 0 {                // bit 0: Y MSB
				sy |= 0x100
			}
			eightBit = a.Byte4&0x80 == 0 // bit 7 clear → 8bpp pattern
		}
		// Vertical clip: the sprite covers sy .. sy+16*scaleY-1.
		sizeY := SpriteSize * scaleY
		if y < sy || y >= sy+sizeY {
			continue
		}
		row := (y - sy) / scaleY
		// Sprite pattern RAM is 64 slots × 256 bytes. An 8bpp sprite uses a
		// full 256-byte slot (16 rows × 16 bytes, 1 px/byte). A 4bpp sprite
		// uses one 128-byte half of the slot (16 rows × 8 bytes, 2 px/byte),
		// selected by N6 (byte4 bit6). This matches the port $303B/$5B upload
		// addressing: cursor = slot*256 + half*128.
		base := slot * 256
		span := 256
		if !eightBit {
			span = 128
			if n6 {
				base += 128
			}
		}
		if base+span > PatternRAMSize {
			continue
		}
		// Effective X mirror = X-mirror XOR rotate (a rotation inverts
		// the X mirror), per FPGA sprites.vhd:813.
		xMirrorEff := a.XMirror != a.Rotate
		sizeX := SpriteSize * scaleX
		// The FSM's off-right-edge exit term (sprites.vhd:855): hcount is
		// 9-bit, so a sprite whose X sits in the top of the range wraps
		// through 511 onto the left edge — the mask admits the last
		// sizeX-aligned block (496+ at 1x, 480+ at 2x, ...). Outside that
		// block an invalid hcount ends the sprite.
		wrapMask := 0x1F &^ (scaleX - 1)
		for dx := 0; dx < sizeX; dx++ {
			if cycles >= renderCyclesPerLine {
				e.overtime = true
				return
			}
			cycles++ // S_PROCESS: one cycle per pixel column
			sx := (int(a.X) + dx) & 0x1FF
			if sx >= 320 {
				if (sx>>4)&wrapMask != wrapMask {
					break // off the right edge, no wrap possible: FSM exits
				}
				continue // wrap-through region: cycles spent, nothing shown
			}
			if sx >= width {
				continue // caller's buffer is narrower than the 320 frame
			}
			// Sprite clip window X bounds, resolved through the over-border
			// mode (clipXs..clipXe computed once above).
			if e.clipSet && (sx < clipXs || sx > clipXe) {
				continue
			}
			col := dx / scaleX
			// Transform (col,row) into the pattern coordinate (tc,tr):
			// mirror inverts the axis, rotate swaps X and Y.
			tc, tr := col, row
			if xMirrorEff {
				tc = (SpriteSize - 1) - tc
			}
			if a.YMirror {
				tr = (SpriteSize - 1) - tr
			}
			if a.Rotate {
				tc, tr = tr, tc
			}
			// Palette index per FPGA sprites.vhd:968. 4bpp: the 4-bit
			// palette offset is the high nibble (offset<<4 | pixel).
			// 8bpp: the offset is added to the byte's high nibble.
			// Transparency compares the RAW pattern value (pre-offset)
			// against NR$4B — full byte for 8bpp, low nibble for 4bpp
			// (sprites.vhd:971).
			if eightBit {
				idx := e.pattern[base+tr*16+tc]
				if idx == e.transpColour {
					continue // transparent
				}
				// zero-on-top (NR$15 bit 6): a pixel already painted by a
				// lower-numbered sprite this line is locked in (sprites.vhd:73).
				if !e.zeroOnTop || !e.lineCovered[sx] {
					dst[sx] = byte((int(idx) + (int(a.Palette) << 4)) & 0xFF)
				}
				e.cover(sx)
			} else {
				pix := e.pattern[base+tr*8+(tc>>1)]
				var idx byte
				if tc&1 == 0 {
					idx = pix >> 4
				} else {
					idx = pix & 0x0F
				}
				if idx == e.transpColour&0x0F {
					continue // transparent
				}
				if !e.zeroOnTop || !e.lineCovered[sx] {
					dst[sx] = (a.Palette << 4) | idx
				}
				e.cover(sx)
			}
		}
	}
}
