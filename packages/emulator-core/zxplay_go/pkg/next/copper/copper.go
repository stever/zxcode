// Package copper implements the Spectrum Next's Copper
// coprocessor: 1024 16-bit instructions, MOVE / WAIT / NOOP /
// HALT, four start modes.
//
// Implemented:
//
//   - Instruction storage (2 KB = 1024 × 16-bit)
//   - NextReg 0x60 / 0x63 byte-by-byte data writes with
//     auto-increment of an 11-bit byte address (nr_copper_addr)
//   - NextReg 0x61 / 0x62 control: byte-address low 8 / high 3
//     bits + 2-bit start mode
//   - Decoded MOVE / WAIT / NOOP / HALT opcodes
//   - RunToCycle(vcount, cycle): cycle-paced execution at the FPGA's
//     28MHz copper clock costs (MOVE 2 cycles, NOOP 1, WAIT re-checked
//     per cycle releasing at vcount==Y && hcount>=(X<<3)+12), driven
//     per pixel by the ULA's compositor pass
//   - Step(scanline, hpos): the coarser functional walker (at most
//     maxInstr instructions against a raster position) used by the
//     GHDL golden replay and non-cycle-paced callers
//   - VBL auto-restart (StartOnVBL resets the program counter at
//     the top of each frame; mode writes restart the list only on a
//     mode TRANSITION into 01/11, per copper.vhd's edge detect)
//
// Precision limit: the ULA render samples palette state once per 7MHz
// pixel, so effects narrower than a pixel (two MOVEs inside one pixel)
// collapse to one sample — see docs/architecture/known-gaps.md.
package copper

// Instruction is one decoded copper opcode.
type Instruction struct {
	Op  Op
	Reg byte   // for MOVE: which NextReg to write
	Val byte   // for MOVE: byte to write
	Y   uint16 // for WAIT: target scanline (0..511)
	X   byte   // for WAIT: target hpos / 8
}

// Op identifies the four copper opcodes.
type Op int

const (
	OpNOOP Op = iota
	OpMOVE
	OpWAIT
	OpHALT
)

// StartMode is the 2-bit selector in NextReg 0x62.
type StartMode byte

const (
	StartStop     StartMode = 0 // copper halted
	StartFromZero StartMode = 1 // run from instruction 0 once
	StartContinue StartMode = 2 // continue from current cursor
	StartOnVBL    StartMode = 3 // restart from 0 every VBL
)

// MaxInstructions is the size of the copper instruction memory in
// 16-bit words.
const MaxInstructions = 1024

// RegWriter is the contract Copper uses to write NextRegs when
// executing a MOVE. The compositor (or the bus's NextReg
// dispatcher) implements it. Step calls this once per MOVE.
type RegWriter interface {
	WriteReg(reg, val byte)
}

// CyclesPerHcount is the number of copper cycles per hcount unit (one
// 7MHz ULA pixel): since core 3.0 the copper is clocked at 28MHz, four
// cycles per pixel — a MOVE (2 cycles) spans half a pixel, which is why
// the upstream base/Copper test's per-MOVE flag "pixels" render at 50%
// width on real hardware.
const CyclesPerHcount = 4

