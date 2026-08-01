// Package dma implements the Spectrum Next's zxnDMA controller driven
// through its Z80-DMA-compatible command protocol on I/O ports 0x6B
// (zxnDMA mode) and 0x0B (Z80-DMA compatibility mode — the legacy
// MB-02/Datagear decode). Both ports reach the same controller; the
// port used by each access latches the mode (zxnext.vhd:1811-1819),
// which only changes the byte-counter seed at LOAD / CONTINUE /
// auto-restart: 0 in zxnDMA mode, -1 in Z80 mode (dma.vhd:482-486 /
// 664-677), so a Z80-mode block moves blockLen+1 bytes like a genuine
// Zilog DMA.
//
// The controller is programmed by a stream of bytes written to the
// port. Each byte is either a base register byte (WR0..WR6) — whose bit
// pattern both selects the register group and flags which extra
// "follow" bytes come next — or one of those announced follow bytes, or
// (for WR6) a command byte: RESET / LOAD / ENABLE / .... A memory
// transfer runs when an ENABLE command arrives after a LOAD has latched
// the configured addresses.
//
// The command stream is variable-length: which follow bytes appear
// depends on the bits set in the preceding base byte, so a fixed-size
// command framing cannot parse it.
//
// Supported (the subset NextZXOS actually drives):
//
//   - WR0: transfer direction (A->B / B->A), port A start address,
//     block length
//   - WR1/WR2: port A/B address mode (increment / decrement / fixed),
//     with the optional variable-timing (+ prescaler) follow bytes
//     parsed and skipped
//   - WR4: port B start address (+ transfer-mode bits)
//   - WR6 commands: RESET ($C3), reset port A/B timing ($C7/$CB),
//     LOAD ($CF), CONTINUE ($D3), ENABLE ($87), DISABLE ($83), the
//     read-back commands ($BB read mask, $A7 initiate sequence, $BF
//     read status) and $8B reinitialise status; the interrupt
//     commands are accepted as no-ops — CONFORMANT: the FPGA's
//     dma.vhd carries the Zilog interrupt-control machinery commented
//     out (:94-96/:836-856), the zxnDMA never generates interrupts
//
// Memory<->memory transfers run synchronously to completion; IO-port
// endpoints and burst+prescaler transfers interleave with the CPU via
// Step. Transfers yield to the dma-delay condition between bytes when
// a pauseFn is attached (NR$CC-$CE enabled interrupt sources / NMI —
// zxnext.vhd:2005-2008, dma.vhd:269/427; see SetPauseFunc). Not
// modelled: the match logic and DMA-vs-CPU bus contention.
package dma

import (
	"fmt"
	"os"
)

// dmaTrace logs every port-0x6B byte to stderr when ZX_GO_DMA_TRACE is
// set, for diagnosing zxnDMA command-stream issues.
var dmaTrace = os.Getenv("ZX_GO_DMA_TRACE") != ""

func dmaLog(val byte) { fmt.Fprintf(os.Stderr, "DMA<-%02X\n", val) }

// Port address modes, decoded from a WR1/WR2 byte's bits 5..4.
const (
	addrDecrement byte = iota
	addrIncrement
	addrFixed
)

// MemoryBus is the contract DMA needs to move bytes between RAM
// locations. pkg/memory.Memory satisfies it.
type MemoryBus interface {
	Read(addr uint16) byte
	Write(addr uint16, val byte)
}

// IOBus is the contract DMA needs when a port is configured as an IO endpoint
// (WR1/WR2 D3 = 1) — e.g. DMA uploads to the sprite-image ($5B), Layer 2
// ($123B / $253B) or DAC ports. The 16-bit port number is the port's address
// register. pkg/ula.ULA satisfies it. May be nil; an IO endpoint with no bus
// degrades to a no-op read/write rather than corrupting memory.
type IOBus interface {
	ReadPort(port uint16) byte
	WritePort(port uint16, val byte)
}

