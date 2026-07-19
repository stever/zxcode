package z80

import (
	"testing"
)

// 28 MHz cycle-cost conformance against the Next FPGA's T80N core
// (work item #187, the Atic Atac copper-NMI phase audit).
//
// Model being pinned:
//
//   - At cpu_speed = "11" (28 MHz) the FPGA inserts ONE wait cycle on
//     every memory READ machine cycle: zxnext.vhd:3168-3181 asserts
//     sram_wait_n when (sram_req_t or cpu_bank5_sched) and cpu_rd_n=0
//     and cpu_speed="11". sram_req_t pulses once per read request;
//     cpu_bank5_sched covers bank-5 BRAM reads (zxnext.vhd:6592), so
//     ROM, SRAM, divMMC and bank-5 reads all pay exactly +1.
//   - Writes never wait (the condition requires cpu_rd_n = '0').
//   - I/O machine cycles never wait for internal ports: z80_wait_n
//     (zxnext.vhd:1839) composes only ula_wait_n (memory contention
//     only, and only at 3.5 MHz — zxnext.vhd:4481 gates it on
//     cpu_speed = "00"), ulap_wait_n (ULA+ palette port $FF3B),
//     sram_wait_n (memory reads) and the expansion bus. spi_wait_n
//     gates only the DMA (zxnext.vhd:1844). The standard one-cycle
//     I/O stretch is the T80N's own IOWait=1 insertion (t80na.vhd:184,
//     t80n.vhd:1781-1783) and is already part of the documented base
//     T-count (I/O cycles are 4T).
//   - The T80N asserts MREQ+RD in EVERY non-M1 machine cycle whose
//     microcode leaves NoRead/Write/IORQ clear (t80na.vhd "Generate RD
//     for MREQ"), so a handful of "internal" trailing cycles are real
//     bus reads that collect the 28 MHz wait: NEXTREG r,n M4/M5,
//     NEXTREG r,A M3/M4, PUSH nn M6 (t80n_mcode.vhd X"91", X"92",
//     X"8A") and the NMI acceptance M1 (the discarded opcode fetch,
//     t80n_mcode.vhd NMICycle arm).
//
// Expected values are therefore: documented base T-count + number of
// FPGA bus-READ machine cycles. Each entry's comment shows the
// breakdown.

func run28MHzTiming(t *testing.T, bytes []byte, setup func(*CPU, memoryWriter)) uint64 {
	t.Helper()
	cpu, mem := createTestCPU()
	defer cleanupTestROMs("test_roms_z80")
	cpu.Variant = VariantZ80N
	cpu.SetSpeedSelect(0x03)
	// The shared test memory is a classic 48K model with FUSE-style
	// ULA-port contention holds. The Next has none of that here: port
	// contention exists only under guest-selected 48K/128K machine
	// timing AND at 3.5 MHz (zxnext.vhd:4481, zxula.vhd:596-604); at
	// NR$07=3 / +3 timing every internal-port I/O cycle is the plain
	// 4T. Disable the classic model so the harness measures the Next.
	mem.ContentionEnabled = false
	cpu.PC = 0x8000
	cpu.SP = 0xFFF0
	for i, b := range bytes {
		mem.Write(uint16(0x8000+i), b)
	}
	if setup != nil {
		setup(cpu, mem)
	}
	before := cpu.tstates
	cpu.StepInstruction()
	return cpu.tstates - before
}

