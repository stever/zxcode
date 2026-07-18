package main

import (
	"log/slog"
	"os"
	"sort"

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
// MOVE instant to a frame-relative reference T-state, and the CPU's
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

	instants   []int // frame-relative ref T-states, ascending
	vals       []byte
	idx        int
	lastOrigin uint64

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
}

// quietRebuildM1s is how many consecutive polls without a copper
// write must pass before a dirtied schedule is rebuilt (~a few µs of
// guest time; an NMI pacer's ~170-T-state period is never starved
// perceptibly, and a per-frame list patcher costs one rebuild per
// quiet gap instead of one per write).
const quietRebuildM1s = 64

func newCopperNMIPacer(cop *copper.Copper, cpu *z80.CPU, mem *memory.Memory, disp *nextregs.Dispatcher) *copperNMIPacer {
	return &copperNMIPacer{cop: cop, cpu: cpu, mem: mem, disp: disp}
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
		p.dirty = true
		p.quietM1 = 0
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
		// Fast-forward past already-elapsed instants: a mid-frame
		// rebuild must not fire the frame's past as a burst.
		t := int(p.cpu.RefTstates() - origin)
		for p.idx < len(p.instants) && p.instants[p.idx] <= t {
			p.idx++
		}
		if copperNMITrace {
			slog.Info("copper-nmi: rebuilt after quiet gap",
				"instants", len(p.instants), "skipped", p.idx, "t", t,
				"mode", p.cop.Mode(), "pc", p.cpu.PC)
		}
		return
	}
	if origin != p.lastOrigin {
		p.lastOrigin = origin
		p.rebuild()
	}
	if p.idx >= len(p.instants) {
		return
	}
	t := int(p.cpu.RefTstates() - origin)
	for p.idx < len(p.instants) && p.instants[p.idx] <= t {
		p.disp.WriteReg(0x02, p.vals[p.idx])
		p.idx++
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
	moves := p.cop.FrameMoveInstants(0x02, g.Lines, tpl*copper.CyclesPerHcount*2)
	if len(moves) == 0 {
		return
	}
	// cvc line L plays at raw line (L+MinVActive)%Lines; a copper cycle
	// is 1/8 of a reference T-state (28 MHz vs 3.5 MHz).
	type inst struct {
		t   int
		val byte
	}
	tmp := make([]inst, len(moves))
	for i, m := range moves {
		raw := (int(m.Line) + g.MinVActive) % g.Lines
		tmp[i] = inst{t: raw*tpl + m.Cycle/8, val: m.Val}
	}
	sort.Slice(tmp, func(i, j int) bool { return tmp[i].t < tmp[j].t })
	for _, e := range tmp {
		p.instants = append(p.instants, e.t)
		p.vals = append(p.vals, e.val)
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