// DMA is the zxnDMA controller: the configuration latched from the
// WR-register stream plus the small follow-byte state machine.
type DMA struct {
	mem MemoryBus
	io  IOBus

	portAStart uint16 // WR0: port A start address
	portBStart uint16 // WR4: port B start address
	blockLen   uint16 // WR0: block length (0 == 65536)
	aToB       bool   // WR0 bit 2: transfer port A -> port B
	aMode      byte   // WR1: port A address mode
	bMode      byte   // WR2: port B address mode
	aIsIO      bool   // WR1 D3: port A is an IO endpoint (else memory)
	bIsIO      bool   // WR2 D3: port B is an IO endpoint (else memory)
	loaded     bool   // a LOAD command has latched the addresses

	// zilogMode mirrors the top-level dma_mode latch (zxnext.vhd:1811-1819):
	// every DMA port access sets it from the port used — $0B = Z80-DMA
	// compatibility mode, $6B = zxnDMA mode. Machine reset clears it (fresh
	// construction); the $C3 RESET command does NOT (it lives outside the
	// z80dma entity).
	zilogMode bool

	// Internal pointers the chip exposes via the read mask, held as the
	// FPGA holds them: dma_src_s / dma_dest_s, latched from the port A/B
	// start addresses BY THE DIRECTION IN FORCE AT LOAD (dma.vhd:646-663)
	// and never re-derived at ENABLE. A direction flip between LOAD and
	// ENABLE therefore transfers with the stale source/destination roles
	// — the Misc/ZilogDMA border-text quirk, where a B->A LOAD latches the
	// IO port as source and the flip to A->B then memory-reads from the
	// port number and IO-writes to the buffer address. CONTINUE keeps the
	// pointers; auto-restart re-derives them per the live direction
	// (dma.vhd:473-480). Per-byte address stepping and the memory-vs-IO
	// cycle type also follow the LIVE direction bit (dma.vhd:350-396).
	curSrc, curDst uint16

	// counter is dma_counter_s: incremented per byte, compared against the
	// block length. LOAD / CONTINUE / auto-restart seed it 0 in zxnDMA mode
	// or -1 in Z80 mode — the -1 seed is what makes a Z80-mode block one
	// byte longer. Held as int so the -1 seed is explicit; read-back
	// truncates to uint16 (-1 reads $FFFF, exactly the FPGA's all-ones).
	counter int

	// Timing: per-port cycle length (2..4) and the zxnDMA fixed-time
	// prescaler, plus the transfer mode (continuous/burst).
	aCycleLen byte
	bCycleLen byte
	prescaler byte
	mode      byte

	autoRestart bool // WR5 D5: reload + repeat at end of block

	// endOfBlock mirrors the chip's status_endofblock_n bit (inverted): the
	// FPGA sets status_endofblock_n='0' when a block finishes (dma.vhd:471) and
	// back to '1' on RESET / LOAD ($CF) / CONTINUE ($D3) / reinit-status ($8B)
	// (dma.vhd:639/654/671/691). It surfaces in the status read-back register
	// as bit 5 (active-low: 1 = not at end, 0 = end-of-block reached).
	endOfBlock bool

	// lastDuration is the T-state cost of the most recent transfer, derived
	// from the per-byte cycle cost (read + write cycle lengths, or the
	// prescaler if larger). The emulator charges it to the CPU clock.
	lastDuration uint64

	// Read-back: a WR6 "read mask follows" ($BB) selects which of the seven
	// internal registers (status, byte-counter lo/hi, port A lo/hi, port B
	// lo/hi — bits 0..6) appear in the read sequence; IO reads of port 0x6B
	// return them in order, cycling. Power-up mask is 0x7F.
	//
	// readState mirrors the FPGA's reg_rd_seq_s: WHICH register (0..6) the
	// next port read returns. $BB (dma.vhd:859-886) and $A7 (:694-720) aim
	// it at the first masked register; $BF aims it at STATUS (:687); each
	// read advances it to the next masked register after the current one,
	// wrapping, defaulting to STATUS when nothing else is masked
	// (:895-1133). Registers outside the mask are simply never LANDED on —
	// the state itself is not validated against the mask, exactly like the
	// hardware (a $BF read of status works even with status unmasked).
	readMask  byte
	readState int

	// atLeastOne mirrors status_atleastone: set when a transfer moves a
	// byte while the FSM stays busy (an in-flight interleaved burst),
	// cleared when the FSM returns to IDLE (dma.vhd:265) — end of a
	// non-auto-restart block, DISABLE ($83) — or by RESET / $8B
	// (dma.vhd:640/692). Synchronous transfers complete inside ENABLE and
	// are already back at "IDLE" when the CPU can next read, so they never
	// expose the bit — matching what a CPU-visible read observes on
	// hardware.
	atLeastOne bool

	// cycleSink, when set, is called with a continuous-mode transfer's T-state
	// duration so the emulator can charge it to the CPU clock (the DMA stalls
	// the CPU for that long). Burst mode does not charge — the CPU keeps
	// running while the DMA waits between bytes.
	cycleSink func(uint64)

	// clock returns the current position on a MONOTONIC 3.5MHz-reference
	// timeline (z80.CPU.RefTstates — the raw per-frame T-state counter
	// wraps at every frame end, which would stall a burst whose next byte
	// falls past the boundary). When set, a burst-mode transfer with a
	// non-zero prescaler is interleaved with the CPU: it pumps one byte
	// every prescaler-delay reference T-states from Step(), letting the
	// CPU run in the gaps (so DMA-streamed audio is paced across the CPU
	// timeline).
	clock func() uint64

	// turbo returns the current CPU speed (NR$07, 0=3.5MHz .. 3=28MHz).
	// The FPGA's prescaler timer gains 8>>turbo per 28MHz tick
	// (dma.vhd:250-255) and a byte's transfer stalls until the timer
	// reaches prescaler*32 (dma.vhd:424/451), so the per-byte delay in
	// CPU T-states is prescaler*4^turbo/2. nil = speed 0.
	turbo func() byte

	// Active interleaved-burst state.
	activeBurst bool
	remaining   int
	nextDue     uint64

	// pauseFn, when set, is the FPGA's dma-delay condition
	// (zxnext.vhd:2005-2008 im2_dma_delay): the DMA must yield the bus
	// between byte transfers while an NR$CC-$CE-enabled interrupt source
	// is outside its idle state (im2_device.vhd:151 o_dma_int =
	// state /= S_0 and dma_int_en) or an NMI is outstanding with NR$CC
	// bit 7 set. It reports (paused, recheckAt): paused = yield right
	// now; recheckAt = the earliest reference T-state at which the
	// answer could change (0 = re-ask before every byte, ^uint64(0) =
	// can never pause). The FPGA consults the condition between bytes at
	// START_DMA / WAITING_ACK (dma.vhd:269/427), which is exactly where
	// the transfer loops call it.
	pauseFn func(nowRef uint64) (paused bool, recheckAt uint64)

	// suspended marks a continuous-mode block parked mid-transfer by
	// pauseFn with `remaining` bytes still to move; Step resumes it once
	// the pause clears. (The FPGA never idles the FSM in this window —
	// it sits in START_DMA re-testing dma_delay_i.)
	suspended bool
	// burstPaused marks an interleaved burst held off the bus by pauseFn;
	// on unpause the due schedule restarts from that instant.
	burstPaused bool

	// pending holds the setters for the follow bytes the most recent
	// base byte announced; each subsequent WriteCommand consumes one.
	pending []func(byte)
}

