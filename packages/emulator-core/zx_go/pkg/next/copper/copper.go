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
//   - Step(scanline, hpos) that walks the program against the
//     supplied raster position, executing MOVE writes through a
//     callback and respecting WAIT
//   - VBL auto-restart (StartOnVBL resets the program counter at
//     the top of each frame)
//
// Not implemented: tight raster-precise execution against per-T-state CPU
// stepping — the execution model uses a scanline+hpos quantum instead, so
// it is functional but not cycle-accurate.
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
}

// New returns an empty copper.
func New() *Copper { return &Copper{stopped: true} }

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
	c.addr = (c.addr & 0x0700) | uint16(b)
}

// SetWritePtrHighAndMode sets byte-address bits 10:8 (val bits 2:0)
// AND the start-mode (val bits 7:6).
func (c *Copper) SetWritePtrHighAndMode(b byte) {
	c.addr = (c.addr & 0x00FF) | (uint16(b&0x07) << 8)
	c.mode = StartMode((b >> 6) & 0x03)
	switch c.mode {
	case StartStop:
		c.stopped = true
	case StartFromZero, StartOnVBL:
		c.pc = 0
		c.stopped = false
	case StartContinue:
		c.stopped = false
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

// WaitHThreshold is the horizontal raster counter (hcount, 0..511 in
// pixels) at or above which a WAIT with column field x releases on its
// target scanline. The hardware compares hcount_i >= (x << 3) + 12, i.e.
// the 6-bit column is taken as 8-pixel units with a fixed +12 pixel offset
// (device/copper.vhd:94).
func WaitHThreshold(x byte) uint16 { return uint16(x)<<3 + 12 }

// Step advances the copper by at most maxInstr instructions
// against the supplied raster position. Returns the number of
// MOVE instructions actually executed. MOVE writes go through
// the RegWriter; WAITs that haven't been satisfied leave pc
// parked and stop the step. HALT stops the copper.
//
// maxInstr lets callers spread instruction execution across
// scanlines as real hardware does (one Copper cycle per CPU
// cycle, roughly). Pass 1 from a per-scanline render loop and
// the copper executes at most one instruction per call. Passing
// a larger number is useful for tests that want to "fast-forward"
// to a stable state.
//
// Re-entry guard: if a MOVE writes to NextRegs that mutate the
// Copper's own state (0x60-0x62), the writes are buffered through
// the dispatcher and applied as usual; Step doesn't reload its own
// pc / writePtr fields mid-loop, so a re-entrant mutation only takes
// effect on the NEXT Step call.
//
// scanline is the raster line (vcount, 0..511). hcount is the raster
// horizontal counter (0..511 in pixels) — the same units the FPGA's
// hcount_i carries; a WAIT releases at hcount >= (x<<3)+12 on its target
// line (see WaitHThreshold). A per-scanline caller passes the end-of-line
// hcount (>= 511) so every WAIT on the line releases on that line.
func (c *Copper) Step(scanline uint16, hcount uint16, maxInstr int) int {
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
	for n := 0; n < maxInstr && c.pc < MaxInstructions; n++ {
		inst := Decode(c.program[c.pc])
		switch inst.Op {
		case OpMOVE:
			if c.regs != nil {
				c.regs.WriteReg(inst.Reg, inst.Val)
			}
			c.pc++
			executed++
		case OpWAIT:
			// Release when the raster reaches the target line and the
			// horizontal threshold: hcount >= (X<<3)+12 on line Y
			// (device/copper.vhd:94). The scanline > Y branch is the
			// functional-model fallback for a per-scanline caller that has
			// already advanced past the target line (the hardware, clocked
			// every pixel, releases exactly on line Y; a caller stepping each
			// line hits Y exactly, so this only matters if a line is skipped).
			if scanline > inst.Y ||
				(scanline == inst.Y && hcount >= WaitHThreshold(inst.X)) {
				c.pc++
				continue
			}
			// Not yet — park here.
			return executed
		case OpHALT:
			c.stopped = true
			return executed
		case OpNOOP:
			c.pc++
		}
	}
	// Did we run off the end?
	if c.pc >= MaxInstructions {
		if c.mode == StartOnVBL {
			// Park at the end of the list; the program counter is reset
			// to 0 at the start of the next frame by the VBL check at
			// Step entry (so the list restarts precisely on the raster
			// wrap, not when it happens to run off the end).
			c.pc = MaxInstructions
		} else {
			c.stopped = true
		}
	}
	return executed
}
