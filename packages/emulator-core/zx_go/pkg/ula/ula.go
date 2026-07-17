package ula

import (
	"image"
	"image/color"
	"log"
	"sync/atomic"

	"github.com/conorarmstrong/zx_go/pkg/audio"
	"github.com/conorarmstrong/zx_go/pkg/ay"
	"github.com/conorarmstrong/zx_go/pkg/keyboard"
	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/next/lores"
	"github.com/conorarmstrong/zx_go/pkg/peripherals"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// Display constants
const (
	ScreenWidth  = 256                        // Spectrum screen width in pixels
	ScreenHeight = 192                        // Spectrum screen height in pixels
	BorderLeft   = 32                         // Left border width in pixels
	BorderTop    = 24                         // Classic top border height in pixels
	TotalWidth   = ScreenWidth + BorderLeft*2 // 320
	TotalHeight  = ScreenHeight + BorderTop*2 // 240 (classic frame)
	FlashFrames  = 16                         // Number of frames between flash toggles

	// The Spectrum Next composites into the FPGA's 320×256 wide frame:
	// sprites, the tilemap and Layer 2's wide modes all consume the same
	// whc/wvc counters (zxnext.vhd:4208/4337/4389 ← zxula_timing.vhd
	// o_whc/o_wvc), one coordinate system with (0,0) at the top-left of a
	// 32-px border ring and the classic paper at (32,32). The ULA switches
	// to this geometry when a Next compositor is wired (SetNextCompositor).
	NextBorderTop   = 32                             // Next top/bottom border height
	NextTotalHeight = ScreenHeight + NextBorderTop*2 // 256 (Next wide frame)
	MaxTotalHeight  = NextTotalHeight                // array-sizing bound
)

// TStatesPerLine is the number of T-states per scanline. 228 is the 128K
// family value (456 video columns / 2). The 48K ULA uses 224 (448 / 2); see
// TStatesPerLineFor. This default is retained for the 128K-anchored callers
// (BeamPosition / ActiveVideoLine on the Next, which boots in 128K timing).
const TStatesPerLine = 228

// TStatesPerLineFor returns the documented T-states-per-scanline for a machine
// model: 224 for the 48K (312 lines * 224 = 69888 T-states/frame), 228 for the
// 128K family and +2/+2A/+3 (311 lines * 228 = 70908). The Spectrum Next boots
// in 128K/+3 timing. Matches video/zxula_timing.vhd c_max_hc: 48K=447 (448
// columns → 224 T) and 128K=455 (456 columns → 228 T), and Sean Young's /
// Chris Smith's classic timing references.
func TStatesPerLineFor(model roms.SpectrumModel) int {
	if model == roms.Model48K {
		return 224
	}
	return 228
}

// ULA represents the Uncommitted Logic Array, handling video, sound, and keyboard.
type ULA struct {
	mem         *memory.Memory
	kbd         *keyboard.Keyboard
	audio       *audio.AudioSystem
	ay          *ay.AY
	peripherals *peripherals.PeripheralManager
	img         *image.RGBA
	// borderTop / totalHeight are the frame's vertical geometry: the
	// classic 24/240 until a Next compositor is wired, then the FPGA's
	// 32/256 wide frame (see the NextBorderTop constants). img row r is
	// frame row r; the paper starts at (BorderLeft, borderTop). All
	// render paths use these, never the constants, so the two frames
	// coexist without bias arithmetic.
	borderTop   int
	totalHeight int
	// wideImg / wideRow are reused across frames for the 640-pixel
	// 80-column tilemap path (renderWide), so it doesn't allocate a
	// ~600 KB image every frame in the GUI's 50 Hz render loop.
	wideImg *image.RGBA
	wideRow []byte
	// compositorScan / compositorComposed are reused across frames as the
	// per-row scratch buffers for the Spectrum Next inner-screen compositor
	// pass (applyNextCompositor), and compositorRow likewise for its
	// border-area tilemap and sprite passes (run sequentially, so the one
	// buffer serves both), avoiding a heap allocation on every row pass of
	// every frame.
	compositorScan     []byte
	compositorComposed []byte
	compositorRow      []byte
	palette            [16]color.RGBA
	// borderTracer, if non-nil, fires on every border-colour change
	// caused by an even-port write. Used by the debugger to observe
	// border modulation through any port that matches the ULA's
	// "even-address" decode (not just $FE), which a port-tracer
	// keyed by port number can miss.
	borderTracer func(port uint16, val byte, newBorder byte, scanline int)
	flash        bool
	flashCount   int

	// timexVideoMode is the last value written to the Timex SCLD register
	// (port $FF): bits 2:0 = display mode (110 = 512x192 8x1 hi-res), bits 5:3
	// = hi-res ink/paper colour. 0 (the reset default) is the normal screen.
	// Bit 6 is the ULA frame-INT disable latch — this byte IS the FPGA's
	// port_ff_reg (zxnext.vhd:3609-3635), shared by three writers: a port
	// $FF write (full byte), NR$69 (bits 5:0 only) and NR$22 bit 2 /
	// NR$C4 bit 0 inverted (bit 6 only, via SetULAFrameIntDisable).
	timexVideoMode byte
	// frameIntDisableSink, when wired (ModelNext via pkg/next.Wire),
	// receives every change to the bit-6 latch so the CPU's frame-INT
	// generator mirror stays current. Nil on classic models: a plain
	// 48K/128K has no SCLD, so port $FF bit 6 must not gate its INT.
	frameIntDisableSink func(bool)
	// timexModeChanged flags any CHANGE to the Timex mode since the last
	// executed frame's render (CPU port/NR$69 writes between renders, or
	// copper writes during the compose walk). timexMixedFrame latches it
	// per executed frame: a frame whose Timex mode changed mid-frame
	// (the NReg0x69 copper bands) renders through the 320 path with
	// per-row decimated hi-res, while a STABLE hi-res frame renders the
	// native 512-wide composite (renderWideTimexHiRes).
	timexModeChanged bool
	timexMixedFrame  bool

	// ULANext attribute-decode state (Spectrum Next only), pushed by the
	// NextReg wiring: NR$43 bit 0 enables ULANext, NR$42 is the ink
	// colour mask. Consumed by the live-palette row render
	// (renderNextULARow, per video/zxula.vhd:483-558).
	ulaNextEnabled bool
	ulaNextFormat  byte

	// ULA+ (ports $BF3B/$FF3B, zxnext.vhd:4525-4583): the register
	// port's group select + palette index, the live enable latch
	// (shared with NR$68 bit 3), and the palette access closures the
	// wiring installs (SetULAPlusPaletteAccess).
	ulaPlusEnabled bool
	ulapMode       byte
	ulapIndex      byte
	ulapWrite      func(second bool, index byte, value uint16)
	ulapRead       func(second bool, index byte) uint16

	// ulaPalSecond mirrors NR$43 bit 1 — which ULA palette (first or
	// second) the display resolves through. Kept here (not just in the
	// palette bank) so mid-frame flips raster-stamp like border changes.
	ulaPalSecond bool

	// ULA hardware scroll (NR$26 X / NR$27 Y, zxnext.vhd:5304-5307) and
	// the NR$68 bit 2 fine-scroll-X half-pixel bit. Applied by
	// renderNextULARow per video/zxula.vhd:192-208 (py = vc + scroll_y
	// folded mod 192) and :199 (px = char column + scroll_x, sub-char
	// bits from scroll_x with the neighbour char fetched mod 32 — i.e.
	// source x = (x + scroll_x) mod 256). The fine bit is a HALF-pixel
	// shift on the 14 MHz video bus — below this renderer's 7 MHz pixel
	// resolution, so it is stored but not rendered (known-gaps.md).
	ulaScrollX, ulaScrollY byte
	ulaFineScrollX         bool

	// layerControl is the live raw NR$15 byte (see ulaVideoState.nr15).
	layerControl byte

	// LoRes/Radastan layer state (pkg/next/lores): enable is NR$15 bit 7
	// (carried raster-stamped in ulaVideoState.nr15); NR$6A mode /
	// dfile-xor / palette-offset, NR$32/$33 scroll. While enabled, the
	// LoRes pixel replaces the classic ULA pixel inside the shared NR$1A
	// clip window (zxnext.vhd:6980).
	loresRadastan      bool
	loresRadastanXor   bool
	loresPaletteOffset byte
	loresScrollX       byte
	loresScrollY       byte

	// ULA clip window (NR$1A, zxula.vhd:562): paper pixels outside the
	// inclusive [x1,x2]×[y1,y2] display-space window are transparent
	// (lower layers / NR$4A fallback show). The border is never clipped.
	ulaClipX1, ulaClipX2, ulaClipY1, ulaClipY2 byte

	// ulaVideoChanges raster-stamps mid-frame changes to the ULANext
	// decode state / displayed-palette select, the same machinery as
	// borderChanges: Render folds them into the per-display-line
	// ulaVideoLine map that the Next render passes consume. The
	// MrKWatkins ULA/ClassicPaletized test flips the displayed ULA
	// palette at mid-screen by CPU raster timing — without the stamp
	// the whole frame rendered through the frame-final palette.
	ulaVideoChanges    []ulaVideoChange
	frameStartULAVideo ulaVideoState
	ulaVideoLine       [MaxTotalHeight]ulaVideoState

	// lastRenderRefT detects a back-to-back Render with no CPU execution
	// in between (the harness's screenshot path) so the raster maps built
	// from the executed frame's change lists are kept instead of being
	// rebuilt as uniform live state. See the `stale` logic in Render.
	lastRenderRefT    uint64
	lastRenderRefSeen bool

	// borderLineColours is the per-display-line border colour map built by
	// Render each frame (port-$FE change list applied). Kept on the ULA so
	// the Next compositor pass can re-resolve border pixels through the
	// live ULA palette per row.
	borderLineColours [MaxTotalHeight]byte

	// Port 0xFE state
	BorderColour byte
	Mic          bool
	TapeIn       bool
	// lastTapeTstate is the monotonic reference T-state (refNow: 3.5 MHz-
	// equivalent) at which the tape was last advanced. The tape is driven from
	// each port-$FE read (tapeLevel), so the EAR bit reflects the live tape
	// level at microsecond resolution — which is what edge-timed ROM and
	// custom (turbo) loaders sample. (The old once-per-frame Update froze the
	// level for a whole 69888-T frame, so custom loaders saw no pulses and
	// never loaded.)
	lastTapeTstate uint64
	// Tape-loading sound: EAR-level transitions recorded during the frame so
	// flushAudioFrame can reconstruct the audible loading tone (the pilot
	// whistle + data screech) and mix it into the output — as a real 48K does
	// through the beeper and a 128K through the TV. Only recorded while the
	// tape is playing.
	tapeAudioEvents     []audioEvent
	frameStartTapeState bool
	Speaker             bool

	// Kempston joystick state (port 0x1F).
	// Bit 0: Right, Bit 1: Left, Bit 2: Down, Bit 3: Up, Bit 4: Fire.
	// A bit is 1 when the corresponding direction/fire is active.
	KempstonEnabled bool
	KempstonState   byte

	// ulaOutputDisabled mirrors NextReg $68 bit 7 ("Disable ULA output").
	// When set the ULA layer paints nothing — the screen area shows the
	// lower layers (Layer 2 / Tilemap) or the NR$4A fallback colour, never
	// stale screen RAM. Sonic disables the ULA for its Layer-2/tilemap
	// title; without honouring this, stale screen RAM rendered as garbage.
	ulaOutputDisabled bool

	// Mid-frame border tracking: records (scanline, colour) pairs for each border change.
	// Allows accurate rendering of border effects that change colour during the frame.
	borderChanges []borderChange
	// frameStartBorderColour is the border colour in effect at the start of
	// the frame currently being built, i.e. before any of this frame's port
	// 0xFE writes. BorderColour itself is mutated live by WritePort as the
	// CPU runs, so by the time Render() runs it already holds this frame's
	// latest value — Render uses frameStartBorderColour, not BorderColour,
	// as the baseline for scanlines before the first recorded change.
	frameStartBorderColour byte

	// Beeper audio event recording. Each port-0xFE write that flips
	// bit 4 appends an (offset, state) tuple here. Render() walks the
	// list at end of frame to synthesise audio samples and pushes
	// them to the audio system. Reset at start of every frame.
	audioEvents      []audioEvent
	frameStartTstate uint64
	// frameStartRefTstate is frameStartTstate's counterpart on the 3.5 MHz-
	// reference timeline (refNow); audio/tape event offsets are measured
	// against it so mid-frame turbo changes can't misplace them.
	frameStartRefTstate uint64
	// LastAudioEventCount is how many speaker toggles the previous frame
	// recorded — a diagnostic for audio-silence investigations.
	LastAudioEventCount    int
	frameStartSpeakerState bool

	// dc models the capacitor-coupled audio output: it high-pass-filters the
	// per-frame mix so a held speaker level decays to silence instead of
	// sitting at a full-scale DC rail (which made power-on/reset/tape
	// boundaries click like a speaker wired to a battery). dcEnabled allows
	// disabling it (A/B diagnostics) — when off, the raw ±beeper levels are
	// emitted (faithful square waves, but the idle DC rail/click returns).
	dc        dcBlocker
	dcEnabled bool

	// fastLoad, when set, mutes audio output: during fast-tape turbo many
	// emulated frames collapse into one audio frame, so the reconstructed
	// loading sound is garbled. Silence is emitted instead.
	fastLoad bool

	// lastFlushFEReads snapshots feReadCount at each audio-frame flush so
	// flushAudioFrame can rate-gate the audible tape mix (see there).
	lastFlushFEReads uint64

	// feReadCount is a monotonic count of port-$FE reads, used to detect
	// active tape loading by its read rate (see ReadPort).
	feReadCount uint64

	// Tape loading state
	tape *TapePlayer

	// RZX playback/recording hooks. The RZX driver installs these
	// to intercept IN-port traffic: the playback hook substitutes
	// the recorded byte (skipping the real peripheral path), the
	// record hook logs the byte the peripherals returned. At most
	// one of the two should be set at a time — playback and
	// recording are mutually exclusive in FUSE (rzx.c:164, 278).
	//
	// Stored as atomic.Pointer because the UI thread installs and
	// clears them while the emulation goroutine reads them in
	// ReadPort — a plain func field would race.
	rzxPlaybackHook atomic.Pointer[func() (byte, bool)]
	rzxRecordHook   atomic.Pointer[func(byte)]

	// nextRegs forwards port 0x243B / 0x253B traffic to the
	// Spectrum Next NextReg dispatcher when one has been wired
	// (ModelNext only). Stays nil on other models; the ports
	// then fall through to the existing floating-bus dispatch.
	nextRegs NextRegAccess

	// nextAY is the Spectrum Next's three-chip AY engine when
	// wired. When non-nil, port 0xFFFD / 0xBFFD traffic routes
	// to engine.Active() instead of the singleton u.ay. Stays
	// nil on every other model.
	nextAY *ay.Engine

	// nextCompositor blends Layer 2 (and, later, Tilemap and
	// Sprites) over the ULA's rendered framebuffer at the end
	// of each frame. Wired by the ModelNext bus during
	// construction; nil on every other model.
	nextCompositor NextCompositor

	// nextI2C receives port $103B/$113B SCL/SDA bit-bang traffic
	// (the DS1307 RTC bus). nil on classic models.
	nextI2C NextI2C
	// nextDMA receives port 0x6B / 0x0B traffic (zxnDMA command
	// stream; $0B is the Zilog-compat decode). Wired only for
	// ModelNext.
	nextDMA NextDMA

	// nextCTC receives the CTC channel ports — a(15:11)="00011"
	// with low byte $3B ($183B-$1F3B, channel = a(10:8);
	// zxnext.vhd:2690). Wired only for ModelNext.
	nextCTC NextCTC

	// nextUART receives the UART ports $133B/$143B/$153B/$163B
	// (zxnext.vhd:2639). Wired only for ModelNext.
	nextUART NextUART

	// nextSprite receives port $303B traffic: a write selects the
	// active sprite, a read returns the sprite status (collision /
	// max-per-line, clear-on-read). Wired only for ModelNext.
	nextSprite NextSpritePort

	// nextCopper is ticked once per active scanline during the
	// post-render compositor pass. nil on non-Next models.
	nextCopper NextCopper

	// nextDAC receives the four DAC channel port writes. Decoded
	// on low byte only — channels A/B/C/D map to several alias
	// ports per the SpecNext wiki. Wired only for ModelNext.
	nextDAC NextDAC

	// nextDivMMC receives port 0xE3 writes (divMMC control:
	// CONMEM / MAPRAM / bank-select). Wired only for ModelNext.
	nextDivMMC NextDivMMC

	// speccyDAC is the classic-Spectrum 8-bit DAC pair (SpecDrum on $DF,
	// Covox on $FB). Wired on classic models when the user enables either
	// peripheral; nil otherwise. Its writes are recorded with T-state offsets
	// and mixed into the beeper output at end-of-frame.
	speccyDAC SpeccyDAC

	// beta is the Beta Disk / TR-DOS interface, wired on classic models when a
	// disk is mounted; nil otherwise. Its ports are decoded only while the
	// TR-DOS ROM is paged in (mem.IsBetaActive).
	beta BetaDisk

	// portTracer, when non-nil, fires after every port read or
	// write that completes through WritePort / ReadPort. Set via
	// SetPortTracer; nil at the zero value so the trace path is
	// one nil-check per access when disabled.
	portTracer PortTracer
}

// PortTracer is the callback signature for ULA port I/O tracing.
// The handled flag indicates whether the ULA produced a value
// (true) or fell through to floating-bus / open-bus (false).
type PortTracer func(addr uint16, val byte, write, handled bool)

// NextCompositor is the contract the ULA uses to ask the
// Spectrum Next render stack for a composited scanline. The only
// implementation today is pkg/next/compositor.Compositor; the
// interface lives in pkg/ula so the package doesn't have to
// import pkg/next/compositor (which would invite a cycle once
// the compositor needs to pull in more pkg/ula state, e.g. for a
// sprite bandwidth model).
type NextCompositor interface {
	ComposeScanline(y int, ulaRGBA []byte, dst []byte)
	// HasActiveTilemap reports whether the compositor has a
	// tilemap layer wired AND enabled. ULA uses this to decide
	// whether to run the border-area pass for Layer-3 content
	// that extends beyond the classic 256-wide inner screen.
	HasActiveTilemap() bool
	// ComposeBorderRow paints tilemap content over the border
	// pixels of a 320-wide RGBA row. tilemapY is the row index
	// within the tilemap (0 = top of the full 320×256 Next
	// display). isInBorderArea(x) returns true for x values
	// outside the classic 256-wide inner screen; those are the
	// pixels the border pass paints, leaving inner pixels
	// untouched.
	ComposeBorderRow(tilemapY int, dst []byte, isInBorderArea func(x int) bool)
	// HasActiveSprites reports whether the sprite layer is wired AND
	// enabled, so the ULA knows whether to run the sprite border pass.
	HasActiveSprites() bool
	// ComposeSpriteBorderRow paints sprite pixels over the border-area
	// pixels of a 320-wide RGBA row. frameY is the sprite vcounter for
	// this row (frame-relative); isInBorderArea(x) selects the pixels to
	// paint, leaving inner-screen pixels to the main pass.
	ComposeSpriteBorderRow(frameY int, dst []byte, isInBorderArea func(x int) bool)
	// TilemapIs80Col reports whether the tilemap is in 80-column
	// (640-pixel) mode. When true the ULA renders the wide path
	// (renderWide) and the 320-pixel passes above skip the tilemap.
	TilemapIs80Col() bool
	// ComposeWideTilemapRow composites the native 640-pixel tilemap
	// over dst, a 640-pixel RGBA row already holding the doubled lower
	// layers.
	ComposeWideTilemapRow(tilemapY int, dst []byte)
	// HiResLayer2Active reports whether Layer 2 is in a hi-res mode
	// (NR$70 resolution 1/2). When true the ULA renders the wide Layer 2
	// path (renderHiResLayer2) and the 256-wide pass skips Layer 2.
	HiResLayer2Active() bool
	// Layer2Width returns the active Layer 2 width (256/320/640).
	Layer2Width() int
	// ComposeWideLayer2Row overlays the hi-res Layer 2 row onto dst, an
	// RGBA row Layer2Width pixels wide already holding the lower layers.
	ComposeWideLayer2Row(y int, dst []byte)
	// OverpaintWideL2Row restores the layers the wide Layer 2 overlay
	// covered, in the active NR$15 order: sprites (non-L-topmost
	// modes) and the tilemap (the U-above-L modes) — the hi-res
	// Layer 2 path's layer-order repair. xScale is output pixels per
	// frame pixel (1 = 320, 2 = 640).
	OverpaintWideL2Row(frameY int, dst []byte, xScale int)
}

// NextSpritePort is the contract for port $303B: SelectSprite on a
// write (sets the active sprite index), ReadStatus on a read (sprite
// status — bit 0 collision, bit 1 max-per-line — clear-on-read).
// pkg/next/sprite.Engine satisfies it.
type NextSpritePort interface {
	SelectSprite(v byte)
	// SelectSlot applies a port $303B write: sets the current sprite and the
	// pattern-RAM upload cursor (ports.txt 0x303B).
	SelectSlot(v byte)
	// WritePatternByte streams one byte to the current sprite-pattern cursor
	// (port $005B, auto-incrementing).
	WritePatternByte(v byte)
	// WriteAttr streams one byte to the current sprite's attributes (port
	// $0057); after a sprite's 4/5 bytes the current-sprite pointer advances.
	WriteAttr(v byte)
	ReadStatus() byte
}

// NextDMA is the contract for ports 0x6B (zxnDMA mode) and 0x0B (Z80-DMA
// compatibility mode) — one controller behind both decodes
// (zxnext.vhd:2643). pkg/next/dma.DMA satisfies it: WriteCommand consumes
// the WR-register byte stream; ReadCommand returns the next register in
// the read-mask sequence (an IO read of the port); SetZilogMode latches
// which port the access used, as the FPGA does on every DMA read or write
// (zxnext.vhd:1811-1819).
type NextDMA interface {
	WriteCommand(val byte)
	ReadCommand() byte
	SetZilogMode(z bool)
}

// NextCTC is the Spectrum Next CTC block's port-facing contract:
// channel port writes (control word / time constant / vector) and
// reads (the live down-counter). ClaimsPort implements the FPGA's
// decode — a(15:11)="00011" and low byte $3B (zxnext.vhd:2690).
type NextCTC interface {
	ClaimsPort(addr uint16) bool
	WritePort(addr uint16, val byte)
	ReadPort(addr uint16) byte
}

// NextUART is the Spectrum Next UART's port-facing contract. The four
// ports $133B/$143B/$153B/$163B share one decode (zxnext.vhd:2639:
// a(15:11)="00010", a10 xor (a9 and a8) = '1', low byte $3B); the
// 2-bit register select is address bits 9:8 (uart.vhd:44 — "00" Rx,
// "01" select, "10" frame, "11" Tx/status). pkg/next/uart.UART
// satisfies it.
type NextUART interface {
	PortRead(reg byte) byte
	PortWrite(reg, val byte)
}

// uartClaims reports whether the Next UART claims IO address addr,
// per the FPGA decode above. Returns the 2-bit register select.
func (u *ULA) uartClaims(addr uint16) (byte, bool) {
	if u.nextUART == nil || addr&0xFF != 0x3B || addr&0xF800 != 0x1000 {
		return 0, false
	}
	a10 := addr >> 10 & 1
	a9 := addr >> 9 & 1
	a8 := addr >> 8 & 1
	if a10^(a9&a8) != 1 {
		return 0, false
	}
	return byte(addr >> 8 & 0x03), true
}

// dmaClaims reports whether the Spectrum Next DMA claims IO address addr
// (low byte 0x6B or 0x0B — both decoded on the low 8 bits only,
// zxnext.vhd:2544/2558), latching the controller's Zilog-compatibility
// mode from the port used before the access proceeds.
func (u *ULA) dmaClaims(addr uint16) bool {
	if u.nextDMA == nil {
		return false
	}
	switch addr & 0xFF {
	case 0x6B:
		u.nextDMA.SetZilogMode(false)
		return true
	case 0x0B:
		u.nextDMA.SetZilogMode(true)
		return true
	}
	return false
}

// NextI2C is the contract for the Spectrum Next's bit-banged i2c bus
// on ports $103B (SCL) and $113B (SDA) — zxnext.vhd:2630-2631 decode
// + :3234-3250 write latches. The DS1307 RTC slave lives behind it
// (pkg/next/rtc.Bus).
type NextI2C interface {
	WriteSCL(bit bool)
	WriteSDA(bit bool)
	ReadSDA() bool
}

// NextCopper is the contract the per-frame render loop uses to
// drive the Spectrum Next Copper coprocessor. pkg/next/copper.Copper
// satisfies it. The compositor calls Step once per active scanline
// so MOVEs that affect palette / Layer 2 state take effect before
// the row composites.
type NextCopper interface {
	Step(scanline uint16, hcount uint16, maxInstr int) int
}

// nextCopperCyclePaced is the optional cycle-paced copper contract
// (pkg/next/copper RunToCycle). When the wired NextCopper also satisfies
// it, the compositor pass interleaves copper execution with the ULA row
// render at per-pixel granularity — mid-scanline MOVEs (the upstream
// base/Copper test's Swedish flags) land on the right pixels instead of
// quantising to whole scanlines.
type nextCopperCyclePaced interface {
	RunToCycle(vcount uint16, cycle int)
}

// nextULAPaletteResolver is the optional compositor contract for resolving
// a ULA palette index (0..255) through the LIVE Next ULA palette, the way
// the FPGA feeds every ULA pixel through the palette SRAM. transparent
// reports whether the entry's 8-bit projection equals the NR$14 global
// transparency colour (a transparent ULA pixel lets lower layers / the
// NR$4A fallback show).
type nextULAPaletteResolver interface {
	ULARGBA(idx byte) (r, g, b byte, transparent bool)
}

// nextULAPaletteSelector is the optional compositor contract for switching
// which ULA palette (first/second) ULARGBA resolves through. Used by the
// applyNextCompositor replay of raster-stamped NR$43 bit-1 flips.
type nextULAPaletteSelector interface {
	SetULAActivePalette(second bool)
}

// nextPaletteReplay is the optional compositor contract for the raster-
// stamped palette-CONTENT replay: applyNextCompositor brackets its row
// walk with Begin/End (which also suspends the bank's write logging so
// render-time copper writes are never logged), steps ReplayPaletteThrough
// per row, and rewinds once for the top-border pass whose rows scanned
// before the paper. Satisfied by pkg/next/compositor, which delegates to
// palette.Bank's stamped-write log. Begin's stale flag marks a re-render
// with no CPU execution since the last one (the harness screenshot
// path): the retained log replays identically instead of the walk
// erasing the raster-timed recolours with the end-of-frame state.
type nextPaletteReplay interface {
	BeginPaletteReplay(stale bool) bool
	ReplayPaletteThrough(line int)
	RewindPaletteReplay()
	EndPaletteReplay()
}

// nextTilemapScrollFold is the optional compositor extension for the
// raster-stamped tilemap scroll: Render opens the bracket (fold CPU
// stamps + start render-time capture), the compositor walk feeds
// per-row captures of copper scroll writes, and the deferred End
// re-enables CPU-write stamping after the wide passes.
type nextTilemapScrollFold interface {
	FoldTilemapScroll(stale bool)
	CaptureTilemapRowScroll(rasterLine int)
	EndTilemapScrollCapture()
}

// NextDAC is the contract for the four Spectrum Next DAC channels.
// pkg/next/dac.Bank satisfies it via WritePort (which returns
// "handled?" so the ULA's port dispatcher knows whether to fall
// through). The ULA forwards every port write to the DAC; the bank
// internally checks the low byte for one of the documented DAC
// ports and ignores everything else.
type NextDAC interface {
	WritePort(port uint16, val byte) bool
}

// SpeccyDAC is the contract for the classic-Spectrum SpecDrum/Covox 8-bit DAC.
// pkg/audiodac.DAC satisfies it. The ULA claims the device's ports, records
// each write with its T-state offset, and mixes a reconstructed frame into the
// beeper output.
type SpeccyDAC interface {
	Handles(low byte) bool
	Record(tstateOffset int, val byte)
	Enabled() bool
	GenerateFrame(samplesPerFrame, tstatesPerFrame int) []int16
}

// BetaDisk is the contract for the Beta Disk / TR-DOS interface.
// pkg/betadisk.Interface satisfies it. The ULA only routes I/O to it while the
// TR-DOS ROM is paged in (Memory.IsBetaActive) — so the Beta's $1F/$FF decode
// doesn't shadow the Kempston joystick / floating bus during ordinary games.
type BetaDisk interface {
	Handles(port uint16) bool
	ReadPort(port uint16) byte
	WritePort(port uint16, val byte)
}

// NextDivMMC is the contract for the divMMC control port (0xE3 on
// the low byte). pkg/next/divmmc.Pager satisfies it. NextZXOS's
// boot trampoline writes to 0xE3 to drop the divMMC overlay; its
// IRQ handler reads 0xE3 to capture the current state before
// modifying it. Without both directions wired the boot deadlocks.
type NextDivMMC interface {
	WritePort(port uint16, val byte) bool
	ReadPort(port uint16) (byte, bool)
}

// NextRegAccess is the contract the ULA uses to forward port 0x243B
// (select latch) and 0x253B (data port) traffic into the Spectrum
// Next register file.
//
// The interface is declared here rather than in pkg/next/nextregs
// because Go's preferred style is to define interfaces at the
// consumer site. The concrete type implementing it lives in
// pkg/next/nextregs; pkg/ula must NOT import that package, which
// would invite a cycle once the nextregs callbacks need to invoke
// other ULA-side state.
//
// On non-Next models nothing wires a NextRegAccess in, so the port
// dispatch falls through to the existing 0xFE / 0xFFFD / floating-
// bus paths exactly as before.
type NextRegAccess interface {
	Select(reg byte)
	Selected() byte
	WriteData(val byte)
	ReadData() byte
	// WriteReg writes directly to a register without disturbing
	// the current Selected() latch. Used by classic-port aliases
	// (port $123B → NR$69, etc.) where the legacy I/O point has
	// to drive the same backing state as the NextReg form.
	WriteReg(reg, val byte)
	ReadReg(reg byte) byte
}

// SetNextRegs installs the NextReg port handler. Called once during
// ModelNext construction; passing nil unhooks (useful for tests).
func (u *ULA) SetNextRegs(n NextRegAccess) { u.nextRegs = n }

// SetNextCompositor installs the Spectrum Next render stack's
// scanline compositor. Once installed, Render overlays the
// composited output on top of the 256x192 active display region,
// and the frame switches to the FPGA's 320×256 wide geometry
// (paper at 32,32 — see the NextBorderTop constants): sprites,
// tilemap and wide Layer 2 all share that one coordinate frame, so
// img row r IS frame row r with no bias arithmetic. Passing nil
// restores the plain-ULA render and the classic 320×240 frame.
func (u *ULA) SetNextCompositor(c NextCompositor) {
	u.nextCompositor = c
	bt, th := BorderTop, TotalHeight
	if c != nil {
		bt, th = NextBorderTop, NextTotalHeight
	}
	if th != u.totalHeight {
		u.borderTop, u.totalHeight = bt, th
		u.img = image.NewRGBA(image.Rect(0, 0, TotalWidth, th))
		// The wide scratch frame is height-dependent; drop it so the
		// wide paths reallocate at the new geometry.
		u.wideImg = nil
		u.wideRow = nil
	}
}

// Palette returns the ULA's 16-colour palette. The Next compositor uses it
// to resolve the ULA transparency colour: the classic ULA renders via this
// palette, so the global transparency NR$14 (when < 16) corresponds to
// u.palette[NR$14], which is the colour a transparent ULA pixel carries.
func (u *ULA) Palette() [16]color.RGBA { return u.palette }

// SetNextDMA installs the Spectrum Next zxnDMA controller. Port 0x6B /
// 0x0B writes are forwarded as command bytes (the port latching the
// controller's Zilog-compat mode). Passing nil unhooks.
func (u *ULA) SetNextDMA(d NextDMA) { u.nextDMA = d }

// SetNextCTC installs the Spectrum Next CTC block. Channel ports
// $183B-$1F3B (a(15:11)="00011", low byte $3B) route to it.
func (u *ULA) SetNextCTC(c NextCTC) { u.nextCTC = c }

// SetNextUART installs the Spectrum Next UART. Ports
// $133B/$143B/$153B/$163B (zxnext.vhd:2639) route to it.
func (u *ULA) SetNextUART(nu NextUART) { u.nextUART = nu }

// SetNextSpritePort installs the sprite engine's $303B select/status
// port handler. Passing nil unhooks.
func (u *ULA) SetNextSpritePort(s NextSpritePort) { u.nextSprite = s }

// SetNextI2C installs the Spectrum Next i2c bus (RTC at $68). Ports
// $103B / $113B dispatch to it when present.
func (u *ULA) SetNextI2C(b NextI2C) { u.nextI2C = b }

// SetNextCopper installs the Spectrum Next Copper coprocessor.
// The compositor pass calls Step once per active scanline so MOVEs
// affecting palette / Layer 2 state are visible to that row's
// composition. Passing nil unhooks.
func (u *ULA) SetNextCopper(c NextCopper) { u.nextCopper = c }

// SetNextDAC installs the Spectrum Next four-channel DAC bank.
// Port writes are forwarded to it after the NextRegs / DMA priority
// checks; the bank internally decodes whether the low byte is one
// of its channels. Passing nil unhooks both the port path and any
// previously-attached mixer source so switching back to a classic
// model silences the DAC cleanly.
//
// If the audio mixer has already been started (via EnableAudio),
// the bank is also wired into it so a runtime model switch picks
// up the DAC immediately without having to restart audio.
func (u *ULA) SetNextDAC(d NextDAC) {
	u.nextDAC = d
	// The Next DAC is mixed event-timed in flushAudioFrame (see its
	// GenerateFrame), not via the audio system's per-pull DACSource path.
}

// SetSpeccyDAC attaches the classic-Spectrum SpecDrum/Covox DAC. Unlike the
// Next DAC it is event-timed: the ULA records its writes with T-state offsets
// and mixes a reconstructed frame into the beeper at end-of-frame (see
// flushAudioFrame), so PCM playback is sample-accurate. Pass nil to detach.
func (u *ULA) SetSpeccyDAC(d SpeccyDAC) { u.speccyDAC = d }

// SetBetaDisk attaches (or, with nil, detaches) the Beta Disk / TR-DOS
// interface. Port I/O is gated on Memory.IsBetaActive so it only intercepts the
// $1F/$3F/$5F/$7F/$FF ports while the TR-DOS ROM is paged in.
func (u *ULA) SetBetaDisk(d BetaDisk) { u.beta = d }

// betaClaims reports whether the Beta interface should handle this port now:
// it must be wired, the TR-DOS ROM paged in, and the port one of its registers.
func (u *ULA) betaClaims(addr uint16) bool {
	return u.beta != nil && u.mem != nil && u.mem.IsBetaActive() && u.beta.Handles(addr)
}

// SetNextDivMMC installs the divMMC pager's port-write hook so
// OUT (0xE3) reaches it. The pager itself is also wired via the
// CPU M1 pre-fetch hook (for automap on trigger PCs) and via
// memory.PeripheralRead/Write (for the 0x0000-0x3FFF overlay).
func (u *ULA) SetNextDivMMC(d NextDivMMC) { u.nextDivMMC = d }

// NextDivMMC returns the currently-wired divMMC pager (nil if
// none). Exposed so tests and debug tools can poke at pager
// state without going through the port interface.
func (u *ULA) NextDivMMC() NextDivMMC { return u.nextDivMMC }

// SetPortTracer installs a per-access callback fired after every
// port read and write that completes through ReadPort / WritePort.
// Pass nil to disable. Used by the `--trace=ports` CLI path.
func (u *ULA) SetPortTracer(fn PortTracer) { u.portTracer = fn }

// GetPortTracer returns the currently-installed PortTracer (or
// nil). Used by chained-tracer patterns where a new caller wants
// to run alongside any pre-existing tracer without losing it.
func (u *ULA) GetPortTracer() PortTracer { return u.portTracer }

// SetNextAY installs the Spectrum Next's three-chip AY engine.
// When set, port 0xFFFD / 0xBFFD traffic dispatches to the
// currently-active chip per NextReg 0x06's chip-select. Passing
// nil restores the single-AY routing.
func (u *ULA) SetNextAY(e *ay.Engine) {
	u.nextAY = e
	// Route the engine into the audio mixer so its (TurboSound) chips are
	// actually heard. Without this the mixer kept pulling from the single
	// u.ay — a chip the Next's port writes never reach — so 128K/AY music was
	// silent on the Next. SetNextAY runs after EnableAudio during Next setup,
	// so this is where the swap has to happen.
	if u.audio != nil {
		if e != nil {
			u.audio.SetAY(e)
		} else if u.ay != nil {
			u.audio.SetAY(u.ay)
		}
	}
}

// activeAY returns the AY chip that should currently service port
// 0xFFFD / 0xBFFD traffic. On ModelNext with an Engine wired, this
// is engine.Active() — unless the engine is in disabled mode, in
// which case nil is returned and AY port writes are silently
// dropped (matching real hardware's "AY disabled" bit). On every
// other configuration it returns the singleton u.ay.
func (u *ULA) activeAY() *ay.AY {
	if u.nextAY != nil {
		if u.nextAY.Disabled() {
			return nil
		}
		return u.nextAY.Active()
	}
	return u.ay
}

type borderChange struct {
	scanline int
	colour   byte
}

// ulaVideoState is the raster-stampable slice of ULA-video decode state:
// the ULANext enable/format (NR$43 bit 0 / NR$42) and the displayed ULA
// palette select (NR$43 bit 1). One value applies per display line.
type ulaVideoState struct {
	ulaNextEnabled bool
	ulaNextFormat  byte
	ulaPalSecond   bool
	// nr15 is the raw NR$15 layer-control byte (raster-stamped like the
	// rest of this state): bits 4:2 the layer priority/blend mode, bit 7
	// the LoRes enable. The MrKWatkins LayersMixing tests rewrite it per
	// 32-line raster band from the CPU — each band must composite with
	// the mode active at its raster line, not the frame-final value.
	nr15 byte
	// ulaPlusEnabled is the live port_ff3b_ulap_en latch (port $FF3B
	// mode group bit 0 / NR$68 bit 3). ULANext wins when both are on
	// (zxula.vhd:483 `if i_ulanext_en … elsif i_ulap_en`).
	ulaPlusEnabled bool
}

// ulaVideoChange records a mid-frame ulaVideoState transition at the
// frame scanline it was written, borderChange-style.
type ulaVideoChange struct {
	scanline int
	state    ulaVideoState
}

// audioEvent records a single speaker-bit toggle within a frame, with
// the T-state offset (0..tstatesPerFrame) at which it happened.
type audioEvent struct {
	tstateOffset int
	state        bool
}

// New creates a new ULA instance.
func New(mem *memory.Memory, kbd *keyboard.Keyboard) *ULA {
	u := &ULA{
		mem:         mem,
		kbd:         kbd,
		borderTop:   BorderTop,
		totalHeight: TotalHeight,
		img:         image.NewRGBA(image.Rect(0, 0, TotalWidth, TotalHeight)),
		// ULA clip window reset default = the full paper
		// (zxnext.vhd:4971-4976 {00,FF,00,BF}); the NextReg wiring
		// re-pushes this, but a bare ULA must not clip anything.
		ulaClipX2: 0xFF,
		ulaClipY2: 0xBF,
	}
	// Bound the DC-blocked audio to the speaker's physical amplitude so an
	// isolated speaker toggle clicks at the level, not the high-pass's 2x
	// step-response overshoot.
	u.dc.limit = int32(beeperHigh)
	u.dcEnabled = true
	u.initPalette()

	// Audio initialization is deferred to EnableAudio() to avoid crashes
	// in headless/test environments where audio hardware is unavailable.

	// AY-3-8912 sound chip is fitted on every model except the original 48K.
	if mem.GetCurrentModel() != roms.Model48K {
		u.ay = ay.New()
	}

	return u
}

// AY returns the AY-3-8912 sound chip instance, or nil for models that do
// not have one (e.g. the 48K).
func (u *ULA) AY() *ay.AY {
	return u.ay
}

func (u *ULA) initPalette() {
	// Standard Spectrum palette (dark and bright versions)
	u.palette = [16]color.RGBA{
		// Dark
		{0, 0, 0, 255},       // Black
		{0, 0, 205, 255},     // Blue
		{205, 0, 0, 255},     // Red
		{205, 0, 205, 255},   // Magenta
		{0, 205, 0, 255},     // Green
		{0, 205, 205, 255},   // Cyan
		{205, 205, 0, 255},   // Yellow
		{205, 205, 205, 255}, // White
		// Bright
		{0, 0, 0, 255},       // Bright Black (same as dark)
		{0, 0, 255, 255},     // Bright Blue
		{255, 0, 0, 255},     // Bright Red
		{255, 0, 255, 255},   // Bright Magenta
		{0, 255, 0, 255},     // Bright Green
		{0, 255, 255, 255},   // Bright Cyan
		{255, 255, 0, 255},   // Bright Yellow
		{255, 255, 255, 255}, // Bright White
	}
}

// Render generates the current frame.
// SetBorderTracer installs a callback fired on every ULA border-
// colour change (whatever even-address port was used).
func (u *ULA) SetBorderTracer(fn func(port uint16, val byte, newBorder byte, scanline int)) {
	u.borderTracer = fn
}

// SetULAOutputDisabled mirrors NextReg $68 bit 7. When true the ULA layer is
// not painted (see Render). Idempotent and safe to call every frame.
func (u *ULA) SetULAOutputDisabled(disabled bool) { u.ulaOutputDisabled = disabled }

// SetULANext mirrors the ULANext attribute-decode state: NR$43 bit 0
// (enable) and NR$42 (ink colour mask). Pushed by the Next wiring
// (pkg/next.WirePalette). Mid-frame changes are raster-stamped so each
// display row renders with the state active at its raster line.
func (u *ULA) SetULANext(enabled bool, format byte) {
	if u.ulaNextEnabled == enabled && u.ulaNextFormat == format {
		return
	}
	u.ulaNextEnabled = enabled
	u.ulaNextFormat = format
	u.recordULAVideoChange()
}

// SetULAPlusEnabled sets the live ULA+ enable latch — the FPGA's
// port_ff3b_ulap_en, written by a port $FF3B mode-group write (bit 0,
// zxnext.vhd:4548-4549) AND by every NR$68 write (bit 3, :4550-4551),
// and read back at NR$68 bit 3 (:6093). Raster-stamped like the
// ULANext state so a mid-frame switch re-decodes from its raster line.
func (u *ULA) SetULAPlusEnabled(on bool) {
	if u.ulaPlusEnabled == on {
		return
	}
	u.ulaPlusEnabled = on
	u.recordULAVideoChange()
}

// ULAPlusEnabled returns the live ULA+ enable latch (for the NR$68
// bit 3 read composition).
func (u *ULA) ULAPlusEnabled() bool { return u.ulaPlusEnabled }

// SetULAPlusPaletteAccess installs the palette read/write closures the
// ULA+ data port uses. The FPGA routes $FF3B palette traffic through
// the NextReg palette stream as virtual register $FF (zxnext.vhd:4741/
// 4906) into ULA-palette entry 192+index, first/second selected by
// NR$43's write-select bit 2 (:6958). Wired by pkg/next.Wire against
// the palette bank; nil access degrades palette-group traffic to
// no-ops (reads 0).
func (u *ULA) SetULAPlusPaletteAccess(write func(second bool, index byte, value uint16), read func(second bool, index byte) uint16) {
	u.ulapWrite = write
	u.ulapRead = read
}

// ResetULAPlus restores the ULA+ port latches to their reset state
// (zxnext.vhd:4529-4530/:4547): mode group 0, index 0, enable off.
// Called from the NR$02 reset path.
func (u *ULA) ResetULAPlus() {
	u.ulapMode = 0
	u.ulapIndex = 0
	u.SetULAPlusEnabled(false)
}

// ulapSecond reports which ULA palette (first/second) the ULA+ data
// port targets: NR$43's palette-write-select bit 2 (zxnext.vhd:6958
// nr_palette_index_utm bit 8 = nr_43_palette_write_select(2)).
func (u *ULA) ulapSecond() bool {
	return u.nextRegs != nil && u.nextRegs.ReadReg(0x43)&0x40 != 0
}

// SetULAPaletteSecond mirrors NR$43 bit 1 — the displayed ULA palette.
// Raster-stamped like SetULANext: the MrKWatkins ULA/ClassicPaletized
// test flips it at mid-screen every frame, expecting the top half of
// the paper through the first palette and the bottom through the
// second. Satisfies pkg/next.ULAPaletteSelectSink.
func (u *ULA) SetULAPaletteSecond(second bool) {
	if u.ulaPalSecond == second {
		return
	}
	u.ulaPalSecond = second
	u.recordULAVideoChange()
}

// recordULAVideoChange appends the CURRENT live ulaVideoState to the
// frame's change log, stamped with the same scanline clock the border
// change list uses.
func (u *ULA) recordULAVideoChange() {
	scanline := 0
	if u.mem != nil && u.mem.TStates != nil {
		scanline = int(*u.mem.TStates) / TStatesPerLineFor(u.mem.GetCurrentModel())
	}
	u.ulaVideoChanges = append(u.ulaVideoChanges, ulaVideoChange{
		scanline: scanline,
		state:    u.liveULAVideoState(),
	})
}

// liveULAVideoState snapshots the current raster-stamped video state.
func (u *ULA) liveULAVideoState() ulaVideoState {
	return ulaVideoState{u.ulaNextEnabled, u.ulaNextFormat, u.ulaPalSecond, u.layerControl, u.ulaPlusEnabled}
}

// SetLayerControl mirrors the raw NR$15 layer-control byte (priority /
// blend mode bits 4:2, LoRes enable bit 7). Raster-stamped like the
// ULANext / displayed-palette state: the MrKWatkins LayersMixing tests
// rewrite NR$15 per 32-line raster band by CPU timing, so each band must
// composite with its own mode. Pushed by pkg/next.WireLayerPriority.
func (u *ULA) SetLayerControl(val byte) {
	if u.layerControl == val {
		return
	}
	u.layerControl = val
	u.recordULAVideoChange()
}

// SetULAScroll mirrors the NR$26/$27 ULA X/Y hardware scroll registers
// (zxnext.vhd:5304-5307). Pushed by pkg/next.WireULAControl; consumed
// by renderNextULARow. Satisfies part of pkg/next.ULAVideoSink.
func (u *ULA) SetULAScroll(x, y byte) {
	u.ulaScrollX = x
	u.ulaScrollY = y
}

// SetULAFineScrollX mirrors NR$68 bit 2, the ULA half-pixel X scroll
// (zxnext.vhd:5449). Stored only: the shift is half a 7 MHz pixel on
// the FPGA's 14 MHz video bus, below this renderer's resolution
// (catalogued in known-gaps.md).
func (u *ULA) SetULAFineScrollX(on bool) { u.ulaFineScrollX = on }

// SetULAClipWindow mirrors the NR$1A ULA clip window. Coordinates are
// display-space paper pixels, inclusive on all four edges
// (zxula.vhd:562); the border is never clipped. Pushed by
// pkg/next.WireClipWindows.
func (u *ULA) SetULAClipWindow(x1, x2, y1, y2 byte) {
	u.ulaClipX1, u.ulaClipX2, u.ulaClipY1, u.ulaClipY2 = x1, x2, y1, y2
}

// SetTimexVideoMode mirrors NR$69 bits 5:0, the port-$FF Timex video
// mode alias (zxnext.vhd:3617-3618 — nr_69_we writes port_ff_reg(5:0)).
// Bits 7:6 of the live port-$FF state are preserved.
func (u *ULA) SetTimexVideoMode(v byte) {
	nv := u.timexVideoMode&0xC0 | v&0x3F
	if u.timexVideoMode != nv {
		u.timexModeChanged = true
	}
	u.timexVideoMode = nv
}

// TimexVideoMode returns the live port-$FF Timex video state's low six
// bits (port_ff_reg(5:0)) — the source NR$69's composed read pulls its
// bits 5:0 from (zxnext.vhd:6096).
func (u *ULA) TimexVideoMode() byte { return u.timexVideoMode & 0x3F }

// SetULAFrameIntDisable drives the port_ff_reg(6) frame-INT disable
// latch from its NextReg writers — NR$22 bit 2 (zxnext.vhd:3619) and
// NR$C4 bit 0 inverted (:3621). The latch lives here, in port $FF
// bit 6, so the NR$08-gated port-$FF read-back reflects those writes
// exactly as the FPGA's port_ff_dat_tmx does.
func (u *ULA) SetULAFrameIntDisable(disable bool) {
	if disable {
		u.timexVideoMode |= 0x40
	} else {
		u.timexVideoMode &^= 0x40
	}
	if u.frameIntDisableSink != nil {
		u.frameIntDisableSink(disable)
	}
}

// ULAFrameIntDisabled reports the port_ff_reg(6) latch
// (port_ff_interrupt_disable, zxnext.vhd:3635) — the source NR$22's
// read bit 2 (:5992) and NR$C4's read bit 0 (inverted, :6239 via
// ula_int_en) compose from.
func (u *ULA) ULAFrameIntDisabled() bool { return u.timexVideoMode&0x40 != 0 }

// SetFrameIntDisableSink wires the frame-INT disable latch to its
// consumer (cpu.FrameIntDisabled on ModelNext — pkg/next.Wire). Every
// latch change, whichever of the three writers caused it, is pushed.
func (u *ULA) SetFrameIntDisableSink(fn func(bool)) { u.frameIntDisableSink = fn }

// SetULABlendMode mirrors NR$68 bits 6:5 (the blend operand select for
// the additive layer modes 6/7) and bit 0 (the ULA/tilemap AND-stencil),
// forwarded to the Next compositor's blend path. Pushed by
// pkg/next.WireULAControl.
func (u *ULA) SetULABlendMode(mode byte, stencil bool) {
	if c, ok := u.nextCompositor.(interface{ SetBlendConfig(byte, bool) }); ok {
		c.SetBlendConfig(mode, stencil)
	}
}

// SetLoResControl mirrors NR$6A: bit 5 radastan mode, bit 4 the
// radastan display-file XOR, bits 3:0 the palette offset
// (zxnext.vhd:5455-5458 → lores_mode_0 / lores_dfile_0 /
// lores_palette_offset_0 at :6795-6797). Pushed by pkg/next.WireULAControl.
func (u *ULA) SetLoResControl(radastan, radastanXor bool, paletteOffset byte) {
	u.loresRadastan = radastan
	u.loresRadastanXor = radastanXor
	u.loresPaletteOffset = paletteOffset & 0x0F
}

// SetLoResScroll mirrors NR$32/$33, the LoRes layer's own scroll pair
// (zxnext.vhd:6772-6773 — independent of the ULA's NR$26/$27). Pushed
// by pkg/next.WireULAControl.
func (u *ULA) SetLoResScroll(x, y byte) { u.loresScrollX, u.loresScrollY = x, y }

// ulaDisabledFill is the colour painted across the frame when the ULA output
// is disabled: the Next compositor's NR$4A fallback when one is wired, else
// opaque black.
func (u *ULA) ulaDisabledFill() color.RGBA {
	if fb, ok := u.nextCompositor.(interface{ FallbackRGBA() [4]byte }); ok {
		c := fb.FallbackRGBA()
		return color.RGBA{R: c[0], G: c[1], B: c[2], A: 0xFF}
	}
	return color.RGBA{A: 0xFF}
}

func (u *ULA) Render() *image.RGBA {
	// The tape EAR level is advanced per port-$FE read (tapeLevel), not here —
	// a once-per-frame Update would freeze the level for the whole frame and
	// starve edge-timed loaders.

	// Synthesise audio for the frame from recorded speaker events
	// and push to the audio system, then reset the per-frame state.
	u.flushAudioFrame()

	// A "stale" render is a second Render with NO CPU execution since the
	// last one — the test harness's screenshot path (ScreenImage calls
	// Render after RunFrames already rendered the frame). The per-frame
	// raster maps (border stripes, ULA-video state) were folded from
	// change lists the executed frame produced and the lists are now
	// empty, so rebuilding them here would erase every CPU-raster-timed
	// effect (the MrKWatkins ULA/ClassicPaletized rainbow + mid-frame
	// palette flip rendered uniform). Detected via the monotonic
	// reference clock (Next only; nil elsewhere = never stale): an
	// executed frame always advances it, a back-to-back Render doesn't.
	stale := false
	if u.mem != nil && u.mem.RefTstates != nil {
		cur := u.mem.RefTstates()
		if u.lastRenderRefSeen && cur == u.lastRenderRefT {
			stale = true
		}
		u.lastRenderRefT = cur
		u.lastRenderRefSeen = true
	}

	if !stale {
		u.flashCount++
		if u.flashCount >= FlashFrames {
			u.flash = !u.flash
			u.flashCount = 0
		}
	}

	// Raster-stamped tilemap-scroll bracket (Next): fold the frame's
	// CPU scroll stamps into the per-line table now, and capture the
	// copper's render-time scroll writes per row as the walk proceeds
	// (CaptureTilemapRowScroll from the paper/border passes) — so
	// EVERY tilemap pass this render, the post-walk wide-L2 overpaint
	// included, applies the scroll in force at each row's raster line.
	// RAMS band-scrolls the Galaxian player ship with per-line copper
	// MOVEs to NR$30; the FPGA registers are combinational into the
	// pixel pipeline (tilemap.vhd:326). The deferred End re-enables
	// CPU-write stamping once the whole render (wide passes included)
	// is done.
	if tsf, ok := u.nextCompositor.(nextTilemapScrollFold); ok {
		tsf.FoldTilemapScroll(stale)
		defer tsf.EndTilemapScrollCapture()
	}

	// Build per-scanline border colour map from recorded changes.
	// Each display scanline (0-239) maps to a border colour.
	var borderPerLine [MaxTotalHeight]byte
	if stale {
		borderPerLine = u.borderLineColours
	} else if len(u.borderChanges) > 0 {
		// Start with the colour that was active before the first change in
		// this frame (frameStartBorderColour, not the live BorderColour,
		// which this frame's writes have already advanced past).
		currentBorder := u.frameStartBorderColour
		if u.borderChanges[0].scanline == 0 {
			currentBorder = u.borderChanges[0].colour
		}
		changeIdx := 0
		for line := 0; line < u.totalHeight; line++ {
			// Advance past any border changes that apply to this scanline
			// Map display line to frame scanline (line 0 = top border start)
			frameScanline := line + (64 - u.borderTop) // display top = raster 64-borderTop (paper top = raster 64)
			for changeIdx < len(u.borderChanges) && u.borderChanges[changeIdx].scanline <= frameScanline {
				currentBorder = u.borderChanges[changeIdx].colour
				changeIdx++
			}
			borderPerLine[line] = currentBorder
		}
	} else {
		for line := 0; line < u.totalHeight; line++ {
			borderPerLine[line] = u.BorderColour
		}
	}
	if !stale {
		u.borderChanges = u.borderChanges[:0] // Clear for next frame
		// Snapshot the now-current border colour as the baseline for the next
		// frame's render (see frameStartBorderColour).
		u.frameStartBorderColour = u.BorderColour
		// Keep the per-line border map for the Next compositor pass, which
		// re-resolves border pixels through the live ULA palette.
		u.borderLineColours = borderPerLine

		// Fold the raster-stamped ULA-video changes (ULANext decode,
		// displayed-palette select) into the per-display-line state map the
		// Next render passes consume — the same fold as borderPerLine.
		liveVideo := u.liveULAVideoState()
		if len(u.ulaVideoChanges) > 0 {
			cur := u.frameStartULAVideo
			idx := 0
			for line := 0; line < u.totalHeight; line++ {
				frameScanline := line + (64 - u.borderTop)
				for idx < len(u.ulaVideoChanges) && u.ulaVideoChanges[idx].scanline <= frameScanline {
					cur = u.ulaVideoChanges[idx].state
					idx++
				}
				u.ulaVideoLine[line] = cur
			}
			u.ulaVideoChanges = u.ulaVideoChanges[:0]
		} else {
			for line := range u.ulaVideoLine {
				u.ulaVideoLine[line] = liveVideo
			}
		}
		u.frameStartULAVideo = liveVideo
	}

	// NextReg $68 bit 7 ("Disable ULA output"): the ULA layer paints
	// nothing. Fill the whole frame with the disabled fill (the NR$4A
	// fallback colour when a Next compositor is wired, else black) so the
	// border + screen passes are skipped and the lower layers / fallback
	// show instead of stale screen RAM. This makes the ULA fully
	// transparent regardless of NR$14 (which sonic sets >= 16, disabling
	// the per-pixel transparency path).
	if u.ulaOutputDisabled {
		fill := u.ulaDisabledFill()
		for y := 0; y < u.totalHeight; y++ {
			for x := 0; x < TotalWidth; x++ {
				u.img.Set(x, y, fill)
			}
		}
		if u.nextCompositor != nil {
			u.applyNextCompositor(stale)
			if u.nextCompositor.HiResLayer2Active() {
				return u.renderHiResLayer2()
			}
			if u.nextCompositor.TilemapIs80Col() {
				return u.renderWide()
			}
		}
		return u.img
	}

	// Draw borders with per-scanline colours
	for y := 0; y < u.totalHeight; y++ {
		borderColor := u.palette[borderPerLine[y]]
		for x := 0; x < TotalWidth; x++ {
			if x < BorderLeft || x >= BorderLeft+ScreenWidth || y < u.borderTop || y >= u.borderTop+ScreenHeight {
				u.img.Set(x, y, borderColor)
			}
		}
	}

	// Draw screen
	screenMem := u.mem.GetPage(u.mem.ScreenPage)
	attrMem := screenMem[0x1800:]

	for y := 0; y < ScreenHeight; y++ {
		for x := 0; x < ScreenWidth/8; x++ {
			addr := screenAddrForRowCol(y, x)
			attrAddr := ((y >> 3) * 32) + x

			pixels := screenMem[addr]
			attr := attrMem[attrAddr]

			inkIdx := attr & 0x07
			paperIdx := (attr >> 3) & 0x07
			if (attr & 0x40) != 0 { // Bright
				inkIdx += 8
				paperIdx += 8
			}

			ink := u.palette[inkIdx]
			paper := u.palette[paperIdx]

			if u.flash && (attr&0x80) != 0 {
				ink, paper = paper, ink
			}

			for bit := 0; bit < 8; bit++ {
				px := BorderLeft + (x*8 + bit)
				py := u.borderTop + y
				if (pixels & (0x80 >> bit)) != 0 {
					u.img.Set(px, py, ink)
				} else {
					u.img.Set(px, py, paper)
				}
			}
		}
	}

	// Spectrum Next overlay: if a compositor is wired (ModelNext),
	// blend Layer 2 (and, later, Tilemap and Sprites) over the
	// active display region row by row. The compositor pulls
	// Layer 2 data internally; we just hand it the existing ULA
	// scanline and write the result back.
	if u.nextCompositor != nil {
		u.applyNextCompositor(stale)
		if u.nextCompositor.HiResLayer2Active() {
			// Layer 2 in 320×256 / 640×256 hi-res mode spans the full
			// display width; composite it over the base frame.
			return u.renderHiResLayer2()
		}
		if u.nextCompositor.TilemapIs80Col() {
			// 80-column tilemap = 640px wide; render the wide frame.
			return u.renderWide()
		}
		// Timex hi-res through the compositor: a STABLE hi-res frame
		// re-renders the paper at its native 512 half-pixels and
		// composites at that granularity; a mixed-mode frame (copper
		// switching NR$69 per band) already rendered decimated hi-res
		// rows in the 320 walk above.
		if !stale {
			u.timexMixedFrame = u.timexModeChanged
			u.timexModeChanged = false
		}
		if u.timexHiResActive() && !u.timexMixedFrame {
			return u.renderWideTimexHiRes()
		}
		if u.timexHiResActive() {
			return u.img
		}
	}

	// Timex 512x192 8x1 hi-res (port $FF mode 110) without a Next
	// compositor (classic machines): the pixel-doubled ULA-only render.
	if u.timexHiResActive() {
		return u.renderTimexHiRes()
	}

	// The Next's img is already the full 320×256 wide frame (paper at
	// 32,32 — SetNextCompositor switched the geometry), so over-border
	// sprites/tilemap rows were composited in place by the border
	// passes; nothing to crop or extend.
	return u.img
}

// renderWide builds a 640×TotalHeight frame for 80-column tilemap mode.
// The 320-pixel base (ULA + Layer 2 + sprites — the tilemap was skipped
// in the 320-pixel passes) is horizontally pixel-doubled, then the
// native 640-pixel tilemap is composited on top. This is the faithful
// representation of the Next's 80-column tilemap, which runs the tilemap
// layer at double the horizontal pixel clock (640px) over the 320px ULA.
func (u *ULA) renderWide() *image.RGBA {
	const ww = 2 * TotalWidth // 640
	if u.wideImg == nil {
		u.wideImg = image.NewRGBA(image.Rect(0, 0, ww, u.totalHeight))
		u.wideRow = make([]byte, ww*4)
	}
	wide := u.wideImg
	rowWide := u.wideRow
	for y := 0; y < u.totalHeight; y++ {
		srcStart := y * u.img.Stride
		for x := 0; x < TotalWidth; x++ {
			s := srcStart + x*4
			r, g, b, a := u.img.Pix[s+0], u.img.Pix[s+1], u.img.Pix[s+2], u.img.Pix[s+3]
			d := x * 8
			rowWide[d+0], rowWide[d+1], rowWide[d+2], rowWide[d+3] = r, g, b, a
			rowWide[d+4], rowWide[d+5], rowWide[d+6], rowWide[d+7] = r, g, b, a
		}
		u.nextCompositor.ComposeWideTilemapRow(y, rowWide)
		dstStart := y * wide.Stride
		copy(wide.Pix[dstStart:dstStart+ww*4], rowWide)
	}
	return wide
}

// timexHiResActive reports whether the Timex SCLD register (port $FF) selects
// the 512x192 8x1 hi-res display mode (bits 2:0 == 110).
func (u *ULA) timexHiResActive() bool { return u.timexVideoMode&0x07 == 0x06 }

// timexHiResColours decodes the hi-res ink/paper from port $FF bits 5:3. Hi-res
// uses two bright, complementary colours: ink = colour code, paper = 7 - code
// (so code 0 = black ink on white paper, the default text colours).
func (u *ULA) timexHiResColours() (ink, paper color.RGBA) {
	code := (u.timexVideoMode >> 3) & 0x07
	return u.palette[code|0x08], u.palette[(7-code)|0x08]
}

// renderTimexHiRes builds a 640×TotalHeight frame for the Timex 512×192 8x1
// hi-res mode. The pixel-doubled base frame supplies the (doubled) border; the
// central 512px paper is drawn at native resolution from the two display files
// — display file 1 (screen base) provides the even byte columns, display file 2
// (base + $2000) the odd — interleaved, with the y-address scramble of the
// standard screen. This is how the Next runs its 64/85-column text at double
// the horizontal pixel clock.
func (u *ULA) renderTimexHiRes() *image.RGBA {
	const ww = 2 * TotalWidth // 640
	if u.wideImg == nil {
		u.wideImg = image.NewRGBA(image.Rect(0, 0, ww, u.totalHeight))
		u.wideRow = make([]byte, ww*4)
	}
	wide := u.wideImg
	// Pixel-double the base frame (correct doubled border + a fallback paper).
	for y := 0; y < u.totalHeight; y++ {
		srcStart := y * u.img.Stride
		dstStart := y * wide.Stride
		for x := 0; x < TotalWidth; x++ {
			s := srcStart + x*4
			r, g, b, a := u.img.Pix[s+0], u.img.Pix[s+1], u.img.Pix[s+2], u.img.Pix[s+3]
			d := dstStart + x*8
			wide.Pix[d+0], wide.Pix[d+1], wide.Pix[d+2], wide.Pix[d+3] = r, g, b, a
			wide.Pix[d+4], wide.Pix[d+5], wide.Pix[d+6], wide.Pix[d+7] = r, g, b, a
		}
	}
	screen := u.mem.GetPage(u.mem.ScreenPage)
	if len(screen) < 0x2000+6144 {
		return wide
	}
	ink, paper := u.timexHiResColours()
	for sy := 0; sy < ScreenHeight; sy++ { // 192
		py := u.borderTop + sy
		for fileIdx := 0; fileIdx < ScreenWidth/8; fileIdx++ { // 0..31
			addr := screenAddrForRowCol(sy, fileIdx)
			for half := 0; half < 2; half++ {
				bb := screen[addr] // display file 1 -> even display bytes
				if half == 1 {
					bb = screen[0x2000+addr] // display file 2 -> odd display bytes
				}
				dpByte := 2*fileIdx + half // 0..63
				for bit := 0; bit < 8; bit++ {
					px := 2*BorderLeft + dpByte*8 + bit // paper starts at x=64
					col := paper
					if bb&(0x80>>bit) != 0 {
						col = ink
					}
					d := py*wide.Stride + px*4
					wide.Pix[d+0], wide.Pix[d+1], wide.Pix[d+2], wide.Pix[d+3] = col.R, col.G, col.B, 0xFF
				}
			}
		}
	}
	return wide
}

// renderHiResLayer2 builds the frame for a hi-res Layer 2 mode (NR$70
// resolution 1 = 320×256, 2 = 640×256). The base frame (ULA + border +
// sprites + tilemap — Layer 2 was skipped in the 256-wide pass) is the
// lower layer; the native-width Layer 2 is composited on top. Both the
// base and the hi-res L2 live in the same 320×256 wide frame (identical
// whc/wvc counters in the FPGA), so L2 row y IS img row y — all 256
// lines show. After the L2 overlay covers the base frame, the layers
// the active NR$15 mode places ABOVE Layer 2 are repainted from their
// sources (Compositor.OverpaintWideL2Row): sprites in the non-L-topmost
// modes, and the ULA+TM slot's tilemap in the U-above-L modes (RAMS:
// USL with the ULA output disabled — its menu text and Galaxian's
// formation/HUD live on the tilemap above the L2 art). Classic ULA
// pixels above wide L2 remain approximated as covered (known-gaps.md).
// For 640 the 320 base is pixel-doubled.
func (u *ULA) renderHiResLayer2() *image.RGBA {
	w := u.nextCompositor.Layer2Width()
	if w <= TotalWidth {
		// 320-wide: composite directly into the existing 320-wide img.
		row := make([]byte, w*4)
		for y := 0; y < u.totalHeight; y++ {
			start := y * u.img.Stride
			copy(row, u.img.Pix[start:start+w*4])
			u.nextCompositor.ComposeWideLayer2Row(y, row)
			u.nextCompositor.OverpaintWideL2Row(y, row, 1)
			copy(u.img.Pix[start:start+w*4], row)
		}
		return u.img
	}
	// 640-wide: pixel-double the 320 base, then overlay the 640 L2.
	const ww = 2 * TotalWidth
	if u.wideImg == nil {
		u.wideImg = image.NewRGBA(image.Rect(0, 0, ww, u.totalHeight))
		u.wideRow = make([]byte, ww*4)
	}
	wide := u.wideImg
	rowWide := u.wideRow
	for y := 0; y < u.totalHeight; y++ {
		srcStart := y * u.img.Stride
		for x := 0; x < TotalWidth; x++ {
			s := srcStart + x*4
			r, g, b, a := u.img.Pix[s+0], u.img.Pix[s+1], u.img.Pix[s+2], u.img.Pix[s+3]
			d := x * 8
			rowWide[d+0], rowWide[d+1], rowWide[d+2], rowWide[d+3] = r, g, b, a
			rowWide[d+4], rowWide[d+5], rowWide[d+6], rowWide[d+7] = r, g, b, a
		}
		u.nextCompositor.ComposeWideLayer2Row(y, rowWide)
		u.nextCompositor.OverpaintWideL2Row(y, rowWide, 2)
		dstStart := y * wide.Stride
		copy(wide.Pix[dstStart:dstStart+ww*4], rowWide)
	}
	return wide
}

// ActiveVideoLine returns the current raster line in the FPGA's video-
// counter convention (cvc): line 0 is the TOP PAPER line, 191 the last,
// and the bottom border / blank / top border run 192..310 (128K timing,
// 311 lines). This is the counter NextReg $1E (MSB, bit 0) / $1F (LSB)
// read (zxnext.vhd:5982-5986 — port_253b_dat <= cvc), the same
// convention as the copper WAIT lines and the NR$22/$23 line interrupt
// (paper top = raw line 64 after the frame INT — see WireLineInterrupt).
// NextZXOS dot commands such as NextGuide DISABLE interrupts and poll it
// to sync to the raster, so it MUST advance as the CPU runs or the wait
// hangs; the MrKWatkins suite's WaitForScanline loops rely on the paper-
// relative values to place raster-timed effects on the right rows.
func (u *ULA) ActiveVideoLine() int {
	line, _ := u.BeamPosition()
	const linesPerFrame = 311 // 70908 / 228 (128K timing, Next included)
	const paperStartLine = 64 // frame INT → paper top, per WireLineInterrupt
	return (line + linesPerFrame - paperStartLine) % linesPerFrame
}

// BeamPosition returns the current raster beam position: the scanline
// (0-based, 9-bit) and the horizontal position in 8-pixel units (2 pixels
// per T-state, 8 pixels per hpos unit, so hpos = (T-state-in-line)/4 →
// 0..56 across a 228-T-state line). This lets the Copper, memory
// contention and (eventually) a per-scanline ULA renderer query the beam
// mid-frame at per-T-state granularity instead of the coarse scanline
// quantum. Returns (0,0) when no T-state source is wired.
//
// The beam is derived from the 3.5 MHz-REFERENCE timeline (refNow /
// frameStartRefTstate), not the raw CPU T-state counter: the FPGA's cvc
// counter runs on the video clock, so it advances at the same real-time
// rate whatever NR$07 turbo the CPU selects. Dividing raw CPU T-states by
// 228 made NR$1E/$1F sweep the frame 8× per real frame at 28 MHz —
// TX-1696's raster-sync (poll NR$1F ≥ 192, then a ~9-line SP push-fill
// with SP descending through $2000-$3FFF) read garbage lines, let the
// frame INT land mid-fill with SP in ROM territory, and wedged in the
// NextZXOS $0013 JP (IX) rescue loop.
func (u *ULA) BeamPosition() (line, hpos int) {
	if u.mem == nil || u.mem.TStates == nil {
		return 0, 0
	}
	// Preferred origin: the CPU's own frame origin on the reference
	// timeline (ModelNext wiring). It is re-recorded at every frame
	// boundary unconditionally — the legacy frameStartRefTstate stamp
	// below lives in the AUDIO frame flush, which never runs in
	// no-audio (headless) sessions, leaving the beam free-running
	// across the &0x1FF wrap.
	var t int
	if u.mem.FrameOriginRef != nil {
		t = int(u.refNow() - u.mem.FrameOriginRef())
	} else {
		t = int(u.refNow() - u.frameStartRefTstate)
	}
	if t < 0 {
		t = 0
	}
	line = (t / TStatesPerLine) & 0x1FF
	hpos = (t % TStatesPerLine) / 4
	return line, hpos
}

// ReadPort handles CPU reads from ULA-controlled ports. The single
// chokepoint at which the RZX driver intercepts the IN stream:
//
//  1. If RZX playback is active, the substitute byte is returned
//     directly without consulting any real peripheral.
//  2. Otherwise the normal port-dispatch logic runs.
//  3. If RZX recording is active, the resulting byte is logged so the
//     session can be replayed later.
//
// Mirrors FUSE's readport_internal at periph.c:310-355.
func (u *ULA) ReadPort(addr uint16) (byte, bool) {
	if hp := u.rzxPlaybackHook.Load(); hp != nil {
		if val, ok := (*hp)(); ok {
			return val, true
		}
		// Stream exhausted — fall through to normal dispatch.
	}

	val, handled := u.readPortInternal(addr)

	if hr := u.rzxRecordHook.Load(); hr != nil {
		(*hr)(val)
	}
	if u.portTracer != nil {
		u.portTracer(addr, val, false /*write*/, handled)
	}
	return val, handled
}

// readPortInternal contains the real port-dispatch logic, free of any
// RZX bookkeeping. Pulled out so ReadPort can sandwich it between the
// playback and recording hooks without duplicating dispatch code.
func (u *ULA) readPortInternal(addr uint16) (byte, bool) {
	// Spectrum Next NextReg ports. Data port (0x253B) reads return
	// whatever the dispatcher's currently-selected register says.
	// Select port (0x243B) reads back the selected register NUMBER
	// (zxnext.vhd:4603 `port_243b_dat <= nr_register`) — NextZXOS's
	// IM1 handler saves the guest's selection with an IN here on
	// entry and restores it at the handler tail ($2040 OUT (C),L), so
	// a write-only select port (returning open bus) would corrupt the
	// guest's NR-select on every interrupt.
	if u.nextRegs != nil {
		switch addr {
		case 0x253B:
			return u.nextRegs.ReadData(), true
		case 0x243B:
			return u.nextRegs.Selected(), true
		}
	}

	// Beta Disk / TR-DOS registers, while the TR-DOS ROM is paged in. Checked
	// ahead of the Kempston joystick ($1F) and floating bus ($FF) so the FDC
	// wins those ports during a disk operation.
	if u.betaClaims(addr) {
		return u.beta.ReadPort(addr), true
	}

	// Ports 0x6B / 0x0B: zxnDMA register read-back (status / byte counter /
	// port addresses, selected by the read mask). Decoded on the low 8 bits;
	// $0B is the Zilog-compatibility decode.
	if u.dmaClaims(addr) {
		return u.nextDMA.ReadCommand(), true
	}

	// Multiface 3 paging-register readback. Per the FPGA source
	// (zxnext.vhd:2612-2616 port_mf_enable decode + the mf_port_dat mux,
	// and multiface.vhd:43-44): while the Multiface is active (paged in /
	// "invisible off") in MF+3 mode, an IN whose LOW byte is $3F returns a
	// paging register selected by A15:12 —
	//   $7F3F -> port $7FFD (full byte)   (mf_port_dat: A15:12 = 0111)
	//   $1F3F -> port $1FFD (low nibble)  (mf_port_dat: A15:12 = 0001 =
	//            "0000" & !motor & 1ffd_reg(2:0))
	// NextZXOS's 128K-BASIC launch fires the MF NMI; its handler reads
	// $7F3F/$1F3F to snapshot the live paging into MF RAM ($3FCC/$3FFF),
	// then a routine ($15F9) tests those bytes against the expected paging
	// state (MF ROM $01F6 `cp $04; jr nz`) to decide whether to continue to
	// the Sinclair 128 menu or abort — so this read must return the real
	// paging register, not open bus. The $Dxxx/$Exxx (dffd/eff7) and border
	// high-nibble cases aren't modelled — ours doesn't track those
	// registers and the launch doesn't read them.
	if u.mem != nil && u.mem.MultifaceActive() && addr&0x00FF == 0x003F {
		p7ffd, p1ffd, _ := u.mem.GetPortState()
		switch addr >> 12 {
		case 0x7:
			return p7ffd, true
		case 0x1:
			return p1ffd & 0x0F, true
		}
	}

	// Port $123B (Layer 2) readback: the COMPOSED control state, not the
	// last written byte (zxnext.vhd:3933 port_123b_dat <= segment & "00" &
	// shadow & rd_en & layer2_en & wr_en) — so a bank-offset write (bit 4
	// set) doesn't corrupt the read-back, and a Layer 2 enable via NR$69
	// bit 7 is reflected here. The 128K launch's MF NMI handler reads
	// $123B to snapshot Layer 2 state, so this must return the real
	// state, not open bus (which would read as bit1=1, "Layer 2
	// visible", and leave it visibly enabled afterwards).
	if u.nextRegs != nil && addr == 0x123B {
		var v byte
		if u.mem != nil {
			v = u.mem.Layer2MapControl()
		}
		if u.nextRegs.ReadReg(0x69)&0x80 != 0 {
			v |= 0x02
		}
		return v, true
	}

	// Port $303B read: sprite status (bit 0 collision, bit 1
	// max-per-line); reading clears the latched collision flag.
	if u.nextSprite != nil && addr == 0x303B {
		return u.nextSprite.ReadStatus(), true
	}

	// CTC channel ports $183B-$1F3B: the selected channel's live
	// down-counter (ctc_chan.vhd:168 o_cpu_d).
	if u.nextCTC != nil && u.nextCTC.ClaimsPort(addr) {
		return u.nextCTC.ReadPort(addr), true
	}

	// UART ports $133B (status) / $143B (RX) / $153B (select) /
	// $163B (frame) — zxnext.vhd:2639 decode, uart.vhd register map.
	if reg, ok := u.uartClaims(addr); ok {
		return u.nextUART.PortRead(reg), true
	}

	// ULA+ ports (zxnext.vhd:2668-2669 decode; :4555-4567 read).
	// $FF3B palette group reads the palette entry swizzled back to
	// GGGRRRBB (:4563); any other group reads "0000000" & ulap_en.
	// $BF3B is decoded (claims the bus) but has no read data source —
	// it returns the port mux's idle $00.
	if u.nextRegs != nil && (addr == 0xFF3B || addr == 0xBF3B) {
		if addr == 0xBF3B {
			return 0x00, true
		}
		if u.ulapMode == 0 {
			var v uint16
			if u.ulapRead != nil {
				v = u.ulapRead(u.ulapSecond(), 0xC0|u.ulapIndex)
			}
			// 9-bit RRRGGGBBB → GGGRRRBB: dat(5:3) & dat(8:6) & dat(2:1)
			return byte(v>>3&0x07)<<5 | byte(v>>6&0x07)<<2 | byte(v>>1&0x03), true
		}
		var v byte
		if u.ulaPlusEnabled {
			v = 0x01
		}
		return v, true
	}

	// Port $113B: i2c SDA line read-back (bit 0; upper bits float
	// high — open-drain bus). Port $103B reads return the SCL latch
	// the same way on real hardware but NextZXOS never reads it; we
	// serve SDA only and leave $103B to the float path.
	if u.nextI2C != nil && addr == 0x113B {
		v := byte(0xFE)
		if u.nextI2C.ReadSDA() {
			v |= 0x01
		}
		return v, true
	}

	// divMMC control register read-back (port 0xE3). The divMMC
	// IRQ handler does IN A,(0xE3) to capture the current state.
	if u.nextDivMMC != nil {
		if val, ok := u.nextDivMMC.ReadPort(addr); ok {
			return val, true
		}
	}

	if addr&0x01 == 0 { // Port 0xFE
		// Per ZX Spectrum ULA spec: bits 0-4 are the keyboard
		// matrix half-row, bit 5 is reserved (reads 1), bit 6 is
		// the tape EAR signal (0 normally, 1 when TapeIn drives it),
		// bit 7 is reserved (reads 1). Spectrum Next's boot.bin (and
		// Sinclair Test ROMs) distinguish "live ULA" from "stuck bus"
		// by reading the reserved bits as 1; a zero there sends them
		// into error-handling paths. The base value is therefore 0xBF
		// (bit 6 = 0 default, bits 5 and 7 = 1) ANDed with the keyboard
		// scan ORed with 0xE0, so the kbd matrix only affects bits 0-4.
		// Count port-$FE reads. A tape loader polls this register thousands
		// of times per frame to time edges, whereas a running game reads it
		// only sparsely for the keyboard — so the rate cleanly distinguishes
		// "actively loading" from "game running", which the fast-load turbo
		// uses to know when to stop accelerating.
		u.feReadCount++
		val := byte(0xBF)
		if u.tapeLevel() {
			val |= 0x40
		}
		val &= u.kbd.Scan(addr) | 0xE0
		return val, true
	}

	// AY-3-8912 register read: port 0xFFFD on 128K+ models.
	// Decoded as A15=1, A14=1, A1=0 (addr & 0xC002 == 0xC000).
	// On ModelNext this routes through the engine's currently-
	// active chip (NextReg 0x06 chip-select).
	if chip := u.activeAY(); chip != nil && (addr&0xC002) == 0xC000 {
		return chip.ReadSelected(), true
	}

	// Delegate to peripherals before Kempston — plug-in hardware
	// (DISCiPLE, IF1, etc.) intercepts the bus first. The DISCiPLE
	// control register at port 0x1F conflicts with Kempston; when the
	// DISCiPLE is active it takes priority, matching real hardware.
	if u.peripherals != nil {
		if value, handled := u.peripherals.HandlePortRead(addr); handled {
			return value, true
		}
	}

	// Port $FF Timex read-back: with NR$08 bit 2 set ("Enable port $FF
	// Timex video-mode read"), IN A,($FF) returns the live port-$FF
	// register instead of the floating bus (zxnext.vhd:2813
	// port_ff_rd_dat <= port_ff_dat_tmx when nr_08_port_ff_rd_en). The
	// MrKWatkins NextReg0x69 test sets this bit and reads Timex state
	// through the port to verify the NR$69 aliasing.
	if u.nextRegs != nil && (addr&0xFF) == 0xFF && u.nextRegs.ReadReg(0x08)&0x04 != 0 {
		return u.timexVideoMode, true
	}

	// Next joystick ports $1F and $37: the FPGA decodes BOTH on the low
	// address byte alone (zxnext.vhd:2546-2547) and always answers — an
	// unrouted port reads $00, never the floating bus (:2829-2830 mux
	// port_XX_dat, which idles at 0). NR$05 routes each physical stick
	// to one port and mode (:3472-3494): modes "001"/"100" put a
	// Kempston-style stick on $1F/$37 (i_JOY bits 5:0), and the MD-pad
	// modes "101"/"110" additionally expose START/A in bits 7:6. Games
	// rely on the always-decoded idle $00: Sonic complements IN($1F)
	// for an option-menu flag, and Atic Atac ORs IN($1F) with IN($37)
	// every frame — a floating-bus $FF from an undecoded $37 reads as
	// every button held, so its title screen never saw a fire edge.
	isNext := u.mem != nil && u.mem.GetCurrentModel() == roms.ModelNext
	if isNext && u.nextRegs != nil && (byte(addr) == 0x1F || byte(addr) == 0x37) {
		// NR$05 read-back layout (see WireJoystickMode): bits 7:6 =
		// joy0[1:0], bit 3 = joy0[2]; bits 5:4 = joy1[1:0], bit 1 =
		// joy1[2].
		mode05 := u.nextRegs.ReadReg(0x05)
		joy0 := mode05>>6&0x03 | mode05>>1&0x04
		joy1 := mode05>>4&0x03 | mode05<<1&0x04
		return nextJoyPortByte(u.MDJoyLeft(), joy0, byte(addr)) |
			nextJoyPortByte(u.MDJoyRight(), joy1, byte(addr)), true
	}

	// Kempston joystick: port 0x1F. Decoded as A7..A5 = 0 and A4..A0 = 0x1F.
	// (On the Next the branch above handles $1F; this stays as the
	// classic-interface path, and as a fallback for Next wirings with
	// no NextReg dispatcher attached.)
	if (u.KempstonEnabled || isNext) && (addr&0x00E0) == 0x0000 && (addr&0x001F) == 0x001F {
		return u.KempstonState & 0x1F, true
	}

	// Floating-bus: on 48K and 128K, an unattached IN returns
	// whichever byte the ULA is currently fetching from screen
	// memory (or 0xFF during border/retrace/idle bus phases).
	// The +2A/+3 memory controller disables this behaviour;
	// ModelNext also returns 0xFF for compatibility with most
	// post-Sinclair software that's clean about port use.
	return u.floatingBusByte(), false
}

// floatingBusByte computes the value an unattached IN returns
// based on the current scanline / column timing. Implements the
// canonical algorithm documented by Ramsoft (1999) and FUSE
// (spectrum.c:spectrum_unattached_port). Used by some games
// (Arkanoid, Sidewize, Cobra, Short Circuit) for fast
// attribute readback. Returns 0xFF on +2A/+3 (no floating bus)
// and on ModelNext.
func (u *ULA) floatingBusByte() byte {
	if u.mem == nil || u.mem.TStates == nil {
		return 0xFF
	}
	model := u.mem.GetCurrentModel()
	if model == roms.ModelPlus2A || model == roms.ModelPlus3 || model == roms.ModelNext {
		return 0xFF
	}

	// Compute T-state offset within the current frame.
	tstates := int(*u.mem.TStates - u.frameStartTstate)

	// Per-model line length: the 48K ULA uses 224 T-states/line, the 128K
	// family 228. Using the wrong length shifts the floating-bus origin by a
	// full 256 T-states on 48K (the documented first paper fetch is 64*224 =
	// 14336, not 64*228 = 14592 — Ramsoft "floating bus", Sean Young notes,
	// video/zxula_timing.vhd c_max_hc 447 vs 455).
	tPerLine := TStatesPerLineFor(model)

	// Top border: before the first display line.
	topBorderTStates := 64 * tPerLine
	if tstates < topBorderTStates {
		return 0xFF
	}

	line := (tstates - topBorderTStates) / tPerLine
	if line >= 192 { // bottom border
		return 0xFF
	}

	// T-states into this line. The first 18 are the leftmost
	// blanking/sync; the first displayed pixel is at T-state 14336 on 48K.
	// Our frameStartTstate is the start of frame, so we subtract the
	// per-line origin.
	tInLine := tstates - topBorderTStates - line*tPerLine

	// Each line: 24 T-states left border, 128 T-states display,
	// 24 right border, 52 retrace. Only the 128 display T-states
	// produce floating-bus data.
	const leftBorder = 24
	const horizontalScreen = 128
	if tInLine < leftBorder {
		return 0xFF
	}
	if tInLine >= leftBorder+horizontalScreen {
		return 0xFF
	}

	tInDisplay := tInLine - leftBorder
	// 8 T-states per 16-pixel column pair. Within those 8 T-states
	// the ULA's fetch pattern is:
	//   t%8 = 0,1: idle bus (0xFF)
	//   t%8 = 2:   bitmap[col]
	//   t%8 = 3:   attribute[col]
	//   t%8 = 4:   bitmap[col+1]
	//   t%8 = 5:   attribute[col+1]
	//   t%8 = 6,7: idle bus (0xFF)
	column := (tInDisplay / 8) * 2

	// Screen memory: bank 5 always holds the displayed screen on
	// 48K; on 128K the bank selected by 7FFD bit 3 holds it
	// (bank 5 or 7). The Memory accessor returns the active
	// screen page.
	screenBank := u.mem.ScreenPage
	if screenBank == 0 {
		screenBank = 5
	}
	page := u.mem.GetPage(screenBank)
	if page == nil {
		return 0xFF
	}

	switch tInDisplay % 8 {
	case 2:
		return page[screenAddrForRowCol(line, column)]
	case 3:
		return page[0x1800+(line/8)*32+column]
	case 4:
		return page[screenAddrForRowCol(line, column+1)]
	case 5:
		return page[0x1800+(line/8)*32+column+1]
	}
	return 0xFF
}

// screenAddrForRowCol returns the offset within a 16K screen RAM
// page where pixel-row `row` (0..191), column `col` (0..31, units
// of 8 pixels) is stored. The Spectrum's interleaved screen
// layout: row bits are scrambled as `010 765 432 1xx` to give the
// distinctive thirds-rotated memory map.
func screenAddrForRowCol(row, col int) int {
	if col < 0 || col > 31 || row < 0 || row > 191 {
		return 0
	}
	// y = bits y7..y0; address = (y7y6 << 11) | (y2y1y0 << 8) | (y5y4y3 << 5) | col
	y := uint(row)
	addr := ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | uint(col)
	return int(addr)
}

// SetRZXPlaybackHook installs (or removes, with hook=nil) the RZX
// playback IN-byte source. The hook returns ok=true with the next
// recorded byte, or ok=false if the stream has been exhausted.
// Safe to call from any goroutine — the hook field is atomic.
func (u *ULA) SetRZXPlaybackHook(hook func() (byte, bool)) {
	if hook == nil {
		u.rzxPlaybackHook.Store(nil)
		return
	}
	u.rzxPlaybackHook.Store(&hook)
}

// SetRZXRecordHook installs (or removes, with hook=nil) the RZX
// recording sink. The hook is called once per IN-port read with the
// value the real peripherals returned, BEFORE that value is delivered
// to the CPU. Safe to call from any goroutine.
func (u *ULA) SetRZXRecordHook(hook func(byte)) {
	if hook == nil {
		u.rzxRecordHook.Store(nil)
		return
	}
	u.rzxRecordHook.Store(&hook)
}

// Kempston joystick bit constants for KempstonState.
const (
	KempstonRight = 0x01
	KempstonLeft  = 0x02
	KempstonDown  = 0x04
	KempstonUp    = 0x08
	KempstonFire  = 0x10
)

// SetKempstonButton sets or clears a Kempston joystick button bit.
func (u *ULA) SetKempstonButton(mask byte, pressed bool) {
	if pressed {
		u.KempstonState |= mask
	} else {
		u.KempstonState &^= mask
	}
}

// ExtendedKeys exposes the keyboard's Spectrum Next extended-key vector
// (i_KBD_EXTENDED_KEYS) for the NR $B0/$B1 read-back — see
// keyboard.ExtendedKeys for the bit layout and derivation.
func (u *ULA) ExtendedKeys() uint16 {
	return u.kbd.ExtendedKeys()
}

// MDJoyLeft returns the left joystick as the FPGA's 12-bit i_JOY_LEFT
// vector, active high, bits 11..0 = MODE X Z Y START A C B U D L R
// (zxnext.vhd:90). Our joystick state is the Kempston byte, whose low
// five bits (Fire=B, U, D, L, R) are the same order as i_JOY(4:0) —
// the FPGA feeds i_JOY(5:0) straight to the Kempston port read
// (zxnext.vhd:3479). The Megadrive-only buttons (START A C, and the
// X Z Y MODE that NR $B2 reads) have no emulator-side source yet and
// read idle (0).
func (u *ULA) MDJoyLeft() uint16 {
	return uint16(u.KempstonState & 0x1F)
}

// MDJoyRight is the right joystick's i_JOY_RIGHT vector. Only one
// joystick is modelled (the Kempston state, reported as the left pad),
// so the right pad always reads idle.
func (u *ULA) MDJoyRight() uint16 {
	return 0
}

// nextJoyPortByte composes one stick's contribution to a joystick
// port read per zxnext.vhd:3472-3506. mode is the stick's 3-bit
// NR$05 routing, vec its 12-bit i_JOY vector (active high), port the
// low address byte ($1F or $37). Bits 5:0 pass when the stick is
// routed to this port in Kempston or MD mode (joyX_YY_en); bits 7:6
// (START/A) only in the MD mode for this port (mdX_YY_en). The two
// sticks' bytes are ORed by the caller, matching port_1f_dat /
// port_37_dat.
func nextJoyPortByte(vec uint16, mode byte, port byte) byte {
	var md, en bool
	if port == 0x1F {
		md = mode == 0b101
		en = mode == 0b001 || md
	} else {
		md = mode == 0b110
		en = mode == 0b100 || md
	}
	var b byte
	if en {
		b = byte(vec) & 0x3F
	}
	if md {
		b |= byte(vec) & 0xC0
	}
	return b
}

// WritePort handles CPU writes to ULA-controlled ports. Public
// entry point: dispatches to the internal handler and then fires
// the port tracer if one is installed.
func (u *ULA) WritePort(addr uint16, val byte) {
	u.writePortInternal(addr, val)
	if u.portTracer != nil {
		// Writes have no observable "handled" signal (the
		// internal dispatch swallows all addresses), so we always
		// report handled=true for writes. Reads have a real
		// handled flag from the underlying dispatcher.
		u.portTracer(addr, val, true /*write*/, true /*handled*/)
	}
}

// writePortInternal is the original WritePort body. It contains
// the early-return cascade for each port family. Kept as a
// separate function so the public WritePort can wrap it with
// tracing without disturbing the dispatch structure.
func (u *ULA) writePortInternal(addr uint16, val byte) {
	// Port $FF — the Timex SCLD video-mode register. bits 2:0 select the
	// display mode (110 = 512x192 8x1 hi-res), bits 5:3 the hi-res colour.
	// NextZXOS's 64/85-column text modes (e.g. the .more text viewer) use the
	// hi-res mode. Bit 6 is the ULA frame-INT disable latch (zxnext.vhd:3615
	// port_ff_wr stores the full byte; :3635 port_ff_interrupt_disable is
	// bit 6), pushed to the CPU's INT generator when the Next wiring has
	// connected the sink. Stored here; rendered by renderTimexHiRes. Falls
	// through so any other $FF semantics are unaffected.
	if (addr & 0xFF) == 0xFF {
		// Mixed-frame detection watches the VIDEO bits only — a write
		// that just toggles the INT-disable latch must not demote a
		// stable hi-res frame to the decimated 320 path.
		if (u.timexVideoMode^val)&0x3F != 0 {
			u.timexModeChanged = true
		}
		u.timexVideoMode = val
		if u.frameIntDisableSink != nil {
			u.frameIntDisableSink(val&0x40 != 0)
		}
	}
	// Spectrum Next NextReg ports take priority over any other
	// dispatch when wired. 0x243B is the select latch (write-only),
	// 0x253B is the data port (read+write).
	if u.nextRegs != nil {
		switch addr {
		case 0x243B:
			u.nextRegs.Select(val)
			return
		case 0x253B:
			u.nextRegs.WriteData(val)
			return
		}
	}

	// Beta Disk / TR-DOS registers, while the TR-DOS ROM is paged in (see the
	// read side). Intercepts the FDC ports before the ULA/SpecDrum dispatch.
	if u.betaClaims(addr) {
		u.beta.WritePort(addr, val)
		return
	}

	// Ports $103B / $113B: Spectrum Next i2c SCL / SDA write latches
	// (zxnext.vhd:3234-3250 — bit 0 of the data byte drives the
	// open-drain line; full 16-bit decode $10xx/$11xx + $3B).
	if u.nextI2C != nil && (addr&0xFF) == 0x3B {
		switch addr >> 8 {
		case 0x10:
			u.nextI2C.WriteSCL(val&0x01 != 0)
			return
		case 0x11:
			u.nextI2C.WriteSDA(val&0x01 != 0)
			return
		}
	}

	// ULA+ ports. $BF3B (register) selects the group in bits 7:6 and,
	// for the palette group, the 6-bit palette index (zxnext.vhd:
	// 4528-4536). $FF3B (data): palette group writes route through the
	// NextReg palette stream into ULA-palette entry 192+index with the
	// GGGRRRBB byte swizzled to RRRGGGBB + or-blue (:4741/:4746/:4919/
	// :6958); mode group writes drive the live ULA+ enable (:4548-4549)
	// that NR$68 bit 3 shares.
	if u.nextRegs != nil && (addr == 0xBF3B || addr == 0xFF3B) {
		if addr == 0xBF3B {
			u.ulapMode = val >> 6 & 0x03
			if u.ulapMode == 0 {
				u.ulapIndex = val & 0x3F
			}
			return
		}
		if u.ulapMode == 0 {
			if u.ulapWrite != nil {
				// GGGRRRBB → 9-bit RRRGGGBBB: do(4:2) & do(7:5) & do(1:0)
				// & (do(1) or do(0)) — zxnext.vhd:4746 + :4919.
				rgb := uint16(val>>2&0x07)<<6 | uint16(val>>5&0x07)<<3 | uint16(val&0x03)<<1
				if val&0x03 != 0 {
					rgb |= 1
				}
				u.ulapWrite(u.ulapSecond(), 0xC0|u.ulapIndex, rgb)
			}
			return
		}
		if u.ulapMode == 1 {
			u.SetULAPlusEnabled(val&0x01 != 0)
		}
		return
	}

	// CTC channel ports $183B-$1F3B (zxnext.vhd:2690): control word /
	// time constant / vector writes to the selected channel.
	if u.nextCTC != nil && u.nextCTC.ClaimsPort(addr) {
		u.nextCTC.WritePort(addr, val)
		return
	}

	// UART ports $133B (TX) / $143B (prescaler) / $153B (select) /
	// $163B (frame) — zxnext.vhd:2639 decode, uart.vhd register map.
	if reg, ok := u.uartClaims(addr); ok {
		u.nextUART.PortWrite(reg, val)
		return
	}

	// Ports 0x6B / 0x0B: zxnDMA command stream. Decoded on low 8 bits only;
	// $0B selects the Zilog-DMA compatibility mode.
	if u.dmaClaims(addr) {
		u.nextDMA.WriteCommand(val)
		return
	}

	// Port $303B write: select the active sprite AND pattern-upload cursor
	// (ports.txt 0x303B — sets both quantities from the one value).
	if u.nextSprite != nil && addr == 0x303B {
		u.nextSprite.SelectSlot(val)
		return
	}

	// Port $005B write: stream a byte into the sprite pattern RAM at the
	// current cursor (ports.txt 0x5B). Decoded on the low 8 bits only because
	// OTIR (the canonical pattern-upload loop) varies the high byte via B.
	if u.nextSprite != nil && (addr&0xFF) == 0x5B {
		u.nextSprite.WritePatternByte(val)
		return
	}

	// Port $0057 write: stream a byte into the current sprite's attributes
	// (ports.txt 0x57, "Sprite Attribute Upload"). Each sprite takes 4 or 5
	// bytes, then the current-sprite pointer auto-advances. Decoded on the low
	// 8 bits only because the OTIR upload loop varies the high byte via B — the
	// same convention as the $5B pattern stream above. Nextoid uploads all its
	// sprites (bat, ball, HUD) through this port each frame.
	if u.nextSprite != nil && (addr&0xFF) == 0x57 {
		u.nextSprite.WriteAttr(val)
		return
	}

	// Port 0x123B: legacy Spectrum Next Layer 2 control
	// (zxnext.vhd:3914-3923). A write with bit 4 clear sets the control
	// register: bit 1 = Layer 2 visible (the SAME live register NR$69
	// bit 7 writes — boot.bin enables its testcard through this port),
	// bit 0/2 = write/read-over-ROM paging, bit 3 = shadow PAGING select
	// (which NR$13 bank the over-ROM window maps — display source is
	// untouched: the FPGA's $123B write drives no ULA-shadow signal),
	// bits 7:6 = segment. A write with bit 4 set loads only the 3-bit
	// bank offset (core 3.0.7+) and must leave the control state alone.
	if u.nextRegs != nil && addr == 0x123B {
		// Layer-2 write/read paging: route CPU accesses to Layer-2 RAM while
		// enabled (bit 0/2) so a game's Layer-2 screen clear hits Layer-2 RAM,
		// not normal RAM. (zxnext.vhd:3915-3933)
		if u.mem != nil {
			u.mem.SetLayer2MapControl(val)
		}
		if val&0x10 == 0 {
			// Propagate bit 1 into the shared layer2_en register through
			// the NR$69 write fan-out — composing the OTHER bits from
			// their live sources (shadow display, Timex mode) so this
			// write changes only what the FPGA's would.
			nr69 := u.timexVideoMode & 0x3F
			if u.mem != nil && u.mem.ScreenPage == 7 {
				nr69 |= 0x40
			}
			if val&0x02 != 0 {
				nr69 |= 0x80
			}
			u.nextRegs.WriteReg(0x69, nr69)
		}
		return
	}

	// Spectrum Next DAC ports (0x0F / 0x1F / 0xF1 / 0xF3 / 0xF9 /
	// 0xDF / 0xFB on the low byte). The bank returns true if the
	// port was a DAC channel — when handled, fall through to the
	// rest of the dispatch is unnecessary (DAC ports don't alias
	// classic ULA ports). When the port wasn't a DAC port the bank
	// returns false and we continue with the normal dispatch.
	if u.nextDAC != nil && u.nextDAC.WritePort(addr, val) {
		// Record the timed write so flushAudioFrame can reconstruct the DAC
		// waveform sample-accurately (event-timed, like the beeper).
		if u.audio != nil && u.mem.TStates != nil {
			if rec, ok := u.nextDAC.(interface{ Record(int) }); ok {
				rec.Record(u.audioFrameOffset())
			}
		}
		return
	}

	// Classic-Spectrum SpecDrum ($DF) / Covox ($FB) DAC. When an enabled
	// device claims the port, latch the 8-bit sample with its T-state offset so
	// flushAudioFrame can reconstruct the waveform, and consume the write
	// (claiming $FB is why Covox and the ZX Printer can't both be on at once).
	if u.speccyDAC != nil && u.speccyDAC.Handles(byte(addr&0xFF)) {
		if u.audio != nil && u.mem.TStates != nil {
			u.speccyDAC.Record(u.audioFrameOffset(), val)
		}
		return
	}

	// divMMC control port 0xE3 (low-byte decode). The pager
	// claims the port if matched. NextZXOS's boot trampoline
	// writes 0 to 0xE3 to drop the divMMC overlay after it
	// finishes initialising; without this dispatch the boot
	// deadlocks in a tight 0x006A→0x1FF9→0x0001 loop.
	if u.nextDivMMC != nil && u.nextDivMMC.WritePort(addr, val) {
		return
	}

	if addr&0x01 == 0 { // Port 0xFE
		newBorder := val & 0x07
		if newBorder != u.BorderColour {
			// Record the border change with current scanline for mid-frame rendering.
			// Per-model line length (224 on 48K, 228 on 128K+) — see
			// TStatesPerLineFor and its use in floatingBusByte.
			scanline := 0
			if u.mem.TStates != nil {
				scanline = int(*u.mem.TStates) / TStatesPerLineFor(u.mem.GetCurrentModel())
			}
			u.borderChanges = append(u.borderChanges, borderChange{scanline: scanline, colour: newBorder})
			u.BorderColour = newBorder
			if u.borderTracer != nil {
				u.borderTracer(addr, val, newBorder, scanline)
			}
		}
		u.Mic = (val & 0x08) != 0

		// Handle speaker state change. Each toggle is recorded with
		// the T-state offset within the current frame so the audio
		// generator can reconstruct the waveform at end-of-frame.
		newSpeakerState := (val & 0x10) != 0
		if newSpeakerState != u.Speaker {
			u.Speaker = newSpeakerState
			if u.audio != nil && u.mem.TStates != nil {
				u.audioEvents = append(u.audioEvents, audioEvent{
					tstateOffset: u.audioFrameOffset(),
					state:        newSpeakerState,
				})
			}
		}
	} else if u.nextAY != nil && (addr&0xC002) == 0xC000 && val >= 0xFD {
		// Spectrum Next TurboSound chip select: writing 0xFF/0xFE/0xFD to
		// port 0xFFFD selects AY chip 0/1/2 (chip = 0xFF - val). Register
		// selects are 0x00-0x0F, so there is no overlap. (NextReg 0x06 does
		// NOT select the chip.)
		u.nextAY.SelectChip(0xFF - val)
	} else if u.mem.GetCurrentModel() == roms.ModelNext && (addr&0xF0FF) == 0xE0F7 {
		// Port 0xEFF7 (zxnext.vhd:2604): incompletely decoded on address
		// bits 15:12="1110" and low byte $F7 only — bits 11:8 are don't-
		// care, so $E0F7-$EFF7 all alias this port (a classic Pentagon/
		// Scorpion-style port carried through on the Next). Checked
		// before the AY/DFFD patterns below since 0xF0FF doesn't
		// overlap them, but ordering it early keeps the loose-decode
		// port from ever being shadowed by a future broader pattern.
		u.mem.SetEFF7(val)
	} else if u.mem.GetCurrentModel() == roms.ModelNext && (addr&0xF002) == 0xD000 {
		// Port 0xDFFD (Spectrum Next high RAM-bank extension): bits 3:0 are the
		// MSBs of the $C000-slot RAM bank. Must be decoded before the AY
		// register-select port 0xFFFD below, which shares the same
		// (addr&0xC002)==0xC000 pattern — the Next gives 0xDFFD precedence
		// over AY (ports.txt 0xdffd), or RAM banks >= 8 would be unreachable
		// via the classic $C000 slot.
		u.mem.SetDFFD(val)
	} else if chip := u.activeAY(); chip != nil && (addr&0xC002) == 0xC000 {
		// AY-3-8912 register select: port 0xFFFD on 128K+ models.
		// Decoded as A15=1, A14=1, A1=0.
		chip.SelectRegister(val)
	} else if chip := u.activeAY(); chip != nil && (addr&0xC002) == 0x8000 {
		// AY-3-8912 data write: port 0xBFFD on 128K+ models.
		// Decoded as A15=1, A14=0, A1=0.
		chip.WriteSelected(val)
	} else if u.mem.GetCurrentModel() == roms.ModelPlus3 || u.mem.GetCurrentModel() == roms.ModelPlus2A || u.mem.GetCurrentModel() == roms.ModelNext {
		// +3 / +2A / Next use stricter port decoding to avoid
		// conflicts between 0x7FFD and 0x1FFD:
		//   0x7FFD: mask=0xC002 value=0x4000 (A15=0, A14=1, A1=0)
		//   0x1FFD: mask=0xF002 value=0x1000 (A15=0, A14=0, A13=0, A12=1, A1=0)
		// ModelNext must be included in this branch: 0x1FFD also matches the
		// loose 0x7FFD pattern below (0x1FFD & 0x8002 == 0), so without the
		// strict decode here a $1FFD write would be misread as a $7FFD
		// paging write and remap the wrong RAM bank into the $C000 slot.
		if addr&0xC002 == 0x4000 {
			u.mem.PageMemory(val)
		} else if addr&0xF002 == 0x1000 {
			u.mem.PageMemoryPlus3(val)
		}
	} else if addr&0x8002 == 0 { // Port 0x7FFD (128K memory paging): A15=0, A1=0
		// Only handle this on 128K+ models
		if u.mem.GetCurrentModel() != roms.Model48K {
			u.mem.PageMemory(val)
		}
	}

	// Delegate to peripherals
	if u.peripherals != nil {
		u.peripherals.HandlePortWrite(addr, val)
	}
}

// Close properly shuts down the ULA and releases resources
func (u *ULA) Close() {
	if u.audio != nil {
		_ = u.audio.Close()
	}
}

// applyNextCompositor walks the 192 active display rows, hands
// each one to the Spectrum Next compositor and writes the
// composited result back into u.img. Called from Render only
// when u.nextCompositor != nil.
//
// Cost: 192 rows × 256 pixels × {extract + compose + write} per
// frame. At 50 Hz that's a few hundred thousand pixel touches —
// well within budget per the §13.5 performance estimate. The
// row scratch buffers (compositorScan / compositorComposed /
// compositorRow) are allocated once and reused across frames.
func (u *ULA) applyNextCompositor(stale bool) {
	const w = 256
	const h = 192
	// The copper runs at 28 MHz, one cycle per NOOP / two per MOVE
	// (device/copper.vhd). A scanline on the Next's 128K/+3 timing is
	// 456 hcounts (c_max_hc = 455, zxula_timing.vhd:196) x 4 cycles =
	// 1824 copper cycles — Step's budget is in those cycles, so a
	// free-running looped list (Atic Atac's NMI sample pacer: 1024
	// entries ≈ 1361 cycles) wraps at the hardware rate (~20 kHz).
	// WAIT-heavy programs park early and spend almost none of it.
	// NB a WAIT whose threshold (X<<3)+12 exceeds 455 (X >= 56) can
	// never release on hardware — the hcount wraps first — and both
	// engines reproduce that (#179 equivalence).
	const copperCyclesPerScanline = 456 * 4
	// Raster geometry for the cycle-paced copper interleave. hcount
	// counts 7MHz pixels (456 per 128K-timing line, 0..455); the copper
	// runs 4 cycles per hcount (28 MHz, copper.CyclesPerHcount).
	// Display pixel x is influenced by copper activity through hcount
	// x+12 — the same +12 offset the WAIT release threshold (X<<3)+12
	// carries (device/copper.vhd:94), so WAIT(h=X) + MOVE recolours the
	// pixel at exactly x = X*8, matching the real-board behaviour the
	// upstream base/Copper test's ReadMe documents. The +2 inside
	// pixelCycle admits the releasing WAIT check (1 cycle) plus its
	// following MOVE's write pulse into the pixel's own 4-cycle window.
	const cyclesPerHcount = 4
	const lineEndCycle = 456*cyclesPerHcount - 1
	const frameLines = 312
	pixelCycle := func(x int) int { return (x+12)*cyclesPerHcount + 2 }
	if u.compositorScan == nil {
		u.compositorScan = make([]byte, w*4)
		u.compositorComposed = make([]byte, w*4)
	}
	ulaScan := u.compositorScan
	composed := u.compositorComposed
	resolver, liveULA := u.liveULAResolver()
	var paced nextCopperCyclePaced
	if u.nextCopper != nil {
		paced, _ = u.nextCopper.(nextCopperCyclePaced)
	}
	// Raster-stamped palette-CONTENT replay: rewind the palette bank to
	// its frame-start state and re-apply the frame's logged NR$41/$44
	// writes row by row, so a CPU rewriting palette entries mid-frame
	// (the ScanlineReadingAndInterrupt one-line flashes) recolours from
	// exactly its raster line — the FPGA's palette BRAM write is visible
	// to the video fetch on the next pixel (zxnext.vhd:4919-4930). The
	// bracket also suspends the bank's write logging for the whole walk,
	// so the copper interleave's render-time writes are never logged.
	// Stamp clock and fold convention match borderChanges (BeamPosition
	// lines, paper top = 64).
	palReplay, _ := u.nextCompositor.(nextPaletteReplay)
	if palReplay != nil {
		palReplay.BeginPaletteReplay(stale)
		defer palReplay.EndPaletteReplay()
	}
	// The tilemap-scroll fold/capture bracket was opened by Render
	// (nextTilemapScrollFold) before any compositor pass; this walk
	// feeds it per-row captures below.
	scrollCap, _ := u.nextCompositor.(nextTilemapScrollFold)
	// Raster order of one display row's border pixels (hcount = pixel+12,
	// 448 hcounts per line): the left border's first 20 pixels display
	// during the PREVIOUS line's tail (hcount 428..447) and its last 12
	// during hcount 0..11 of the row's own line; the right border follows
	// the paper at hcount 268..299. leftCarry hands the previous line's
	// tail pixels (resolved live, mid-tail) to the next row — this is what
	// renders the base/Copper test's over-left-border flag, whose MOVEs
	// live entirely inside that tail and are white-restored before the
	// line ends.
	const leftTailPx = 20
	var leftCarry [leftTailPx][4]byte
	leftCarryValid := false
	// Displayed-ULA-palette replay: push each row's raster-stamped
	// palette select (NR$43 bit 1) into the compositor's bank before
	// rendering the row, so a CPU flipping the displayed palette
	// mid-frame recolours from exactly its raster line. Pushed only on
	// TRANSITIONS so a copper-driven live select (already applied at the
	// bank by WirePalette) is not clobbered on every row; the live state
	// is restored after the walk.
	selector, _ := u.nextCompositor.(nextULAPaletteSelector)
	selPushed := false
	var selCur bool
	pushSelect := func(second bool) {
		if selector == nil || (selPushed && selCur == second) {
			return
		}
		selector.SetULAActivePalette(second)
		selPushed = true
		selCur = second
	}
	defer func() {
		if selPushed {
			selector.SetULAActivePalette(u.ulaPalSecond)
		}
	}()
	// Raster-stamped NR$15 replay: push each row's layer-priority mode
	// (bits 4:2) into the compositor before composing it, so a CPU
	// rewriting NR$15 per raster band (the MrKWatkins LayersMixing
	// pattern) composites each band with its own mode. Pushed only on
	// TRANSITIONS — a copper-driven live NR$15 (already applied at the
	// priority source) is not clobbered row by row — and cleared after
	// the walk so the live register resumes control.
	prioOverride, _ := u.nextCompositor.(interface {
		SetPriorityModeOverride(byte)
		ClearPriorityModeOverride()
	})
	prioPushed := false
	var prioCur byte
	pushPriority := func(nr15 byte) {
		m := (nr15 >> 2) & 0x07
		if prioOverride == nil || (prioPushed && prioCur == m) {
			return
		}
		prioOverride.SetPriorityModeOverride(m)
		prioPushed = true
		prioCur = m
	}
	defer func() {
		if prioPushed {
			prioOverride.ClearPriorityModeOverride()
		}
	}()
	for y := 0; y < h; y++ {
		// Apply the frame's stamped palette writes up to this paper
		// row's raster line (y+64) before composing it — same
		// convention as the borderChanges fold (line granularity;
		// sub-line detail is below the render's precision floor).
		if palReplay != nil {
			palReplay.ReplayPaletteThrough(64 + y)
		}
		// Run the Copper for this row BEFORE composing it so MOVEs
		// affecting the compositor palette / Layer 2 are visible to this
		// row's composition. With a cycle-paced copper + live-palette ULA
		// render the interleave is per PIXEL (inside renderNextULARow);
		// otherwise the whole line executes up front — the pre-existing
		// scanline quantum.
		if u.nextCopper != nil && (paced == nil || !liveULA) {
			// Step the Copper for scanline y at the end-of-line horizontal
			// counter (>= 511) so every WAIT targeting any column on scanline
			// y releases on y, not one scanline late. The Copper's WAIT
			// release threshold is hcount >= (X<<3)+12 (device/copper.vhd:94);
			// passing the max hcount clears it for all X.
			// Capture the scroll in force at the START of row y — the
			// state the copper left at the end of line y-1. Copper scroll
			// lists write each band's value at the END of the preceding
			// line (WAIT(y-1, end); MOVE) so the whole next line renders
			// cleanly; capturing after line y's ops instead put the
			// band's restore one row early (RAMS Galaxian: the formation
			// band's BOTTOM row rendered with the post-band scroll —
			// stale-looking ships). Row granularity: a mid-row MOVE lands
			// on the next row, the render's documented line quantum.
			if scrollCap != nil {
				scrollCap.CaptureTilemapRowScroll(64 + y)
			}
			u.nextCopper.Step(uint16(y), 455, copperCyclesPerScanline)
		} else if scrollCap != nil {
			scrollCap.CaptureTilemapRowScroll(64 + y)
		}
		rowStart := (u.borderTop+y)*u.img.Stride + BorderLeft*4
		pushPriority(u.ulaVideoLine[u.borderTop+y].nr15)
		if liveULA {
			st := u.ulaVideoLine[u.borderTop+y]
			pushSelect(st.ulaPalSecond)
			// Left border: carried tail pixels first, then the 12 pixels
			// that belong to this line's own hcount 0..11.
			for bx := 0; bx < leftTailPx; bx++ {
				if leftCarryValid {
					u.paintImagePixel(y, bx, leftCarry[bx])
				} else {
					u.paintImagePixel(y, bx, u.nextBorderRGBA(u.borderTop+y, resolver))
				}
			}
			for bx := leftTailPx; bx < BorderLeft; bx++ {
				if paced != nil {
					paced.RunToCycle(uint16(y), (bx-leftTailPx)*cyclesPerHcount+2)
				}
				u.paintImagePixel(y, bx, u.nextBorderRGBA(u.borderTop+y, resolver))
			}
			u.renderNextULARow(y, ulaScan, resolver, paced, pixelCycle, st)
		} else {
			copy(ulaScan, u.img.Pix[rowStart:rowStart+w*4])
		}
		u.nextCompositor.ComposeScanline(y, ulaScan, composed)
		copy(u.img.Pix[rowStart:rowStart+w*4], composed)
		if liveULA {
			// Right border: per pixel at hcount 268+bx.
			for bx := 0; bx < BorderLeft; bx++ {
				if paced != nil {
					paced.RunToCycle(uint16(y), (268+bx)*cyclesPerHcount+2)
				}
				u.paintImagePixel(y, BorderLeft+w+bx, u.nextBorderRGBA(u.borderTop+y, resolver))
			}
			// Line tail: resolve the next row's carried left-border pixels
			// live at their hcount, then finish the copper's line.
			if y+1 < h {
				for bx := 0; bx < leftTailPx; bx++ {
					if paced != nil {
						paced.RunToCycle(uint16(y), (428+bx)*cyclesPerHcount+2)
					}
					leftCarry[bx] = u.nextBorderRGBA(u.borderTop+y+1, resolver)
				}
				leftCarryValid = true
			}
			if paced != nil {
				paced.RunToCycle(uint16(y), lineEndCycle)
			}
		}
	}
	// Sweep the copper through the vertical blank / border lines so WAITs
	// targeting lines 192..311 release on their line and the raster wrap
	// to line 0 restarts a StartOnVBL list next frame — and repaint the
	// top/bottom border rows through the live palette at their raster
	// lines. The FPGA resolves EVERY border pixel through the same
	// palette SRAM as the paper, so these rows must match the paper-row
	// borders (one palette, one DAC — a redefined white is redefined
	// everywhere). Raster mapping: the bottom border rows scan on lines
	// h..h+BorderTop-1 right after the paper; the displayed frame's top
	// border rows scan on the last BorderTop lines of the sweep, just
	// before the wrap to line 0. Each row takes its line's END-of-line
	// palette state (line granularity — the per-pixel copper interleave
	// covers only the paper rows; see known-gaps.md).
	//
	// The copper advance + per-line scroll capture run even WITHOUT the
	// live-ULA render: content that disables the ULA output entirely
	// (NR$68 bit 7 — RAMS) still runs its copper across the border
	// lines, where RAMS's Galaxian writes the HUD bands' tilemap
	// scroll. Only the border-pixel repaint (live palette resolve) is
	// liveULA machinery.
	if liveULA || u.nextCopper != nil {
		for v := h; v < frameLines; v++ {
			imgRow := -1
			switch {
			case v < h+u.borderTop:
				imgRow = u.borderTop + v // bottom border, right after the paper
			case v >= frameLines-u.borderTop:
				imgRow = v - (frameLines - u.borderTop) // top border, end of sweep
			}
			// Border rows: same per-row scroll capture as the paper
			// walk (raster = image row + 32 on the wide frame),
			// BEFORE this line's copper ops — the start-of-line state
			// (see the paper walk's capture comment).
			if imgRow >= 0 && scrollCap != nil {
				scrollCap.CaptureTilemapRowScroll(imgRow + 32)
			}
			// Stamped-palette replay for the sweep rows. Bottom border
			// rows scan at raster v+64, straight after the paper. The
			// displayed frame's top border rows scanned BEFORE the
			// paper (raster 40..63), so when the sweep reaches them the
			// applied writes rewind to the frame start and replay
			// forward again from there.
			if liveULA && palReplay != nil {
				if v < frameLines-u.borderTop {
					palReplay.ReplayPaletteThrough(64 + v)
				} else {
					if v == frameLines-u.borderTop {
						palReplay.RewindPaletteReplay()
					}
					palReplay.ReplayPaletteThrough(v - (frameLines - u.borderTop) + (64 - u.borderTop))
				}
			}
			if paced != nil && liveULA {
				paced.RunToCycle(uint16(v), lineEndCycle)
			} else if u.nextCopper != nil {
				// Non-live flow (the paper walk used per-row Step): keep
				// stepping so line-192..311 WAITs release on their line.
				u.nextCopper.Step(uint16(v), 455, copperCyclesPerScanline)
			}
			if imgRow >= 0 {
				if liveULA {
					pushSelect(u.ulaVideoLine[imgRow].ulaPalSecond)
					c := u.nextBorderRGBA(imgRow, resolver)
					off := imgRow * u.img.Stride
					for x := 0; x < TotalWidth; x++ {
						o := off + x*4
						u.img.Pix[o+0] = c[0]
						u.img.Pix[o+1] = c[1]
						u.img.Pix[o+2] = c[2]
						u.img.Pix[o+3] = c[3]
					}
				}
			}
		}
	}

	// Border-area tilemap pass. Tilemap content in NextZXOS Browser
	// (40×32 tile grid = 320×256 pixels) extends beyond the classic
	// 256×192 inner screen into the 32-px border ring. The inner pass
	// above already painted tilemap inside the 256×192 box; here we
	// walk the FULL 320×256 image and only touch border pixels.
	if u.nextCompositor.HasActiveTilemap() {
		if u.compositorRow == nil {
			u.compositorRow = make([]byte, TotalWidth*4)
		}
		rowFull := u.compositorRow
		for y := 0; y < u.totalHeight; y++ {
			imgRowStart := y * u.img.Stride
			copy(rowFull, u.img.Pix[imgRowStart:imgRowStart+TotalWidth*4])
			// The image IS the 320×256 wide frame, and the tilemap
			// shares the sprite frame's origin (same whc/wvc
			// counters, zxnext.vhd:4337/4389): image row y = tilemap
			// row y, all 256 rows visible.
			inBorder := func(x int) bool {
				return x < BorderLeft || x >= BorderLeft+ScreenWidth
			}
			if y < u.borderTop || y >= u.borderTop+ScreenHeight {
				// Above or below the inner screen: every x is
				// border, paint the whole row.
				inBorder = func(int) bool { return true }
			}
			u.nextCompositor.ComposeBorderRow(y, rowFull, inBorder)
			copy(u.img.Pix[imgRowStart:imgRowStart+TotalWidth*4], rowFull)
		}
	}

	// Sprite border pass. Sprites are frame-relative (320x256, paper at 32,32),
	// so this image's row r maps to sprite vcounter r + spriteFrameYBias. The
	// inner paper pass already drew sprites inside the 256x192 box; here we walk
	// the full image and paint sprite pixels only in the border strips — the
	// top/bottom borders (where games park HUD sprites, e.g. Nextoid's
	// SHIPS/SCORE row at frame Y 224-225) and the 32-px L/R borders of screen
	// rows. The sprite engine's over-border clip gates whether they show.
	if u.nextCompositor.HasActiveSprites() {
		// The image IS the 320×256 sprite frame (SetNextCompositor
		// switched the geometry): image row r = sprite vcounter r.
		if u.compositorRow == nil {
			u.compositorRow = make([]byte, TotalWidth*4)
		}
		rowFull := u.compositorRow
		for y := 0; y < u.totalHeight; y++ {
			imgRowStart := y * u.img.Stride
			copy(rowFull, u.img.Pix[imgRowStart:imgRowStart+TotalWidth*4])
			inBorder := func(x int) bool {
				return x < BorderLeft || x >= BorderLeft+ScreenWidth
			}
			if y < u.borderTop || y >= u.borderTop+ScreenHeight {
				inBorder = func(int) bool { return true }
			}
			u.nextCompositor.ComposeSpriteBorderRow(y, rowFull, inBorder)
			copy(u.img.Pix[imgRowStart:imgRowStart+TotalWidth*4], rowFull)
		}
	}
}

// ulaNextPaperShift maps a canonical ULANext ink mask (NR$42) to the paper
// index shift: paper = 128 | attr>>shift (video/zxula.vhd:516-527's case
// arms). 0 = non-canonical mask (paper/border show the NR$4A background).
func ulaNextPaperShift(format byte) int {
	switch format {
	case 0x01:
		return 1
	case 0x03:
		return 2
	case 0x07:
		return 3
	case 0x0F:
		return 4
	case 0x1F:
		return 5
	case 0x3F:
		return 6
	case 0x7F:
		return 7
	}
	return 0
}

// nextBorderRGBA resolves image row imgRow's (0..TotalHeight-1) border
// colour through the LIVE Next ULA palette via nextBorderColourRGBA,
// using the raster-stamped ULA-video state for that row.
func (u *ULA) nextBorderRGBA(imgRow int, res nextULAPaletteResolver) [4]byte {
	return u.nextBorderColourRGBA(u.borderLineColours[imgRow], res, u.ulaVideoLine[imgRow])
}

// nextBorderColourRGBA resolves a port-$FE border colour through the LIVE
// Next ULA palette: entry 128+border in ULANext mode (video/zxula.vhd:
// 496-504 — paper_base & border), entry 16+border otherwise (zxula.vhd:547
// — border pixels take the standard paper path, bright 0). A transparent
// entry (== NR$14) and the ULANext all-ink format $FF show the NR$4A
// fallback.
func (u *ULA) nextBorderColourRGBA(borderColour byte, res nextULAPaletteResolver, st ulaVideoState) [4]byte {
	border := borderColour & 7
	// Timex hi-res: the border takes the synthesized hi-res attribute
	// instead of port $FE (zxula.vhd:425-427 — attr_reg <=
	// border_clr_tmx for screen_mode(2)), so it decodes to the hi-res
	// PAPER colour: ULANext border path = 128 + attr(5:3) = 128 +
	// NOT(colour) (the core-2.00.25+ "index 130" behaviour the upstream
	// LayersMixingHiRes ReadMe documents), classic = 24 + NOT(colour).
	if u.timexVideoMode&0x07 == 0x06 && u.mem != nil && u.mem.ScreenPage != 7 {
		notColour := ^(u.timexVideoMode >> 3) & 0x07
		idx := 24 + notColour
		if st.ulaNextEnabled {
			idx = 128 + notColour
		}
		r, g, b, transparent := res.ULARGBA(idx)
		if st.ulaNextEnabled && st.ulaNextFormat == 0xFF {
			transparent = true
		}
		if transparent {
			f := u.ulaDisabledFill()
			r, g, b = f.R, f.G, f.B
		}
		return [4]byte{r, g, b, 0xFF}
	}
	var r, g, b byte
	var transparent bool
	switch {
	case st.ulaNextEnabled:
		if st.ulaNextFormat == 0xFF {
			transparent = true
		} else {
			r, g, b, transparent = res.ULARGBA(128 + border)
		}
	case st.ulaPlusEnabled:
		// ULA+ border: the border attribute is "00" & border & border
		// (zxula.vhd:418), decoded through the ULA+ paper path
		// (:531-541) → entry "11" & "00" & '1' & border = $C8+border.
		r, g, b, transparent = res.ULARGBA(0xC8 + border)
	default:
		r, g, b, transparent = res.ULARGBA(16 + border)
	}
	if transparent {
		f := u.ulaDisabledFill()
		r, g, b = f.R, f.G, f.B
	}
	return [4]byte{r, g, b, 0xFF}
}

// liveULAResolver returns the compositor's live ULA palette resolver when
// the live-palette render applies: a resolver is wired and the ULA layer
// paints (the disabled-fill path keeps its pre-render). Timex hi-res
// frames use the live render too — decimated per row in the 320 walk,
// with the stable-frame 512-wide re-composite on top
// (renderWideTimexHiRes).
func (u *ULA) liveULAResolver() (nextULAPaletteResolver, bool) {
	res, ok := u.nextCompositor.(nextULAPaletteResolver)
	if !ok || u.ulaOutputDisabled {
		return nil, false
	}
	return res, true
}

// paintImagePixel writes one RGBA pixel at image column x of display row y.
func (u *ULA) paintImagePixel(y, x int, c [4]byte) {
	off := (u.borderTop+y)*u.img.Stride + x*4
	u.img.Pix[off+0] = c[0]
	u.img.Pix[off+1] = c[1]
	u.img.Pix[off+2] = c[2]
	u.img.Pix[off+3] = c[3]
}

// renderNextULARow renders one 256-pixel ULA row straight from screen RAM
// through the LIVE Next ULA palette — the FPGA feeds every ULA pixel
// through the palette SRAM (video/zxula.vhd:483-558), so palette
// redefinitions (NR$40/$41/$44, incl. copper MOVEs) recolour the classic
// screen. Index composition per that process:
//
//	standard: ink = bright<<3 | ink, paper = 16 | bright<<3 | paper
//	          (attr bit 7 flash swaps ink/paper, standard mode only)
//	ULANext:  ink = attr & format; paper = 128 | attr>>shift for the
//	          canonical formats, else the NR$4A background
//
// Transparent pixels (palette value == NR$14) are emitted with alpha 0 —
// the compositor's per-pixel ULA transparency signal. When a cycle-paced
// copper is wired, execution interleaves per pixel so mid-scanline MOVEs
// recolour from exactly their pixel onward.
func (u *ULA) renderNextULARow(y int, dst []byte, res nextULAPaletteResolver,
	paced nextCopperCyclePaced, pixelCycle func(int) int, st ulaVideoState) {
	screenMem := u.mem.GetPage(u.mem.ScreenPage)
	fallback := u.ulaDisabledFill()
	paperShift := ulaNextPaperShift(st.ulaNextFormat)
	// Timex display mode (port $FF bits 2:0, zxula.vhd:191): bit 0
	// selects display file 2 (+$2000, "screen 1"), bit 1 the 8x1
	// hi-colour attributes. With the ULA shadow display active the mode
	// is forced to 000 (bank 7 only has 8K BRAM on the FPGA — same
	// line). Hi-res (bit 2) renders through the wide path, not here.
	// Read live (not raster-stamped): the copper interleave updates it
	// through the NR$69 fan-out before each row's render, giving the
	// row granularity the NReg0x69 scanline-switch test expects.
	mode := u.timexVideoMode & 0x07
	if u.mem.ScreenPage == 7 {
		mode = 0
	}
	pixBase := 0
	if mode&0x01 != 0 {
		pixBase = 0x2000 // vram_a bit 13 = screen_mode(0), zxula.vhd:235
	}
	hiCol := mode&0x02 != 0
	// Timex hi-res inside a MIXED-mode frame (a copper switching NR$69
	// per band — renderWideTimexHiRes handles the stable whole-frame
	// case): decimate to 256 pixels by sampling the even half-pixels
	// (display file 1) and decode through the synthesized hi-res
	// attribute "01" & NOT(colour) & colour (zxula.vhd:419).
	hiRes := mode&0x04 != 0
	var hiResAttr byte
	if hiRes {
		colour := (u.timexVideoMode >> 3) & 0x07
		hiResAttr = 0x40 | (^colour&0x07)<<3 | colour
		hiCol = false
	}
	// Classic attributes live at +$1800 of the SELECTED display file
	// (screen 1 attrs at $7800: vram_a = screen_mode(0) & "110" & …,
	// zxula.vhd:239-241).
	attrMem := screenMem[pixBase+0x1800:]
	// LoRes/Radastan layer (NR$15 bit 7): while enabled, the LoRes pixel
	// replaces the classic ULA pixel wherever the shared NR$1A clip
	// admits it (zxnext.vhd:6980 — ulalores_pixel_1 <= lores_pixel when
	// lores_pixel_en else ula_pixel). LoRes has its OWN scroll pair
	// (NR$32/$33) and dfile select (port $FF bit 0 XOR NR$6A bit 4,
	// zxnext.vhd:6796); the ULA's NR$26/$27 scroll does not apply to it.
	loresOn := st.nr15&0x80 != 0
	var loresCfg lores.Config
	var loresBank []byte
	if loresOn {
		loresCfg = lores.Config{
			Radastan:      u.loresRadastan,
			Dfile:         (u.timexVideoMode&0x01 != 0) != u.loresRadastanXor,
			PaletteOffset: u.loresPaletteOffset,
			ScrollX:       u.loresScrollX,
			ScrollY:       u.loresScrollY,
		}
		loresBank = u.mem.GetPage(5)
	}
	// ULA Y hardware scroll (NR$27): source row = (y + scroll) mod 192 —
	// zxula.vhd:192 (py_s = vc + scroll_y) folded back into 0..191 at
	// :201-208. Attributes fetch through the same scrolled row (:222-223).
	srcY := (y + int(u.ulaScrollY)) % ScreenHeight
	attrRow := attrMem[(srcY>>3)*32:]
	rowClipped := y < int(u.ulaClipY1) || y > int(u.ulaClipY2)
	for x := 0; x < ScreenWidth; x++ {
		if paced != nil {
			paced.RunToCycle(uint16(y), pixelCycle(x))
		}
		// ULA X hardware scroll (NR$26): source column = (x + scroll)
		// mod 256 — zxula.vhd:199 adds the scroll's char column mod 32
		// and appends its low bits; the neighbouring char loads via
		// px_1 (char+1 mod 32), so the wrap is a clean mod-256.
		srcX := (x + int(u.ulaScrollX)) & 0xFF
		var idx byte
		background := false
		if loresOn {
			// 8-bit LoRes palette index through the full ULA palette
			// (lores.vhd:102-111); resolved below via the same live
			// ULARGBA path, NR$14 transparency included.
			addr := loresCfg.Address(uint16(x), uint16(y))
			var data byte
			if loresBank != nil && int(addr) < len(loresBank) {
				data = loresBank[addr]
			}
			_, idx, _ = loresCfg.Pixel(uint16(x), uint16(y), data)
		} else {
			pixels := screenMem[pixBase+screenAddrForRowCol(srcY, srcX>>3)]
			var attr byte
			switch {
			case hiRes:
				attr = hiResAttr // display file 1 already sampled above
			case hiCol:
				// Timex hi-colour: the attribute byte fetches through the
				// PIXEL address layout with vram_a bit 13 = 1 — one
				// attribute per 8x1 pixel row (zxula.vhd:238-239 '1' &
				// addr_p_spc_12_5).
				attr = screenMem[0x2000+screenAddrForRowCol(srcY, srcX>>3)]
			default:
				attr = attrRow[srcX>>3]
			}
			on := pixels&(0x80>>uint(srcX&7)) != 0
			switch {
			case st.ulaNextEnabled:
				if on {
					idx = attr & st.ulaNextFormat
				} else if paperShift == 0 {
					background = true
				} else {
					idx = 128 | attr>>paperShift
				}
			case st.ulaPlusEnabled:
				// ULA+ (zxula.vhd:531-541): palette entry "11" &
				// attr(7:6) & paper-bit & colour — the 64-entry ULA+
				// palette at 192-255 of the ULA palette, four 16-entry
				// CLUTs selected by the old flash/bright bits. Flash
				// never swaps (zxula.vhd:470 gates it on NOT ulap_en).
				if on {
					idx = 0xC0 | attr>>2&0x30 | attr&7
				} else {
					idx = 0xC0 | attr>>2&0x30 | 0x08 | attr>>3&7
				}
			default:
				if u.flash && attr&0x80 != 0 {
					on = !on
				}
				bright := (attr >> 6) & 1
				if on {
					idx = bright<<3 | attr&7
				} else {
					idx = 16 | bright<<3 | (attr>>3)&7
				}
			}
		}
		var r, g, b byte
		var transparent bool
		switch {
		case rowClipped || x < int(u.ulaClipX1) || x > int(u.ulaClipX2):
			// NR$1A clip: a paper pixel outside the inclusive window is
			// transparent — lower layers / NR$4A fallback show
			// (zxula.vhd:562 o_ula_clipped → zxnext.vhd:7100).
			r, g, b = fallback.R, fallback.G, fallback.B
			transparent = true
		case background:
			r, g, b = fallback.R, fallback.G, fallback.B
		default:
			r, g, b, transparent = res.ULARGBA(idx)
		}
		off := x * 4
		dst[off+0] = r
		dst[off+1] = g
		dst[off+2] = b
		if transparent {
			dst[off+3] = 0
		} else {
			dst[off+3] = 0xFF
		}
	}
}

// renderNextTimexHiResRow renders one 512-half-pixel Timex hi-res ULA
// row through the live palette. Pixel stream per zxula.vhd:389 — in
// hi-res the shift register interleaves the two display files byte by
// byte (even display byte = file 1, odd = file 2), so half-pixel h maps
// to display byte h>>3 (file = byte&1) bit h&7. Every half-pixel decodes
// through the SYNTHESIZED hi-res attribute "01" & NOT(colour) & colour
// (border_clr_tmx, zxula.vhd:419/425-427) via the normal ULANext /
// standard paths, then the palette — the ReadMe-documented "ink 5,
// paper 138" decomposition for colour code 5 under ink-mask 7 falls out
// of exactly this. The ULA X scroll shifts by classic pixels (two
// half-pixels); Y scroll and the NR$1A clip fold as in the 256 render.
func (u *ULA) renderNextTimexHiResRow(y int, dst []byte, res nextULAPaletteResolver, st ulaVideoState) {
	screenMem := u.mem.GetPage(u.mem.ScreenPage)
	fallback := u.ulaDisabledFill()
	paperShift := ulaNextPaperShift(st.ulaNextFormat)
	colour := (u.timexVideoMode >> 3) & 0x07
	attr := 0x40 | (^colour&0x07)<<3 | colour
	srcY := (y + int(u.ulaScrollY)) % ScreenHeight
	rowClipped := y < int(u.ulaClipY1) || y > int(u.ulaClipY2)
	for sx := 0; sx < 2*ScreenWidth; sx++ {
		// Scroll at classic-pixel granularity = two half-pixels.
		hsrc := (sx + 2*int(u.ulaScrollX)) & 0x1FF
		dpByte := hsrc >> 3 // 0..63 display bytes per row
		fileOff := 0
		if dpByte&1 == 1 {
			fileOff = 0x2000 // odd display bytes come from file 2
		}
		pixels := screenMem[fileOff+screenAddrForRowCol(srcY, dpByte>>1)]
		on := pixels&(0x80>>uint(hsrc&7)) != 0
		var idx byte
		background := false
		if st.ulaNextEnabled {
			if on {
				idx = attr & st.ulaNextFormat
			} else if paperShift == 0 {
				background = true
			} else {
				idx = 128 | attr>>paperShift
			}
		} else {
			bright := (attr >> 6) & 1
			if on {
				idx = bright<<3 | attr&7
			} else {
				idx = 16 | bright<<3 | (attr>>3)&7
			}
		}
		var r, g, b byte
		var transparent bool
		cx := sx >> 1 // classic-pixel coordinate for the clip window
		switch {
		case rowClipped || cx < int(u.ulaClipX1) || cx > int(u.ulaClipX2):
			r, g, b = fallback.R, fallback.G, fallback.B
			transparent = true
		case background:
			r, g, b = fallback.R, fallback.G, fallback.B
		default:
			r, g, b, transparent = res.ULARGBA(idx)
		}
		off := sx * 4
		dst[off+0] = r
		dst[off+1] = g
		dst[off+2] = b
		if transparent {
			dst[off+3] = 0
		} else {
			dst[off+3] = 0xFF
		}
	}
}

// renderWideTimexHiRes builds the 640-wide frame for a STABLE Timex
// hi-res frame on the Next: the composed 320 base (borders, sprite
// strips — and the decimated paper, which this pass replaces) is
// pixel-doubled, then each paper row is re-rendered at its native 512
// half-pixels and re-composited against the layer stack at half-pixel
// granularity (the FPGA mixes at its full pixel clock, so a sprite or
// Layer 2 pixel covers two ULA half-pixels — the LayersMixingHiRes
// checker rows exercise exactly this). Falls back to the doubled base
// when the compositor lacks the hi-res pass.
func (u *ULA) renderWideTimexHiRes() *image.RGBA {
	const ww = 2 * TotalWidth
	if u.wideImg == nil {
		u.wideImg = image.NewRGBA(image.Rect(0, 0, ww, u.totalHeight))
		u.wideRow = make([]byte, ww*4)
	}
	wide := u.wideImg
	for y := 0; y < u.totalHeight; y++ {
		srcStart := y * u.img.Stride
		dstStart := y * wide.Stride
		for x := 0; x < TotalWidth; x++ {
			s := srcStart + x*4
			r, g, b, a := u.img.Pix[s+0], u.img.Pix[s+1], u.img.Pix[s+2], u.img.Pix[s+3]
			d := dstStart + x*8
			wide.Pix[d+0], wide.Pix[d+1], wide.Pix[d+2], wide.Pix[d+3] = r, g, b, a
			wide.Pix[d+4], wide.Pix[d+5], wide.Pix[d+6], wide.Pix[d+7] = r, g, b, a
		}
	}
	res, okRes := u.nextCompositor.(nextULAPaletteResolver)
	comp, okComp := u.nextCompositor.(interface {
		ComposeHiResScanline(y int, ulaRGBA []byte, dst []byte)
	})
	if !okRes || !okComp {
		return wide
	}
	// Raster-stamped replay for the re-composite, as in the 320 walk.
	selector, _ := u.nextCompositor.(nextULAPaletteSelector)
	prioOverride, _ := u.nextCompositor.(interface {
		SetPriorityModeOverride(byte)
		ClearPriorityModeOverride()
	})
	defer func() {
		if selector != nil {
			selector.SetULAActivePalette(u.ulaPalSecond)
		}
		if prioOverride != nil {
			prioOverride.ClearPriorityModeOverride()
		}
	}()
	scan := make([]byte, 2*ScreenWidth*4)
	composed := make([]byte, 2*ScreenWidth*4)
	for y := 0; y < ScreenHeight; y++ {
		st := u.ulaVideoLine[u.borderTop+y]
		if selector != nil {
			selector.SetULAActivePalette(st.ulaPalSecond)
		}
		if prioOverride != nil {
			prioOverride.SetPriorityModeOverride((st.nr15 >> 2) & 0x07)
		}
		u.renderNextTimexHiResRow(y, scan, res, st)
		comp.ComposeHiResScanline(y, scan, composed)
		dstStart := (u.borderTop+y)*wide.Stride + 2*BorderLeft*4
		copy(wide.Pix[dstStart:dstStart+2*ScreenWidth*4], composed)
	}
	return wide
}

// StartRecording begins capturing the audio output to a WAV file. Returns
// nil if no audio system is available (in which case recording is silently
// skipped).
func (u *ULA) StartRecording(path string) error {
	if u.audio == nil {
		return nil
	}
	return u.audio.StartRecording(path)
}

// StopRecording finalises the active WAV recording, if any.
func (u *ULA) StopRecording() error {
	if u.audio == nil {
		return nil
	}
	return u.audio.StopRecording()
}

// IsRecording reports whether a WAV recording is currently in progress.
func (u *ULA) IsRecording() bool {
	if u.audio == nil {
		return false
	}
	return u.audio.IsRecording()
}

// EnableAudio initializes and starts the audio system.
// Call this from the application (not tests) after creating the ULA.
func (u *ULA) EnableAudio() {
	audioSys, err := audio.New()
	if err != nil {
		log.Printf("Warning: Failed to initialize audio system: %v", err)
		return
	}
	u.audio = audioSys
	// Prefer the Next's multi-chip AY engine when wired; otherwise the classic
	// single AY. (On the Next, SetNextAY usually runs after this and re-wires
	// it anyway, but handle the already-wired order too.)
	if u.nextAY != nil {
		u.audio.SetAY(u.nextAY)
	} else if u.ay != nil {
		u.audio.SetAY(u.ay)
	}
	// The Spectrum Next DAC (ModelNext) is mixed event-timed in flushAudioFrame
	// (see its GenerateFrame), so it is NOT wired into the audio system's
	// per-pull DACSource path here.
	if err := u.audio.Start(); err != nil {
		log.Printf("Warning: Failed to start audio system: %v", err)
	}
}

// Audio returns the ULA's audio system, or nil before EnableAudio. The wasm
// build's zxPullAudio export drains it from the page (audio.PullMono).
func (u *ULA) Audio() *audio.AudioSystem {
	return u.audio
}

// SetPeripherals sets the peripheral manager for I/O port delegation
func (u *ULA) SetPeripherals(pm *peripherals.PeripheralManager) {
	u.peripherals = pm
}

// SetAudioKeepAliveLevel forwards a keep-alive dither level to the audio
// system (no-op if audio isn't enabled). See audio.SetKeepAliveLevel.
func (u *ULA) SetAudioKeepAliveLevel(level int16) {
	if u.audio != nil {
		u.audio.SetKeepAliveLevel(level)
	}
}

// SetDCBlockEnabled toggles the audio DC-blocking high-pass filter. Off emits
// the raw ±beeper levels (faithful squares, but the idle DC rail/click
// returns) — primarily an A/B diagnostic.
func (u *ULA) SetDCBlockEnabled(enabled bool) {
	u.dcEnabled = enabled
}

// SetFastLoad toggles fast-tape-turbo audio muting. While true, flushAudioFrame
// emits silence because the per-frame audio reconstruction is meaningless when
// dozens of emulated frames are collapsed into one audio frame.
func (u *ULA) SetFastLoad(on bool) {
	u.fastLoad = on
}

// FEReadCount returns the monotonic count of port-$FE reads. The fast-load
// turbo samples this per frame: a high read rate means the CPU is in a tape
// loader's edge-timing loop, a low rate means the game is running (only
// sparse keyboard reads), so turbo can stop once the program is live.
func (u *ULA) FEReadCount() uint64 {
	return u.feReadCount
}

// SetTapePlayer sets the tape player for tape loading. The tape clock is
// re-synced to the current reference T-state so playback starts "now" rather
// than jumping forward by the whole elapsed run.
func (u *ULA) SetTapePlayer(tp *TapePlayer) {
	u.tape = tp
	u.lastTapeTstate = u.refNow()
}

// frameTStates returns the current model's real frame length in 3.5 MHz
// T-states — the window the per-frame audio reconstruction integrates over.
// Looked up per frame (not cached) so a runtime SwitchModel is picked up.
func (u *ULA) frameTStates() int {
	if u.mem == nil {
		return roms.Model48K.FrameTStates()
	}
	return u.mem.GetCurrentModel().FrameTStates()
}

// refNow returns the current position on the 3.5 MHz-reference timeline used
// for audio/tape event timing: the CPU's segment-scaled reference clock on
// the Next (z80.CPU.RefTstates — correct across mid-frame NR$07 turbo
// changes), the raw T-state counter on every other model.
func (u *ULA) refNow() uint64 {
	if u.mem == nil {
		return 0
	}
	if u.mem.RefTstates != nil {
		return u.mem.RefTstates()
	}
	if u.mem.TStates != nil {
		return *u.mem.TStates
	}
	return 0
}

// audioFrameOffset returns the current event offset within the audio frame,
// in 3.5 MHz-reference T-states. It reads the CPU's reference clock rather
// than dividing the raw within-frame delta by the CURRENT turbo multiplier:
// the division was only correct while the whole frame ran at one speed. A
// game that drops to 3.5 MHz mid-frame just for a beeper effect (Next games
// do exactly this, since a timed loop plays 8x too high at 28 MHz) had its
// slow-segment offsets left at turbo scale — events landed past the frame
// window (dropped, so silence) or out of order (garbled reconstruction).
func (u *ULA) audioFrameOffset() int {
	return int(u.refNow() - u.frameStartRefTstate)
}

// tapeLevel advances the tape player to the current reference T-state and
// returns the live EAR level. Called from every port-$FE read so edge-timed
// loaders (the ROM's LD-BYTES and games' custom turbo loaders alike) sample
// real pulses instead of a per-frame-frozen level. When no tape is loaded
// it's a cheap no-op returning the last level. Tape pulses are defined in
// 3.5 MHz T-states; the reference clock advances at exactly that rate
// through any turbo changes, so no per-call multiplier scaling is needed —
// an edge-timed loader polling at 28 MHz still sees correctly-sized pulses
// (a raw-clock delta would look 8x too long and NextZXOS's Tape Loader
// would hang on a blank screen).
func (u *ULA) tapeLevel() bool {
	if u.tape == nil || u.mem == nil || u.mem.TStates == nil {
		return u.TapeIn
	}
	now := u.refNow()
	prev := u.TapeIn
	playing := u.tape.IsPlaying()
	if now > u.lastTapeTstate && playing {
		u.TapeIn = u.tape.Update(now - u.lastTapeTstate)
	}
	u.lastTapeTstate = now
	// Record EAR transitions so flushAudioFrame can reproduce the loading sound.
	if u.audio != nil && playing && u.TapeIn != prev {
		if off := u.audioFrameOffset(); off >= 0 && off < u.frameTStates() {
			u.tapeAudioEvents = append(u.tapeAudioEvents, audioEvent{tstateOffset: off, state: u.TapeIn})
		}
	}
	return u.TapeIn
}

// GetTapePlayer returns the currently loaded tape player (or nil).
func (u *ULA) GetTapePlayer() *TapePlayer {
	return u.tape
}

// Reset resets the ULA to initial state
func (u *ULA) Reset() {
	u.BorderColour = 0
	u.frameStartBorderColour = 0
	u.Mic = false
	u.TapeIn = false
	u.tapeAudioEvents = u.tapeAudioEvents[:0]
	u.frameStartTapeState = false
	u.Speaker = false
	u.flash = false
	u.flashCount = 0
	u.KempstonState = 0
	// The FPGA clears the whole port_ff_reg on reset (zxnext.vhd:3611).
	// Only the frame-INT disable latch (bit 6) is cleared here: a stale
	// disable would leave the machine INT-less after a reset, while the
	// video bits keep their long-standing survive-reset behaviour (the
	// next boot's NR$69 write refreshes them anyway).
	if u.timexVideoMode&0x40 != 0 {
		u.SetULAFrameIntDisable(false)
	}
	// Clear any per-scanline border changes left in the buffer.
	// Without this, a model switch (e.g. 48K -> Next via the
	// Machine menu) inherits the previous model's border writes;
	// the next Render() then paints the stale colour bands as
	// horizontal stripes in the border before any new writes
	// happen. The drawn cells stay visible until the next Render
	// frame's clear at the end of the border-render block.
	u.borderChanges = u.borderChanges[:0]

	if u.audio != nil {
		u.audio.Reset()
	}
	// Re-arm the DC blocker so the first post-reset frame establishes a fresh
	// silent baseline (the audio queue is re-primed with silence too). This is
	// what stops the reset itself (e.g. a +3 disk boot) from clicking.
	u.dc.reset()

	// Sync the AY presence with the current memory model. SwitchModel may
	// have changed the machine since the ULA was created, so we (re)create
	// the AY here for any 128K+ model and detach it on a plain 48K.
	if u.mem.GetCurrentModel() != roms.Model48K {
		if u.ay == nil {
			u.ay = ay.New()
		} else {
			u.ay.Reset()
		}
		if u.nextAY != nil {
			u.nextAY.Reset() // reset all TurboSound chips (incl. chip 0 == u.ay)
		}
		// Keep the mixer pointed at the engine on the Next (chip 0 == u.ay), or
		// the single AY otherwise — so AY music survives a reset/reboot.
		if u.audio != nil {
			if u.nextAY != nil {
				u.audio.SetAY(u.nextAY)
			} else {
				u.audio.SetAY(u.ay)
			}
		}
	} else {
		if u.ay != nil {
			u.ay = nil
			if u.audio != nil {
				u.audio.SetAY(nil)
			}
		}
	}

	// Reset beeper sample generation state.
	u.audioEvents = u.audioEvents[:0]
	u.frameStartSpeakerState = false
	if u.mem.TStates != nil {
		u.frameStartTstate = *u.mem.TStates
		u.frameStartRefTstate = u.refNow()
	}
}

// flushAudioFrame synthesises the beeper waveform for the just-finished
// frame from the recorded speaker events, pushes it to the audio
// system, and resets the per-frame state for the next frame.
func (u *ULA) flushAudioFrame() {
	if u.audio == nil {
		return
	}
	// During fast-tape turbo, many emulated frames collapse into this single
	// audio frame, so the reconstructed waveform is garbled. Emit silence and
	// re-arm the DC blocker so normal audio resumes cleanly once loading ends.
	if u.fastLoad {
		u.audioEvents = u.audioEvents[:0]
		u.tapeAudioEvents = u.tapeAudioEvents[:0]
		u.frameStartTapeState = false
		u.frameStartSpeakerState = u.Speaker
		u.dc.reset()
		u.audio.PushBeeperSamples(make([]int16, audio.SamplesPerFrame))
		if u.mem.TStates != nil {
			u.frameStartTstate = *u.mem.TStates
			u.frameStartRefTstate = u.refNow()
		}
		return
	}
	u.LastAudioEventCount = len(u.audioEvents)
	tpf := u.frameTStates()
	samples, finalState := generateBeeperFrame(u.audioEvents, u.frameStartSpeakerState, tpf)
	// Mix the SpecDrum/Covox DAC frame (event-timed, sample-accurate) into the
	// beeper waveform before pushing it.
	if u.speccyDAC != nil && u.speccyDAC.Enabled() {
		mixInt16(samples, u.speccyDAC.GenerateFrame(audio.SamplesPerFrame, tpf))
	}
	// Spectrum Next 4-channel DAC: event-timed, mixed the same way (replaces the
	// old per-pull MixInto snapshot).
	if gen, ok := u.nextDAC.(interface {
		GenerateFrame(int, int) []int16
	}); ok && gen != nil {
		mixInt16(samples, gen.GenerateFrame(audio.SamplesPerFrame, tpf))
	}
	// Tape-loading sound: reconstruct the EAR waveform and mix it in (the
	// audible pilot whistle + data screech). Only while a tape is playing
	// AND something is actually edge-timing it. The waveform is rebuilt
	// from EAR levels sampled at port-$FE reads, so it is only faithful
	// while a loader polls at tape rate (thousands of reads per frame).
	// When the deck merely rolls — the 128 menu, the autoload macro still
	// typing, a game running on after a trap fast-load — only the ~8
	// keyboard-scan reads per frame sample it, and the reconstruction
	// aliases the pilot tone into constant clicky noise (heard as a
	// GSM-interference-like buzz for the whole tape duration).
	feReads := u.feReadCount - u.lastFlushFEReads
	u.lastFlushFEReads = u.feReadCount
	if u.tape != nil && u.tape.IsPlaying() && feReads >= tapeAudioMinFEReads {
		tapeSamples, finalTape := generateSquareWaveFrame(
			u.tapeAudioEvents, u.frameStartTapeState, -tapeAudioAmplitude, tapeAudioAmplitude, tpf)
		mixInt16(samples, tapeSamples)
		u.frameStartTapeState = finalTape
	} else {
		u.frameStartTapeState = false
	}
	u.tapeAudioEvents = u.tapeAudioEvents[:0]

	// AC-couple the mix (beeper + tape + DAC) like the hardware's output
	// capacitor: a held level decays to silence and only edges make sound, so
	// idle/power-on/reset and the gaps between loader blocks no longer step
	// to a full-scale DC rail (the "battery click").
	if u.dcEnabled {
		u.dc.process(samples)
	}

	u.audio.PushBeeperSamples(samples)
	u.frameStartSpeakerState = finalState
	u.audioEvents = u.audioEvents[:0]
	if u.mem.TStates != nil {
		u.frameStartTstate = *u.mem.TStates
		u.frameStartRefTstate = u.refNow()
	}
}

// mixInt16 adds src into dst element-wise with int16 saturation. Used to fold
// the DAC frame into the beeper frame without wrap-around pops.
func mixInt16(dst, src []int16) {
	n := len(dst)
	if len(src) < n {
		n = len(src)
	}
	for i := 0; i < n; i++ {
		sum := int32(dst[i]) + int32(src[i])
		switch {
		case sum > 32767:
			dst[i] = 32767
		case sum < -32768:
			dst[i] = -32768
		default:
			dst[i] = int16(sum)
		}
	}
}

// generateBeeperFrame synthesises one frame's worth of mono beeper
// samples from a list of speaker-toggle events. Returns the samples
// and the speaker state at the end of the frame so the caller can
// seed the next frame's initial state.
//
// Each output sample is the *average* speaker level over the T-state
// range that sample represents — i.e. a box-filter integration. This
// matters because the speaker can toggle far faster than the audio
// sample rate (BEEP runs at a few kHz, the audio rate is ~44kHz with
// ~79 T-states per sample), so a sample window can contain several
// transitions. Point-sampling at the midpoint loses the duty cycle
// inside the window and snaps every transition to a sample boundary,
// which produces audible time-jitter — the "fuzzy" sound the
// midpoint version had on a clean square wave. Integration converts
// the jitter into amplitude variation, which is much less perceptible
// and naturally low-pass-filters the output.
func generateBeeperFrame(events []audioEvent, initialState bool, tstatesPerFrame int) (samples []int16, finalState bool) {
	return generateSquareWaveFrame(events, initialState, beeperLow, beeperHigh, tstatesPerFrame)
}

// generateSquareWaveFrame is the box-filter square-wave reconstruction shared by
// the beeper and the tape-loading sound: it integrates a 1-bit signal (toggled
// by `events`) into one frame of samples between `low` (state false) and `high`
// (state true). See generateBeeperFrame for why integration (not point-sampling)
// is used. tstatesPerFrame is the real frame length for the current model
// (roms.SpectrumModel.FrameTStates) — with the 48K value hardcoded here, the
// 128K/Next frame's last ~1020 T-states of toggles were dropped every frame and
// finalState missed them, phase-inverting whole frames: an audible 50Hz buzz on
// any sustained tone.
func generateSquareWaveFrame(events []audioEvent, initialState bool, low, high int16, tstatesPerFrame int) (samples []int16, finalState bool) {
	samples = make([]int16, audio.SamplesPerFrame)
	state := initialState
	eventIdx := 0

	delta := int32(high) - int32(low)
	lowV := int32(low)

	for i := 0; i < audio.SamplesPerFrame; i++ {
		sampleStart := i * tstatesPerFrame / audio.SamplesPerFrame
		sampleEnd := (i + 1) * tstatesPerFrame / audio.SamplesPerFrame
		sampleLen := sampleEnd - sampleStart

		// Walk events that fall inside [sampleStart, sampleEnd),
		// summing the T-states the speaker was high.
		highTstates := 0
		cur := sampleStart
		for eventIdx < len(events) && events[eventIdx].tstateOffset < sampleEnd {
			next := events[eventIdx].tstateOffset
			if next < cur {
				next = cur
			}
			if state {
				highTstates += next - cur
			}
			cur = next
			state = events[eventIdx].state
			eventIdx++
		}
		// Tail of the sample window (after the last event in it).
		if state {
			highTstates += sampleEnd - cur
		}

		if sampleLen > 0 {
			samples[i] = int16(lowV + delta*int32(highTstates)/int32(sampleLen))
		} else {
			samples[i] = low
		}
	}
	// Any event at or after the frame's final sample boundary never entered a
	// [sampleStart, sampleEnd) window above (the last window is exclusive at
	// tstatesPerFrame, and turbo-division rounding can land an offset on the
	// boundary), so it never updated state — drain the tail so finalState seeds
	// the next frame correctly instead of phase-inverting it.
	if eventIdx < len(events) {
		state = events[len(events)-1].state
	}
	return samples, state
}

// Beeper amplitude levels — symmetric around zero. The 1-bit speaker is
// rendered at ±beeperHigh and the per-frame mix is then DC-blocked (see
// dcBlocker) to model the real Spectrum's capacitor-coupled output, so an
// idle level decays to silence instead of sitting at a full-scale rail.
//
// The amplitude is capped so that a *full swing* (beeperLow→beeperHigh =
// 2·beeperHigh = 32000) stays inside int16: the DC blocker's step response
// is the swing height, so an isolated speaker toggle renders as a clean
// 32000 transient rather than a clipped 40000 spike. The remaining headroom
// (32767 − 16000) also covers one AY channel at max without clipping; the
// worst case (3 AY channels + beeper at peak) is rare and clips gracefully
// via the int32 saturation in MixInto.
const (
	beeperHigh int16 = 16000
	beeperLow  int16 = -16000

	// tapeAudioAmplitude is the peak level of the mixed-in tape-loading sound.
	// Below the beeper so it's clearly the loading tone, not deafening, and
	// leaves headroom for the beeper/AY in the saturating mix.
	tapeAudioAmplitude int16 = 9000

	// tapeAudioMinFEReads is the per-frame port-$FE read count above which
	// the CPU is considered to be edge-timing the tape, making the
	// read-sampled EAR reconstruction faithful enough to mix audibly. The
	// same rate threshold the fast-load turbo uses to detect active
	// loading (cmd's tapeLoadReadThreshold); keyboard scanning alone is ~8.
	tapeAudioMinFEReads = 500
)