// Transfer modes (WR4 D6:D5).
const (
	modeContinuous byte = iota
	modeBurst
)

// New returns a fresh DMA with no transfer queued.
func New(mem MemoryBus) *DMA {
	return &DMA{mem: mem, aCycleLen: 2, bCycleLen: 2, readMask: 0x7F}
}

// SetIOBus attaches the port bus used for IO endpoints. Optional.
func (d *DMA) SetIOBus(io IOBus) { d.io = io }

// SetCycleSink attaches the callback used to charge a continuous-mode
// transfer's T-state duration to the CPU clock. Optional.
func (d *DMA) SetCycleSink(sink func(uint64)) { d.cycleSink = sink }

// SetClock attaches a CPU-T-state source. With it, burst-mode + prescaler
// transfers interleave with the CPU via Step(). Optional — without it, burst
// transfers run to completion at ENABLE.
func (d *DMA) SetClock(clock func() uint64) { d.clock = clock }

// SetTurbo attaches the CPU speed source (NR$07 value, 0..3) used to scale
// the prescaler delay. Optional — without it the reset speed 0 is assumed.
func (d *DMA) SetTurbo(turbo func() byte) { d.turbo = turbo }

// SetPauseFunc attaches the dma-delay condition (see the pauseFn field).
// Optional — without it transfers never yield, the pre-#158 behaviour and
// the correct one whenever NR$CC-$CE are all zero (the reset default).
func (d *DMA) SetPauseFunc(f func(nowRef uint64) (bool, uint64)) { d.pauseFn = f }

// Suspended reports whether a continuous-mode block is parked mid-transfer
// waiting for the dma-delay condition to clear.
func (d *DMA) Suspended() bool { return d.suspended }

// SetZilogMode latches the dma_mode select. The ULA calls it on every
// DMA port access with "was this port $0B" — mirroring the FPGA, which
// latches port_0b_lsb whenever the DMA is read or written
// (zxnext.vhd:1811-1819). The latched mode is consumed at LOAD /
// CONTINUE / auto-restart time (the counter seed), not per byte.
func (d *DMA) SetZilogMode(z bool) { d.zilogMode = z }

// counterSeed is the LOAD/CONTINUE/auto-restart byte-counter seed:
// dma.vhd:482-486 — all-zeros in zxnDMA mode, all-ones (-1) in Z80-DMA
// compatibility mode ("z80 dma loads -1").
func (d *DMA) counterSeed() int {
	if d.zilogMode {
		return -1
	}
	return 0
}

