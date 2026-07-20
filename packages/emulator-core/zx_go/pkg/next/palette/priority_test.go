package palette

import "testing"

// TestPalettePriority covers the per-entry priority storage + the Layer 2
// promote bit (NR$44 bit 7).
func TestPalettePriority(t *testing.T) {
	p := New()
	p.SetPriority(5, 0x03) // both priority bits → bit 7 set
	if !p.HasPriority(5) || p.Priority(5) != 0x03 {
		t.Errorf("entry 5: HasPriority=%v Priority=%d, want true/3", p.HasPriority(5), p.Priority(5))
	}
	p.SetPriority(6, 0x01) // only bit 6 → NOT the L2 promote bit
	if p.HasPriority(6) {
		t.Error("entry 6: HasPriority=true, want false (bit 7 clear)")
	}
	// Write9 captures lo bits 7:6 as the priority.
	b := NewBank()
	b.Write9(0x00, 0x80) // lo bit 7 set → promote bit
	if !b.Active().HasPriority(0) {
		t.Error("Write9 lo=0x80: entry 0 HasPriority=false, want true")
	}
	b.SetIndex(0) // Write9 auto-incremented; point back at the entry we wrote
	if got := b.ReadNR44(); got&0x80 == 0 {
		t.Errorf("ReadNR44 = %#x, want bit 7 set", got)
	}
}

// TestWrite8ClearsPriority pins the NR$41 write's whole-word BRAM
// semantics: the palette write data is always priority & "00000" &
// value with nr_palette_priority forced "00" when nr_44_we = '0'
// (zxnext.vhd:4920, :6972/:7025) — so an 8-bit write CLEARS a stale
// NR$44 priority on the entry (#196: Atic Atac rewrites a
// priority-carrying Layer 2 palette via NR$41; its black pixels must
// not stay promoted above the sprites).
func TestWrite8ClearsPriority(t *testing.T) {
	b := NewBank()
	b.Write9(0x00, 0x80) // entry 0: priority promote bit set
	b.SetIndex(0)
	b.Write8(0x1C) // NR$41 rewrite of the same entry
	if b.Active().HasPriority(0) {
		t.Error("Write8 left the stale NR$44 priority set; the FPGA writes priority 00 (zxnext.vhd:4920)")
	}
	if b.Active().Priority(0) != 0 {
		t.Errorf("Write8: entry 0 priority = %d, want 0", b.Active().Priority(0))
	}
}

// TestWrite8PriorityClearReplays pins the raster-stamped replay of the
// NR$41 priority clear: rewinding restores the stale priority, replaying
// re-clears it — the stamp carries the priority halves like a NR$44
// write does.
func TestWrite8PriorityClearReplays(t *testing.T) {
	b := NewBank()
	line := 0
	b.SetRasterLineSource(func() int { return line })
	b.Write9(0x00, 0x80) // entry 0: promote bit, stamped line 0
	line = 100
	b.SetIndex(0)
	b.Write8(0x1C) // clears priority, stamped line 100
	if !b.BeginReplay(false) {
		t.Fatal("no stamped writes to replay")
	}
	// Frame start: rewound to the pre-Write9 state (priority 0).
	b.ReplayThrough(50) // the Write9 has replayed, the Write8 not yet
	if !b.Active().HasPriority(0) {
		t.Error("replay through line 50: the NR$44 priority should be live again")
	}
	b.ReplayThrough(150) // the Write8 replays
	if b.Active().HasPriority(0) {
		t.Error("replay through line 150: the NR$41 write must re-clear the priority")
	}
	b.EndReplay()
	if b.Active().HasPriority(0) {
		t.Error("end of replay: live state has no priority")
	}
}
