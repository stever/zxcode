package z80

import "testing"

// Central-choke-point contention (#189). Contention used to ride only
// the m1/rd/wr cycle helpers, so it reached the ~81 opcodes converted
// to them and nothing else — and never the opcode FETCH, which no
// opcode routed through a contending path. It now lives in readMem
// (every M1 fetch, operand and data read) and writeMem (lump-timed
// writes), so all 256 opcodes pay the ULA hold.
//
// These tests pin the two properties the per-opcode tests could not:
// that an UNCONVERTED opcode contends, and that executing FROM
// contended RAM costs more than executing from uncontended RAM.

// costAt runs one instruction placed at org and returns its T-state
// cost, with the CPU positioned at startT.
func costAt(t *testing.T, org uint16, bytes []byte, startT uint64, setup func(*CPU)) uint64 {
	t.Helper()
	cpu, mem := createTestCPU()
	defer cleanupTestROMs("test_roms_z80")
	cpu.MemContend = true
	cpu.PC = org
	cpu.SP = 0xFFF0
	for i, b := range bytes {
		mem.Write(org+uint16(i), b)
	}
	if setup != nil {
		setup(cpu)
	}
	cpu.tstates = startT
	before := cpu.tstates
	cpu.StepInstruction()
	return cpu.tstates - before
}

const (
	// One T into the contended display window, so accesses land on a
	// non-zero slot of the {6,5,4,3,2,1,0,0} pattern.
	inDisplayT = 14336
	// Well past the display window — the ULA holds nothing.
	inBorderT = 100000
)

// Opcodes left on lump T-state accounting must contend now that their
// reads and writes pass through the central path. Each case executes
// from UNCONTENDED RAM ($8000) so the only contention on offer is the
// data access itself.
func TestCentralContention_LumpOpcodesContend(t *testing.T) {
	screen := func(c *CPU) {}
	cases := []struct {
		name  string
		bytes []byte
		setup func(*CPU)
	}{
		// Absolute loads: operand fetch is uncontended, the data
		// access is in screen RAM.
		{"LD A,(nn) screen", []byte{0x3A, 0x00, 0x40}, screen},
		{"LD (nn),A screen", []byte{0x32, 0x00, 0x40}, screen},
		{"LD HL,(nn) screen", []byte{0x2A, 0x00, 0x40}, screen},
		{"LD (nn),HL screen", []byte{0x22, 0x00, 0x40}, screen},
		// Stack traffic into screen RAM.
		{"PUSH BC screen", []byte{0xC5}, func(c *CPU) { c.SP = 0x4100 }},
		{"POP BC screen", []byte{0xC1}, func(c *CPU) { c.SP = 0x4100 }},
		{"CALL nn screen stack", []byte{0xCD, 0x00, 0x90}, func(c *CPU) { c.SP = 0x4100 }},
		// Indexed store — DD-prefixed, lump-timed.
		{"LD (IX+d),n screen", []byte{0xDD, 0x36, 0x00, 0x42}, func(c *CPU) { c.IX = 0x4000 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			inside := costAt(t, 0x8000, tc.bytes, inDisplayT, tc.setup)
			outside := costAt(t, 0x8000, tc.bytes, inBorderT, tc.setup)
			if inside <= outside {
				t.Errorf("in-display=%d T not > border=%d T — lump opcode does not contend", inside, outside)
			}
		})
	}
}

// The same opcodes touching UNCONTENDED memory must cost identically
// in and out of the display window: the central path must not invent
// contention for addresses the ULA never holds.
func TestCentralContention_UncontendedAddressesUnaffected(t *testing.T) {
	cases := []struct {
		name  string
		bytes []byte
		setup func(*CPU)
	}{
		{"LD A,(nn) bank2", []byte{0x3A, 0x00, 0x90}, nil},
		{"LD (nn),A bank2", []byte{0x32, 0x00, 0x90}, nil},
		{"PUSH BC bank2", []byte{0xC5}, func(c *CPU) { c.SP = 0x9100 }},
		{"POP BC bank2", []byte{0xC1}, func(c *CPU) { c.SP = 0x9100 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			inside := costAt(t, 0x8000, tc.bytes, inDisplayT, tc.setup)
			outside := costAt(t, 0x8000, tc.bytes, inBorderT, tc.setup)
			if inside != outside {
				t.Errorf("in-display=%d T != border=%d T — spurious contention on uncontended address", inside, outside)
			}
		})
	}
}

// Executing FROM contended RAM must cost more than executing the same
// instruction from uncontended RAM. This is the case that was missing
// entirely: fetch() never contended, so a game whose code lives in the
// lower 16K ran at full speed through the display window — the direct
// cause of #189's fast 48K games. NOP touches no data, so the whole
// difference is M1-fetch contention.
func TestCentralContention_M1FetchFromContendedRAM(t *testing.T) {
	for _, tc := range []struct {
		name  string
		bytes []byte
	}{
		{"NOP", []byte{0x00}},
		{"INC A", []byte{0x3C}},
		{"JR e", []byte{0x18, 0x00}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			contendedOrg := costAt(t, 0x4000, tc.bytes, inDisplayT, nil)
			uncontendedOrg := costAt(t, 0x8000, tc.bytes, inDisplayT, nil)
			if contendedOrg <= uncontendedOrg {
				t.Errorf("fetch from $4000=%d T not > from $8000=%d T — M1 fetch does not contend",
					contendedOrg, uncontendedOrg)
			}
		})
	}
}

// Outside the display window even contended-RAM execution is free —
// the ULA is not fetching, so it holds nothing.
func TestCentralContention_NoHoldOutsideDisplayWindow(t *testing.T) {
	fromContended := costAt(t, 0x4000, []byte{0x00}, inBorderT, nil)
	fromUncontended := costAt(t, 0x8000, []byte{0x00}, inBorderT, nil)
	if fromContended != fromUncontended {
		t.Errorf("border-time fetch from $4000=%d T != from $8000=%d T — contention leaked outside the display window",
			fromContended, fromUncontended)
	}
}

// MemContend=false must restore the exact pre-#189 lump totals, so the
// switch remains a true opt-in for backends that do not model the ULA.
func TestCentralContention_DisabledRestoresLumpTotals(t *testing.T) {
	run := func(org uint16, bytes []byte, startT uint64) uint64 {
		cpu, mem := createTestCPU()
		defer cleanupTestROMs("test_roms_z80")
		cpu.MemContend = false
		cpu.PC = org
		cpu.SP = 0xFFF0
		for i, b := range bytes {
			mem.Write(org+uint16(i), b)
		}
		cpu.tstates = startT
		before := cpu.tstates
		cpu.StepInstruction()
		return cpu.tstates - before
	}
	cases := []struct {
		name  string
		bytes []byte
		want  uint64
	}{
		{"NOP", []byte{0x00}, 4},
		{"LD A,(nn)", []byte{0x3A, 0x00, 0x40}, 13},
		{"LD (nn),A", []byte{0x32, 0x00, 0x40}, 13},
		{"PUSH BC", []byte{0xC5}, 11},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// From contended RAM, mid-display: the position that would
			// contend hardest if the switch were leaking.
			if got := run(0x4000, tc.bytes, inDisplayT); got != tc.want {
				t.Errorf("MemContend=false: %s cost %d T, want lump total %d", tc.name, got, tc.want)
			}
		})
	}
}
