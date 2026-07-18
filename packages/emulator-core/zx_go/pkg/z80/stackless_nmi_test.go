package z80

import "testing"

// The ZX Spectrum Next "stackless NMI" (NextReg $C0 bit 3): on NMI the return
// address goes to NR$C2 (LSB)/NR$C3 (MSB) and the push's memory WRITE cycles
// are suppressed by the FPGA (zxnext.vhd:1828 `cpu_mreq_n <= z80_mreq_n or
// z80_stackless_nmi`, :2052) — RAM is never touched, SP still decrements. The
// next RETN takes its PC from NR$C2/$C3 with its pop reads likewise
// suppressed (zxnext.vhd:1850); SP still increments. NextZXOS uses this to
// launch 128 BASIC (the MF-NMI handler rewrites NR$C2/$C3 to the editor's
// entry); Atic Atac (#187) relies on the write suppression to keep its
// SP-cursor object sorter safe under its ~20 kHz copper NMI pacer.
func TestStacklessNMI_RETNReturnsToNextReg(t *testing.T) {
	mem := &flatMem{}
	c := New(mem, nullULA{})
	nr := map[byte]byte{}
	c.StacklessReadNR = func(r byte) byte { return nr[r] }
	c.StacklessWriteNR = func(r, v byte) { nr[r] = v }
	c.NMIStackless = true
	c.SP = 0x8000
	c.PC = 0x1234
	mem[0x7FFE] = 0xAA // sentinel bytes under the would-be push
	mem[0x7FFF] = 0xBB

	c.NMI()
	if c.PC != 0x0066 {
		t.Fatalf("after NMI, PC=%04X want 0066", c.PC)
	}
	if nr[0xC2] != 0x34 || nr[0xC3] != 0x12 {
		t.Fatalf("after NMI, NR$C2/$C3=%02X/%02X want 34/12 (the return PC)", nr[0xC2], nr[0xC3])
	}
	if c.SP != 0x7FFE {
		t.Fatalf("after NMI, SP=%04X want 7FFE (SP still decrements)", c.SP)
	}
	if mem[0x7FFE] != 0xAA || mem[0x7FFF] != 0xBB {
		t.Fatalf("stackless NMI WROTE the stack (%02X %02X at 7FFE/7FFF, want AA BB): the FPGA suppresses the push's MREQ cycles (zxnext.vhd:1828/2052)",
			mem[0x7FFE], mem[0x7FFF])
	}
	if !c.StacklessRETNArmed {
		t.Fatalf("stackless NMI acceptance must arm the stackless RETN (z80_stackless_retn_en)")
	}

	// The handler rewrites NR$C2/$C3 to redirect the return (e.g. the editor).
	nr[0xC2] = 0x78
	nr[0xC3] = 0x56

	mem[0x0066] = 0xED
	mem[0x0067] = 0x45 // RETN
	c.PC = 0x0066
	c.StepInstruction()
	if c.PC != 0x5678 {
		t.Fatalf("stackless RETN took PC=%04X want 5678 (from NR$C2/$C3, not the stack)", c.PC)
	}
	if c.SP != 0x8000 {
		t.Fatalf("after RETN, SP=%04X want 8000 (SP still increments)", c.SP)
	}
	if c.StacklessRETNArmed {
		t.Fatalf("stackless RETN must consume the armed latch (zxnext.vhd:2079-2080)")
	}

	// A SECOND RETN — no stackless NMI acceptance pending — pops the real
	// stack even though NR$C0 bit 3 is still set: z80_stackless_retn_en was
	// consumed by the first RETN (zxnext.vhd:2073-2083).
	c.SP = 0x9000
	mem[0x9000] = 0xCD
	mem[0x9001] = 0xAB
	c.PC = 0x0066
	c.StepInstruction()
	if c.PC != 0xABCD {
		t.Fatalf("unarmed RETN took PC=%04X want ABCD (the real stack — arming is one-shot)", c.PC)
	}
	if c.SP != 0x9002 {
		t.Fatalf("unarmed RETN SP=%04X want 9002", c.SP)
	}
}

