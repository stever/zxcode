package memory

// Value-identity cross-checks for the read/write fast-path caches
// (#187). The subject Memory runs with the fast paths live; the
// reference Memory has them force-disabled through the global gates
// (a no-op allReadHook blocks read caching, a no-op WriteObserver
// blocks write caching — both observers are value-neutral), so every
// reference access takes the full readValue/writeValue dispatch.
// Identical mutation/event streams must then produce identical reads
// everywhere, across random paging and overlay churn — including the
// divMMC automap transitions that toggle the bottom-16K mapping at
// NMI cadence in Atic Atac.

import (
	"math/rand"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/divmmc"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// xcheckRig is one Memory + divMMC pager pair wired the way
// cmd/zx_go/next.go wires production: chained peripheral hooks,
// bottom-only write declaration, overlay probe and map-change
// notifier, rom3 gate.
type xcheckRig struct {
	mem   *Memory
	pager *divmmc.Pager
}

func newXcheckRig(t *testing.T, reference bool) *xcheckRig {
	t.Helper()
	m, err := New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	rom := make([]byte, divmmc.ROMSize)
	for i := range rom {
		rom[i] = byte(0xD0 ^ i ^ i>>8)
	}
	p := divmmc.New(rom)
	p.SetAutomap(true)
	p.SetRom3Query(m.DivMMCRom3Gate)
	m.PeripheralRead = p.HandleRead
	m.PeripheralWrite = func(addr uint16, val byte) bool { return p.HandleWrite(addr, val) }
	m.SetPeripheralWriteBottomOnly(true)
	m.SetBottomOverlayProbe(p.OverlayActive)
	p.SetMapChangeNotifier(m.InvalidateBottomFast)
	mf := make([]byte, 0x2000)
	for i := range mf {
		mf[i] = byte(0x3C ^ i)
	}
	m.SetMultifaceROM(mf)
	if reference {
		// Force the slow path everywhere: these observers are the
		// caches' global gates and value-neutral by contract.
		m.SetAllReadHook(func(addr uint16, val byte) {})
		m.SetWriteObserver(func(addr uint16, val byte, pc uint16) {})
	}
	return &xcheckRig{mem: m, pager: p}
}

// TestFastPathRandomizedCrossCheck drives two production-wired rigs
// with one deterministic random stream of paging mutations, overlay
// transitions and guest writes, comparing reads continuously. Any
// stale fast-path entry (a missed invalidation choke point) shows up
// as a byte divergence at the address it covers.
func TestFastPathRandomizedCrossCheck(t *testing.T) {
	subj := newXcheckRig(t, false)
	ref := newXcheckRig(t, true)
	rng := rand.New(rand.NewSource(0xA71C47AC))

	bootrom := make([]byte, 0x2000)
	for i := range bootrom {
		bootrom[i] = byte(0xB0 ^ i)
	}

	both := func(fn func(r *xcheckRig)) {
		fn(subj)
		fn(ref)
	}

	sample := func(round int) {
		t.Helper()
		if a, b := subj.pager.IsPagedIn(), ref.pager.IsPagedIn(); a != b {
			t.Fatalf("round %d: pager lockstep lost (subj paged=%v ref=%v)", round, a, b)
		}
		// 64 random probes plus the bottom-16K boundary addresses the
		// overlay decode splits on.
		probes := []uint16{0x0000, 0x1FFF, 0x2000, 0x3FFF, 0x4000, 0x8000, 0xC000, 0xFFFF}
		for i := 0; i < 64; i++ {
			probes = append(probes, uint16(rng.Intn(0x10000)))
		}
		for _, a := range probes {
			got, want := subj.mem.Read(a), ref.mem.Read(a)
			if got != want {
				t.Fatalf("round %d: Read($%04X) fast=$%02X slow=$%02X", round, a, got, want)
			}
		}
	}

	for round := 0; round < 4000; round++ {
		switch rng.Intn(20) {
		case 0: // MMU slot reassignment (incl. the Atic slots 0/1)
			slot := byte(rng.Intn(8))
			bank := byte(rng.Intn(48))
			if rng.Intn(4) == 0 {
				bank = 0xFF
			}
			both(func(r *xcheckRig) { r.mem.SetMMU(slot, bank) })
		case 1: // classic 128K paging (keep bit 5 clear: the paging
			// lock is one-way and would freeze the rest of the run)
			v := byte(rng.Intn(256)) &^ 0x20
			both(func(r *xcheckRig) { r.mem.PageMemory(v) })
		case 2: // +3 special paging / ROM high bit
			v := byte(rng.Intn(256)) &^ 0x20
			both(func(r *xcheckRig) { r.mem.PageMemoryPlus3(v) })
		case 3: // Alt-ROM NR$8C (read/write redirects, lock bits)
			v := byte(rng.Intn(256))
			both(func(r *xcheckRig) { r.mem.SetAltROMReg(v) })
		case 4: // Multiface overlay in/out
			on := rng.Intn(2) == 0
			both(func(r *xcheckRig) { r.mem.SetMultifaceActive(on) })
		case 5: // config mode enter/exit + window page
			if rng.Intn(2) == 0 {
				pg := byte(rng.Intn(4))
				both(func(r *xcheckRig) {
					r.mem.SetConfigModeRAMPage(pg)
					r.mem.EnterConfigMode()
				})
			} else {
				both(func(r *xcheckRig) { r.mem.ClearConfigMode() })
			}
		case 6: // FPGA bootrom arm / clear
			if rng.Intn(2) == 0 {
				both(func(r *xcheckRig) { r.mem.SetFPGABootROM(bootrom) })
			} else {
				both(func(r *xcheckRig) { r.mem.ClearFPGABootROM() })
			}
		case 7: // Layer-2 legacy paging $123B (map control or offset)
			v := byte(rng.Intn(256))
			both(func(r *xcheckRig) { r.mem.SetLayer2MapControl(v) })
		case 8: // Layer-2 banks NR$12/$13
			a, s := byte(rng.Intn(96)), byte(rng.Intn(96))
			both(func(r *xcheckRig) {
				r.mem.SetLayer2ActiveBank(a)
				r.mem.SetLayer2ShadowBank(s)
			})
		case 9: // divMMC automap trigger M1 (RST vectors, $3DXX)
			pc := []uint16{0x0000, 0x0008, 0x0038, 0x3D00 + uint16(rng.Intn(0x100))}[rng.Intn(4)]
			both(func(r *xcheckRig) { r.pager.Step(pc) })
		case 10: // ordinary M1 (converts a pending delayed page-in)
			pc := uint16(rng.Intn(0x10000))
			both(func(r *xcheckRig) { r.pager.Step(pc) })
		case 11: // divMMC off-area page-out
			pc := 0x1FF8 + uint16(rng.Intn(8))
			both(func(r *xcheckRig) { r.pager.PostStep(pc) })
		case 12: // RETN unmap
			both(func(r *xcheckRig) { r.pager.HandleRETN() })
		case 13: // port $E3: CONMEM force-in/out, MAPRAM, bank select
			v := byte(rng.Intn(256))
			both(func(r *xcheckRig) { r.pager.WritePort(0xE3, v) })
		case 14: // divMMC NMI entry ($0066 with button latched)
			both(func(r *xcheckRig) {
				r.pager.AssertNMIButton()
				r.pager.Step(0x0066)
			})
		case 15: // entry-point / timing reconfiguration (NR$B8-$BB)
			b8, b9, ba := byte(rng.Intn(256)), byte(rng.Intn(256)), byte(rng.Intn(256))
			both(func(r *xcheckRig) {
				r.pager.SetEntryPoints0(b8)
				r.pager.SetEntryPointsValid0(b9)
				r.pager.SetEntryPointsTiming0(ba)
			})
		case 16: // NR$09 MAPRAM escape
			both(func(r *xcheckRig) { r.pager.ClearMAPRAM() })
		case 17: // EFF7 bit 3: RAM 0 revealed at $0000
			v := byte(rng.Intn(16))
			both(func(r *xcheckRig) { r.mem.SetEFF7(v) })
		case 18: // reset to power-on paging
			both(func(r *xcheckRig) {
				if err := r.mem.Reset(); err != nil {
					t.Fatalf("Reset: %v", err)
				}
			})
		default: // guest writes (the dominant op, like real execution)
			for i := 0; i < 16; i++ {
				a := uint16(rng.Intn(0x10000))
				v := byte(rng.Intn(256))
				both(func(r *xcheckRig) { r.mem.Write(a, v) })
			}
		}
		sample(round)
	}

	// Final full-address-space sweep.
	for a := 0; a < 0x10000; a++ {
		got, want := subj.mem.Read(uint16(a)), ref.mem.Read(uint16(a))
		if got != want {
			t.Fatalf("final sweep: Read($%04X) fast=$%02X slow=$%02X", a, got, want)
		}
	}
}

// TestFastPathDivMMCOverlayTransitions pins the exact Atic Atac shape:
// game code MMU-mapped at $0000-$3FFF (banks 16/17 → slots 0/1), the
// divMMC automap paging in and out around every pacer NMI. Each
// transition must flip the effective bottom-16K mapping immediately —
// a stale cached page would serve game RAM inside the overlay window
// (or esxDOS ROM after the unmap).
func TestFastPathDivMMCOverlayTransitions(t *testing.T) {
	rig := newXcheckRig(t, false)
	m, p := rig.mem, rig.pager

	// Atic's engine mapping: MMU RAM across the bottom 16K.
	m.SetMMU(0, 16) // 16K bank 8 low half
	m.SetMMU(1, 17)
	m.Write(0x0100, 0xAA)
	m.Write(0x2100, 0xBB)
	if got := m.Read(0x0100); got != 0xAA {
		t.Fatalf("MMU RAM read via fast path = $%02X, want $AA", got)
	}
	if m.readFast[0] == nil || m.readFast[1] == nil || m.writeFast[0] == nil {
		t.Fatalf("bottom slots not cached under plain MMU RAM: r0=%v r1=%v w0=%v",
			m.readFast[0] != nil, m.readFast[1] != nil, m.writeFast[0] != nil)
	}
	upper := m.readFast[4] // $8000 slot — must survive bottom-only churn

	// --- NMI-vector automap in (the pacer path), RETN out ---
	p.AssertNMIButton()
	p.Step(0x0066) // instant page-in (NR$BB bit 1/0 armed by default)
	if !p.IsPagedIn() {
		t.Fatal("NMI automap did not page in")
	}
	if got, want := m.Read(0x0100), rig.pagerROMByte(0x0100); got != want {
		t.Fatalf("overlay read $0100 = $%02X, want divMMC ROM $%02X", got, want)
	}
	// Writes inside the overlay window must land in divMMC RAM, not
	// the MMU-mapped game bank.
	m.Write(0x2100, 0x5C)
	if got := p.RAMBank(0)[0x0100]; got != 0x5C {
		t.Fatalf("overlay write went astray: divMMC bank0[$0100]=$%02X, want $5C", got)
	}
	p.HandleRETN() // unmap
	if got := m.Read(0x0100); got != 0xAA {
		t.Fatalf("post-RETN read $0100 = $%02X, want game RAM $AA", got)
	}
	if got := m.Read(0x2100); got != 0xBB {
		t.Fatalf("post-RETN read $2100 = $%02X, want $BB (overlay write must not leak)", got)
	}

	// --- delayed_on RST trap: trigger M1 runs pre-overlay, next M1 in ---
	p.Step(0x0000) // arms pendingPageIn (BA bit 0 clear by default)
	if got := m.Read(0x0100); got != 0xAA {
		t.Fatalf("delayed arm must not remap yet: $0100 = $%02X", got)
	}
	p.Step(0x0002) // conversion M1
	if got, want := m.Read(0x0100), rig.pagerROMByte(0x0100); got != want {
		t.Fatalf("delayed page-in read $0100 = $%02X, want $%02X", got, want)
	}
	p.PostStep(0x1FF8) // off-area page-out
	if got := m.Read(0x0100); got != 0xAA {
		t.Fatalf("off-area page-out read $0100 = $%02X, want $AA", got)
	}

	// --- CONMEM force-in via port $E3 ---
	p.WritePort(0xE3, 0x80)
	if got, want := m.Read(0x0100), rig.pagerROMByte(0x0100); got != want {
		t.Fatalf("CONMEM read $0100 = $%02X, want $%02X", got, want)
	}
	p.WritePort(0xE3, 0x00)
	if got := m.Read(0x0100); got != 0xAA {
		t.Fatalf("CONMEM clear read $0100 = $%02X, want $AA", got)
	}

	// --- Multiface overlay ---
	m.SetMultifaceActive(true)
	if got := m.Read(0x0100); got == 0xAA {
		t.Fatal("Multiface overlay ignored by fast path")
	}
	m.SetMultifaceActive(false)
	if got := m.Read(0x0100); got != 0xAA {
		t.Fatalf("Multiface deactivate read $0100 = $%02X, want $AA", got)
	}

	// --- Alt-ROM read redirect is outranked by MMU RAM, but must
	// apply the moment the MMU stops mapping RAM here ---
	m.SetAltROMReg(0x80)
	if got := m.Read(0x0100); got != 0xAA {
		t.Fatalf("Alt-ROM redirect must lose to MMU RAM: $0100 = $%02X", got)
	}
	m.SetMMU(0, 0xFF)                       // slot 0 back to ROM → redirect engages
	if got := m.Read(0x0100); got != 0x00 { // alt-rom starts zero-filled
		t.Fatalf("Alt-ROM redirect read $0100 = $%02X, want $00", got)
	}
	m.SetAltROMReg(0x00)
	m.SetMMU(0, 16)
	if got := m.Read(0x0100); got != 0xAA {
		t.Fatalf("restored MMU RAM read $0100 = $%02X, want $AA", got)
	}

	// Bottom-only invalidation must not have rebuilt/replaced the
	// upper slots' pages: same backing slice, still cached.
	if m.readFast[4] == nil || &m.readFast[4][0] != &upper[0] {
		t.Fatal("upper-slot cache disturbed by bottom-16K churn")
	}
}

// pagerROMByte returns the divMMC ROM byte the overlay serves at addr
// ($0000-$1FFF window, MAPRAM clear).
func (r *xcheckRig) pagerROMByte(addr uint16) byte {
	return r.pager.ReadROMByte(int(addr))
}