// WriteCommand accepts one byte of the port-0x6B/0x0B command stream.
// Wired via ULA.SetNextDMA / the routing in ULA.WritePort.
func (d *DMA) WriteCommand(val byte) {
	if dmaTrace {
		dmaLog(val)
	}
	if len(d.pending) > 0 {
		f := d.pending[0]
		d.pending = d.pending[1:]
		f(val)
		return
	}
	d.decodeBase(val)
}

func setLow(p *uint16) func(byte)  { return func(v byte) { *p = (*p &^ 0x00FF) | uint16(v) } }
func setHigh(p *uint16) func(byte) { return func(v byte) { *p = (*p &^ 0xFF00) | uint16(v)<<8 } }
func ignore() func(byte)           { return func(byte) {} }

// addrMode decodes a WR1/WR2 byte's address-mode bits (D5 D4): bit 5 set
// = fixed; else bit 4 set = increment; else decrement.
func addrMode(val byte) byte {
	switch {
	case val&0x20 != 0:
		return addrFixed
	case val&0x10 != 0:
		return addrIncrement
	default:
		return addrDecrement
	}
}

// decodeBase interprets a base register byte and queues its follow
// bytes (or, for WR6, executes the command immediately).
func (d *DMA) decodeBase(val byte) {
	if val&0x80 == 0 {
		switch {
		case val&0x03 != 0: // WR0 — transfer setup
			d.aToB = val&0x04 != 0
			var p []func(byte)
			if val&0x08 != 0 {
				p = append(p, setLow(&d.portAStart))
			}
			if val&0x10 != 0 {
				p = append(p, setHigh(&d.portAStart))
			}
			if val&0x20 != 0 {
				p = append(p, setLow(&d.blockLen))
			}
			if val&0x40 != 0 {
				p = append(p, setHigh(&d.blockLen))
			}
			d.pending = p
		case val&0x07 == 0x04: // WR1 — port A config
			d.aMode = addrMode(val)
			d.aIsIO = val&0x08 != 0
			if val&0x40 != 0 { // variable-timing byte follows
				d.pending = []func(byte){d.aTimingByte()}
			}
		case val&0x07 == 0x00: // WR2 — port B config
			d.bMode = addrMode(val)
			d.bIsIO = val&0x08 != 0
			if val&0x40 != 0 {
				d.pending = []func(byte){d.bTimingByte()}
			}
		}
		return
	}
	switch val & 0x03 {
	case 0x00: // WR3 — match/mask (accepted; follow bytes skipped)
		var p []func(byte)
		if val&0x08 != 0 {
			p = append(p, ignore())
		}
		if val&0x10 != 0 {
			p = append(p, ignore())
		}
		d.pending = p
	case 0x01: // WR4 — port B address + transfer mode
		switch (val >> 5) & 0x03 {
		case 0x02: // 10 = burst
			d.mode = modeBurst
		default: // 01 continuous; 00/11 "do not use" behave continuous
			d.mode = modeContinuous
		}
		var p []func(byte)
		if val&0x04 != 0 {
			p = append(p, setLow(&d.portBStart))
		}
		if val&0x08 != 0 {
			p = append(p, setHigh(&d.portBStart))
		}
		if val&0x10 != 0 { // interrupt-control byte (with its own follows)
			p = append(p, d.interruptControl())
		}
		d.pending = p
	case 0x02: // WR5 — ready/wait/auto-restart (no follow bytes)
		d.autoRestart = val&0x20 != 0 // D5: 0 = stop on end, 1 = auto-restart
	case 0x03: // WR6 — command
		d.command(val)
	}
}

// cycleLen decodes a timing byte's D1:D0 into a read/write cycle count:
// 00=4, 01=3, 10=2 (11 "do not use" → treated as 2).
func cycleLen(v byte) byte {
	switch v & 0x03 {
	case 0x00:
		return 4
	case 0x01:
		return 3
	default:
		return 2
	}
}

// aTimingByte consumes the WR1 (port A) variable-timing byte, latching port A's
// cycle length. Port A has no prescaler.
func (d *DMA) aTimingByte() func(byte) {
	return func(v byte) { d.aCycleLen = cycleLen(v) }
}

// bTimingByte consumes the WR2 (port B) variable-timing byte, latching port B's
// cycle length; if its D5 is set, the zxnDMA fixed-time prescaler byte follows.
func (d *DMA) bTimingByte() func(byte) {
	return func(v byte) {
		d.bCycleLen = cycleLen(v)
		if v&0x20 != 0 {
			d.pending = append(d.pending, func(p byte) { d.prescaler = p })
		}
	}
}

