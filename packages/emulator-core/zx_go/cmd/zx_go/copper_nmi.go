package main

import (
	"log/slog"
	"os"

	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/next/copper"
	"github.com/conorarmstrong/zx_go/pkg/next/nextregs"
	"github.com/conorarmstrong/zx_go/pkg/z80"
)

// copperNMITrace gates the pacer's diagnostic logging
// (ZX_GO_COPPER_NMI_TRACE=1): schedule rebuilds and generation bumps.
var copperNMITrace = os.Getenv("ZX_GO_COPPER_NMI_TRACE") != ""

// copperNMIPacer delivers the copper's NR$02 MOVEs (NMI generation,
// zxnext.vhd nmi_cu_02_we) on the CPU timeline. The copper's
// authoritative execution happens inside the render pass, AFTER the
// frame's CPU has already run — every write it fires there lands on an
// idle CPU and a whole frame's worth of NMI edges collapses into one
// PendingNMI latch, delivered once at the next frame's first
// instruction. A free-running NMI pacer list (Atic Atac: 1024 entries,
// final MOVE NR$02,$04 — one divMMC NMI per ~1361-cycle wrap, ~20 kHz)
// therefore ran at 50 Hz: one sample per frame, the game's entire
// music-position timeline ~400x slow, and every scene gated on a music
// position froze (#187).
//
// Per CPU frame this pacer simulates one frame of copper execution on
// a THROWAWAY copy (copper.FrameMoveInstants — the real state still
// advances only in the render pass), converts each captured NR$02
// MOVE instant to a frame-relative 28 MHz copper cycle, and the CPU's
// ExtNMIFunc poll (live during HALT too) fires the writes through the
// NextReg dispatcher as the CPU crosses each instant — so the NMI source latching, divMMC
// automap arming and Multiface semantics all stay in the dispatcher's
// one NR$02 handler. The render pass's copper RegWriter filters NR$02
// out (copperVideoWriter) so the same MOVE is never applied twice.
//
// Instant mapping: FrameMoveInstants lines are the copper's vcount
// space (cvc, 0 = paper top); the CPU frame origin
// (FrameOriginRefTstates) is raw line 0, paper top at MinVActive.
type copperNMIPacer struct {
	cop  *copper.Copper
	cpu  *z80.CPU
	mem  *memory.Memory
	disp *nextregs.Dispatcher

	instants   []int // frame-relative COPPER CYCLES (28 MHz), ascending
	vals       []byte
	idx        int
	lastOrigin uint64
	// Seam carry: sim instants past the CPU frame budget belong to
	// copper time the render also advanced — dropping them made a
	// deterministic ~1.3-NMI gap at the frame origin every frame.
	// Atic Atac's engine switches NMI-stub sets in phase with its
	// raster-synced effects; the per-frame hiccup slipped the stub
	// walk one sample per frame until a stack-repointing stub fired
	// mis-phased and derailed the machine (#187). Overflow instants
	// are re-based into the next frame's schedule instead.
	carryT   []int
	carryVal []byte

	// Staleness: any CPU write to the copper (NR$60-$63 — program data,
	// cursor, mode) invalidates the precomputed schedule. The schedule
	// clears IMMEDIATELY (a stopped/reprogrammed pacer must stop firing
	// NMIs at once — firing from the old list mid-transition crashes
	// guests that believe the pacer is off), then rebuilds only after a
	// quiet gap, so a reprogramming burst (1000+ data writes) doesn't
	// re-simulate per write. Rebuilds mid-frame fast-forward past the
	// already-elapsed instants instead of firing them as a burst.
	lastGen uint32
	dirty   bool
	quietM1 int
	// dirty8 is the absolute Ref8 (28 MHz reference) instant of the
	// LAST generation bump. The post-rebuild fast-forward cuts at this
	// instant, not at the rebuild instant: instants that elapsed
	// DURING the quiet gap (the ~64 M1s between the final NR write and
	// the rebuild) would have fired on the FPGA — dropping them loses
	// a just-started list's first pulse, which a guest may be DI;HALT
	// waiting on. Instants before the bump belong to the OLD list's
	// already-delivered schedule and stay skipped.
	dirty8 uint64

	// onDeliver, when non-nil, observes each delivered write (probe
	// instrumentation): the instant's absolute Ref8 time and the value.
	onDeliver func(instant8 uint64, val byte)
}

// quietRebuildM1s is how many consecutive polls without a copper
// write must pass before a dirtied schedule is rebuilt (~a few µs of
// guest time; an NMI pacer's ~170-T-state period is never starved
// perceptibly, and a per-frame list patcher costs one rebuild per
// quiet gap instead of one per write).
const quietRebuildM1s = 64

func newCopperNMIPacer(cop *copper.Copper, cpu *z80.CPU, mem *memory.Memory, disp *nextregs.Dispatcher) *copperNMIPacer {
	p := &copperNMIPacer{cop: cop, cpu: cpu, mem: mem, disp: disp}
	// Deadline-gated dispatch (#187 performance): after each poll the
	// pacer arms the CPU's ExtNMI gate with its next instant, so the
	// per-instruction (and per-HALT-T-state) closure call collapses to
	// an integer compare between instants — the wasm build's dominant
	// per-instruction overhead at 28 MHz. Any copper reprogramming
	// voids the gate at once so the next sample point re-polls and the
	// stale schedule clears with pre-gate promptness.
	cop.SetGenerationHook(cpu.KickExtNMIDeadline)
	return p
}