func TestZ80N28MHz_OpcodeCycleConformance(t *testing.T) {
	cases := []struct {
		name  string
		bytes []byte
		setup func(*CPU, memoryWriter)
		want  uint64
	}{
		// --- Plain loads / ALU (base + reads) ---
		{"NOP", []byte{0x00}, nil, 5},                     // 4 + 1 (M1)
		{"EX AF,AF'", []byte{0x08}, nil, 5},               // 4 + 1
		{"LD D,B", []byte{0x50}, nil, 5},                  // 4 + 1
		{"RLCA", []byte{0x07}, nil, 5},                    // 4 + 1
		{"LD A,n", []byte{0x3E, 0x52}, nil, 9},            // 7 + 2 (M1, operand)
		{"ADD A,n", []byte{0xC6, 0x50}, nil, 9},           // 7 + 2
		{"AND n", []byte{0xE6, 0xE0}, nil, 9},             // 7 + 2
		{"LD A,(HL)", []byte{0x7E}, nil, 9},               // 7 + 2 (M1, data)
		{"LD (HL),A", []byte{0x77}, setHL8000, 8},         // 7 + 1 (write cycle free)
		{"LD (HL),n", []byte{0x36, 0x42}, setHL8000, 12},  // 10 + 2 (M1, operand; write free)
		{"LD A,(nn)", []byte{0x3A, 0x00, 0x90}, nil, 17},  // 13 + 4 (M1, 2 operands, data)
		{"LD (nn),A", []byte{0x32, 0x00, 0x90}, nil, 16},  // 13 + 3 (write free)
		{"LD HL,nn", []byte{0x21, 0x34, 0x12}, nil, 13},   // 10 + 3
		{"LD SP,nn", []byte{0x31, 0xF8, 0xF9}, nil, 13},   // 10 + 3
		{"LD SP,HL", []byte{0xF9}, nil, 7},                // 6 + 1 (t80n_mcode LD SP,HL TStates "110")
		{"LD (nn),HL", []byte{0x22, 0xC2, 0xDA}, nil, 19}, // 16 + 3 (M1, 2 operands; 2 writes free)
		{"LD HL,(nn)", []byte{0x2A, 0x00, 0x90}, nil, 21}, // 16 + 5 (all five cycles read)
		{"DEC HL", []byte{0x2B}, nil, 7},                  // 6 + 1 (M1 6T, t80n_mcode DEC ss TStates "110")
		{"INC BC", []byte{0x03}, nil, 7},                  // 6 + 1
		{"ADD HL,DE", []byte{0x19}, nil, 12},              // 11 + 1 (M2/M3 are NoRead internal cycles)
		{"EX DE,HL", []byte{0xEB}, nil, 5},                // 4 + 1
		{"EX (SP),HL", []byte{0xE3}, setupStack, 22},      // 19 + 3 (M1 + 2 stack reads; 2 writes free)
		{"INC A", []byte{0x3C}, nil, 5},                   // 4 + 1
		{"OR D", []byte{0xB2}, nil, 5},                    // 4 + 1
		{"BIT 7,D (CB)", []byte{0xCB, 0x7A}, nil, 10},     // 8 + 2 (both M1s)
		{"SRL A (CB)", []byte{0xCB, 0x3F}, nil, 10},       // 8 + 2
		{"INC IYH (FD)", []byte{0xFD, 0x24}, nil, 10},     // 8 + 2 (prefix M1 + M1)
		{"DEC IYH (FD)", []byte{0xFD, 0x25}, nil, 10},     // 8 + 2
		{"JP (IY)", []byte{0xFD, 0xE9}, nil, 10},          // 8 + 2
		{"ADC HL,BC", []byte{0xED, 0x4A}, nil, 17},        // 15 + 2 (ED M1 + M1; M2/M3 NoRead)
		{"LD A,I", []byte{0xED, 0x57}, nil, 11},           // 9 + 2 (5T M1)

		// --- Stack / control flow ---
		{"PUSH DE", []byte{0xD5}, setupStack, 12},                                                           // 11 + 1 (5T M1; both writes free)
		{"POP HL", []byte{0xE1}, setupStack, 13},                                                            // 10 + 3 (M1 + 2 stack reads)
		{"CALL nn", []byte{0xCD, 0x00, 0x90}, setupStack, 20},                                               // 17 + 3 (M1 + 2 operand reads; 2 writes free)
		{"RET", []byte{0xC9}, setupStack, 13},                                                               // 10 + 3
		{"RET Z taken", []byte{0xC8}, func(c *CPU, m memoryWriter) { setupStack(c, m); c.F |= FLAG_Z }, 14}, // 11 + 3 (5T M1 + 2 reads)
		{"RET Z not taken", []byte{0xC8}, func(c *CPU, m memoryWriter) { c.F &^= FLAG_Z }, 6},               // 5 + 1
		{"RST 20h", []byte{0xE7}, setupStack, 12},                                                           // 11 + 1 (5T M1; writes free)
		{"JP nn", []byte{0xC3, 0x00, 0x90}, nil, 13},                                                        // 10 + 3
		{"JR e", []byte{0x18, 0x10}, nil, 14},                                                               // 12 + 2 (M1 + operand; 5T internal is NoRead)
		{"JR NZ taken", []byte{0x20, 0x10}, func(c *CPU, m memoryWriter) { c.F &^= FLAG_Z }, 14},            // 12 + 2
		{"JR NZ not taken", []byte{0x20, 0x10}, func(c *CPU, m memoryWriter) { c.F |= FLAG_Z }, 9},          // 7 + 2
		{"DJNZ taken", []byte{0x10, 0x10}, func(c *CPU, m memoryWriter) { c.B = 2 }, 15},                    // 13 + 2
		{"DJNZ not taken", []byte{0x10, 0x10}, func(c *CPU, m memoryWriter) { c.B = 1 }, 10},                // 8 + 2
		{"RETN", []byte{0xED, 0x45}, setupStack, 18},                                                        // 14 + 4 (2 M1s + 2 stack reads)
		{"HALT", []byte{0x76}, nil, 5},                                                                      // 4 + 1

		// --- I/O: base counts already include the T80N IOWait=1
		// stretch (I/O cycle = 4T); the I/O cycle itself collects NO
		// 28 MHz wait (not a memory read; internal ports assert no
		// wait line — zxnext.vhd:1839) ---
		{"OUT (n),A", []byte{0xD3, 0xFE}, nil, 13},         // 11 + 2 (M1 + operand)
		{"IN A,(n)", []byte{0xDB, 0xFE}, nil, 13},          // 11 + 2
		{"OUT (C),A", []byte{0xED, 0x79}, nil, 14},         // 12 + 2 (both M1s)
		{"IN A,(C)", []byte{0xED, 0x78}, nil, 14},          // 12 + 2
		{"OUTI", []byte{0xED, 0xA3}, setB1, 19},            // 16 + 3 (2 M1s + mem read; I/O write free)
		{"OTIR repeating", []byte{0xED, 0xB3}, setB2, 24},  // 21 + 3
		{"INI", []byte{0xED, 0xA2}, setB1, 18},             // 16 + 2 (2 M1s; I/O read + mem write free)
		{"INIR repeating", []byte{0xED, 0xB2}, setB2, 23},  // 21 + 2
		{"LDI", []byte{0xED, 0xA0}, setBC1, 19},            // 16 + 3 (2 M1s + mem read)
		{"LDIR repeating", []byte{0xED, 0xB0}, setBC2, 24}, // 21 + 3

		// --- Z80N extensions ---
		{"ADD HL,A", []byte{0xED, 0x31}, nil, 10},              // 8 + 2 (single-M1 pair)
		{"MUL D,E", []byte{0xED, 0x30}, nil, 10},               // 8 + 2
		{"ADD HL,nn", []byte{0xED, 0x34, 0x34, 0x12}, nil, 20}, // 16 + 4 (2 M1s + 2 operand reads, all cycles 4T)
		{"TEST n", []byte{0xED, 0x27, 0x55}, nil, 14},          // 11 + 3 (2 M1s + operand)
		{"LDIX", []byte{0xED, 0xA4}, setBC1, 19},               // 16 + 3
		{"LDWS", []byte{0xED, 0xA5}, nil, 17},                  // 14 + 3 (2 M1s + (HL) read)
		{"OUTINB", []byte{0xED, 0x90}, nil, 19},                // 16 + 3 (2 M1s + (HL) read)
		{"JP (C)", []byte{0xED, 0x98}, nil, 15},                // 13 + 2 (2 M1s; I/O read cycle free)
		// The three fixed by this audit — trailing microcode cycles
		// with NoRead/Write clear are dummy bus reads on the FPGA:
		{"NEXTREG r,n", []byte{0xED, 0x91, 0x02, 0x00}, nil, 26},    // 20 + 4 real reads + 2 dummy (M4/M5)
		{"NEXTREG r,A", []byte{0xED, 0x92, 0x02}, nil, 22},          // 17 + 3 real reads + 2 dummy (M3/M4)
		{"PUSH nn", []byte{0xED, 0x8A, 0x12, 0x34}, setupStack, 28}, // 23 + 4 real reads + 1 dummy (M6)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := run28MHzTiming(t, tc.bytes, tc.setup)
			if got != tc.want {
				t.Errorf("%s at 28 MHz: got %d cycles, want %d", tc.name, got, tc.want)
			}
		})
	}
}