// Disabling NR$C0 bit 3 kills a pending armed stackless return:
// z80_stackless_retn_en is held in synchronous reset while the bit is 0
// (zxnext.vhd:2075-2076). pkg/next's NR$C0 wiring clears StacklessRETNArmed
// on such writes; here the field contract is exercised directly.
func TestStacklessNMI_DisableClearsArm(t *testing.T) {
	mem := &flatMem{}
	c := New(mem, nullULA{})
	nr := map[byte]byte{}
	c.StacklessReadNR = func(r byte) byte { return nr[r] }
	c.StacklessWriteNR = func(r, v byte) { nr[r] = v }
	c.NMIStackless = true
	c.SP = 0x8000
	c.PC = 0x1234
	c.NMI()

	// Guest disables stackless mode before the RETN (the wiring layer
	// mirrors this pair of assignments).
	c.NMIStackless = false
	c.StacklessRETNArmed = false

	mem[0x0066] = 0xED
	mem[0x0067] = 0x45 // RETN
	// The acceptance suppressed the push, so seed the stack explicitly.
	c.SP = 0x9000
	mem[0x9000] = 0x34
	mem[0x9001] = 0x12
	c.PC = 0x0066
	c.StepInstruction()
	if c.PC != 0x1234 {
		t.Fatalf("RETN after disable PC=%04X want 1234 (real stack)", c.PC)
	}
}

// T80N groups ED $5D/$6D/$7D with the RETN family for the Z80N
// RETN_LSB/MSB commands (t80n_mcode.vhd:2426-2455; only ED $4D is RETI
// there) — an armed stackless return is consumed by those mirrors too,
// while ED $4D always pops the real stack.
func TestStacklessNMI_MirrorConsumesArm(t *testing.T) {
	for _, tc := range []struct {
		op        byte
		stackless bool
	}{
		{0x5D, true}, {0x6D, true}, {0x7D, true}, {0x4D, false},
	} {
		mem := &flatMem{}
		c := New(mem, nullULA{})
		nr := map[byte]byte{}
		c.StacklessReadNR = func(r byte) byte { return nr[r] }
		c.StacklessWriteNR = func(r, v byte) { nr[r] = v }
		c.NMIStackless = true
		c.SP = 0x8000
		c.PC = 0x1234
		c.NMI()            // arms; NR$C2/$C3 = 1234; SP = 7FFE, memory untouched
		mem[0x7FFE] = 0x00 // stack holds garbage (never written)
		mem[0x7FFF] = 0x00
		mem[0x0066] = 0xED
		mem[0x0067] = tc.op
		c.PC = 0x0066
		c.StepInstruction()
		if tc.stackless {
			if c.PC != 0x1234 {
				t.Fatalf("ED %02X armed: PC=%04X want 1234 (NR$C2/$C3)", tc.op, c.PC)
			}
			if c.StacklessRETNArmed {
				t.Fatalf("ED %02X must consume the armed latch", tc.op)
			}
		} else {
			if c.PC != 0x0000 {
				t.Fatalf("ED 4D (RETI): PC=%04X want 0000 (real stack pop; stackless does not apply)", c.PC)
			}
			if !c.StacklessRETNArmed {
				t.Fatalf("ED 4D must NOT consume the armed latch (cleared only at RETN_MSB)")
			}
		}
	}
}

// Regression: with stackless DISABLED, NMI/RETN use the stack as normal.
func TestStacklessNMI_DisabledUsesStack(t *testing.T) {
	mem := &flatMem{}
	c := New(mem, nullULA{})
	c.NMIStackless = false
	c.SP = 0x8000
	c.PC = 0x1234

	c.NMI()
	if mem[0x7FFE] != 0x34 || mem[0x7FFF] != 0x12 {
		t.Fatalf("non-stackless NMI must push the return PC (got %02X %02X)", mem[0x7FFE], mem[0x7FFF])
	}
	mem[0x0066] = 0xED
	mem[0x0067] = 0x45 // RETN
	c.PC = 0x0066
	c.StepInstruction()
	if c.PC != 0x1234 {
		t.Fatalf("non-stackless RETN PC=%04X want 1234 (from the stack)", c.PC)
	}
}
