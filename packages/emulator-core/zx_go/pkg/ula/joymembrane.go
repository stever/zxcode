package ula

// Spectrum Next joystick keyrow injection ("key joystick").
//
// On real hardware the pads are not only port devices: the FPGA's
// membrane_stick module (input/membrane/membrane_stick.vhd) walks each
// pad's 12-bit i_JOY vector against a 64x6 keymap RAM and pulls the
// mapped membrane COLUMNS low while the matching row is scanned —
// keyb_col <= keyb_col_i_q and membrane_stick_col and ps2_kbd_col
// (zxnext_top_issue4.vhd:1843). That is how the NR$05 Sinclair 1/2,
// Cursor and User-Defined joystick modes work: the pad literally
// presses keys, and any software that reads the keyboard matrix sees
// them (Bomb Jack's JOYSTICK option reads row $EFFE directly, #202).
//
// Each pad owns 32 keymap entries; the low 16 are ROM defaults
// (src/ram/init/keyjoy_64_6.coe, identical for both pads), the high 16
// are the writable "user" slots reached through the NR$28/$29/$2B
// joymap interface (write address = pad<<4 | button; membrane_stick's
// write port maps that to entry 16+button of the pad's half). A 6-bit
// entry is row(5:3) & col(2:0), col 7 = no action. The per-mode walk
// (membrane_stick.vhd joy_addr_start/joy_bit_count_*):
//
//	mode 011 Sinclair 1: entries  0-4,  joy bits 0-4 (R L D U B -> 7 6 8 9 0)
//	mode 000 Sinclair 2: entries  5-9,  joy bits 0-4 (R L D U B -> 2 1 3 4 5)
//	mode 010 Cursor:     entries 10-14, joy bits 0-4 (R L D U B -> 8 5 6 7 0)
//	mode 111 User:       entries 16-27, joy bits 0-11
//	mode 001/100 Kempston: entries 21-27, joy bits 5-11 (excess buttons)
//	mode 101/110 MD:       entries 24-27, joy bits 8-11 (excess buttons)
//
// The Kempston/MD walks cover only the buttons the port does NOT
// report, through user slots that default to no-op — "excess buttons
// on the pad will generate keypresses if so programmed" (ports.txt).
// Injection is disabled while the joysticks are in I/O mode
// (i_joy_en_n <= zxn_joy_io_mode_en, NR$0B bit 7).
//
// Membrane columns 5-6 (the Next keyboard's extended-key columns) are
// representable in an entry but only columns 0-4 reach a port $FE
// read; a user mapping onto 5/6 would land in the extended-key vector,
// which this model does not route (no default entry uses them).

// joyKeymapDefault is the per-pad ROM half of the key-joystick map,
// entries 0-15, transcribed from keyjoy_64_6.coe. 6-bit row/col,
// row n = address line A(8+n): row 3 = keys 1-5 ($F7FE), row 4 =
// keys 0,9,8,7,6 ($EFFE), column 0 = the row's outermost key.
var joyKeymapDefault = [16]byte{
	0b100011, // 0  Sinclair 1 R -> row 4 col 3 (key 7)
	0b100100, // 1  Sinclair 1 L -> row 4 col 4 (key 6)
	0b100010, // 2  Sinclair 1 D -> row 4 col 2 (key 8)
	0b100001, // 3  Sinclair 1 U -> row 4 col 1 (key 9)
	0b100000, // 4  Sinclair 1 B -> row 4 col 0 (key 0)
	0b011001, // 5  Sinclair 2 R -> row 3 col 1 (key 2)
	0b011000, // 6  Sinclair 2 L -> row 3 col 0 (key 1)
	0b011010, // 7  Sinclair 2 D -> row 3 col 2 (key 3)
	0b011011, // 8  Sinclair 2 U -> row 3 col 3 (key 4)
	0b011100, // 9  Sinclair 2 B -> row 3 col 4 (key 5)
	0b100010, // 10 Cursor R -> row 4 col 2 (key 8)
	0b011100, // 11 Cursor L -> row 3 col 4 (key 5)
	0b100100, // 12 Cursor D -> row 4 col 4 (key 6)
	0b100011, // 13 Cursor U -> row 4 col 3 (key 7)
	0b100000, // 14 Cursor B -> row 4 col 0 (key 0)
	0b111111, // 15 unused
}