func setHL8000(c *CPU, m memoryWriter)  { c.H, c.L = 0x90, 0x00 }
func setupStack(c *CPU, m memoryWriter) { c.SP = 0xE000 }
func setB1(c *CPU, m memoryWriter)      { c.B = 1; c.C = 0xEB; c.H, c.L = 0x90, 0x00 }
func setB2(c *CPU, m memoryWriter)      { c.B = 2; c.C = 0xEB; c.H, c.L = 0x90, 0x00 }
func setBC1(c *CPU, m memoryWriter) {
	c.B, c.C = 0, 1
	c.H, c.L = 0x90, 0x00
	c.D, c.E = 0x91, 0x00
}
func setBC2(c *CPU, m memoryWriter) {
	c.B, c.C = 0, 2
	c.H, c.L = 0x90, 0x00
	c.D, c.E = 0x91, 0x00
}

// TestZ80N28MHz_NMIAcceptance pins NMI acceptance at 12 cycles at
// 28 MHz (5T M1 — a real, discarded opcode-fetch bus read that
// collects the all-reads wait — plus two free 3T pushes;
// t80n_mcode.vhd NMICycle arm, zxnext.vhd:3175) and the classic 11
// everywhere else.
func TestZ80N28MHz_NMIAcceptance(t *testing.T) {
	for _, tc := range []struct {
		name string
		sel  byte
		want uint64
	}{
		{"3.5 MHz", 0x00, 11},
		{"7 MHz", 0x01, 11},
		{"14 MHz", 0x02, 11},
		{"28 MHz", 0x03, 12},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cpu, _ := createTestCPU()
			defer cleanupTestROMs("test_roms_z80")
			cpu.Variant = VariantZ80N
			cpu.SetSpeedSelect(tc.sel)
			cpu.PC = 0x8000
			cpu.SP = 0xE000
			before := cpu.tstates
			cpu.NMI()
			if got := cpu.tstates - before; got != tc.want {
				t.Errorf("NMI acceptance at %s: got %d cycles, want %d", tc.name, got, tc.want)
			}
			if cpu.PC != 0x0066 {
				t.Errorf("NMI PC: got $%04X, want $0066", cpu.PC)
			}
		})
	}
}