// armDeadline publishes the pacer's next pending instant into the
// CPU's ExtNMI dispatch gate: the next poll happens exactly at the
// first sample point whose reference time reaches that instant —
// the same point the ungated per-instruction poll would have fired.
// With nothing pending the gate parks until the next frame origin
// (the CPU clears it there; the origin poll rebuilds the schedule).
// Never armed while dirty: the quiet-gap counter needs every sample
// point.
func (p *copperNMIPacer) armDeadline(origin uint64) {
	if p.dirty {
		return
	}
	if p.idx >= len(p.instants) {
		p.cpu.DisarmExtNMIDeadline()
		return
	}
	p.cpu.ArmExtNMIDeadline(uint64(p.instants[p.idx]) + origin*8)
}

// poll is the CPU's ExtNMIFunc: called at every instruction's INT
// sample point AND every T-state of a HALT. It rebuilds the schedule
// at each frame origin, then fires every scheduled NR$02 write whose
// instant the reference timeline has crossed. Multiple crossed
// instants (long instruction, HALT wake) all write — the CPU's single
// PendingNMI latch coalesces them exactly like the hardware's edge
// latch.
func (p *copperNMIPacer) poll(_ uint64) {
	if g := p.cop.Generation(); g != p.lastGen {
		if copperNMITrace && !p.dirty {
			slog.Info("copper-nmi: gen bump, schedule cleared",
				"gen", g, "pc", p.cpu.PC, "mode", p.cop.Mode())
		}
		p.lastGen = g
		p.instants = p.instants[:0]
		p.vals = p.vals[:0]
		p.idx = 0
		// The seam carry belongs to the OLD list's trajectory — carrying
		// it into a reprogrammed list's first frame fires a stale NMI
		// bunched against the new list's own first instant, overrunning
		// the one-push pad Atic Atac's SP-repointing stubs rely on (#187).
		p.carryT = p.carryT[:0]
		p.carryVal = p.carryVal[:0]
		p.dirty = true
		p.quietM1 = 0
		p.dirty8 = p.cpu.Ref8Tstates()
		return
	}
	origin := p.cpu.FrameOriginRefTstates()
	if p.dirty {
		p.quietM1++
		if p.quietM1 < quietRebuildM1s {
			return
		}
		p.dirty = false
		p.lastOrigin = origin
		p.rebuild()
		// Fast-forward past instants already covered by the OLD
		// schedule (before the generation bump): a mid-frame rebuild
		// must not re-fire the frame's past as a burst. Instants
		// between the bump and now fire below on this or the next
		// poll — the FPGA delivered those during the quiet gap
		// (dropping them starves a just-started pacer's first pulse).
		cut := int64(p.dirty8) - int64(origin*8)
		for p.idx < len(p.instants) && int64(p.instants[p.idx]) <= cut {
			p.idx++
		}
		if copperNMITrace {
			slog.Info("copper-nmi: rebuilt after quiet gap",
				"instants", len(p.instants), "skipped", p.idx, "cut", cut,
				"mode", p.cop.Mode(), "pc", p.cpu.PC)
		}
	}
	if origin != p.lastOrigin {
		p.lastOrigin = origin
		p.rebuild()
	}
	if p.idx >= len(p.instants) {
		p.armDeadline(origin)
		return
	}
	// 28 MHz-granular comparison: an instant fires once the reference
	// clock has REACHED it. The old refT compare truncated instants /8,
	// firing up to 7 copper cycles early (#187 conformance).
	t8 := int(p.cpu.Ref8Tstates() - origin*8)
	for p.idx < len(p.instants) && p.instants[p.idx] <= t8 {
		if p.onDeliver != nil {
			p.onDeliver(uint64(p.instants[p.idx])+origin*8, p.vals[p.idx])
		}
		p.disp.WriteReg(0x02, p.vals[p.idx])
		p.idx++
	}
	p.armDeadline(origin)
}