// Copper holds the instruction memory + cursor + start mode.
type Copper struct {
	program [MaxInstructions]uint16
	// addr is the FPGA's nr_copper_addr: an 11-bit BYTE address into
	// the 2 KB instruction memory (zxnext.vhd:1194). Every NR$60/$63
	// data write increments it by one byte (zxnext.vhd:5417-5437);
	// NR$61 sets bits 7:0 and NR$62 bits 2:0 set bits 10:8. Even
	// addresses hold an instruction's high byte, odd its low byte.
	addr uint16
	// stored is nr_copper_data_stored (zxnext.vhd:1195): the staged
	// even-address byte a 16-bit-port write (NR$63) commits together
	// with the following odd-address byte.
	stored  byte
	mode    StartMode
	pc      uint16 // execution pointer
	stopped bool
	regs    RegWriter
	// lastScanline tracks the previous Step's raster line so a wrap back
	// to the top of the frame can trigger the StartOnVBL program restart.
	lastScanline uint16

	// Cycle-paced engine state (RunToCycle): the scanline being executed
	// and the 28MHz cycle position consumed within it, plus its own
	// raster-wrap tracker for the StartOnVBL restart. Independent of the
	// functional Step path — a machine drives one engine or the other.
	lineV    uint16
	linePos  int
	runLastV uint16
	// lineCycles is one scanline's copper-cycle length (hcounts x 4;
	// 1824 on the 456-hcount 128K/+3 timing). Used to CARRY an
	// in-flight instruction's overrun across line boundaries: the
	// FPGA copper is a free-running 28 MHz machine — line boundaries
	// do not exist for its MOVE/NOOP pacing. Both engines previously
	// reset the intra-line position to 0 on a line change, silently
	// forgiving the overrun and running free-running lists a fraction
	// fast; engines that phase-lock NMI-pacer stub walks to raster
	// events (Atic Atac) drift and derail on that inflation (#187).
	lineCycles int
	// stepCarry is Step's cross-call overrun (cycles an instruction
	// consumed past the previous call's budget).
	stepCarry int
	// continuous enables the cross-line/cross-call overrun carry
	// (SetContinuousPacing). The per-tick golden-trace and equivalence
	// drivers rely on the legacy "budget gates STARTING an instruction"
	// contract, so the carry is opt-in; the production machine enables
	// it (cmd/zxplay_go wiring).
	continuous bool

	// gen counts CPU-side mutations (NR$60-$63 writes: program data,
	// cursor, mode). Side-effect schedulers (the NR$02 NMI pacer)
	// precompute a frame of copper execution; a generation bump tells
	// them their schedule is stale.
	gen uint32
	// genHook, when set (SetGenerationHook), fires on every gen bump.
	genHook func()

	// noopRun caches, per program index, the length of the consecutive
	// NOOP run starting there (0 for a non-NOOP). NOOPs have no side
	// effects, so both engines advance a whole run with one add instead
	// of one Decode per copper cycle — Atic Atac's pacer list is 687
	// consecutive NOOPs out of a 1361-cycle wrap, stepped ~417 times
	// per frame by the render pass (#187 performance). Lazily built by
	// noopRuns(); invalidated by every program mutation (bumpGen).
	noopRun   [MaxInstructions]int32
	noopRunOK bool
	// dupRun caches, per program index, the length of the consecutive
	// run of IDENTICAL inert MOVEs (MOVE NR$7F — see skipInertDupMove)
	// starting there (0 for anything else). Every MOVE in such a run
	// except the last skips its dispatcher write, so both engines
	// advance the skipped prefix (dupRun-1 instructions, 2 cycles each)
	// with one add instead of one Decode+skip check per MOVE — Atic
	// Atac's pacer list pads with 245-336 consecutive `MOVE NR$7F,$00`
	// entries stepped every rendered line (#187 performance). Lazily
	// built by dupRuns(); invalidated by every program mutation
	// (bumpGen), like noopRun.
	dupRun   [MaxInstructions]int32
	dupRunOK bool
	// videoMoves caches HasVideoMoves() (gen-invalidated like noopRun).
	videoMoves   bool
	videoMovesOK bool

	// startPhase, when set (SetStartPhaseSource), returns the current
	// CPU position within the frame in COPPER CYCLES (28 MHz; 8 per
	// reference T-state) at the instant a stopped→running NR$62
	// transition commits. On the FPGA the copper begins executing on
	// the next 28 MHz cycle after that write (copper.vhd:70-83
	// edge-detects copper_en and the dot-clock lattice never stops),
	// so a list started mid-frame is phase-anchored to the WRITE
	// instant. The render pass only advances this model's copper at
	// frame end, whole-frame at a time — without an anchor a list
	// started mid-frame executed as if started at the frame origin, a
	// constant lattice phase error of (write - origin) mod wrap.
	// Atic Atac's free-running ~20 kHz NMI pacer list (1361-cycle
	// wrap, frame-incommensurate) keeps that phase forever, and its
	// raster-slaved SP-repointed walks live or die by it (#187).
	// The debt is banked in startDebt (consumed before any execution
	// by Step, RunToCycle and FrameMoveInstants) so the start frame
	// advances the list only over the post-write span.
	startPhase func() int
	// startDebt is the pending stopped→running anchor debt in copper
	// cycles from the current frame's origin. Distinct from stepCarry:
	// the carry follows the completed-line convention (a line's final
	// position includes its full budget), while the debt is an
	// absolute intra-frame position.
	startDebt int
	// Mid-frame RUNNING→stop / stopped→start PAIR (#205): a game that
	// stops the copper mid-raster, re-uploads its list and restarts it
	// EVERY frame (TX-1696's per-band engine: NR$62=$00, ~512 NR$60
	// writes, NR$62=$C0 each frame) must render as the FPGA's control
	// timeline does — the list RUNS from the frame top (OnVBL reset)
	// until the stop instant, freezes across [pauseAt, resumeAt), then
	// resumes at the start instant with the start's pc. Charging the
	// whole frame's head as startDebt instead (the start-only #197
	// convention) deferred the program past its early-line WAITs, whose
	// strict same-line release then parked it for the entire pass:
	// every band write vanished from every displayed frame. midStopAt/
	// midStopSeen bank the stop instant at execution time; the
	// following start converts the pair into the pauseAt/resumeAt
	// schedule consumed by Step and RunToCycle. pauseAt < 0 = no pair
	// pending. All instants are on the startPhase clock (paper-top-
	// rebased copper cycles). A start with NO mid-frame stop keeps the
	// pure startDebt behaviour (#197's Quantum Storm contract). The
	// list CONTENT the pass head runs is the post-upload one (this
	// model has no per-frame program snapshot) — one frame early,
	// a documented residue.
	midStopAt   int
	midStopSeen bool
	pauseAt     int
	resumeAt    int
	resumePC    uint16
	// dbg counters (#205 diagnostics)
	dbgPairArms  int
	dbgStartArms int
	dbgStops     int
}

// Generation returns the CPU-write mutation counter. It bumps on every
// NR$60-$63 write (program data, cursor, start mode) — anything that
// can change what a precomputed execution schedule would have done.
func (c *Copper) Generation() uint32 { return c.gen }

// SetGenerationHook installs a callback fired on every generation bump
// (NR$60-$63 write). The NMI pacer uses it to void the CPU's ExtNMI
// dispatch gate immediately, so its next-instruction poll observes the
// bump and clears the stale schedule at once — the pre-gate "poll every
// instruction" promptness, without polling every instruction.
func (c *Copper) SetGenerationHook(fn func()) { c.genHook = fn }

// bumpGen advances the mutation counter and fires the hook.
func (c *Copper) bumpGen() {
	c.gen++
	c.noopRunOK = false
	c.dupRunOK = false
	c.videoMovesOK = false
	if c.genHook != nil {
		c.genHook()
	}
}

