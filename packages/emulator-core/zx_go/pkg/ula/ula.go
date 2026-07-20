package ula

import (
	"image"
	"image/color"
	"log"
	"os"
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
	// xs is the horizontal output scale: 1 on classic machines (320-wide
	// frames), 2 when a Next compositor is wired — the live Next path
	// always emits a 640×256 frame (#183 stage 1: pure pixel doubling at
	// every row store, no resolution change; the half-pixel-native
	// content lands in the later pipeline stages). One output width for
	// one machine keeps the frame shape independent of per-frame video
	// modes, matching how the FPGA's 14 MHz pixel bus always carries two
	// half-pixel slots per 7 MHz pixel (zxnext.vhd:6543-6552).
	xs int
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
	// Stride census of the last compositor walk (#208 diagnostics):
	// paper rows that took the paced per-half-pixel stride, paper rows
	// half-strided for any reason, and border sweep rows resolved per
	// half-pixel (rowEvents). Plain counters — no gating, no cost.
	dbgRowsPaced         int
	dbgRowsHalf          int
	dbgBorderRowsEvented int
	compositorRow        []byte
	palette              [16]color.RGBA
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
	// tapeRefClock, when wired (SetTapeRefClock), supplies the monotonic
	// reference clock lastTapeTstate is kept on. See SetTapeRefClock.
	tapeRefClock func() uint64
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

	// Megadrive-only buttons of the left pad, held in their i_JOY
	// vector positions (bits 11..5 = MODE X Z Y START A C). The low
	// five bits of that vector are KempstonState, so they are not
	// duplicated here — MDJoyLeft composes the two. Read back by the
	// Next's NR $B2 and by the MD modes of ports $1F/$37.
	MDExtraState uint16

	// Count of guest reads decoding as the Kempston port, incremented
	// even when no Kempston interface is attached, and of the subset of
	// those made while a button was actually held. Diagnostic only —
	// neither affects what a read returns.
	KempstonPortReads      uint64
	KempstonReadsWhileHeld uint64

	// Per-low-byte tally of IN reads no device answered — see
	// UnattachedPortReads. Diagnostic only.
	unattachedReads [256]uint64

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
	// Beam-time paper capture (classic models): each line's bitmap and
	// attribute bytes copied when the beam completes that line's fetch
	// window (CaptureScanlines, driven by the CPU's ScanlineFunc hook).
	// Render prefers these rows; lineCapCount lines are valid this
	// frame. See CaptureScanlines for why end-of-frame memory is the
	// wrong thing to render (#194, Arkanoid's vblank-erased bat).
	lineCapBitmap [192][32]byte
	lineCapAttr   [192][32]byte
	lineCapCount  int
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
	// pixels of a full-frame RGBA row at xScale output pixels per
	// frame pixel (320*xScale wide). tilemapY is the row index
	// within the tilemap (0 = top of the full 320×256 Next
	// display). isInBorderArea(x) is in FRAME (320-space) x and
	// returns true for x values outside the classic 256-wide inner
	// screen; those are the pixels the border pass paints, leaving
	// inner pixels untouched.
	ComposeBorderRow(tilemapY int, dst []byte, xScale int, isInBorderArea func(x int) bool)
	// HasActiveSprites reports whether the sprite layer is wired AND
	// enabled, so the ULA knows whether to run the sprite border pass.
	HasActiveSprites() bool
	// ComposeSpriteBorderRow paints sprite pixels over the border-area
	// pixels of a full-frame RGBA row at xScale output pixels per frame
	// pixel. frameY is the sprite vcounter for this row (frame-relative);
	// isInBorderArea(x) selects the frame pixels to paint, leaving
	// inner-screen pixels to the main pass.
	ComposeSpriteBorderRow(frameY int, dst []byte, xScale int, isInBorderArea func(x int) bool)
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
	// RGBA row already holding the lower layers, at xScale output pixels
	// per LAYER 2 pixel (Layer2Width*xScale wide).
	ComposeWideLayer2Row(y int, dst []byte, xScale int)
	// OverpaintWideL2Row restores the layers the wide Layer 2 overlay
	// covered, in the active NR$15 order: sprites (non-L-topmost
	// modes) and the ULA+tilemap slot (the U-above-L modes) — the
	// hi-res Layer 2 path's layer-order repair. xScale is output
	// pixels per frame pixel (1 = 320, 2 = 640).
	OverpaintWideL2Row(frameY int, dst []byte, xScale int)
	// CaptureULABase snapshots the pure classic-ULA frame before the
	// overlay pass mutates it, so OverpaintWideL2Row can repaint
	// non-transparent ULA pixels above wide Layer 2 in the U-above-L
	// modes. A no-op (and invalidation) when those conditions don't
	// hold — call it every render, right before applyNextCompositor.
	CaptureULABase(pix []byte, stride, w, h int)
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

// nextAYA2OK applies the Next-only A2=1 term in the FPGA's AY port
// decode (zxnext.vhd:2646-2647: port_fffd/port_bffd require
// cpu_a(2)='1'). Classic machines keep their looser partial decode.
func (u *ULA) nextAYA2OK(addr uint16) bool {
	if u.mem == nil || u.mem.GetCurrentModel() != roms.ModelNext {
		return true
	}
	return addr&0x0004 != 0
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

// nextCopperLinePeek is the cycle-paced copper's optional companion: a
// side-effect-free "could any instruction retire on this line?" probe
// (pkg/next/copper CanRetireOnLine). Rows where it reports false take
// the render's pair-coalescing fast stride — one compute per 7 MHz
// pixel — because a copper that is stopped, parked on HALT, or parked
// on a WAIT for another line (strict line equality, copper.vhd:94)
// cannot change any video state mid-row (#183 Option C).
type nextCopperLinePeek interface {
	CanRetireOnLine(vcount uint16) bool
}

// nextLiveRowComposer is the optional compositor contract for the FUSED
// half-pixel compose (#183 stage 3): the ULA's paced row loop calls
// ComposeLiveHalfPixel once per 14 MHz slot INSIDE the copper
// interleave, so every layer's palette lookup and the mixer state
// (NR$15 priority, NR$68 blend, NR$14 transparency, NR$43 selects) are
// read at that half-pixel's own copper time — the FPGA's grain
// (zxnext.vhd:6799-6832 per-slot mixer input registers, :6981/:7033
// per-half-pixel palette BRAM lookups). Layer index buffers stay
// per-row (BeginLiveRow), which is itself the hardware grain for
// sprites (line-buffer build-ahead, sprites.vhd:537-540).
type nextLiveRowComposer interface {
	BeginLiveRow(y int)
	ComposeLiveHalfPixel(sx int, ula [4]byte) [4]byte
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

// nextPaletteSubLineReplay is the optional sub-line extension of the
// stamped-palette replay (#183 stage 5): the walk opens each paper row
// with ToLineStart (strictly-before-line writes), asks whether the row
// has its OWN stamps, and — when it does — applies them per half-pixel
// via WithinLine inside the row loop, so a CPU palette write recolours
// from its (line, hpos) raster position, the FPGA's next-lookup rule
// (zxnext.vhd:6969-6977).
type nextPaletteSubLineReplay interface {
	ReplayPaletteToLineStart(line int)
	ReplayPaletteWithinLine(line, hcount int)
	PaletteLineHasStamps(line int) bool
}

// nextLayerScrollFold is the optional compositor extension for the
// raster-stamped layer scrolls (tilemap NR$2F/$30/$31 AND Layer 2
// NR$16/$17/$71): Render opens the bracket (fold CPU stamps + start
// render-time capture), the compositor walk feeds per-row captures of
// copper scroll writes, and the deferred End re-enables CPU-write
// stamping after the wide passes.
type nextLayerScrollFold interface {
	FoldLayerScrolls(stale bool)
	CaptureLayerRowScroll(rasterLine int)
	EndLayerScrollCapture()
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
	bt, th, xs := BorderTop, TotalHeight, 1
	if c != nil {
		// The Next frame is 640×256: the FPGA's 320×256 wide frame at
		// its native 14 MHz half-pixel width (two output pixels per
		// 7 MHz frame pixel — see the xs field).
		bt, th, xs = NextBorderTop, NextTotalHeight, 2
	}
	if th != u.totalHeight || xs != u.xs {
		u.borderTop, u.totalHeight, u.xs = bt, th, xs
		u.img = image.NewRGBA(image.Rect(0, 0, TotalWidth*xs, th))
		// The wide scratch frame is geometry-dependent; drop it so the
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
		xs:          1,
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
// not painted (see Render). Forwarded to the Next compositor, whose wide-path
// tilemap overlay arbitrates BELOW-flagged tiles against the
// everywhere-transparent ULA (#196). Idempotent and safe to call every frame.
func (u *ULA) SetULAOutputDisabled(disabled bool) {
	u.ulaOutputDisabled = disabled
	if c, ok := u.nextCompositor.(interface{ SetULAOutputDisabled(bool) }); ok {
		c.SetULAOutputDisabled(disabled)
	}
}

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

// CaptureScanlines copies every paper line whose fetch window the
// beam has completed (fetch = the FIRST 128 T of the line, from the
// top-left-pixel time) into the beam-time capture buffer, and returns
// the T-state at which the next line's capture is due (or done-
// sentinel ^0 once all 192 lines are in). The CPU's ExecuteFrame
// polls this between instructions (ScanlineFunc), so the captured
// rows hold what the ULA actually FETCHED when the beam passed — not
// what memory holds at frame end. Beam-racing games depend on the
// difference: Arkanoid XOR-erases its bat during the vblank and
// redraws it next frame before the beam returns, so the bat exists
// on the CRT for every scan of its rows yet is ABSENT from memory at
// the frame boundary — an end-of-frame renderer shows no bat at all
// (#194). Render consumes these rows for the paper area and resets
// the buffer for the next frame; lines not captured (single-step
// paths, first frame) fall back to live memory, the old behaviour.
func (u *ULA) CaptureScanlines(now uint64) uint64 {
	const doneSentinel = ^uint64(0)
	if u.mem == nil {
		return doneSentinel
	}
	model := u.mem.GetCurrentModel()
	if model == roms.ModelNext {
		return doneSentinel
	}
	tPerLine := uint64(TStatesPerLineFor(model))
	paperStart := uint64(64) * tPerLine // 14336 on 48K
	if model != roms.Model48K {
		paperStart = 14362 // 128K family top-left pixel (libspectrum)
	}
	// A call before line 0's fetch completes can only be the frame-
	// start arming call (ExecuteFrame entry, T = the wrap overshoot):
	// start a fresh capture. Mid-frame calls are deadline-gated to
	// now >= due(lineCapCount) >= this threshold.
	if now < paperStart+128 {
		u.lineCapCount = 0
	}
	for u.lineCapCount < 192 {
		due := paperStart + uint64(u.lineCapCount)*tPerLine + 128
		if now < due {
			return due
		}
		screenBank := u.mem.ScreenPage
		if screenBank == 0 {
			screenBank = 5
		}
		page := u.mem.GetPage(screenBank)
		if page == nil {
			return doneSentinel
		}
		y := u.lineCapCount
		base := screenAddrForRowCol(y, 0)
		copy(u.lineCapBitmap[y][:], page[base:base+32])
		attrBase := 0x1800 + (y>>3)*32
		copy(u.lineCapAttr[y][:], page[attrBase:attrBase+32])
		u.lineCapCount++
	}
	return doneSentinel
}

// currentScanline returns the raster line of "now" for stamping
// mid-frame effects (border changes, video-state flips). On the Next
// it rides the 3.5 MHz REFERENCE timeline (the same clock
// BeamPosition and the palette/tilemap raster sources use), which is
// speed-INDEPENDENT — a CPU running at 14/28 MHz (NR$07) executes
// more T-states per real scanline, so dividing the CPU-domain
// T-counter stamped effects 2/4/8× too far down the frame (the
// Axis 10 "turbo-speed video timing" row, closed by #180). Classic
// models have no turbo and keep the per-model CPU-clock division.
func (u *ULA) currentScanline() int {
	if u.mem == nil {
		return 0
	}
	if u.mem.FrameOriginRef != nil {
		line, _ := u.BeamPosition()
		return line
	}
	if u.mem.TStates != nil {
		return int(*u.mem.TStates) / TStatesPerLineFor(u.mem.GetCurrentModel())
	}
	return 0
}

// recordULAVideoChange appends the CURRENT live ulaVideoState to the
// frame's change log, stamped with the same scanline clock the border
// change list uses.
func (u *ULA) recordULAVideoChange() {
	u.ulaVideoChanges = append(u.ulaVideoChanges, ulaVideoChange{
		scanline: u.currentScanline(),
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
	u.timexVideoMode = u.timexVideoMode&0xC0 | v&0x3F
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

	// Raster-stamped layer-scroll bracket (Next): fold the frame's CPU
	// scroll stamps into the per-line tables now, and capture the
	// copper's render-time scroll writes per row as the walk proceeds
	// (CaptureLayerRowScroll from the paper/border passes) — so EVERY
	// scrolled-layer pass this render, the post-walk wide passes
	// included, applies the scroll in force at each row's raster line.
	// RAMS band-scrolls the Galaxian player ship with per-line copper
	// MOVEs to NR$30; Atic Atac raster-waits on NR$1E/$1F and rewrites
	// the Layer 2 X scroll (NR$16/$71) mid-frame for its cinematic
	// scroll-text band (#187). The FPGA registers are combinational
	// into both pixel pipelines (tilemap.vhd:326; layer2.vhd:152/:156).
	// The deferred End re-enables CPU-write stamping once the whole
	// render (wide passes included) is done.
	if tsf, ok := u.nextCompositor.(nextLayerScrollFold); ok {
		tsf.FoldLayerScrolls(stale)
		defer tsf.EndLayerScrollCapture()
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
		// Row-pattern fill: write the first row once, copy it to the
		// rest — byte-identical to the per-pixel putPix walk (#187
		// performance; this fill runs every frame for Layer 2-only
		// content like Atic Atac).
		rowBytes := TotalWidth * u.xs * 4
		for x := 0; x < TotalWidth; x++ {
			u.putPix(x, 0, fill)
		}
		for y := 1; y < u.totalHeight; y++ {
			copy(u.img.Pix[y*u.img.Stride:y*u.img.Stride+rowBytes], u.img.Pix[:rowBytes])
		}
		if u.nextCompositor != nil {
			// Invalidates any prior pure-ULA capture: a disabled ULA is
			// everywhere-transparent, so the wide-L2 overpaint must not
			// repaint stale pixels (CaptureULABase self-gates on it).
			u.nextCompositor.CaptureULABase(u.img.Pix, u.img.Stride, TotalWidth*u.xs, u.totalHeight)
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

	// Draw borders with per-scanline colours. Segment fills instead of a
	// per-pixel conditional walk (#187 performance): full rows above/
	// below the paper, left/right strips beside it — the same pixels the
	// old putPix loop painted.
	for y := 0; y < u.totalHeight; y++ {
		borderColor := u.palette[borderPerLine[y]]
		if y < u.borderTop || y >= u.borderTop+ScreenHeight {
			u.fillRowSegment(y, 0, TotalWidth, borderColor)
		} else {
			u.fillRowSegment(y, 0, BorderLeft, borderColor)
			u.fillRowSegment(y, BorderLeft+ScreenWidth, TotalWidth, borderColor)
		}
	}

	// Draw screen. Paper rows the beam-time capture holds for this
	// frame render from the captured bytes — what the ULA fetched as
	// the beam passed — with live memory as the fallback for
	// uncaptured lines (single-step paths, first frame, Next). See
	// CaptureScanlines (#194).
	screenMem := u.mem.GetPage(u.mem.ScreenPage)
	attrMem := screenMem[0x1800:]
	// The capture buffer persists through stale re-renders (the
	// harness screenshot path); CaptureScanlines resets it when the
	// next frame begins.
	capLines := u.lineCapCount

	for y := 0; y < ScreenHeight; y++ {
		for x := 0; x < ScreenWidth/8; x++ {
			addr := screenAddrForRowCol(y, x)
			attrAddr := ((y >> 3) * 32) + x

			var pixels, attr byte
			if y < capLines {
				pixels = u.lineCapBitmap[y][x]
				attr = u.lineCapAttr[y][x]
			} else {
				pixels = screenMem[addr]
				attr = attrMem[attrAddr]
			}

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
					u.putPix(px, py, ink)
				} else {
					u.putPix(px, py, paper)
				}
			}
		}
	}

	// Spectrum Next overlay: if a compositor is wired (ModelNext),
	// blend Layer 2 (and, later, Tilemap and Sprites) over the
	// active display region row by row. The compositor pulls
	// Layer 2 data internally; we just hand it the existing ULA
	// scanline and write the result back. The pure-ULA frame is
	// snapshotted first (CaptureULABase, a no-op unless hi-res L2 +
	// a U-above-L mode needs it) so the wide-L2 overpaint can
	// repaint classic ULA pixels above the Layer 2 overlay (#204).
	if u.nextCompositor != nil {
		u.nextCompositor.CaptureULABase(u.img.Pix, u.img.Stride, TotalWidth*u.xs, u.totalHeight)
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
		// Timex hi-res rows (stable frames and copper-banded mixed
		// frames alike) composed natively at 512 half-pixels inside the
		// walk above (#183 stage 4 — the per-character mode latch in
		// renderNextULARow); the img IS the full 640×256 wide frame.
		return u.img
	}

	// Timex 512x192 8x1 hi-res (port $FF mode 110) without a Next
	// compositor (classic machines): the pixel-doubled ULA-only render.
	if u.timexHiResActive() {
		return u.renderTimexHiRes()
	}

	return u.img
}

// renderWide composites the 80-column tilemap over the Next frame. The
// frame is already 640 wide (xs = 2) holding the doubled lower layers
// (ULA + Layer 2 + sprites — the tilemap was skipped in the frame
// passes); the native 640-pixel tilemap is composited on top in place.
// This is the faithful representation of the Next's 80-column tilemap,
// which runs the tilemap layer at double the horizontal pixel clock
// (640px) over the 320px ULA.
func (u *ULA) renderWide() *image.RGBA {
	for y := 0; y < u.totalHeight; y++ {
		start := y * u.img.Stride
		u.nextCompositor.ComposeWideTilemapRow(y, u.img.Pix[start:start+TotalWidth*u.xs*4])
	}
	return u.img
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
// modes, and the ULA+TM slot in the U-above-L modes: the tilemap
// (RAMS: USL with the ULA output disabled — its menu text and
// Galaxian's formation/HUD live on the tilemap above the L2 art) and
// the classic ULA pixels from the CaptureULABase snapshot (Space
// Invaders #204: USL with NR$14=black — the white arcade overlay
// paints above the 320x256 planet backdrop).
// The frame is already 640 wide (xs = 2), so a 320-wide Layer 2 paints
// two output pixels per L2 pixel and a 640-wide one paints natively.
func (u *ULA) renderHiResLayer2() *image.RGBA {
	w := u.nextCompositor.Layer2Width()
	// Output pixels per Layer 2 pixel: 2 for the 320-wide mode, 1 for 640.
	xsL2 := TotalWidth * u.xs / w
	for y := 0; y < u.totalHeight; y++ {
		start := y * u.img.Stride
		row := u.img.Pix[start : start+TotalWidth*u.xs*4]
		u.nextCompositor.ComposeWideLayer2Row(y, row, xsL2)
		u.nextCompositor.OverpaintWideL2Row(y, row, u.xs)
	}
	return u.img
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
	// Live geometry (NR$03/NR$05 mirror): 311 lines with paper top at
	// raw line 64 in the boot +3 50 Hz timing; 312/320/264 lines with
	// paper top at 64/80/40 under 48K/Pentagon/60 Hz timing
	// (zxula_timing.vhd c_max_vc / c_min_vactive — the cvc counter
	// resets at c_min_vactive, :458-468).
	g := memory.DefaultNextGeometry()
	if u.mem != nil {
		g = u.mem.NextGeometry()
	}
	return (line + g.Lines - g.MinVActive) % g.Lines
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
	// Live per-line length from the NR$03/NR$05 geometry mirror:
	// 228 T in the boot +3 timing, 224 under 48K/Pentagon timing
	// (zxula_timing.vhd c_max_hc 455 vs 447). BeamPosition's callers
	// are all Next-conventioned (NR$1E/$1F, copper, palette raster
	// stamps); an unpushed mirror returns the boot default 228.
	tpl := u.mem.NextGeometry().TStatesPerLine
	line = (t / tpl) & 0x1FF
	hpos = (t % tpl) / 4
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
	// active chip (NextReg 0x06 chip-select), and the FPGA's decode
	// carries an extra A2=1 term (zxnext.vhd:2646 port_fffd:
	// a15:14="11" and a2='1' and port_fd) the classic machines don't
	// — $C001 is NOT an AY port on the Next.
	if chip := u.activeAY(); chip != nil && (addr&0xC002) == 0xC000 && u.nextAYA2OK(addr) {
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
	if (addr&0x00E0) == 0x0000 && (addr&0x001F) == 0x001F {
		// Counted whether or not a Kempston interface is attached: a game
		// polling this port is asking for a Kempston stick, and that is
		// the one joystick scheme a host CAN detect (Sinclair and Cursor
		// are ordinary keyboard reads, indistinguishable from a game
		// reading its own menu keys). Lets a frontend tell "the pad isn't
		// reaching the machine" apart from "this game never looks".
		u.KempstonPortReads++
		if u.KempstonState != 0 {
			// The game read the port at a moment when a button was
			// genuinely held. This is the decisive diagnostic: it means
			// real input was handed to the guest. If the game still does
			// not respond, the emulator delivered and the game chose to
			// ignore it — typically because its own control-select menu
			// is set to keyboard — and no emulator-side fix applies.
			u.KempstonReadsWhileHeld++
		}
		if u.KempstonEnabled || isNext {
			return u.KempstonState & 0x1F, true
		}
	}

	// Floating-bus: on 48K and 128K, an unattached IN returns
	// whichever byte the ULA is currently fetching from screen
	// memory (or 0xFF during border/retrace/idle bus phases).
	// The +2A/+3 memory controller disables this behaviour;
	// ModelNext also returns 0xFF for compatibility with most
	// post-Sinclair software that's clean about port use.
	// Record what the guest asked for and got nothing. A joystick that
	// "does not work" is usually a game polling an address we do not
	// decode: it gets floating-bus garbage, reads it as noise or as every
	// button held, and gives up. Which address it used is the one fact
	// that settles it, and guessing at Kempston clone decodes is how you
	// break the games (Arkanoid included) that read the bus ON PURPOSE.
	// Low byte only — that is what every interface decodes on.
	u.unattachedReads[byte(addr)]++
	return u.floatingBusByte(), false
}

// UnattachedPortReads returns a copy of the per-low-byte tally of IN
// reads that no device answered. Diagnostic only.
func (u *ULA) UnattachedPortReads() [256]uint64 {
	return u.unattachedReads
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

	// T-state offset within the current frame: the RAW counter.
	// ExecuteFrame wraps it to the per-frame overshoot at every frame
	// boundary, so it is frame-relative by construction — the same
	// convention memory.contentionDelay anchors its pattern on. Do
	// NOT subtract frameStartTstate here: that field is stamped by
	// the AUDIO flush at whatever overshoot the previous frame ended
	// on (0..~20 T, varying per frame), and subtracting it jitters
	// the bus-slot grid against the contention grid by up to 3 slots
	// — with audio running, Arkanoid's write-stall phase lock then
	// sampled idle slots and its beam-race pacing collapsed to 2-3
	// game updates per frame (#194). (Audio off left the field at 0,
	// which is why the harness never showed the regression;
	// TestFloatingBusIgnoresAudioFrameStamp pins this.)
	tstates := int(*u.mem.TStates)

	// Per-model line length: the 48K ULA uses 224 T-states/line, the 128K
	// family 228. Using the wrong length shifts the floating-bus origin by a
	// full 256 T-states on 48K (the documented first paper fetch is 64*224 =
	// 14336, not 64*228 = 14592 — Ramsoft "floating bus", Sean Young notes,
	// video/zxula_timing.vhd c_max_hc 447 vs 455).
	tPerLine := TStatesPerLineFor(model)

	// Top border: before the first display line. The 48K's paper starts
	// 64 lines in (64*224 = 14336); the 128K/+2's starts at 14362
	// (libspectrum timings.c ferranti_7c top-left pixel — NOT 64 of its
	// 228 T lines, which would be 230 T late). This origin must stay on
	// the same grid as the contention window (memory.contentionDelay:
	// 14335 / 14361) — beam-chasing games (Arkanoid #194) phase-lock
	// bus polls via contended writes and read the bus one slot later.
	topBorderTStates := 64 * tPerLine
	if model != roms.Model48K {
		topBorderTStates = 14362
	}
	if tstates < topBorderTStates {
		return 0xFF
	}

	line := (tstates - topBorderTStates) / tPerLine
	if line >= 192 { // bottom border
		return 0xFF
	}

	// T-states into this line, measured from the line's paper-fetch
	// origin: the fetch window is the FIRST 128 T-states of each
	// paper line (t = paperStart + line*tPerLine + 0..127), with the
	// first bitmap byte on the bus 2 T in (48K: 14338 — Ramsoft, and
	// FUSE spectrum_unattached_port, whose per-line display window
	// also begins AT the top-left-pixel time). The right border,
	// retrace and next line's left border make up the remaining
	// T-states of the line and read 0xFF. An extra 24 T "left
	// border" offset here (the old model) shifts the whole fetch
	// grid 3 slots late relative to the contention grid (base
	// paperStart-1) — beam-chasing games phase-lock on contended
	// writes and then sample the bus one machine cycle later, so the
	// two grids must agree (Arkanoid #194).
	const horizontalScreen = 128
	tInDisplay := tstates - topBorderTStates - line*tPerLine
	if tInDisplay >= horizontalScreen {
		return 0xFF
	}
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

// Megadrive-only button bits of the 12-bit i_JOY vector, in their
// vector positions (zxnext.vhd:90). Bits 4..0 (B U D L R) are not
// listed: they ARE the Kempston bits above and live in KempstonState.
const (
	MDJoyC     = 0x0020
	MDJoyA     = 0x0040
	MDJoyStart = 0x0080
	MDJoyY     = 0x0100
	MDJoyZ     = 0x0200
	MDJoyX     = 0x0400
	MDJoyMode  = 0x0800

	// mdExtraMask is every bit SetMDExtraButtons owns (11..5).
	mdExtraMask = 0x0FE0
)

// SetMDExtraButtons sets the Megadrive-only buttons of the left pad
// (C A START Y Z X MODE) as a whole vector, in i_JOY bit positions.
// Bits outside 11..5 are ignored: the directions and B live in
// KempstonState, so a caller cannot accidentally clobber them here.
func (u *ULA) SetMDExtraButtons(vec uint16) {
	u.MDExtraState = vec & mdExtraMask
}

// ExtendedKeys exposes the keyboard's Spectrum Next extended-key vector
// (i_KBD_EXTENDED_KEYS) for the NR $B0/$B1 read-back — see
// keyboard.ExtendedKeys for the bit layout and derivation.
func (u *ULA) ExtendedKeys() uint16 {
	return u.kbd.ExtendedKeys()
}

// MDJoyLeft returns the left joystick as the FPGA's 12-bit i_JOY_LEFT
// vector, active high, bits 11..0 = MODE X Z Y START A C B U D L R
// (zxnext.vhd:90). The low five bits (Fire=B, U, D, L, R) are the
// Kempston byte, whose bit order is the same as i_JOY(4:0) — the FPGA
// feeds i_JOY(5:0) straight to the Kempston port read
// (zxnext.vhd:3479). The Megadrive-only buttons above them come from
// SetMDExtraButtons, so a host pad drives both halves; with no pad
// attached MDExtraState stays 0 and the vector degrades to the plain
// Kempston reading.
func (u *ULA) MDJoyLeft() uint16 {
	return uint16(u.KempstonState&0x1F) | u.MDExtraState
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
			// Record the border change with the current scanline for
			// mid-frame rendering — on the reference timeline where
			// wired (speed-independent under NR$07 turbo, #180), else
			// the per-model CPU-clock division (224 on 48K, 228 on
			// 128K+ — see TStatesPerLineFor / floatingBusByte).
			scanline := u.currentScanline()
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
	} else if u.nextAY != nil && (addr&0xC002) == 0xC000 && u.nextAYA2OK(addr) && val >= 0xFD {
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
	} else if chip := u.activeAY(); chip != nil && (addr&0xC002) == 0xC000 && u.nextAYA2OK(addr) {
		// AY-3-8912 register select: port 0xFFFD on 128K+ models.
		// Decoded as A15=1, A14=1, A1=0 (+ A2=1 on the Next,
		// zxnext.vhd:2646).
		chip.SelectRegister(val)
	} else if chip := u.activeAY(); chip != nil && (addr&0xC002) == 0x8000 && u.nextAYA2OK(addr) {
		// AY-3-8912 data write: port 0xBFFD on 128K+ models.
		// Decoded as A15=1, A14=0, A1=0 (+ A2=1 on the Next,
		// zxnext.vhd:2647).
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
	// halfCycle admits the releasing WAIT check (1 cycle) plus its
	// following MOVE's write pulse into the pixel's own 4-cycle window.
	//
	// The interleave grain is the 14 MHz HALF-pixel (#183 stage 2): the
	// copper clocks at 28 MHz, a MOVE costs 2 cycles (copper.vhd:87-109)
	// — exactly one write per half-pixel slot — and every palette lookup
	// happens once per half-pixel (the sc(0)-multiplexed BRAM reads,
	// zxnext.vhd:6981/:7033). Half h of hcount hc therefore paces to 2
	// cycles into its own half-slot — hc*4 + 2 + 2*h (the slotAt closure
	// in the row loop): the even half at its pixel's cycle +2 (identical
	// to the previous per-pixel target, keeping the paced stride
	// bit-compatible with the coalesced one on event-free rows) and the
	// odd half at +4.
	const cyclesPerHcount = 4
	const lineEndCycle = 456*cyclesPerHcount - 1
	// frameLines follows the LIVE geometry (zxula_timing.vhd c_max_vc+1:
	// 311 on the +3 50 Hz boot timing, 312/264/320 on others). The old
	// hardcoded 312 advanced the copper one extra line per frame on the
	// 311-line timing — +0.32% copper rate — which broke engines that
	// phase-lock NMI-pacer stub walks to raster events (Atic Atac's
	// sample engine overshot its per-buffer stub walk by 1-2 stubs and
	// derailed at a scene transition, #187).
	frameLines := memory.DefaultNextGeometry().Lines
	if u.mem != nil {
		frameLines = u.mem.NextGeometry().Lines
	}
	if len(u.compositorScan) < 2*w*4 {
		u.compositorScan = make([]byte, 2*w*4)
		u.compositorComposed = make([]byte, 2*w*4)
	}
	ulaScan := u.compositorScan
	composed := u.compositorComposed
	resolver, liveULA := u.liveULAResolver()
	var paced nextCopperCyclePaced
	var copperPeek nextCopperLinePeek
	if u.nextCopper != nil {
		paced, _ = u.nextCopper.(nextCopperCyclePaced)
		copperPeek, _ = u.nextCopper.(nextCopperLinePeek)
	}
	// Video-effect gate for the paced stride (#187 performance): a
	// program whose MOVEs cannot touch video state (only NR$02 NMI
	// pulses / NR$7F scratch — Atic Atac's free-running ~20 kHz NMI
	// pacer list) retires instructions on EVERY line, but per-half-pixel
	// pacing exists solely to place video writes at their raster
	// instant, so such rows keep the coalesced fast stride and the
	// copper advances at the row-end RunToCycle instead. A program with
	// no video moves cannot self-modify into one mid-render (NR$60-$63
	// count as video), so one program-level check covers the pass.
	pacedVideo := true
	if paced != nil {
		if vm, ok := paced.(interface{ HasVideoMoves() bool }); ok {
			pacedVideo = vm.HasVideoMoves()
		}
	}
	// The 512-half-pixel compose passes: the FUSED live pass (state read
	// per half-pixel inside the copper interleave — the real
	// compositor) and the sub=2 row pass (reduced test mocks). Mocks
	// with neither keep the coalesced 256 stride.
	liveComp, _ := u.nextCompositor.(nextLiveRowComposer)
	hiComp, _ := u.nextCompositor.(interface {
		ComposeHiResScanline(y int, ulaRGBA []byte, dst []byte)
	})
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
	subReplay, _ := u.nextCompositor.(nextPaletteSubLineReplay)
	if palReplay != nil {
		palReplay.BeginPaletteReplay(stale)
		defer palReplay.EndPaletteReplay()
	}
	// The tilemap-scroll fold/capture bracket was opened by Render
	// (nextTilemapScrollFold) before any compositor pass; this walk
	// feeds it per-row captures below.
	scrollCap, _ := u.nextCompositor.(nextLayerScrollFold)
	// Raster order of one display row's border pixels (hcount = pixel+12,
	// 448 hcounts per line): the left border's first 20 pixels display
	// during the PREVIOUS line's tail (hcount 428..447) and its last 12
	// during hcount 0..11 of the row's own line; the right border follows
	// the paper at hcount 268..299. leftCarry hands the previous line's
	// tail pixels (resolved live, mid-tail) to the next row — this is what
	// renders the base/Copper test's over-left-border flag, whose MOVEs
	// live entirely inside that tail and are white-restored before the
	// line ends.
	// leftCarry holds OUTPUT (half-pixel) columns: 20 frame pixels = 40
	// half-pixel slots, each resolved at its own 2-cycle copper position
	// on paced rows (coalesced rows fill both halves of a pair alike).
	const leftTailPx = 20
	var leftCarry [2 * leftTailPx][4]byte
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
	u.dbgRowsPaced, u.dbgRowsHalf, u.dbgBorderRowsEvented = 0, 0, 0
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
		// Apply the frame's stamped palette writes from lines BEFORE
		// this paper row's raster line (y+64); the row's OWN stamps
		// land per half-pixel inside the row loop at their (line, hpos)
		// position (#183 stage 5 — the FPGA's write-visible-on-the-
		// next-lookup rule, zxnext.vhd:6969-6977). Without the sub-line
		// surface (reduced mocks) the whole line applies up front, the
		// pre-stage-5 row-start convention.
		rowStamps := false
		if palReplay != nil {
			if subReplay != nil {
				subReplay.ReplayPaletteToLineStart(64 + y)
				rowStamps = subReplay.PaletteLineHasStamps(64 + y)
			} else {
				palReplay.ReplayPaletteThrough(64 + y)
			}
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
				scrollCap.CaptureLayerRowScroll(64 + y)
			}
			u.nextCopper.Step(uint16(y), 455, copperCyclesPerScanline)
		} else if scrollCap != nil {
			scrollCap.CaptureLayerRowScroll(64 + y)
		}
		rowStart := (u.borderTop+y)*u.img.Stride + BorderLeft*u.xs*4
		pushPriority(u.ulaVideoLine[u.borderTop+y].nr15)
		// Stride decision (#183 Option C): a row takes the PACED
		// half-pixel stride only when its state can genuinely change
		// mid-row — the copper could retire an instruction inside the
		// line's cycle span (nextCopperLinePeek; a paced copper without
		// the peek is conservatively treated as always able) — or when
		// the ULA content itself is half-pixel-distinct (fine-scroll-X).
		// Every other row takes the coalesced stride: one compute per
		// 7 MHz pixel, both output half-pixels stored alike — provably
		// identical output, since nothing can change between the two
		// halves' lookups.
		rowPaced := false
		if paced != nil && pacedVideo && (copperPeek == nil || copperPeek.CanRetireOnLine(uint16(y))) &&
			os.Getenv("ZX_GO_NO_PACED_ROWS") == "" {
			rowPaced = true
		}
		// Half-pixel-distinct content: fine-scroll-X shifts the source
		// stream by one 14 MHz slot, and a Timex hi-res row (mode bit 2,
		// unless the shadow display forces mode 000) IS a native
		// 512-wide pixel stream (zxula.vhd:389). A row with its own
		// palette stamps needs the half stride too, so the stamps land
		// at their half-pixel.
		hiResRow := u.timexVideoMode&0x04 != 0 && u.mem.ScreenPage != 7
		rowHalf := (rowPaced || rowStamps || u.ulaFineScrollX || hiResRow) && (liveComp != nil || hiComp != nil)
		if rowPaced {
			u.dbgRowsPaced++
		}
		if rowHalf {
			u.dbgRowsHalf++
		}
		if rowStamps && !(liveULA && rowHalf) {
			// No per-half-pixel resolution available for this row: apply
			// its stamps up front (the row-start convention).
			palReplay.ReplayPaletteThrough(64 + y)
			rowStamps = false
		}
		// slotAt advances the row's sub-line state to hcount hc, half h:
		// the copper to 2 cycles into that half-slot, and the row's own
		// CPU palette stamps through hc.
		slotAt := func(hc, hf int) {
			if rowPaced {
				paced.RunToCycle(uint16(y), hc*cyclesPerHcount+2+2*hf)
			}
			if rowStamps {
				subReplay.ReplayPaletteWithinLine(64+y, hc)
			}
		}
		if liveULA {
			st := u.ulaVideoLine[u.borderTop+y]
			pushSelect(st.ulaPalSecond)
			// Left border: carried tail half-pixels first, then the 12
			// pixels that belong to this line's own hcount 0..11.
			for obx := 0; obx < 2*leftTailPx; obx++ {
				if leftCarryValid {
					u.paintOutPixel(y, obx, leftCarry[obx])
				} else {
					u.paintOutPixel(y, obx, u.nextBorderRGBA(u.borderTop+y, resolver))
				}
			}
			if rowPaced || rowStamps {
				for obx := 2 * leftTailPx; obx < 2*BorderLeft; obx++ {
					bx := obx >> 1
					slotAt(bx-leftTailPx, obx&1)
					u.paintOutPixel(y, obx, u.nextBorderRGBA(u.borderTop+y, resolver))
				}
			} else {
				for bx := leftTailPx; bx < BorderLeft; bx++ {
					u.paintImagePixel(y, bx, u.nextBorderRGBA(u.borderTop+y, resolver))
				}
			}
			var fuse func(i int, pix [4]byte)
			if rowHalf && liveComp != nil {
				// FUSED half-pixel compose: each ULA half-pixel is
				// composed against the LIVE layer/mixer state at its
				// own copper time and stored straight into the frame.
				liveComp.BeginLiveRow(y)
				img := u.img
				liveComp := liveComp
				fuse = func(i int, pix [4]byte) {
					out := liveComp.ComposeLiveHalfPixel(i, pix)
					off := rowStart + i*4
					img.Pix[off+0] = out[0]
					img.Pix[off+1] = out[1]
					img.Pix[off+2] = out[2]
					img.Pix[off+3] = out[3]
				}
			}
			var pace func(sx int)
			if rowPaced || rowStamps {
				pace = func(sx int) { slotAt(sx>>1+12, sx&1) }
			}
			u.renderNextULARow(y, ulaScan, resolver, pace, st, rowHalf, fuse)
		} else {
			// Non-live fallback: recover the logical 256 pixels from the
			// pre-rendered (xs-doubled) row.
			for x := 0; x < w; x++ {
				s := rowStart + x*u.xs*4
				copy(ulaScan[x*4:x*4+4], u.img.Pix[s:s+4])
			}
		}
		switch {
		case liveULA && rowHalf && liveComp != nil:
			// Fused rows composed and stored inside the loop above.
		case liveULA && rowHalf:
			// Half-pixel row on a reduced mock: 512-wide ULA scan
			// through the sub=2 row compose, stored natively.
			hiComp.ComposeHiResScanline(y, ulaScan, composed)
			copy(u.img.Pix[rowStart:rowStart+2*w*4], composed[:2*w*4])
		default:
			u.nextCompositor.ComposeScanline(y, ulaScan, composed)
			u.storeComposedRow(rowStart, composed, w)
		}
		if liveULA {
			// Right border at hcount 268+bx — per half-pixel on paced /
			// stamped rows.
			if rowPaced || rowStamps {
				for obx := 0; obx < 2*BorderLeft; obx++ {
					bx := obx >> 1
					slotAt(268+bx, obx&1)
					u.paintOutPixel(y, 2*(BorderLeft+w)+obx, u.nextBorderRGBA(u.borderTop+y, resolver))
				}
			} else {
				for bx := 0; bx < BorderLeft; bx++ {
					u.paintImagePixel(y, BorderLeft+w+bx, u.nextBorderRGBA(u.borderTop+y, resolver))
				}
			}
			// Line tail: resolve the next row's carried left-border pixels
			// live at their hcount, then finish the copper's line.
			if y+1 < h {
				for obx := 0; obx < 2*leftTailPx; obx++ {
					if rowPaced || rowStamps {
						slotAt(428+(obx>>1), obx&1)
					}
					leftCarry[obx] = u.nextBorderRGBA(u.borderTop+y+1, resolver)
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
				scrollCap.CaptureLayerRowScroll(imgRow + 32)
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
			// Event-gated per-half-pixel border rows (#183 stage 5): a
			// visible sweep row on whose line the copper can retire an
			// instruction resolves EVERY half-pixel at its own copper
			// cycle — mid-row border recolours land at their half-pixel
			// instead of the whole row taking the end-of-line state.
			// Event-free rows keep the single-resolve fast path (start
			// == end state, provably identical). Frame pixels 0..19 of
			// a border row displayed during the PREVIOUS line's tail
			// (hcount 428..447), so they take the line-START state.
			rowEvents := paced != nil && pacedVideo && liveULA && imgRow >= 0 &&
				(copperPeek == nil || copperPeek.CanRetireOnLine(uint16(v)))
			if rowEvents {
				u.dbgBorderRowsEvented++
				pushSelect(u.ulaVideoLine[imgRow].ulaPalSecond)
				off := imgRow * u.img.Stride
				startC := u.nextBorderRGBA(imgRow, resolver)
				for ox := 0; ox < 2*leftTailPx; ox++ {
					o := off + ox*4
					u.img.Pix[o+0] = startC[0]
					u.img.Pix[o+1] = startC[1]
					u.img.Pix[o+2] = startC[2]
					u.img.Pix[o+3] = startC[3]
				}
				for ox := 2 * leftTailPx; ox < TotalWidth*u.xs; ox++ {
					// Frame pixel ox>>1 displays at hcount (ox>>1)-20.
					paced.RunToCycle(uint16(v), ((ox>>1)-leftTailPx)*cyclesPerHcount+2+2*(ox&1))
					c := u.nextBorderRGBA(imgRow, resolver)
					o := off + ox*4
					u.img.Pix[o+0] = c[0]
					u.img.Pix[o+1] = c[1]
					u.img.Pix[o+2] = c[2]
					u.img.Pix[o+3] = c[3]
				}
				paced.RunToCycle(uint16(v), lineEndCycle)
				continue
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
					for x := 0; x < TotalWidth*u.xs; x++ {
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
		for y := 0; y < u.totalHeight; y++ {
			imgRowStart := y * u.img.Stride
			// The image IS the 320×256 wide frame (xs output pixels per
			// frame pixel), and the tilemap shares the sprite frame's
			// origin (same whc/wvc counters, zxnext.vhd:4337/4389):
			// image row y = tilemap row y, all 256 rows visible.
			inBorder := func(x int) bool {
				return x < BorderLeft || x >= BorderLeft+ScreenWidth
			}
			if y < u.borderTop || y >= u.borderTop+ScreenHeight {
				// Above or below the inner screen: every x is
				// border, paint the whole row.
				inBorder = func(int) bool { return true }
			}
			u.nextCompositor.ComposeBorderRow(y,
				u.img.Pix[imgRowStart:imgRowStart+TotalWidth*u.xs*4], u.xs, inBorder)
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
		for y := 0; y < u.totalHeight; y++ {
			imgRowStart := y * u.img.Stride
			inBorder := func(x int) bool {
				return x < BorderLeft || x >= BorderLeft+ScreenWidth
			}
			if y < u.borderTop || y >= u.borderTop+ScreenHeight {
				inBorder = func(int) bool { return true }
			}
			u.nextCompositor.ComposeSpriteBorderRow(y,
				u.img.Pix[imgRowStart:imgRowStart+TotalWidth*u.xs*4], u.xs, inBorder)
		}
	}
}

// storeComposedRow writes w logical frame pixels from src (w*4 bytes)
// into the image at byte offset rowStart, storing xs output pixels per
// frame pixel (#183 stage 1 pixel doubling at the row store).
func (u *ULA) storeComposedRow(rowStart int, src []byte, w int) {
	if u.xs == 1 {
		copy(u.img.Pix[rowStart:rowStart+w*4], src[:w*4])
		return
	}
	d := rowStart
	for x := 0; x < w; x++ {
		s := x * 4
		r, g, b, a := src[s], src[s+1], src[s+2], src[s+3]
		u.img.Pix[d+0], u.img.Pix[d+1], u.img.Pix[d+2], u.img.Pix[d+3] = r, g, b, a
		u.img.Pix[d+4], u.img.Pix[d+5], u.img.Pix[d+6], u.img.Pix[d+7] = r, g, b, a
		d += 8
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

// paintImagePixel writes the frame pixel at column x of display row y —
// xs output pixels on the doubled Next frame.
func (u *ULA) paintImagePixel(y, x int, c [4]byte) {
	off := (u.borderTop+y)*u.img.Stride + x*u.xs*4
	for i := 0; i < u.xs; i++ {
		u.img.Pix[off+0] = c[0]
		u.img.Pix[off+1] = c[1]
		u.img.Pix[off+2] = c[2]
		u.img.Pix[off+3] = c[3]
		off += 4
	}
}

// paintOutPixel writes ONE output (half-pixel) column outX of display
// row y — the paced border segments resolve every half-pixel
// individually, so they cannot go through paintImagePixel's pair store.
func (u *ULA) paintOutPixel(y, outX int, c [4]byte) {
	off := (u.borderTop+y)*u.img.Stride + outX*4
	u.img.Pix[off+0] = c[0]
	u.img.Pix[off+1] = c[1]
	u.img.Pix[off+2] = c[2]
	u.img.Pix[off+3] = c[3]
}

// putPix writes the RGBA colour at frame coordinate (x, y) — xs output
// pixels on the doubled Next frame. Direct Pix stores: image.RGBA.Set
// boxes its color.Color argument, which cost one heap allocation per
// pixel across the frame-sized render loops.
func (u *ULA) putPix(x, y int, c color.RGBA) {
	off := y*u.img.Stride + x*u.xs*4
	for i := 0; i < u.xs; i++ {
		u.img.Pix[off+0] = c.R
		u.img.Pix[off+1] = c.G
		u.img.Pix[off+2] = c.B
		u.img.Pix[off+3] = c.A
		off += 4
	}
}

// fillRowSegment paints frame columns [x0, x1) of frame row y with one
// colour — the segment counterpart of putPix (xs output pixels per frame
// pixel), replacing per-pixel loops on uniform spans.
func (u *ULA) fillRowSegment(y, x0, x1 int, c color.RGBA) {
	off := y*u.img.Stride + x0*u.xs*4
	end := y*u.img.Stride + x1*u.xs*4
	for ; off < end; off += 4 {
		u.img.Pix[off+0] = c.R
		u.img.Pix[off+1] = c.G
		u.img.Pix[off+2] = c.B
		u.img.Pix[off+3] = c.A
	}
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
// the compositor's per-pixel ULA transparency signal.
//
// Strides (#183 Option C — one loop body, two strides):
//   - half=true: 512 half-pixels into dst, one output pixel per 14 MHz
//     slot; with paced=true, copper execution interleaves per HALF-pixel
//     (2-cycle RunToCycle targets) so mid-scanline MOVEs recolour from
//     exactly their half-pixel onward — the hardware grain: one MOVE
//     write per half-pixel (copper.vhd:87-109), one palette lookup per
//     half-pixel (zxnext.vhd:6981).
//   - half=false: the coalesced stride — 256 pixels into dst, one
//     compute per 7 MHz pixel. Chosen only when the row provably has no
//     mid-row events (nextCopperLinePeek) and no half-pixel-distinct
//     content, so it is bit-identical to the paced stride's pairs.
//
// Fine-scroll-X (NR$68 bit 2) is a +1 half-pixel term in the source
// map: the ULA barrel shifter shifts at 14 MHz and the fine bit is the
// LSB of its shift amount (zxula.vhd:199 px(8), :353 scroll_0 <=
// px(2:0) & px(8), applied at the shift-register load :395).
// pace, when non-nil, advances the row's sub-line state (copper cycles
// and same-line CPU palette stamps) to the given display half-pixel —
// called before each slot's resolution. fuse, when non-nil (the
// stage-3 fused live compose), receives each computed half-pixel IN
// PLACE of the dst store — called inside the interleave so the
// compositor reads live state at the half-pixel's own copper time.
func (u *ULA) renderNextULARow(y int, dst []byte, res nextULAPaletteResolver,
	pace func(sx int), st ulaVideoState, half bool,
	fuse func(i int, pix [4]byte)) {
	screenMem := u.mem.GetPage(u.mem.ScreenPage)
	fallback := u.ulaDisabledFill()
	paperShift := ulaNextPaperShift(st.ulaNextFormat)
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
	rowClipped := y < int(u.ulaClipY1) || y > int(u.ulaClipY2)
	fine := 0
	if u.ulaFineScrollX {
		fine = 1
	}
	// Timex display mode latch (port $FF bits 2:0 / NR$69, zxula.vhd:191):
	// bit 0 selects display file 2 (+$2000, "screen 1"), bit 1 the 8x1
	// hi-colour attributes, bit 2 the 512-wide hi-res stream. With the
	// ULA shadow display active the mode is forced to 000 (bank 7 only
	// has 8K BRAM on the FPGA — same line). Re-latched per CHARACTER
	// cell inside the walk: the FPGA samples the mode registers once per
	// 8-pixel fetch cell (i_hc(3:0) = 0x3/0xB, zxula.vhd:191-214), so a
	// copper NR$69 MOVE mid-row switches mode — hi-res included, which
	// renders NATIVE half-pixels here (#183 stage 4: no decimation, no
	// dedicated stable-frame pass) — from the next cell on the SAME
	// line. Classic attributes live at +$1800 of the SELECTED display
	// file (screen 1 attrs at $7800: vram_a = screen_mode(0) & "110" &
	// …, zxula.vhd:239-241).
	var mode byte
	var pixBase int
	var hiCol, hiRes bool
	var hiResAttr byte
	var attrRow []byte
	latchMode := func() {
		mode = u.timexVideoMode & 0x07
		if u.mem.ScreenPage == 7 {
			mode = 0
		}
		pixBase = 0
		if mode&0x01 != 0 {
			pixBase = 0x2000 // vram_a bit 13 = screen_mode(0), zxula.vhd:235
		}
		hiCol = mode&0x02 != 0
		hiRes = mode&0x04 != 0
		if hiRes {
			// Synthesized hi-res attribute "01" & NOT(colour) & colour
			// (border_clr_tmx, zxula.vhd:419, applied :425-427).
			colour := (u.timexVideoMode >> 3) & 0x07
			hiResAttr = 0x40 | (^colour&0x07)<<3 | colour
			hiCol = false
		}
		attrRow = screenMem[pixBase+0x1800+(srcY>>3)*32:]
	}
	// One character cell = 8 pixels: 16 half-pixel slots in the half
	// stride, 8 iterations in the coalesced one.
	cellMask := 7
	n := ScreenWidth // coalesced stride: one compute per 7 MHz pixel
	if half {
		cellMask = 15
		n = 2 * ScreenWidth
	}
	for i := 0; i < n; i++ {
		// sx is the display HALF-pixel this iteration resolves: its own
		// slot in the half stride, the pixel's even half in the
		// coalesced stride (whose value provably holds for both halves).
		sx := i
		if !half {
			sx = 2 * i
		}
		if pace != nil {
			pace(sx)
		}
		if i&cellMask == 0 {
			latchMode()
		}
		x := sx >> 1
		// ULA X hardware scroll (NR$26) + fine-scroll-X (NR$68 bit 2):
		// source HALF-pixel = display half + 2*scroll + fine, mod 512 —
		// zxula.vhd:199 adds the scroll's char column mod 32 with px(8)
		// (the fine bit) riding into the 14 MHz barrel-shift amount
		// (:353/:395); the neighbouring char loads via px_1 (char+1 mod
		// 32), so the wrap is a clean mod-256 in classic pixels.
		srcHalf := (sx + 2*int(u.ulaScrollX) + fine) & 0x1FF
		srcX := srcHalf >> 1
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
			var on bool
			var attr byte
			if hiRes && half {
				// Native hi-res half-pixel stream (zxula.vhd:389): the
				// 32-bit shift register loads BOTH fetched bytes as
				// pixel data — the two display files interleave byte by
				// byte (even display byte = file 1, odd = file 2), one
				// bit per 14 MHz tick, 512 across. Every half-pixel
				// decodes through the synthesized hi-res attribute.
				dpByte := srcHalf >> 3 // 0..63 display bytes per row
				fileOff := 0
				if dpByte&1 == 1 {
					fileOff = 0x2000 // odd display bytes come from file 2
				}
				on = screenMem[fileOff+screenAddrForRowCol(srcY, dpByte>>1)]&(0x80>>uint(srcHalf&7)) != 0
				attr = hiResAttr
			} else {
				pixels := screenMem[pixBase+screenAddrForRowCol(srcY, srcX>>3)]
				switch {
				case hiRes:
					// Coalesced-stride hi-res (only reachable on reduced
					// test mocks without a 512-wide compose): decimate by
					// sampling display file 1's even half-pixels.
					attr = hiResAttr
				case hiCol:
					// Timex hi-colour: the attribute byte fetches through the
					// PIXEL address layout with vram_a bit 13 = 1 — one
					// attribute per 8x1 pixel row (zxula.vhd:238-239 '1' &
					// addr_p_spc_12_5).
					attr = screenMem[0x2000+screenAddrForRowCol(srcY, srcX>>3)]
				default:
					attr = attrRow[srcX>>3]
				}
				on = pixels&(0x80>>uint(srcX&7)) != 0
			}
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
		a := byte(0xFF)
		if transparent {
			a = 0
		}
		if fuse != nil {
			fuse(i, [4]byte{r, g, b, a})
			continue
		}
		off := i * 4
		dst[off+0] = r
		dst[off+1] = g
		dst[off+2] = b
		dst[off+3] = a
	}
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
	u.lastTapeTstate = u.tapeRefNow()
}

// SetTapeRefClock wires a MONOTONIC reference-T-state source for tape timing
// (z80.CPU.RefTstates). Without it, tape time is read off refNow(), which on
// classic models is the CPU's RAW counter — and that counter wraps to
// frame-relative at the end of every ExecuteFrame, so tapeLevel's
// "now > lastTapeTstate" guard silently discarded all tape time between the
// last port-$FE read of one frame and the first of the next. A loader that
// polls the tape continuously loses ~1%; one that polls sparsely (Exolon's
// custom loader waiting out an inter-block pause, #192) had its tape crawl at
// ~2% of real speed and never finished loading.
func (u *ULA) SetTapeRefClock(fn func() uint64) {
	u.tapeRefClock = fn
}

// tapeRefNow returns the tape-timing clock: the wired monotonic reference
// clock when present, else refNow (Next: monotonic mem.RefTstates; classic
// models: the wrapping raw counter — see SetTapeRefClock).
func (u *ULA) tapeRefNow() uint64 {
	if u.tapeRefClock != nil {
		return u.tapeRefClock()
	}
	return u.refNow()
}

// frameTStates returns the machine's real frame length in 3.5 MHz
// T-states — the window the per-frame audio reconstruction integrates over.
// Looked up per frame (not cached) so a runtime SwitchModel — or, on the
// Next, a guest NR$03/NR$05 geometry retune (memory.FrameTStates reads
// the live mirror) — is picked up.
func (u *ULA) frameTStates() int {
	if u.mem == nil {
		return roms.Model48K.FrameTStates()
	}
	return u.mem.FrameTStates()
}

// samplesForFrame returns how many audio samples one emulated frame of
// tpf T-states contributes. The boot Next geometry (70908 T) and every
// classic model keep the historical fixed audio.SamplesPerFrame — the
// browser/desktop pacing calibration — and a Next frame RETUNED by
// NR$03/NR$05 scales proportionally (a 60 Hz 60192-T frame is shorter
// machine time, so it contributes fewer samples and audio-clock pacing
// runs the machine correspondingly faster).
func (u *ULA) samplesForFrame(tpf int) int {
	const bootFrameT = 70908
	if tpf == bootFrameT || u.mem == nil || u.mem.GetCurrentModel() != roms.ModelNext {
		return audio.SamplesPerFrame
	}
	return audio.SamplesPerFrame * tpf / bootFrameT
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
	now := u.tapeRefNow()
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

// TapeTrapSync advances the tape to the current tape-clock instant and
// returns the live EAR level — the LD-EDGE fast trap's entry/exit sync.
// Identical to a port-$FE read's tapeLevel(), including the loading-sound
// event capture, but without the keyboard scan.
func (u *ULA) TapeTrapSync() bool {
	if u.tape == nil {
		return u.TapeIn
	}
	return u.tapeLevel()
}

// TapeTstatesToNextEdge reports the tape T-states until the next EAR toggle
// (see TapePlayer.TstatesToNextEdge). ok=false with no tape mounted.
func (u *ULA) TapeTstatesToNextEdge() (uint64, bool) {
	if u.tape == nil {
		return 0, false
	}
	return u.tape.TstatesToNextEdge()
}

// CreditTapeReads adds n to the port-$FE read counter. The LD-EDGE fast trap
// replaces the ROM's sampling loop — thousands of INs per frame — with O(1)
// emulation; crediting the reads it absorbs keeps the read-rate signals
// (fast-tape turbo, loader-activity auto-pause) seeing an ACTIVE loader.
func (u *ULA) CreditTapeReads(n uint64) {
	u.feReadCount += n
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
	u.MDExtraState = 0
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
		u.audio.PushBeeperSamples(make([]int16, u.samplesForFrame(u.frameTStates())))
		if u.mem.TStates != nil {
			u.frameStartTstate = *u.mem.TStates
			u.frameStartRefTstate = u.refNow()
		}
		return
	}
	u.LastAudioEventCount = len(u.audioEvents)
	tpf := u.frameTStates()
	nSamples := u.samplesForFrame(tpf)
	samples, finalState := generateSquareWaveFrame(
		u.audioEvents, u.frameStartSpeakerState, beeperLow, beeperHigh, tpf, nSamples)
	// Mix the SpecDrum/Covox DAC frame (event-timed, sample-accurate) into the
	// beeper waveform before pushing it.
	if u.speccyDAC != nil && u.speccyDAC.Enabled() {
		mixInt16(samples, u.speccyDAC.GenerateFrame(nSamples, tpf))
	}
	// Spectrum Next 4-channel DAC: event-timed, mixed the same way (replaces the
	// old per-pull MixInto snapshot).
	if gen, ok := u.nextDAC.(interface {
		GenerateFrame(int, int) []int16
	}); ok && gen != nil {
		mixInt16(samples, gen.GenerateFrame(nSamples, tpf))
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
			u.tapeAudioEvents, u.frameStartTapeState, -tapeAudioAmplitude, tapeAudioAmplitude, tpf, nSamples)
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
	return generateSquareWaveFrame(events, initialState, beeperLow, beeperHigh,
		tstatesPerFrame, audio.SamplesPerFrame)
}

// generateSquareWaveFrame is the box-filter square-wave reconstruction shared by
// the beeper and the tape-loading sound: it integrates a 1-bit signal (toggled
// by `events`) into one frame of samples between `low` (state false) and `high`
// (state true). See generateBeeperFrame for why integration (not point-sampling)
// is used. tstatesPerFrame is the real frame length for the current model
// (roms.SpectrumModel.FrameTStates) — with the 48K value hardcoded here, the
// 128K/Next frame's last ~1020 T-states of toggles were dropped every frame and
// finalState missed them, phase-inverting whole frames: an audible 50Hz buzz on
// any sustained tone. nSamples is the sample count the frame contributes
// (samplesForFrame): audio.SamplesPerFrame in the boot geometry, scaled to
// the frame's real duration under a guest NR$03/NR$05 retune.
func generateSquareWaveFrame(events []audioEvent, initialState bool, low, high int16, tstatesPerFrame, nSamples int) (samples []int16, finalState bool) {
	samples = make([]int16, nSamples)
	state := initialState
	eventIdx := 0

	delta := int32(high) - int32(low)
	lowV := int32(low)

	for i := 0; i < nSamples; i++ {
		sampleStart := i * tstatesPerFrame / nSamples
		sampleEnd := (i + 1) * tstatesPerFrame / nSamples
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

// DebugStrideCounts reports the last compositor walk's stride census
// (#208 diagnostics): paper rows that took the paced per-half-pixel
// stride, paper rows half-strided for any reason (paced, palette
// stamps, fine-scroll-X, Timex hi-res), and border sweep rows resolved
// per half-pixel (copper-evented).
func (u *ULA) DebugStrideCounts() (paced, half, borderEvented int) {
	return u.dbgRowsPaced, u.dbgRowsHalf, u.dbgBorderRowsEvented
}