// runSequence28MHz executes a code sequence instruction by
// instruction at 28 MHz and returns the total cycle cost.
func runSequence28MHz(t *testing.T, code []byte, n int, setup func(*CPU, memoryWriter)) uint64 {
	t.Helper()
	cpu, mem := createTestCPU()
	defer cleanupTestROMs("test_roms_z80")
	cpu.Variant = VariantZ80N
	cpu.SetSpeedSelect(0x03)
	mem.ContentionEnabled = false // see run28MHzTiming
	cpu.PC = 0x8000
	cpu.SP = 0xE000
	for i, b := range code {
		mem.Write(uint16(0x8000+i), b)
	}
	if setup != nil {
		setup(cpu, mem)
	}
	before := cpu.tstates
	for i := 0; i < n; i++ {
		cpu.StepInstruction()
	}
	return cpu.tstates - before
}

// TestZ80N28MHz_AticNMIStubSequence executes the exact per-sample NMI
// stub Atic Atac's copper-paced engine runs ~20800 times per second
// (dumped live from divMMC RAM by the #187 probe, emu_nmi_stub_2800.bin
// offset 0): output the current sample bytes to the DAC ports, advance
// IY to the next stub, ack NR$02 and RETN. Hand-computed FPGA total at
// 28 MHz:
//
//	EX AF,AF'          4+1  =   5
//	LD A,($F210)      13+4  =  17
//	OUT ($0F),A       11+2  =  13
//	LD A,($F211)      13+4  =  17
//	OUT ($4F),A       11+2  =  13
//	LD A,($E908)      13+4  =  17
//	OUT ($DF),A       11+2  =  13
//	LD A,($ED08)      13+4  =  17
//	OUT ($FE),A       11+2  =  13
//	INC IYH            8+2  =  10
//	EX AF,AF'          4+1  =   5
//	NEXTREG $02,$00   20+6  =  26   (incl. the M4/M5 dummy reads)
//	RETN              14+4  =  18
//	                 total  = 184
//
// With NMI acceptance (12) and the $0066 JP (IY) trampoline (8+2=10)
// the full FPGA handler round-trip is 206 cycles = 25.75 refT; before
// this audit the emulator charged 203 — a 3-cycle-per-NMI (~156
// refT/frame at 416.8 NMIs/frame) phase skew against the copper NMI
// lattice the game's SP-repointed descriptor walks are placed on.
func TestZ80N28MHz_AticNMIStubSequence(t *testing.T) {
	stub := []byte{
		0x08,             // EX AF,AF'
		0x3A, 0x10, 0xF2, // LD A,($F210)
		0xD3, 0x0F, // OUT ($0F),A
		0x3A, 0x11, 0xF2, // LD A,($F211)
		0xD3, 0x4F, // OUT ($4F),A
		0x3A, 0x08, 0xE9, // LD A,($E908)
		0xD3, 0xDF, // OUT ($DF),A
		0x3A, 0x08, 0xED, // LD A,($ED08)
		0xD3, 0xFE, // OUT ($FE),A
		0xFD, 0x24, // INC IYH
		0x08,                   // EX AF,AF'
		0xED, 0x91, 0x02, 0x00, // NEXTREG $02,$00
		0xED, 0x45, // RETN
	}
	got := runSequence28MHz(t, stub, 13, setupStack)
	if got != 184 {
		t.Errorf("Atic NMI stub sequence at 28 MHz: got %d cycles, want 184 (FPGA hand count)", got)
	}
}

