package debugger

// Core provider types shared by the fyne debugger GUI (!js files), the
// telnet debug commands in cmd/zx_go, and the wasm build. Keep this
// file free of fyne widget imports so the js build links without the
// GUI stack.

import (
	"image"
	"image/color"
)

// NextProvider exposes Spectrum Next state the debugger should
// show alongside CPU registers. The cmd/zx_go GUI wires this in
// when ModelNext is active; classic emulators leave it nil and
// the Next panel stays hidden.
type NextProvider interface {
	// MMUSlots returns the bank index visible in each of the 8K
	// MMU slots. The Z80 has 8 slots of 8 KB; -1 marks "ROM" or
	// "unmapped".
	MMUSlots() [8]int
	// DivMMCState returns a one-line summary of the divMMC pager
	// state: paged-in, MAPRAM, selected bank, automap on/off.
	DivMMCState() string
	// NextRegs returns a snapshot of NextReg values for the
	// registers listed in NextRegsOfInterest(). The map is keyed
	// by NextReg number.
	NextRegs() map[uint8]byte
}

// PaletteRGBAProvider is an OPTIONAL companion to NextProvider: a
// provider that also implements it feeds the graphical Palette tab.
// SetNextProvider type-asserts for it, so providers that don't supply
// palette colours simply leave the swatch all-black (non-breaking).
type PaletteRGBAProvider interface {
	// PaletteRGBA returns the 256 active palette entries as
	// fully-expanded 8-bit-per-channel RGBA.
	PaletteRGBA() [256]color.RGBA
}

// Layer2FrameProvider is an OPTIONAL companion that feeds the Layer-2
// framebuffer viewer: the live Layer-2 image plus a status string
// (e.g. "256x192" or "disabled"). img may be nil when unavailable.
type Layer2FrameProvider interface {
	Layer2Frame() (img image.Image, status string)
}

// TilemapFrameProvider is an OPTIONAL companion that feeds the tilemap
// viewer: the rendered tilemap image plus a status string.
type TilemapFrameProvider interface {
	TilemapFrame() (img image.Image, status string)
}

// NextRegsOfInterest is the fixed set of NextReg numbers the
// debugger panel displays. Picked for boot-debugging value:
//
//	0x00 machine ID
//	0x01 version
//	0x02 reset reason / state
//	0x07 turbo control
//	0x08 peripheral 1
//	0x09 peripheral 4
//	0x0A peripheral 5
//	0x14 transparency colour
//	0x15 sprite & Layers system
//	0x18 Layer 2 control
//	0x19 sprite control
//	0x43 palette control
//	0x50..0x57 MMU slots
//	0x69 Layer 2 + ULA enables
//	0x6B tilemap control
//	0x80..0x87 internal port decode flags
//	0xB8 divMMC enable / automap mask
var NextRegsOfInterest = []uint8{
	0x00, 0x01, 0x02, 0x07, 0x08, 0x09, 0x0A, 0x14, 0x15, 0x18, 0x19,
	0x43, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57,
	0x69, 0x6B, 0x80, 0x82, 0x83, 0x84, 0x85, 0xB8,
}

// SpriteSnapshot is one visible sprite, pre-resolved to RGBA pixels by
// the provider (so the widget needn't know 4bpp/palette internals).
type SpriteSnapshot struct {
	Index  int
	Pixels [SpritePixels]color.RGBA // row-major 16×16
}

// SpriteVizProvider is the OPTIONAL companion interface that feeds the
// graphical Sprite viewer. A NextProvider implementing it supplies the
// currently-visible sprites' resolved pixels.
type SpriteVizProvider interface {
	VisibleSprites() []SpriteSnapshot
}

// TTRow is one time-travel snapshot, flattened for display.
type TTRow struct {
	Insn  uint64
	PC    uint16
	Label string
}

// TimeTravelController is the backend the TimeTravelWidget drives.
// cmd/zx_go implements it over the emulator-owned snapshot ring, so
// the GUI tab and the telnet `tt-*` commands operate on the SAME
// buffer.
type TimeTravelController interface {
	Enabled() bool
	Enable(everyInsns, keep int)
	Disable()
	Snap(label string)
	Rewind(insn uint64) error
	Clear()
	Rows() []TTRow
}
