package memory

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/install/installtest"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// TestRead28NoWait_Decode pins the address decode behind the bank-7
// BRAM no-wait quirk (zxnext.vhd:6670-6686): Read28NoWait must report
// true exactly when a read resolves to effective 8K page 14 — the
// bank-7 lower 8K held in the FPGA's dedicated dual-port BRAM
// (mem_active_bank7, zxnext.vhd:2962) — via either the 8K MMU or the
// classic $7FFD dispatch, and false for page 15 (bank 7's upper half,
// which lives in external SRAM), for the conservative sub-$4000
// region, and while Layer-2 read paging redirects the address.
func TestRead28NoWait_Decode(t *testing.T) {
	installtest.RedirectConfig(t)
	m, err := New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}

	// Next reset map is [FF FF 10 11 4 5 0 1] — no page 14 anywhere.
	for _, addr := range []uint16{0x0000, 0x2000, 0x4000, 0x6000, 0x8000, 0xA000, 0xC000, 0xE000} {
		if m.Read28NoWait(addr) {
			t.Errorf("reset map: Read28NoWait(%#04x) = true, want false", addr)
		}
	}

	// MMU page 14 at slot 3 ($6000-$7FFF): exempt there and only there.
	m.SetMMU(3, 14)
	if !m.Read28NoWait(0x6000) || !m.Read28NoWait(0x7FFF) {
		t.Errorf("MMU slot3=14: $6000/$7FFF should be no-wait")
	}
	if m.Read28NoWait(0x5FFF) || m.Read28NoWait(0x8000) {
		t.Errorf("MMU slot3=14: neighbours must keep the wait")
	}

	// Page 15 (bank 7 upper half) is NOT in the BRAM.
	m.SetMMU(4, 15)
	if m.Read28NoWait(0x8000) {
		t.Errorf("MMU slot4=15: page 15 must keep the wait (SRAM)")
	}

	// Below $4000 the decode is deliberately conservative even if
	// page 14 is MMU-mapped there (low-area overlays win on the FPGA;
	// no known software maps page 14 low).
	m.SetMMU(1, 14)
	if m.Read28NoWait(0x2000) {
		t.Errorf("MMU slot1=14: sub-$4000 stays conservative (waited)")
	}

	// Layer-2 read paging outranks the MMU dispatch (zxnext.vhd
	// final mux: sram_layer2_map_en before the bank7 arm): with
	// $123B rd_en + segment 3 the $4000-$BFFF window reads Layer-2
	// SRAM, so the exemption must drop while it is active.
	m.SetLayer2MapControl(0xC4) // segment=3, rd_en
	if m.Read28NoWait(0x6000) {
		t.Errorf("L2 read paging active: $6000 must keep the wait")
	}
	m.SetLayer2MapControl(0x00)
	if !m.Read28NoWait(0x6000) {
		t.Errorf("L2 read paging cleared: $6000 no-wait again")
	}

	// Classic dispatch: $7FFD RAM7 at $C000 puts page 14 in slot 6
	// (page 15 in slot 7 — still waited). This is the hot NextZXOS
	// configuration (bank 7 is the DOS workspace).
	m.SetMMU(3, 11) // restore slot 3 before the classic checks
	m.PageMemory(0x07)
	if !m.Read28NoWait(0xC000) || !m.Read28NoWait(0xDFFF) {
		t.Errorf("7FFD RAM7: $C000-$DFFF should be no-wait")
	}
	if m.Read28NoWait(0xE000) {
		t.Errorf("7FFD RAM7: $E000 (page 15) must keep the wait")
	}
	m.PageMemory(0x00)
	if m.Read28NoWait(0xC000) {
		t.Errorf("7FFD RAM0: $C000 must keep the wait again")
	}
}