// TestZ80N28MHz_AticDescriptorWalkSequence executes the $D107
// stream-descriptor writer core (dumped by the #187 probe,
// emu_D100.bin offset 7): the SP-repointed queue walk whose one-push
// slack budget the NMI lattice must respect. Hand-computed FPGA total
// at 28 MHz:
//
//	POP HL            10+3  =  13
//	LD ($DAC2),HL     16+3  =  19
//	POP HL            10+3  =  13
//	ADD HL,DE         11+1  =  12
//	LD ($DAC4),HL     16+3  =  19
//	POP HL            10+3  =  13
//	ADC HL,BC         15+2  =  17
//	LD ($DAC6),HL     16+3  =  19
//	LD SP,$F9F8       10+3  =  13
//	                 total  = 138  (17.25 refT)
func TestZ80N28MHz_AticDescriptorWalkSequence(t *testing.T) {
	walk := []byte{
		0xE1,             // POP HL
		0x22, 0xC2, 0xDA, // LD ($DAC2),HL
		0xE1,             // POP HL
		0x19,             // ADD HL,DE
		0x22, 0xC4, 0xDA, // LD ($DAC4),HL
		0xE1,       // POP HL
		0xED, 0x4A, // ADC HL,BC
		0x22, 0xC6, 0xDA, // LD ($DAC6),HL
		0x31, 0xF8, 0xF9, // LD SP,$F9F8
	}
	got := runSequence28MHz(t, walk, 9, func(c *CPU, m memoryWriter) { c.SP = 0xDC48 })
	if got != 138 {
		t.Errorf("Atic descriptor walk sequence at 28 MHz: got %d cycles, want 138 (FPGA hand count)", got)
	}
}

// TestZ80N28MHz_AticCMD18ArgSequence executes the $D146 CMD18
// argument writer (emu_D100.bin offset $46): command byte + the
// 3-byte big-endian block number read HL-downward + CRC, one OUT per
// byte to the SPI data port. Hand-computed FPGA total at 28 MHz:
//
//	LD A,$52           7+2  =   9
//	OUT (C),A         12+2  =  14
//	3 x [ LD A,(HL) 9 ; DEC HL 7 ; OUT (C),A 14 ] = 90
//	LD A,(HL)          7+2  =   9
//	OUT (C),A         12+2  =  14
//	LD A,$80           7+2  =   9
//	OUT (C),A         12+2  =  14
//	                 total  = 159
func TestZ80N28MHz_AticCMD18ArgSequence(t *testing.T) {
	seq := []byte{
		0x3E, 0x52, // LD A,$52 (CMD18)
		0xED, 0x79, // OUT (C),A
		0x7E, 0x2B, 0xED, 0x79, // LD A,(HL); DEC HL; OUT (C),A
		0x7E, 0x2B, 0xED, 0x79,
		0x7E, 0x2B, 0xED, 0x79,
		0x7E, 0xED, 0x79, // LD A,(HL); OUT (C),A
		0x3E, 0x80, // LD A,$80 (CRC)
		0xED, 0x79, // OUT (C),A
	}
	got := runSequence28MHz(t, seq, 15, func(c *CPU, m memoryWriter) {
		c.C = 0xEB
		c.H, c.L = 0xDA, 0xC7
	})
	if got != 159 {
		t.Errorf("Atic CMD18-arg sequence at 28 MHz: got %d cycles, want 159 (FPGA hand count)", got)
	}
}

