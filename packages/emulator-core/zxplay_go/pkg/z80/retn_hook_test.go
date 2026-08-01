package z80

import "testing"

// The retnHook consumers (divMMC automap latch, Multiface unmap) hang
// off zxnext.vhd's z80_retn_seen, which the im2_control decoder asserts
// for the exact byte pair ED 45 ONLY (im2_control.vhd:236). RETI
// (ED 4D + mirrors) asserts the separate reti_seen for the IM2 daisy
// chain, and the RETN mirrors (ED 55/65/75) assert neither — none of
// them may fire the hook. Treating RETI as RETN unmapped the esxDOS
// overlay under any game whose IM2 handler returned mid-RST$08: the
// NextZXOS 24.11 five-title loader-class wreck (work item #163).
func TestRETNHookFiresForExactED45Only(t *testing.T) {
	for _, tc := range []struct {
		op   byte
		want int
	}{
		{0x45, 1}, // RETN — the one true retn_seen encoding
		{0x55, 0}, // RETN mirror: no retn_seen on the Next FPGA
		{0x65, 0},
		{0x75, 0},
		{0x4D, 0}, // RETI: reti_seen, not retn_seen
		{0x5D, 0},
		{0x6D, 0},
		{0x7D, 0},
	} {
		mem := &flatMem{}
		c := New(mem, nullULA{})
		fired := 0
		c.SetRETNHook(func() { fired++ })
		mem[0] = 0xED
		mem[1] = tc.op
		c.SP = 0x8000
		c.StepInstruction()
		if fired != tc.want {
			t.Errorf("ED %02X: hook fired %d times, want %d", tc.op, fired, tc.want)
		}
	}
}