// interruptControl consumes a WR4 interrupt-control byte and its
// optional pulse-offset / vector follow bytes (D3 / D4).
func (d *DMA) interruptControl() func(byte) {
	return func(v byte) {
		if v&0x08 != 0 {
			d.pending = append(d.pending, ignore()) // pulse offset
		}
		if v&0x10 != 0 {
			d.pending = append(d.pending, ignore()) // interrupt vector
		}
	}
}

// command executes a WR6 command byte.
func (d *DMA) command(val byte) {
	switch val {
	case 0xC3: // RESET — clear configuration + state machine (keep the buses
		// and the mode latch: dma_mode lives outside the z80dma entity)
		*d = DMA{mem: d.mem, io: d.io, cycleSink: d.cycleSink, clock: d.clock,
			turbo: d.turbo, zilogMode: d.zilogMode, pauseFn: d.pauseFn,
			aCycleLen: 2, bCycleLen: 2, readMask: 0x7F}
	case 0xCF: // LOAD — latch the start addresses into the source/destination
		// pointers per the direction in force NOW (dma.vhd:646-663). A later
		// direction flip does not re-latch them.
		d.loaded = true
		if d.aToB {
			d.curSrc, d.curDst = d.portAStart, d.portBStart
		} else {
			d.curSrc, d.curDst = d.portBStart, d.portAStart
		}
		d.counter = d.counterSeed()
		d.endOfBlock = false // dma.vhd:654: LOAD clears status_endofblock_n='1'
	case 0xD3: // CONTINUE — reseed the byte counter; a following ENABLE repeats
		// the block from the CURRENT pointers (not the start addresses).
		d.loaded = true
		d.counter = d.counterSeed()
		d.endOfBlock = false // dma.vhd:671: Continue clears status_endofblock_n='1'
	case 0x87: // ENABLE — run the configured transfer
		if d.loaded {
			d.Trigger()
		}
	case 0x83: // DISABLE — dma_seq_s := IDLE (dma.vhd:727-728): stops an
		// in-flight interleaved burst or a pause-parked continuous block;
		// IDLE clears status_atleastone (:265).
		d.activeBurst = false
		d.suspended = false
		d.atLeastOne = false
	case 0xBB: // READ MASK FOLLOWS — next byte sets the read mask AND aims
		// the read state at the first masked register (dma.vhd:859-886).
		d.pending = []func(byte){func(m byte) {
			d.readMask = m & 0x7F
			d.readState = d.firstMaskedReg()
		}}
	case 0xA7: // INITIATE READ SEQUENCE — aim the read state at the first
		// masked register (dma.vhd:694-720).
		d.readState = d.firstMaskedReg()
	case 0xBF: // READ STATUS BYTE — the next read returns status
		// (dma.vhd:687-688: reg_rd_seq_s := RD_STATUS).
		d.readState = 0
	case 0x8B: // REINITIALIZE STATUS BYTE (dma.vhd:690-692):
		// endofblock_n='1', atleastone='0'.
		d.endOfBlock = false
		d.atLeastOne = false
	default:
		// $C7/$CB reset-timing and the interrupt commands need no state
		// change for the transfers the zxnDMA actually runs.
	}
}

// Trigger runs the configured transfer to completion from the current internal
// pointers. Block length 0 means 65536 per the zxnDMA convention. Each byte is
// read from the source endpoint (memory or IO) and written to the destination
// endpoint, advancing each pointer per its port's address mode. On end of block
// the DMA either auto-restarts (reload start addresses, stay armed) or clears
// its loaded flag.
func (d *DMA) Trigger() {
	length := int(d.blockLen)
	if length == 0 {
		length = 65536
	}
	if dmaTrace {
		var now uint64
		if d.clock != nil {
			now = d.clock()
		}
		fmt.Fprintf(os.Stderr, "DMA xfer src=%04X dst=%04X len=%d aIO=%v bIO=%v mode=%d presc=%d clk=%d\n",
			d.curSrc, d.curDst, length, d.aIsIO, d.bIsIO, d.mode, d.prescaler, now)
	}
	// The FPGA loop runs while counter < blockLen, post-increment
	// (dma.vhd:426/454) — so the Z80-mode -1 seed moves one extra byte.
	moved := length - d.counter
	d.lastDuration = uint64(moved) * d.perByteCycles()

	// Burst mode with a fixed-time prescaler interleaves with the CPU: defer
	// the bytes to Step(), which pumps one every prescaler T-states while the
	// CPU runs in the gaps (the spec's only case where burst yields the bus).
	// Without a clock or prescaler it runs to completion like continuous.
	if d.mode == modeBurst && d.prescaler != 0 && d.clock != nil {
		d.activeBurst = true
		d.remaining = moved
		d.nextDue = d.clock()
		return
	}

	d.runSynchronous(moved)
}