// HasVideoMoves reports whether the program contains any MOVE targeting
// a register that can affect rendered output. MOVEs to NR$02 (reset /
// NMI pulses — no video function; the production render writer filters
// them to the CPU-timeline NMI pacer) and NR$7F (user scratch register)
// cannot change a pixel, so a list containing only those — Atic Atac's
// ~20 kHz NMI pacer: NOOP pads + MOVE NR$7F pads + one MOVE NR$02 —
// lets the ULA render keep its coalesced fast stride even though copper
// instructions retire on every line; per-half-pixel pacing exists to
// place VIDEO writes at their raster instant (#187 performance). The
// classification is program-level and conservative: any other MOVE
// target (palette, scroll, NR$60-$63 self-modification, …) counts as
// video-affecting. Gen-cached; a program with no video moves cannot
// self-modify into one mid-render (NR$60-$63 are video-classified), so
// the flag is stable across a render pass.
func (c *Copper) HasVideoMoves() bool {
	if !c.videoMovesOK {
		c.videoMoves = false
		for _, w := range c.program {
			if w&0x8000 != 0 {
				continue // WAIT/HALT
			}
			reg := byte((w >> 8) & 0x7F)
			if reg == 0 {
				continue // MOVE to NR$00 is the NOOP encoding family
			}
			if reg != 0x02 && reg != 0x7F {
				c.videoMoves = true
				break
			}
		}
		c.videoMovesOK = true
	}
	return c.videoMoves
}

// skipInertDupMove reports whether the MOVE at program index pc may
// skip its dispatcher write: it targets NR$7F (user scratch register —
// no hardware function, no OnWrite handler) and the NEXT program word
// is the IDENTICAL instruction, which will store the same value two
// cycles later. Identical writes to a handler-less register are
// idempotent, the CPU never runs between them (both engines execute at
// render time), and the run's LAST write always lands — so the stored
// NR$7F value is exact at every observable point even if the engine's
// budget stops mid-run. Atic Atac's NMI pacer list pads with 336
// consecutive `MOVE NR$7F,$00` entries (~140k dispatcher round-trips
// per frame before this, the render pass's dominant copper cost, #187).
func (c *Copper) skipInertDupMove(pc uint16) bool {
	w := c.program[pc&(MaxInstructions-1)]
	if (w>>8)&0x7F != 0x7F || w&0x8000 != 0 {
		return false
	}
	return c.program[(pc+1)&(MaxInstructions-1)] == w
}

// noopRuns returns the NOOP-run-length table, rebuilding it after any
// program mutation. Two backward passes over the wrapped index chain
// resolve runs that cross the 1024-entry wrap; the length cap covers
// the all-NOOP program (one full-list run — advancing a whole list of
// NOOPs returns to the same pc, which is exactly what stepping does).
func (c *Copper) noopRuns() *[MaxInstructions]int32 {
	if !c.noopRunOK {
		for pass := 0; pass < 2; pass++ {
			for i := MaxInstructions - 1; i >= 0; i-- {
				if Decode(c.program[i]).Op != OpNOOP {
					c.noopRun[i] = 0
					continue
				}
				rl := c.noopRun[(i+1)&(MaxInstructions-1)] + 1
				if rl > MaxInstructions {
					rl = MaxInstructions
				}
				c.noopRun[i] = rl
			}
		}
		c.noopRunOK = true
	}
	return &c.noopRun
}

// dupRuns returns the identical-inert-MOVE run-length table (see the
// dupRun field), rebuilding it after any program mutation. Same
// two-backward-pass wrap resolution and all-identical-list cap as
// noopRuns. dupRun[i] >= 2 is exactly skipInertDupMove(i): the MOVE at
// i skips its dispatcher write because the next word is identical.
func (c *Copper) dupRuns() *[MaxInstructions]int32 {
	if !c.dupRunOK {
		for pass := 0; pass < 2; pass++ {
			for i := MaxInstructions - 1; i >= 0; i-- {
				w := c.program[i]
				if (w>>8)&0x7F != 0x7F || w&0x8000 != 0 {
					c.dupRun[i] = 0
					continue
				}
				rl := int32(1)
				if c.program[(i+1)&(MaxInstructions-1)] == w {
					rl = c.dupRun[(i+1)&(MaxInstructions-1)] + 1
					if rl > MaxInstructions {
						rl = MaxInstructions
					}
				}
				c.dupRun[i] = rl
			}
		}
		c.dupRunOK = true
	}
	return &c.dupRun
}

// New returns an empty copper.
func New() *Copper {
	return &Copper{stopped: true, lineCycles: 456 * CyclesPerHcount, pauseAt: -1}
}

// SetLineCycles sets the scanline length in copper cycles (hcounts x
// CyclesPerHcount) for the cross-line overrun carry. Defaults to the
// 456-hcount 128K/+3 timing.
func (c *Copper) SetLineCycles(n int) {
	if n > 0 {
		c.lineCycles = n
	}
}

// SetContinuousPacing enables FPGA-true free-running pacing: an
// instruction's cycles consumed past a line boundary (RunToCycle) or a
// call's budget (Step) reduce the next line/call's budget instead of
// being forgiven. See the lineCycles field comment for why (#187).
func (c *Copper) SetContinuousPacing(on bool) {
	c.continuous = on
	c.stepCarry = 0
}

// SetStartPhaseSource installs the callback that reports the CPU's
// current intra-frame position in copper cycles (28 MHz). Used to
// anchor a stopped→running NR$62 start to its write instant — see the
// startPhase field comment. Production wiring (cmd/zxplay_go) supplies
// the CPU reference clock; nil (tests, classic models) keeps the
// legacy frame-origin anchoring.
func (c *Copper) SetStartPhaseSource(f func() int) { c.startPhase = f }

// SetRegWriter installs the NextReg writer. Required for MOVE
// instructions to take effect; otherwise they are silent no-ops.
func (c *Copper) SetRegWriter(rw RegWriter) { c.regs = rw }

// WriteData is the NextReg $60 (Copper Data) write: one byte lands
// at the current byte address and the address advances. Per
// zxnext.vhd:5417-5423 + copper_msb_we/:3977 (the write_8 path), an
// even-address byte writes an instruction's HIGH half immediately
// and an odd-address byte its LOW half — a cursor moved onto an odd
// address patches just the low byte of that instruction, unlike the
// NR$63 staged pair.
func (c *Copper) WriteData(b byte) {
	c.bumpGen()
	i := (c.addr >> 1) & (MaxInstructions - 1)
	if c.addr&1 == 0 {
		c.stored = b // nr_copper_data_stored latches even bytes too (:5419)
		c.program[i] = uint16(b)<<8 | c.program[i]&0x00FF
	} else {
		c.program[i] = c.program[i]&0xFF00 | uint16(b)
	}
	c.addr = (c.addr + 1) & 0x07FF
}

