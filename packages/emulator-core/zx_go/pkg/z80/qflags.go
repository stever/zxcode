package z80

// The Z80's SCF and CCF take their undocumented YF/XF bits from A alone
// when the PREVIOUS instruction wrote the flags, and OR A's bits into
// the existing YF/XF when it did not (Zilog NMOS behaviour; David
// Banks, hoglet67/Z80Decoder wiki "Undocumented Flags"; Patrik Rak's
// z80test ccf variant is the conformance oracle). The internal state
// that carries "the previous instruction wrote F" is conventionally
// called the Q register.
//
// The tables below classify each opcode as flag-writing for that
// purpose. Two deliberate subtleties from the hardware research:
// POP AF and EX AF,AF' load F without counting as flag-writing, and a
// DD/FD prefix destroys the information (the prefix handlers clear Q
// before dispatching, so a prefixed SCF/CCF always takes the OR path).

// flagWritingBase marks the unprefixed opcodes that write F.
var flagWritingBase = buildFlagWritingBase()

// flagWritingED marks the ED-prefixed opcodes that write F.
var flagWritingED = buildFlagWritingED()

func buildFlagWritingBase() (t [256]bool) {
	set := func(ops ...byte) {
		for _, op := range ops {
			t[op] = true
		}
	}
	// INC r / DEC r / INC (HL) / DEC (HL)
	set(0x04, 0x05, 0x0C, 0x0D, 0x14, 0x15, 0x1C, 0x1D,
		0x24, 0x25, 0x2C, 0x2D, 0x34, 0x35, 0x3C, 0x3D)
	// RLCA / RRCA / RLA / RRA
	set(0x07, 0x0F, 0x17, 0x1F)
	// ADD HL,rr
	set(0x09, 0x19, 0x29, 0x39)
	// DAA / CPL / SCF / CCF
	set(0x27, 0x2F, 0x37, 0x3F)
	// The ALU block: ADD/ADC/SUB/SBC/AND/XOR/OR/CP r
	for op := 0x80; op <= 0xBF; op++ {
		t[op] = true
	}
	// ALU with immediate operand
	set(0xC6, 0xCE, 0xD6, 0xDE, 0xE6, 0xEE, 0xF6, 0xFE)
	// NOT flag-writing despite touching F: POP AF (0xF1) and
	// EX AF,AF' (0x08) — they load F rather than compute it.
	return t
}

func buildFlagWritingED() (t [256]bool) {
	set := func(ops ...byte) {
		for _, op := range ops {
			t[op] = true
		}
	}
	// IN r,(C) including the flags-only IN (C)
	set(0x40, 0x48, 0x50, 0x58, 0x60, 0x68, 0x70, 0x78)
	// SBC HL,rr / ADC HL,rr
	set(0x42, 0x52, 0x62, 0x72, 0x4A, 0x5A, 0x6A, 0x7A)
	// NEG and its mirrors
	set(0x44, 0x4C, 0x54, 0x5C, 0x64, 0x6C, 0x74, 0x7C)
	// LD A,I / LD A,R
	set(0x57, 0x5F)
	// RRD / RLD
	set(0x67, 0x6F)
	// The block instructions
	set(0xA0, 0xA1, 0xA2, 0xA3, 0xA8, 0xA9, 0xAA, 0xAB,
		0xB0, 0xB1, 0xB2, 0xB3, 0xB8, 0xB9, 0xBA, 0xBB)
	return t
}

// setQFor records whether the just-executed opcode wrote F, skipping
// the prefix bytes whose sub-dispatchers own the decision.
func (c *CPU) setQFor(opcode byte) {
	switch opcode {
	case 0xCB, 0xDD, 0xED, 0xFD:
		return
	}
	c.Q = flagWritingBase[opcode]
}