// runSynchronous moves a continuous-mode (or clockless-burst) block's bytes,
// yielding to the dma-delay condition between bytes (dma.vhd:269/427 test
// dma_delay_i at START_DMA / WAITING_ACK). Without a pauseFn — or while it
// reports "can never pause" — this is byte-identical to the old
// uninterruptible loop. With one, the block advances in chunks bounded by
// the condition's recheck deadline: bytes that fit before the deadline move
// and charge their duration (the CPU clock advances to the yield instant),
// then the block parks `suspended` for Step to resume once the pause clears.
func (d *DMA) runSynchronous(moved int) {
	remaining := moved
	if d.pauseFn != nil && d.clock != nil {
		refPerByte := d.perByteCycles() >> d.turboLevel()
		if refPerByte == 0 {
			refPerByte = 1
		}
		proj := d.clock()
		checkAt := proj // ask before the first byte
		movedNow := 0
		for remaining > 0 {
			if proj >= checkAt {
				paused, recheck := d.pauseFn(proj)
				if paused {
					break
				}
				checkAt = recheck
				if checkAt <= proj { // 0 = re-ask before every byte
					checkAt = proj + 1
				}
			}
			d.moveByte()
			movedNow++
			remaining--
			proj += refPerByte
		}
		if d.mode == modeContinuous && d.cycleSink != nil && movedNow > 0 {
			d.cycleSink(uint64(movedNow) * d.perByteCycles())
		}
		if remaining > 0 {
			d.suspended = true
			d.remaining = remaining
			return
		}
		d.suspended = false
		d.finishBlock()
		return
	}
	for ; remaining > 0; remaining-- {
		d.moveByte()
	}
	// Continuous mode stalls the CPU for the whole transfer; charge the time
	// to the CPU clock. Burst mode lets the CPU run, so it is not charged.
	if d.mode == modeContinuous && d.cycleSink != nil {
		d.cycleSink(d.lastDuration)
	}
	d.finishBlock()
}

// finishBlock applies the auto-restart-or-stop policy after a transfer's last
// byte: auto-restart reloads the start addresses and stays armed; otherwise the
// loaded flag clears. Either way the end-of-block status bit latches (the FPGA
// sets status_endofblock_n='0' at FINISH_DMA, dma.vhd:471, regardless of the
// auto-restart branch).
func (d *DMA) finishBlock() {
	d.endOfBlock = true
	if d.autoRestart {
		// FINISH_DMA re-derives the pointers per the LIVE direction
		// (dma.vhd:473-486), unlike LOAD's once-latched roles.
		if d.aToB {
			d.curSrc, d.curDst = d.portAStart, d.portBStart
		} else {
			d.curSrc, d.curDst = d.portBStart, d.portAStart
		}
		d.counter = d.counterSeed()
	} else {
		d.loaded = false
		d.atLeastOne = false // FSM back to IDLE clears status_atleastone (dma.vhd:265)
	}
}

// Step advances an interleaved burst transfer: it transfers every byte whose
// due time has arrived by `now` (the current CPU T-state), spacing them by the
// per-byte cycle cost (prescaler delay included, at the live turbo speed).
// No-op unless a burst+prescaler transfer is in flight. Call it from the CPU's
// per-instruction hook so DMA-streamed audio is paced correctly and the CPU
// runs between bytes.
//
// An auto-restart block (WR5 D5) reloads the start addresses and keeps
// going — the FPGA goes FINISH_DMA -> START_DMA without ever idling
// (dma.vhd:469-489) — until DISABLE ($83) or RESET stops it.
func (d *DMA) Step(now uint64) {
	if d.suspended {
		// A pause-parked continuous block: resume the moment the
		// dma-delay condition clears (the FPGA sits in START_DMA
		// re-testing dma_delay_i, dma.vhd:269).
		if d.pauseFn != nil {
			if paused, _ := d.pauseFn(now); paused {
				return
			}
		}
		d.suspended = false
		d.runSynchronous(d.remaining)
		return
	}
	if !d.activeBurst {
		return
	}
	if d.pauseFn != nil && d.remaining > 0 && now >= d.nextDue {
		if paused, _ := d.pauseFn(now); paused {
			// Yield: the schedule restarts from the unpause instant —
			// delayed bytes resume at prescaler pace, they do not
			// catch up in a burst (the FPGA re-enters START_DMA and
			// paces from there).
			d.burstPaused = true
			return
		}
		if d.burstPaused {
			d.burstPaused = false
			d.nextDue = now
		}
	}
	per := d.perByteClockUnits()
	for d.remaining > 0 && now >= d.nextDue {
		d.moveByte()
		d.remaining--
		d.nextDue += per
		d.atLeastOne = true // status_atleastone, set per byte (dma.vhd:412)
		if d.remaining == 0 && d.autoRestart {
			d.endOfBlock = true // FINISH_DMA latches it even on restart (dma.vhd:471)
			if d.aToB {
				d.curSrc, d.curDst = d.portAStart, d.portBStart
			} else {
				d.curSrc, d.curDst = d.portBStart, d.portAStart
			}
			d.counter = d.counterSeed()
			length := int(d.blockLen)
			if length == 0 {
				length = 65536
			}
			d.remaining = length - d.counter
		}
	}
	if d.remaining == 0 {
		d.activeBurst = false
		d.finishBlock()
	}
}