// WriteData16 is the NextReg $63 (Copper Data 16-bit) write. Same
// byte cursor as NR$60, but the even byte is only STAGED
// (nr_copper_data_stored) and both halves commit atomically on the
// odd-address write (zxnext.vhd:5432-5437, copper_msb_we at :3977
// with write_8 = '0'), so the copper never executes a half-updated
// instruction.
func (c *Copper) WriteData16(b byte) {
	c.bumpGen()
	i := (c.addr >> 1) & (MaxInstructions - 1)
	if c.addr&1 == 0 {
		c.stored = b
	} else {
		c.program[i] = uint16(c.stored)<<8 | uint16(b)
	}
	c.addr = (c.addr + 1) & 0x07FF
}

// SetWritePtrLow / SetWritePtrHighAndMode are the NextReg 0x61 /
// 0x62 writes. 0x61 is bits 7:0 of the 11-bit BYTE address; 0x62
// carries the address's bits 10:8 (in bits 2:0) + the 2-bit start
// mode (bits 7:6). zxnext.vhd:5426-5430.
//
// Because the address is byte-granular, moving the cursor to an even
// address naturally starts a fresh instruction pair — this is what
// protects a program stream from a stray odd NR$60 byte written
// earlier (e.g. the dispatcher reset writing NR$60=$00, the Nextoid
// reset-to-Welcome bug): the FPGA needs no separate pairing latch
// for NR$60 and neither do we.
func (c *Copper) SetWritePtrLow(b byte) {
	c.bumpGen()
	c.addr = (c.addr & 0x0700) | uint16(b)
}

// SetWritePtrHighAndMode sets byte-address bits 10:8 (val bits 2:0)
// AND the start-mode (val bits 7:6).
//
// The program counter resets ONLY on a mode TRANSITION into 01/11 —
// the FPGA edge-detects copper_en_i against last_state_s
// (copper.vhd:70-79), so re-writing NR$62 with the SAME mode bits
// (e.g. to select a write address while a list runs, as the upstream
// base/Copper test's Z80 line-animation patcher does every frame)
// does not disturb the running program.
func (c *Copper) SetWritePtrHighAndMode(b byte) {
	c.bumpGen()
	c.addr = (c.addr & 0x00FF) | (uint16(b&0x07) << 8)
	mode := StartMode((b >> 6) & 0x03)
	if mode == c.mode {
		return
	}
	wasStopped := c.stopped
	c.mode = mode
	switch c.mode {
	case StartStop:
		// A RUNNING→stop mid-frame banks the stop instant: if a start
		// follows this frame, the pair renders as run-head / freeze /
		// resume (see the pauseAt field block, #205).
		if !c.stopped && c.continuous && c.startPhase != nil {
			c.midStopAt = c.startPhase()
			c.midStopSeen = true
			c.dbgStops++
		}
		c.stopped = true
	case StartFromZero, StartOnVBL:
		c.pc = 0
		c.stopped = false
	case StartContinue:
		c.stopped = false
	}
	// Anchor a stopped→running start to the write instant: bank the
	// frame's already-elapsed copper cycles as a stepCarry debt so the
	// end-of-frame render advance (and the NMI pacer's schedule sim,
	// which resumes from linePos+stepCarry) executes the list only
	// from the write onward — the FPGA's copper_en edge starts
	// execution on the very next 28 MHz cycle (copper.vhd:70-83), not
	// at the frame top. See the startPhase field comment (#187).
	if wasStopped && !c.stopped && c.continuous && c.startPhase != nil {
		if c.midStopSeen {
			// Stop→start pair within one frame: convert to the
			// pause/resume schedule (see the pauseAt field block, #205).
			// An inverted ordering (start instant before the banked
			// stop — a stop carried over from a previous frame) falls
			// back to freezing from the frame top, the start-only
			// behaviour.
			c.pauseAt = c.midStopAt
			c.resumeAt = c.startPhase()
			if c.resumeAt < c.pauseAt {
				c.pauseAt = 0
			}
			c.resumePC = c.pc
			c.midStopSeen = false
			c.startDebt = 0
			c.dbgPairArms++
		} else {
			c.startDebt = c.startPhase()
			c.pauseAt = -1
			c.dbgStartArms++
		}
		c.stepCarry = 0
		c.linePos = 0
	}
}

// Cursor returns the current write BYTE address (11-bit, as read
// back through NR$61/$62).
func (c *Copper) Cursor() uint16 { return c.addr }

// ResetCursor restores the NR$60-$63 write-side state to the FPGA
// reset values (zxnext.vhd:5019-5022): byte address 0, staged data
// byte 0, mode "00" (stop). The instruction BRAM itself is NOT
// cleared on reset, matching the hardware.
func (c *Copper) ResetCursor() {
	c.addr = 0
	c.stored = 0
	c.mode = StartStop
	c.stopped = true
}

// Mode returns the current start mode.
func (c *Copper) Mode() StartMode { return c.mode }

// Instruction returns the decoded instruction at index i. Indexes
// past MaxInstructions return a NOOP.
func (c *Copper) Instruction(i uint16) Instruction {
	if i >= MaxInstructions {
		return Instruction{Op: OpNOOP}
	}
	return Decode(c.program[i])
}