// --- Bank-7 BRAM no-wait quirk (zxnext.vhd:6670-6686) ---
//
// The Next's bank-7 lower 8K (8K MMU page 14) lives in a dedicated
// dual-port BRAM whose CPU port is clocked directly on i_CLK_28; the
// 28 MHz read-wait term (zxnext.vhd:3175) covers only sram_req_t
// (external SRAM) and cpu_bank5_sched (bank-5 BRAM), so reads that
// resolve to page 14 pay NO wait state — one cycle faster than every
// other memory read. The memory backend advertises those addresses
// through the optional Read28NoWait interface; this mock exposes a
// configurable no-wait window standing in for page 14.

type bank7NoWaitMem struct {
	data       [0x10000]byte
	noWaitFrom uint16
	noWaitTo   uint16
}

func (m *bank7NoWaitMem) Read(addr uint16) byte       { return m.data[addr] }
func (m *bank7NoWaitMem) Write(addr uint16, val byte) { m.data[addr] = val }
func (m *bank7NoWaitMem) ContendPortEarly(port uint16) {}
func (m *bank7NoWaitMem) ContendPortLate(port uint16)  {}
func (m *bank7NoWaitMem) Read28NoWait(addr uint16) bool {
	return addr >= m.noWaitFrom && addr <= m.noWaitTo
}

func TestZ80N28MHz_Bank7BRAMNoWait(t *testing.T) {
	run := func(code []byte, pc uint16, setup func(*CPU)) uint64 {
		mem := &bank7NoWaitMem{noWaitFrom: 0xC000, noWaitTo: 0xDFFF}
		cpu := New(mem, nil)
		cpu.Variant = VariantZ80N
		cpu.SetSpeedSelect(0x03)
		cpu.PC = pc
		cpu.SP = 0xA000
		for i, b := range code {
			mem.data[pc+uint16(i)] = b
		}
		if setup != nil {
			setup(cpu)
		}
		before := cpu.tstates
		cpu.StepInstruction()
		return cpu.tstates - before
	}

	cases := []struct {
		name  string
		bytes []byte
		pc    uint16
		setup func(*CPU)
		want  uint64
	}{
		// Data read resolves to the BRAM: only the M1 fetch (SRAM)
		// collects the wait — 7 + 1, not the 7 + 2 the waited-HL
		// variant of the opcode table pins.
		{"LD A,(HL) data in bank7", []byte{0x7E}, 0x8000,
			func(c *CPU) { c.H, c.L = 0xC1, 0x00 }, 8},
		// Same opcode, data outside the BRAM: both reads wait (the
		// opcode-table baseline, unchanged by the quirk wiring).
		{"LD A,(HL) data in SRAM", []byte{0x7E}, 0x8000,
			func(c *CPU) { c.H, c.L = 0x90, 0x00 }, 9},
		// Executing FROM the BRAM: the M1 fetch is the exempt read.
		{"NOP fetched from bank7", []byte{0x00}, 0xC000, nil, 4},
		{"LD A,n fetched from bank7", []byte{0x3E, 0x52}, 0xC000, nil, 7},
		// Writes never wait anywhere, so a bank-7 write target
		// changes nothing: M1 (SRAM) waits, the write is free.
		{"LD (HL),A into bank7", []byte{0x77}, 0x8000,
			func(c *CPU) { c.H, c.L = 0xC1, 0x00 }, 8},
		// Stack in the BRAM: POP's two stack reads are exempt.
		{"POP HL stack in bank7", []byte{0xE1}, 0x8000,
			func(c *CPU) { c.SP = 0xC800 }, 11},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := run(tc.bytes, tc.pc, tc.setup)
			if got != tc.want {
				t.Errorf("%s at 28 MHz: got %d cycles, want %d", tc.name, got, tc.want)
			}
		})
	}
}