// moveByte transfers one byte from curSrc to curDst and advances both
// pointers. Which PORT (A or B) plays source is the LIVE direction bit —
// the source uses port A's mode/IO-ness when transferring A->B, port B's
// otherwise, regardless of which start address LOAD latched into curSrc
// (dma.vhd:350-396: the mreq/step decisions all test R0_dir_AtoB_s live).
func (d *DMA) moveByte() {
	srcMode, srcIsIO := d.aMode, d.aIsIO
	dstMode, dstIsIO := d.bMode, d.bIsIO
	if !d.aToB { // port B is the source
		srcMode, srcIsIO, dstMode, dstIsIO = d.bMode, d.bIsIO, d.aMode, d.aIsIO
	}
	v := d.endpointRead(srcIsIO, d.curSrc)
	d.curSrc = stepAddr(d.curSrc, srcMode)
	d.endpointWrite(dstIsIO, d.curDst, v)
	d.curDst = stepAddr(d.curDst, dstMode)
	d.counter++
}

func (d *DMA) endpointRead(isIO bool, addr uint16) byte {
	if isIO {
		if d.io != nil {
			return d.io.ReadPort(addr)
		}
		return 0xFF
	}
	return d.mem.Read(addr)
}

func (d *DMA) endpointWrite(isIO bool, addr uint16, val byte) {
	if isIO {
		if d.io != nil {
			d.io.WritePort(addr, val)
		}
		return
	}
	d.mem.Write(addr, val)
}

// perByteCycles is the T-state cost of moving one byte: the source read cycle
// length plus the destination write cycle length, or the prescaler delay if it
// is larger (the FPGA waits after each byte's write until its 28MHz timer
// reaches prescaler*32, dma.vhd:424/451 — the zxnDMA fixed-time sampled-audio
// feature).
func (d *DMA) perByteCycles() uint64 {
	srcCyc, dstCyc := d.aCycleLen, d.bCycleLen
	if !d.aToB { // B is the source
		srcCyc, dstCyc = d.bCycleLen, d.aCycleLen
	}
	per := uint64(srcCyc) + uint64(dstCyc)
	if delay := d.prescalerTstates(); delay > per {
		per = delay
	}
	return per
}

// prescalerTstates is the prescaler's per-byte delay in CPU T-states at the
// current turbo speed. The FPGA timer gains 8>>turbo per 28MHz tick
// (dma.vhd:250-255) and the transfer stalls until it reaches prescaler*32
// (timer bits 13:5 compared against the prescaler, dma.vhd:424/451), so the
// delay is prescaler*32/(8>>turbo) 28MHz ticks = prescaler*4^turbo/2
// T-states — the delay per byte GROWS with the CPU speed, which is exactly
// what the upstream DMA test's MHz-stepping burst fill shows on hardware.
func (d *DMA) prescalerTstates() uint64 {
	if d.prescaler == 0 {
		return 0
	}
	t := d.turboLevel()
	return (uint64(d.prescaler) << (2 * t)) / 2
}

func (d *DMA) turboLevel() byte {
	if d.turbo == nil {
		return 0
	}
	return d.turbo() & 3
}

// perByteClockUnits is the per-byte spacing of an interleaved burst in the
// clock's units — MONOTONIC 3.5MHz-reference T-states. The prescaler's wall
// delay of prescaler*32/(8>>turbo) 28MHz ticks is prescaler*2^turbo/2
// reference T-states (one reference T-state = 8 ticks). The read+write
// cycle-length component is negligible against any prescaler that engages
// this path and is not added.
func (d *DMA) perByteClockUnits() uint64 {
	per := (uint64(d.prescaler) << d.turboLevel()) / 2
	if per == 0 {
		per = 1
	}
	return per
}