// Decode parses a raw 16-bit instruction word into Instruction.
//
// Per the FPGA encoding (device/copper.vhd):
//   - MOVE: bit 15 = 0; bits 14-8 = NextReg index (7 bits);
//     bits 7-0 = value byte.
//   - WAIT: bit 15 = 1; bits 14-9 = horizontal position (0..63, in
//     8-pixel columns); bits 8-0 = vertical scanline (0..511).
//   - HALT: special-case WAIT 0xFFFF (waits for line 511, hpos 63
//     — never reached).
//   - NOOP: a MOVE whose NextReg index (bits 14-8) is zero. The
//     hardware suppresses the write pulse purely on the register
//     field being zero (copper.vhd:104 — "MOVE 0,0" / NOP test is
//     on copper_list_data_i(14 downto 8), the value byte is NOT
//     considered), so MOVE reg 0 with any value is a NOOP.
func Decode(w uint16) Instruction {
	if w == 0xFFFF {
		return Instruction{Op: OpHALT}
	}
	if w&0x8000 == 0 {
		reg := byte((w >> 8) & 0x7F)
		val := byte(w & 0xFF)
		if reg == 0 {
			return Instruction{Op: OpNOOP}
		}
		return Instruction{Op: OpMOVE, Reg: reg, Val: val}
	}
	// WAIT
	x := byte((w >> 9) & 0x3F)
	y := w & 0x01FF
	return Instruction{Op: OpWAIT, X: x, Y: y}
}

// WaitHThreshold is the horizontal raster counter (hcount, in pixels)
// at or above which a WAIT with column field x releases on its
// target scanline. The hardware compares hcount_i >= (x << 3) + 12, i.e.
// the 6-bit column is taken as 8-pixel units with a fixed +12 pixel offset
// (device/copper.vhd:94). hcount tops out at c_max_hc — 455 on 128K/+3
// timing (zxula_timing.vhd:196), 447 on 48K/Pentagon (:262/:160) — so
// thresholds above it (x >= 56, or x >= 55 on 448-hcount lines) never
// release; the boundary follows whatever line length the caller drives.
func WaitHThreshold(x byte) uint16 { return uint16(x)<<3 + 12 }

// RunToCycle advances the cycle-paced copper on raster line vcount through
// 28MHz cycle `cycle` of that line (hcount h spans cycles h*4..h*4+3, see
// CyclesPerHcount). It executes every instruction whose cycles complete by
// then, at the FPGA's per-cycle costs: a MOVE presents its write pulse then
// spends a bubble cycle clearing it = 2 cycles (copper.vhd:87-89/100-110), a
// NOP (MOVE with reg field 0) costs 1 with no pulse (copper.vhd:104), and a
// WAIT re-checks its condition every cycle (copper.vhd:92-98), releasing only
// when vcount EQUALS its target line and hcount has reached (X<<3)+12
// (copper.vhd:94) — a WAIT for another line parks the copper for the rest of
// this call. HALT ($FFFF) is a WAIT that can never be satisfied (line 511,
// hcount 516): it parks forever, and in StartOnVBL mode the frame-origin
// restart un-parks it. The instruction address wraps at the 1024-entry list
// end exactly like the FPGA's 10-bit counter.
//
// Callers step a line by calling RunToCycle with monotonically increasing
// cycle targets (e.g. once per rendered pixel), then move to the next line —
// crossing lines resets the intra-line cycle position.
func (c *Copper) RunToCycle(vcount uint16, cycle int) {
	// StartOnVBL: restart the list when the raster wraps to the frame top
	// (copper.vhd:80-83, vcount==0 && hcount==0).
	if c.mode == StartOnVBL && vcount < c.runLastV {
		c.pc = 0
	}
	c.runLastV = vcount
	if vcount != c.lineV {
		c.lineV = vcount
		// Carry the previous line's overrun (free-running pacing);
		// anything within the line is simply done.
		if over := c.linePos - c.lineCycles; c.continuous && over > 0 {
			c.linePos = over
		} else {
			c.linePos = 0
		}
	}
	// Consume a pending stopped→running start debt as intra-line
	// position: whole-line portions drain through the line-change
	// overrun carry above, so the first instruction executes exactly
	// startDebt cycles into the frame — the NR$62 write instant.
	if c.continuous && c.startDebt > 0 {
		c.linePos += c.startDebt
		c.startDebt = 0
	}
	// Mid-frame stop→start pair (#205): run the pass head normally,
	// freeze across [pauseAt, resumeAt), resume with the start's pc.
	// Calls are raster-monotonic, so clamping the call's target at the
	// pause instant and floor-jumping at the resume instant realises
	// the schedule at this engine's grain.
	if c.pauseAt >= 0 && c.lineCycles > 0 {
		lineStart := int(vcount) * c.lineCycles
		switch {
		case lineStart+cycle < c.pauseAt:
			// wholly before the freeze — run normally
		case lineStart >= c.resumeAt:
			c.pc = c.resumePC
			c.pauseAt = -1
		case lineStart+cycle >= c.resumeAt:
			// this call crosses the resume instant
			c.pc = c.resumePC
			if f := c.resumeAt - lineStart; c.linePos < f {
				c.linePos = f
			}
			c.pauseAt = -1
		default:
			// inside the freeze window: execute only the pre-pause head
			cycle = c.pauseAt - lineStart - 1
			if cycle < 0 {
				return
			}
		}
	}
	if c.mode == StartStop { // copper_en "00": no execution (copper.vhd:85)
		return
	}
	for c.linePos <= cycle {
		inst := Decode(c.program[c.pc&(MaxInstructions-1)])
		switch inst.Op {
		case OpMOVE:
			// Batch the write-skipped prefix of an identical-inert-MOVE
			// run — see Step's OpMOVE case; same semantics under this
			// engine's start convention (an instruction starts while
			// linePos <= cycle, costing 2).
			if l := int(c.dupRuns()[c.pc&(MaxInstructions-1)]); l >= 2 {
				k := l - 1
				if avail := (cycle-c.linePos)/2 + 1; k > avail {
					k = avail
				}
				c.pc = (c.pc + uint16(k)) & (MaxInstructions - 1)
				c.linePos += 2 * k
				continue
			}
			if c.regs != nil && !c.skipInertDupMove(c.pc) {
				c.regs.WriteReg(inst.Reg, inst.Val)
			}
			c.pc = (c.pc + 1) & (MaxInstructions - 1)
			c.linePos += 2
		case OpNOOP:
			// Batch the whole side-effect-free NOOP run (n >= 1): NOOPs
			// start while linePos <= cycle, one cycle each — identical
			// to stepping them.
			n := int(c.noopRuns()[c.pc&(MaxInstructions-1)])
			if avail := cycle - c.linePos + 1; n > avail {
				n = avail
			}
			c.pc = (c.pc + uint16(n)) & (MaxInstructions - 1)
			c.linePos += n
		case OpWAIT:
			if inst.Y != vcount { // strict line equality (copper.vhd:94)
				return
			}
			release := int(WaitHThreshold(inst.X)) * CyclesPerHcount
			if release > cycle {
				return
			}
			if c.linePos < release {
				c.linePos = release
			}
			c.linePos++ // the releasing condition check consumes one cycle
			c.pc = (c.pc + 1) & (MaxInstructions - 1)
		case OpHALT:
			return
		}
	}
}

