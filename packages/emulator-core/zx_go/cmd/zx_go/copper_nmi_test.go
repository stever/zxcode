package main

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
	"github.com/conorarmstrong/zx_go/pkg/z80"
)

// TestCopperNMIPacerDeliversAtHardwareRate pins #187's core fix: a
// free-running copper list whose final entry is MOVE NR$02,$04 (Atic
// Atac's divMMC-NMI sample pacer) must deliver NMIs ON THE CPU
// TIMELINE at the hardware wrap rate (~416 per 311-line frame), not
// coalesce into one PendingNMI edge per frame at render time. The
// bootrom's $0066 stub (PUSH AF; POP AF; RETN) services each NMI, and
// the RETN closes the arbiter's in-flight window so the next pulse can
// latch.
func TestCopperNMIPacerDeliversAtHardwareRate(t *testing.T) {
	prev := cliFlagsActive
	nf := cliFlags{}
	if prev != nil {
		nf = *prev
	}
	nf.noSound = true
	cliFlagsActive = &nf
	t.Cleanup(func() { cliFlagsActive = prev })

	emu, err := newNextEmulator()
	if err != nil {
		t.Skipf("Next ROMs not installed: %v", err)
	}

	// Program the pacer list through the dispatcher, exactly as a guest
	// would: enable the divMMC button/software NMI (NR$06 bit 4 — the
	// NR$02 bit-2 pulse is gated on it, zxnext.vhd:2091), then 687
	// NOOPs + 336 MOVE NR$7F pads + MOVE NR$02,$04, mode 01 (FromZero).
	d := emu.nextRegs
	d.WriteReg(0x06, d.Raw(0x06)|0x10)
	writeWord := func(i int, w uint16) {
		d.WriteReg(0x61, byte((i*2)&0xFF))
		d.WriteReg(0x62, byte((i*2)>>8&0x07))
		d.WriteReg(0x63, byte(w>>8))
		d.WriteReg(0x63, byte(w))
	}
	for i := 0; i < 687; i++ {
		writeWord(i, 0x0000)
	}
	for i := 687; i < 1023; i++ {
		writeWord(i, 0x7F00)
	}
	writeWord(1023, 0x0204)
	d.WriteReg(0x62, 0x40)

	nmis := 0
	emu.cpu.AddPreFetchHook("test-nmi-count", func(pc uint16) {
		if pc == 0x0066 {
			nmis++
		}
	})

	const frames = 10
	for i := 0; i < frames; i++ {
		emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		emu.renderFrame()
	}
	// Hardware: 311 lines x 1824 copper cycles / 1361-cycle wrap ≈ 416
	// NMIs per frame. The old render-time coalescing delivered exactly 1.
	perFrame := nmis / frames
	if perFrame < 300 || perFrame > 450 {
		t.Fatalf("copper NMI pacer delivered %d NMIs/frame, want ~416 (hardware wrap rate)", perFrame)
	}
	t.Logf("pacer delivered %d NMIs/frame", perFrame)
}

// TestCopperNMIPacerEnvelopeReopen pins the FPGA arbiter's mid-RETN
// gate-reopen semantics (#187): scheduled pure divMMC-NMI pulses
// (val $04) whose instants fall BEFORE the reopen point are dropped —
// the FPGA arbiter ignores pulses while nmi_activated is latched
// (zxnext.vhd:2096-2116) and only reopens ~6 CPU cycles before the
// RETN completes. Pulses at/after the reopen instant, and pulses whose
// value carries non-NMI bits (reset/MF), survive.
func TestCopperNMIPacerEnvelopeReopen(t *testing.T) {
	cpu := &z80.CPU{} // only FrameOriginRefTstates()==0 is used
	p := &copperNMIPacer{cpu: cpu}

	p.instants = []int{100, 200, 300}
	p.vals = []byte{0x04, 0x04, 0x04}
	p.idx = 0
	p.noteEnvelopeReopen(250)
	if p.idx != 2 {
		t.Fatalf("reopen at 250: idx=%d, want 2 (instants 100 and 200 dropped, 300 kept)", p.idx)
	}

	// A non-pure-NMI value blocks the scan: its write must still be
	// delivered (reset bits are not gated by the arbiter latch).
	p.instants = []int{10, 20}
	p.vals = []byte{0x05, 0x04}
	p.idx = 0
	p.noteEnvelopeReopen(100)
	if p.idx != 0 {
		t.Fatalf("mixed-value pulse: idx=%d, want 0 (write with reset bit kept)", p.idx)
	}
}