func stepAddr(a uint16, mode byte) uint16 {
	switch mode {
	case addrIncrement:
		return a + 1
	case addrDecrement:
		return a - 1
	default: // addrFixed
		return a
	}
}

// Source / Destination / Length — accessors for tests. Source is the
// port A start address, Destination the port B start address.
func (d *DMA) Source() uint16      { return d.portAStart }
func (d *DMA) Destination() uint16 { return d.portBStart }
func (d *DMA) Length() uint16      { return d.blockLen }

// ByteCounter / CurrentA / CurrentB expose the chip's internal counters (the
// values the read mask returns): bytes transferred in the current operation and
// the live port A / port B pointers. The FPGA stores (src, dst) and maps them
// to port A / port B through the live direction bit on read-back
// (dma.vhd:997-1001 etc.), so these do the same.
func (d *DMA) ByteCounter() uint16 { return uint16(d.counter) }

func (d *DMA) CurrentA() uint16 {
	if d.aToB {
		return d.curSrc
	}
	return d.curDst
}

func (d *DMA) CurrentB() uint16 {
	if d.aToB {
		return d.curDst
	}
	return d.curSrc
}

// Duration returns the T-state cost of the most recent transfer (per-byte cycle
// cost × bytes moved). The emulator charges this to the CPU clock so a
// continuous-mode transfer consumes the right amount of time.
func (d *DMA) Duration() uint64 { return d.lastDuration }

// Mode returns the transfer mode (continuous or burst) from the last WR4 write.
func (d *DMA) Mode() byte { return d.mode }

// ReadCommand returns the register the read state currently points at (an IO
// read of port 0x6B), then advances the state to the next masked register
// after it, wrapping — exactly the FPGA's per-read reg_rd_seq_s transitions
// (dma.vhd:895-1133). An empty mask parks the state on STATUS, so reads
// return the status byte (every VHDL else-branch lands on RD_STATUS).
func (d *DMA) ReadCommand() byte {
	v := d.regValue(d.readState)
	d.readState = d.nextMaskedReg(d.readState)
	return v
}

// firstMaskedReg returns the register the read state is aimed at by $A7 /
// the $BB follow byte: the lowest set mask bit, or STATUS when the mask is
// empty (dma.vhd:694-720 / 859-886).
func (d *DMA) firstMaskedReg() int {
	for bit := 0; bit < 7; bit++ {
		if d.readMask&(1<<bit) != 0 {
			return bit
		}
	}
	return 0
}

// nextMaskedReg returns the read state following a read of register cur: the
// next masked register scanning cur+1..6 then 0..cur, defaulting to STATUS
// (dma.vhd:895-1133 — each RD_* case's if/elsif ladder in exactly this order).
func (d *DMA) nextMaskedReg(cur int) int {
	for i := 1; i <= 7; i++ {
		bit := (cur + i) % 7
		if d.readMask&(1<<bit) != 0 {
			return bit
		}
	}
	return 0
}

// regValue returns the current value of read-mask register reg:
// 0=status, 1/2=byte counter lo/hi, 3/4=port A addr lo/hi, 5/6=port B addr lo/hi.
func (d *DMA) regValue(reg int) byte {
	switch reg {
	case 1:
		return byte(uint16(d.counter))
	case 2:
		return byte(uint16(d.counter) >> 8)
	case 3:
		return byte(d.CurrentA())
	case 4:
		return byte(d.CurrentA() >> 8)
	case 5:
		return byte(d.CurrentB())
	case 6:
		return byte(d.CurrentB() >> 8)
	default: // 0 = status byte
		return d.statusByte()
	}
}

// statusByte builds the read-mask status register exactly as the FPGA does
// (dma.vhd:902): "00" & status_endofblock_n & "1101" & status_atleastone.
//
//	bits 7:6 = 00
//	bit 5    = status_endofblock_n (1 = not at end, 0 = block finished)
//	bits 4:1 = 1101 (fixed)
//	bit 0    = status_atleastone — set while a transfer is mid-flight
//	           (an interleaved burst that has moved a byte), cleared when
//	           the FSM returns to IDLE (dma.vhd:265). Synchronous transfers
//	           complete inside ENABLE, so a read only ever observes them
//	           idle: 0.
func (d *DMA) statusByte() byte {
	const fixed = 0x1A // bits 4:1 = 1101, bits 5/0 = 0
	s := byte(fixed)
	if !d.endOfBlock { // status_endofblock_n = 1
		s |= 0x20
	}
	if d.atLeastOne {
		s |= 0x01
	}
	return s
}