// CanRetireOnLine reports whether any instruction could retire during
// raster line vcount — the render's fast-stride gate (#183): an
// event-free row (copper stopped, parked HALT, or parked WAIT for
// another line — strict line equality, device/copper.vhd:94) provably
// cannot change video state mid-row, so the ULA coalesces each 7 MHz
// pixel's half-pixel pair instead of pacing RunToCycle per half-pixel.
// Pure peek: no engine state changes. The StartOnVBL frame-origin
// restart is anticipated the same way RunToCycle applies it (a raster
// wrap resets the program counter, copper.vhd:80-83). A WAIT for this
// line whose threshold lies past the line end (X >= 56 — never releases
// on hardware) still reports true: conservative, the paced stride is
// merely slower there, never different.
func (c *Copper) CanRetireOnLine(vcount uint16) bool {
	if c.mode == StartStop {
		return false
	}
	pc := c.pc
	if c.mode == StartOnVBL && vcount < c.runLastV {
		pc = 0
	}
	inst := Decode(c.program[pc&(MaxInstructions-1)])
	switch inst.Op {
	case OpHALT:
		return false
	case OpWAIT:
		return inst.Y == vcount
	}
	return true
}

// Step advances the copper by at most cycleBudget copper cycles
// against the supplied raster position, at the FPGA's per-cycle
// costs: a MOVE takes 2 cycles (write pulse + bubble,
// copper.vhd:87-110), a NOOP 1, a WAIT release 1. An instruction
// whose cost overruns the remaining budget still completes (the
// budget gates STARTING an instruction), so a budget of 1 executes
// exactly one instruction — the contract the per-tick golden-trace
// driver relies on. Returns the number of MOVE instructions
// actually executed. MOVE writes go through the RegWriter; a WAIT
// that isn't satisfied leaves pc parked and stops the step, as does
// HALT ($FFFF — a WAIT that can never be satisfied; the StartOnVBL
// frame-origin reset un-parks it).
//
// The instruction address is the FPGA's 10-bit counter: it WRAPS at
// the 1024-entry list end in every running mode (copper.vhd's
// copper_list_addr_s + 1 on a 10-bit vector). A free-running looped
// list (mode 01) that ends without HALT re-executes from entry 0
// forever — Atic Atac's sample pacer is exactly this: 1023
// NOOP/MOVE-pad entries and a final MOVE NR$02,$04 firing one
// divMMC NMI per wrap.
//
// Re-entry guard: if a MOVE writes to NextRegs that mutate the
// Copper's own state (0x60-0x62), the writes are buffered through
// the dispatcher and applied as usual; Step doesn't reload its own
// pc / writePtr fields mid-loop, so a re-entrant mutation only takes
// effect on the NEXT Step call.
//
// scanline is the raster line (vcount). hcount is the raster
// horizontal counter in pixels — the same units the FPGA's hcount_i
// carries; on the Next's 128K/+3 timing it spans 0..455 (c_max_hc,
// zxula_timing.vhd:196). A WAIT releases at hcount >= (x<<3)+12 on its
// target line (see WaitHThreshold); a per-scanline caller passes the
// end-of-line hcount (455) so every REACHABLE WAIT on the line
// releases — thresholds past the line end (X >= 56) never release,
// exactly like the hardware.
func (c *Copper) Step(scanline uint16, hcount uint16, cycleBudget int) int {
	// VBL auto-restart: in StartOnVBL the program counter resets to 0 at
	// the start of each frame, i.e. when the raster wraps back to the top.
	if c.mode == StartOnVBL && scanline < c.lastScanline {
		c.pc = 0
	}
	c.lastScanline = scanline
	if c.stopped {
		return 0
	}
	executed := 0
	spent := c.stepCarry
	c.stepCarry = 0
	// Consume a pending stopped→running start debt: the per-call budget
	// convention drains it line by line, so the first instruction
	// executes exactly startDebt cycles into the frame.
	if c.continuous && c.startDebt > 0 {
		spent += c.startDebt
		c.startDebt = 0
	}
	// Mid-frame stop→start pair (#205): run the pass head normally,
	// freeze across [pauseAt, resumeAt), resume with the start's pc —
	// per-line grain under this engine's one-call-per-line convention.
	if c.pauseAt >= 0 && cycleBudget > 0 {
		lineStart := int(scanline) * cycleBudget
		lineEnd := lineStart + cycleBudget
		switch {
		case lineEnd <= c.pauseAt:
			// wholly before the freeze — run normally
		case lineStart >= c.resumeAt:
			c.pc = c.resumePC
			c.pauseAt = -1
		case c.resumeAt < lineEnd:
			// resume lands inside this line
			c.pc = c.resumePC
			if f := c.resumeAt - lineStart; spent < f {
				spent = f
			}
			c.pauseAt = -1
		case c.pauseAt > lineStart:
			// the freeze begins inside this line: only the head runs
			cycleBudget = c.pauseAt - lineStart
		default:
			return 0 // wholly inside the freeze window
		}
	}
	for spent < cycleBudget {
		inst := Decode(c.program[c.pc&(MaxInstructions-1)])
		switch inst.Op {
		case OpMOVE:
			// Batch the write-skipped prefix of an identical-inert-MOVE
			// run (dupRun L >= 2: the first L-1 MOVEs each see an
			// identical successor, so skipInertDupMove elides their
			// dispatcher writes — advance them with one add, 2 cycles
			// and one executed count each, exactly like stepping them).
			// The run's LAST move falls through to the normal path on a
			// later iteration and stores the value.
			if l := int(c.dupRuns()[c.pc&(MaxInstructions-1)]); l >= 2 {
				k := l - 1
				// Starts allowed under the budget convention (an
				// instruction starts while spent < cycleBudget, costing
				// 2): first at spent, then spent+2, ...
				if avail := (cycleBudget - spent + 1) / 2; k > avail {
					k = avail
				}
				c.pc = (c.pc + uint16(k)) & (MaxInstructions - 1)
				spent += 2 * k
				executed += k
				continue
			}
			if c.regs != nil && !c.skipInertDupMove(c.pc) {
				c.regs.WriteReg(inst.Reg, inst.Val)
			}
			c.pc = (c.pc + 1) & (MaxInstructions - 1)
			spent += 2
			executed++
		case OpWAIT:
			// Release when the raster is ON the target line and past the
			// horizontal threshold: vcount == Y (STRICT equality) and
			// hcount >= (X<<3)+12 (device/copper.vhd:94). A WAIT whose
			// line has already passed parks until the raster comes back
			// around next frame — exactly like the hardware and the
			// RunToCycle engine (the old `scanline > Y` late-release
			// fallback was a functional-model divergence, removed by the
			// #179 equivalence work).
			if scanline == inst.Y && hcount >= WaitHThreshold(inst.X) {
				// The release happens AT the threshold's raster position,
				// so the line's remaining cycle budget starts there — a
				// late-line WAIT leaves room for only a few following
				// instructions before the line ends, exactly like the
				// cycle-paced engine (RunToCycle's linePos jump). Without
				// the floor a per-line caller would execute a full line's
				// budget after the release.
				if floor := int(WaitHThreshold(inst.X)) * CyclesPerHcount; spent < floor {
					spent = floor
				}
				c.pc = (c.pc + 1) & (MaxInstructions - 1)
				spent++
				continue
			}
			// Not yet — park here.
			return executed
		case OpHALT:
			// Park, don't stop: HALT is a WAIT that can never be
			// satisfied. In StartOnVBL the frame-origin reset at Step
			// entry un-parks it; a stopped latch would keep the copper
			// dead across frames (RunToCycle parks the same way).
			return executed
		case OpNOOP:
			// Batch the side-effect-free NOOP run (n >= 1): NOOPs start
			// while spent < cycleBudget, one cycle each — identical to
			// stepping them.
			n := int(c.noopRuns()[c.pc&(MaxInstructions-1)])
			if avail := cycleBudget - spent; n > avail {
				n = avail
			}
			c.pc = (c.pc + uint16(n)) & (MaxInstructions - 1)
			spent += n
		}
	}
	// Free-running carry: the cycles the final instruction consumed
	// past the budget reduce the next call's budget (parked WAIT/HALT
	// exits return above and carry nothing — they are waiting, not
	// mid-instruction).
	if c.continuous {
		c.stepCarry = spent - cycleBudget
	}
	return executed
}