// noteEnvelopeReopen models the FPGA NMI arbiter's mid-RETN gate
// reopen (#187). On the FPGA a divMMC-NMI pulse arriving while
// nmi_activated is latched is DROPPED (the arbiter latch only accepts
// when nmi_activated='0', zxnext.vhd:2096-2116), and the envelope
// reopens ~6 CPU cycles BEFORE the RETN instruction completes:
// retn_seen pulses at T3 of the $45 M1 fetch (im2_control.vhd:236,
// "active in T3 for rising edge of T4"), the divMMC clears button_nmi/
// automap on the next CLK_28 edge (divmmc.vhd:108,126), nmi_hold drops
// and the state machine walks S_NMI_HOLD -> S_NMI_END -> S_NMI_IDLE in
// two i_CLK_CPU edges with the latches clearing in S_NMI_END
// (zxnext.vhd:2118-2166) — cycle ~12 of RETN's 18 at 28 MHz (~8 of 14
// at 3.5 MHz).
//
// The emulator's poll granularity is instruction ends: an instant that
// elapses DURING the RETN would otherwise be delivered at the
// end-of-RETN poll, AFTER the retnHook cleared the envelope — an NMI
// the FPGA never sees. The RETN hook calls this (only when an NMI was
// in flight) with the reopen instant; scheduled pure divMMC-NMI pulses
// ($04 — Atic Atac's pacer value) earlier than it are dropped exactly
// like the hardware drops them. Values carrying reset/MF/bus bits keep
// their write (those paths are not gated by this arbiter latch).
func (p *copperNMIPacer) noteEnvelopeReopen(reopen8 uint64) {
	origin8 := p.cpu.FrameOriginRefTstates() * 8
	dropped := false
	for p.idx < len(p.instants) &&
		uint64(p.instants[p.idx])+origin8 < reopen8 &&
		p.vals[p.idx] == 0x04 {
		p.idx++
		dropped = true
	}
	// The armed dispatch gate points at a dropped instant now — void it
	// so the next sample point re-polls and re-arms on the new head.
	if dropped {
		p.cpu.KickExtNMIDeadline()
	}
}

// rebuild recomputes the frame's NR$02 schedule from the copper's
// current (render-authoritative) state. Cheap gate first: most
// programs never MOVE to NR$02.
func (p *copperNMIPacer) rebuild() {
	p.instants = p.instants[:0]
	p.vals = p.vals[:0]
	p.idx = 0
	if !p.cop.HasRunnableMoveTo(0x02) {
		return
	}
	g := p.mem.NextGeometry()
	tpl := g.TStatesPerLine
	// Simulate the SAME number of lines the render pass drives the
	// authoritative copper with — the live geometry's Lines (the render
	// follows it too since #187) — so the schedule's trajectory stays
	// continuous with the real state across frames. Instants are
	// anchored on MONOTONIC SIM TIME (cumulative copper cycles from
	// frame origin, 8 cycles per reference T-state), NOT re-folded onto
	// the raster: folding parked two instants back-to-back at every
	// frame seam. Atic Atac's stream updater repoints SP into a reused
	// parameter block whose sacrificial pad absorbs exactly ONE NMI
	// push — a bunched pair overran the pad, a return address became a
	// stream sector, and the streamer died on its data-token timeout
	// (#187). The cost of sim-time anchoring: a raster-WAIT-anchored
	// NR$02 list would fire with a paper-top phase offset (rate still
	// exact); no known title uses one.
	lines := g.Lines
	cyclesPerLine := tpl * copper.CyclesPerHcount * 2
	frame8 := g.FrameTStates() * 8
	p.instants = append(p.instants, p.carryT...)
	p.vals = append(p.vals, p.carryVal...)
	p.carryT = p.carryT[:0]
	p.carryVal = p.carryVal[:0]
	moves := p.cop.FrameMoveInstants(0x02, lines, cyclesPerLine)
	for _, m := range moves {
		// Copper-cycle (28 MHz) instants, no /8 truncation. The FPGA
		// pipeline from the MOVE's first cycle N (the instruction read;
		// m.Cycle) to CPU-visible NMI is 4 register stages + the
		// same-edge sampling rule, so the earliest end-of-instruction
		// edge that can accept the NMI is N+5 (#187 conformance):
		//   N+1  copper_dout_s registered (the write pulse lands on the
		//        MOVE's SECOND cycle, copper.vhd:87-96)
		//   N+2  copper_req rising-edge detect register
		//        (zxnext.vhd:4709-4737)
		//   N+3  arbiter nmi_divmmc latch -> nmi_generate_n asserts
		//        NMI_n (zxnext.vhd:2096-2116, :2166)
		//   N+4  T80N NMI_s synchronizer registers the edge
		//        (t80n.vhd:1650-1670)
		//   N+5  first T_Res edge that samples NMI_s='1' (a clocked
		//        process reads the PRE-edge value, so the N+4 edge
		//        itself still sees 0; t80n.vhd:1765)
		// The delivery compare below is `instant <= t8(end of
		// instruction)`, so the instant is anchored at N+5.
		t := int(m.Line)*cyclesPerLine + m.Cycle + 5
		if t >= frame8 {
			p.carryT = append(p.carryT, t-frame8)
			p.carryVal = append(p.carryVal, m.Val)
			continue
		}
		p.instants = append(p.instants, t)
		p.vals = append(p.vals, m.Val)
	}
}

// copperVideoWriter is the render-pass RegWriter for the copper: every
// video register passes through to the dispatcher as before, but NR$02
// (NMI/reset generation) is dropped — the copperNMIPacer delivers those
// writes on the CPU timeline instead, where their NMI edges land at the
// hardware cadence rather than coalescing at render time.
type copperVideoWriter struct {
	d copper.RegWriter
}

func (w copperVideoWriter) WriteReg(reg, val byte) {
	if reg == 0x02 {
		return
	}
	w.d.WriteReg(reg, val)
}