// joyMembraneWalk gives each NR$05 mode's slice of the keymap walk:
// the first entry index within the pad's 32-entry space and the
// inclusive joy-bit range it maps.
func joyMembraneWalk(mode byte) (start, bitLo, bitHi int) {
	switch mode {
	case 0b011: // Sinclair 1
		return 0, 0, 4
	case 0b000: // Sinclair 2
		return 5, 0, 4
	case 0b010: // Cursor
		return 10, 0, 4
	case 0b111: // User defined
		return 16, 0, 11
	case 0b001, 0b100: // Kempston 1/2 — excess buttons only
		return 21, 5, 11
	default: // 101/110 MD pads — excess buttons only
		return 24, 8, 11
	}
}

// SetJoyKeymap connects the NR$28/$29/$2B joymap RAM's read side (the
// pkg/next/keymap Map) so user-defined key-joystick entries resolve.
// idx = pad<<4 | button, matching the programming interface
// (nextreg.txt NR$05: write 0/16 to $29, then 12 bytes to $2B).
func (u *ULA) SetJoyKeymap(read func(idx uint16) byte) {
	u.joyKeymapUser = read
}

// joyMembraneEntry resolves one keymap entry for a pad: ROM half from
// the .coe table, user half from the joymap RAM (no-op when unwired).
func (u *ULA) joyMembraneEntry(pad, idx int) byte {
	if idx < 16 {
		return joyKeymapDefault[idx]
	}
	if u.joyKeymapUser == nil {
		return 0b000111 // col 7 = no action, the RAM's reset default
	}
	return u.joyKeymapUser(uint16(pad<<4|(idx-16))) & 0x3F
}

// joyMembraneScan composes the active-low column bits (0-4) the two
// pads inject into a port $FE keyboard read for the rows selected by
// addr's high byte. Returns $FF when nothing is held or routing sends
// neither pad at the membrane.
func (u *ULA) joyMembraneScan(addr uint16) byte {
	// I/O mode parks the whole injector (membrane_stick i_joy_en_n).
	if u.nextRegs.ReadReg(0x0B)&0x80 != 0 {
		return 0xFF
	}
	// NR$05 read-back layout: [7:6]=joy0[1:0] [3]=joy0[2],
	// [5:4]=joy1[1:0] [1]=joy1[2] (see WireJoystickMode).
	mode05 := u.nextRegs.ReadReg(0x05)
	joy0 := mode05>>6&0x03 | mode05>>1&0x04
	joy1 := mode05>>4&0x03 | mode05<<1&0x04
	out := byte(0xFF)
	out &= u.joyMembranePad(0, u.MDJoyLeft(), joy0, addr)
	out &= u.joyMembranePad(1, u.MDJoyRight(), joy1, addr)
	return out
}

// joyMembranePad walks one pad's mode slice of the keymap and clears
// the mapped columns for every held button whose row is selected.
func (u *ULA) joyMembranePad(pad int, vec uint16, mode byte, addr uint16) byte {
	if vec == 0 {
		return 0xFF
	}
	start, bitLo, bitHi := joyMembraneWalk(mode)
	rows := byte(addr >> 8)
	out := byte(0xFF)
	for bit := bitLo; bit <= bitHi; bit++ {
		if vec&(1<<bit) == 0 {
			continue
		}
		entry := u.joyMembraneEntry(pad, start+bit-bitLo)
		row := entry >> 3 & 0x07
		col := entry & 0x07
		if col > 4 || rows&(1<<row) != 0 {
			continue
		}
		out &^= 1 << col
	}
	return out
}