// MoveInstant is one captured MOVE from FrameMoveInstants: the raster
// line (same vcount space the per-line render drive uses), the copper
// cycle within that line at which the write pulse lands, and the value
// written.
type MoveInstant struct {
	Line  uint16
	Cycle int
	Val   byte
}

// HasRunnableMoveTo reports whether the copper could deliver a MOVE to
// reg at all: it is in a running mode and the program contains a MOVE
// targeting that register. Cheap gate for per-frame side-effect
// scheduling (the NR$02 NMI pacer) — most programs never touch NR$02.
func (c *Copper) HasRunnableMoveTo(reg byte) bool {
	if c.mode == StartStop {
		return false
	}
	for _, w := range c.program {
		if w&0x8000 == 0 && byte((w>>8)&0x7F) == reg && (w>>8)&0x7F != 0 {
			return true
		}
	}
	return false
}

// FrameMoveInstants simulates ONE frame of copper execution on a
// throwaway copy of the current state and captures every MOVE to reg
// with its raster instant. The real state is untouched — the render
// pass stays the authoritative advancer. The cost model is Step's
// exactly (MOVE 2 cycles, NOOP 1, WAIT releases at hcount >=
// (X<<3)+12 with the spent-floor, HALT parks, address wraps at the
// 10-bit list end, StartOnVBL restarts at the frame top).
//
// This exists for MOVEs with machine side effects beyond video —
// NR$02's NMI generation bits. The render-time copper pass runs after
// the frame's CPU has already executed, so side-effectful writes fired
// there coalesce into one visible edge per frame; the schedule this
// returns lets the machine deliver them on the CPU timeline instead
// (Atic Atac's ~20 kHz divMMC NMI sample pacer, #187).
func (c *Copper) FrameMoveInstants(reg byte, lines, cyclesPerLine int) []MoveInstant {
	if c.mode == StartStop {
		return nil
	}
	sim := *c
	var out []MoveInstant
	// Uniform-run batching: the sim only OBSERVES MOVEs to reg — NOOPs
	// and MOVEs to other registers just advance pc and cycles (NOOP 1,
	// MOVE 2). Precompute, per program index, the length of the
	// consecutive same-cost observation-free run starting there, so the
	// per-line walk advances whole runs with one add instead of one
	// Decode per copper cycle (a ~567k-cycle frame at the 28 MHz copper
	// clock was the pacer's dominant per-frame cost, #187). Costs
	// within a run are uniform, so the partial fit at a line's end is
	// exact arithmetic: instructions start while spent < cyclesPerLine,
	// the last may overrun — identical to stepping. runClass: 0 = event
	// (WAIT/HALT/MOVE-to-reg, never batched), 1 = NOOP, 2 = other-MOVE
	// (the class doubles as the per-instruction cycle cost).
	var runLen [MaxInstructions]int32
	var runClass [MaxInstructions]int8
	for i := 0; i < MaxInstructions; i++ {
		inst := Decode(sim.program[i])
		switch {
		case inst.Op == OpNOOP:
			runClass[i] = 1
		case inst.Op == OpMOVE && inst.Reg != reg:
			runClass[i] = 2
		}
	}
	// Two backward passes over the doubled index range resolve the
	// wrap-around runs; lengths cap at MaxInstructions (an all-plain
	// program is one full-list run).
	for pass := 0; pass < 2; pass++ {
		for i := MaxInstructions - 1; i >= 0; i-- {
			if runClass[i] == 0 {
				runLen[i] = 0
				continue
			}
			next := (i + 1) & (MaxInstructions - 1)
			if runClass[next] == runClass[i] {
				rl := runLen[next] + 1
				if rl > MaxInstructions {
					rl = MaxInstructions
				}
				runLen[i] = rl
			} else {
				runLen[i] = 1
			}
		}
	}
	// Resume from the authoritative copper's carried intra-line phase
	// (continuous pacing's linePos + stepCarry) instead of re-anchoring
	// at cycle 0: the FPGA's free-running list is a perfectly continuous
	// lattice, and restarting each frame's simulation at spent=0 wobbled
	// the NMI schedule's phase by up to a line (~228 refT) per frame —
	// enough to walk Atic Atac's NMI-atomic SP-repointed descriptor
	// walks under a sample NMI (#187).
	spent := 0
	debt := 0
	if c.continuous {
		spent = sim.linePos + sim.stepCarry
		// A pending stopped→running start debt (absolute intra-frame
		// cycle position of the NR$62 write) delays the list's first
		// instruction to exactly that instant — the FPGA's enable-edge
		// anchor (copper.vhd:70-83). Whole lines drain via the per-line
		// walk; the remainder floors the entry line's spent position.
		debt = sim.startDebt
	}
	// The per-line drive mirrors the render's: each line offers the full
	// line budget, WAITs park against the line's end-of-line hcount
	// horizon reached progressively (the spent counter is the intra-line
	// cycle position).
	for line := 0; line < lines; line++ {
		v := uint16(line)
		if sim.mode == StartOnVBL && v < sim.lastScanline {
			sim.pc = 0
		}
		sim.lastScanline = v
		if sim.stopped {
			return out
		}
		if spent >= cyclesPerLine {
			spent -= cyclesPerLine
		} else {
			spent = 0
		}
		if debt >= cyclesPerLine {
			debt -= cyclesPerLine
			continue
		}
		if debt > 0 {
			if spent < debt {
				spent = debt
			}
			debt = 0
		}
	lineLoop:
		for spent < cyclesPerLine {
			p := sim.pc & (MaxInstructions - 1)
			// Observation-free run: advance as many of its uniform-cost
			// instructions as can START inside this line's budget, in one
			// arithmetic step. Behaviourally identical to stepping them.
			if n := runLen[p]; n > 0 {
				cost := int32(runClass[p])
				if fit := (int32(cyclesPerLine-spent) + cost - 1) / cost; n > fit {
					n = fit
				}
				sim.pc = (sim.pc + uint16(n)) & (MaxInstructions - 1)
				spent += int(n * cost)
				continue
			}
			inst := Decode(sim.program[p])
			switch inst.Op {
			case OpMOVE:
				if inst.Reg == reg {
					out = append(out, MoveInstant{Line: v, Cycle: spent, Val: inst.Val})
				}
				sim.pc = (sim.pc + 1) & (MaxInstructions - 1)
				spent += 2
			case OpWAIT:
				// The per-line horizon: on the target line the WAIT
				// releases at its threshold cycle; on any other line it
				// parks for the rest of this line.
				if v == inst.Y {
					if floor := int(WaitHThreshold(inst.X)) * CyclesPerHcount; spent < floor {
						spent = floor
					}
					sim.pc = (sim.pc + 1) & (MaxInstructions - 1)
					spent++
					continue
				}
				break lineLoop
			case OpHALT:
				break lineLoop
			case OpNOOP:
				sim.pc = (sim.pc + 1) & (MaxInstructions - 1)
				spent++
			}
		}
	}
	return out
}

// DebugPair reports the armed mid-frame stop/start schedule (#205
// diagnostics): pauseAt/resumeAt on the startPhase clock, -1 when none.
func (c *Copper) DebugPair() (pauseAt, resumeAt int) {
	if c.pauseAt < 0 {
		return -1, -1
	}
	return c.pauseAt, c.resumeAt
}

// DebugArms reports the #205 diagnostic counters: mid-frame stops
// seen, stop/start pairs armed, start-only debts armed.
func (c *Copper) DebugArms() (stops, pairs, starts int) {
	return c.dbgStops, c.dbgPairArms, c.dbgStartArms
}
