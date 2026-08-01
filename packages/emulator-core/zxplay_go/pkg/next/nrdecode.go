package next

import "github.com/stever/zxplay_go/pkg/next/nextregs"

// nrReadMux marks the NextReg numbers the FPGA's port $253B read mux
// decodes (zxnext.vhd:5882-6289). Every register NOT in this set hits
// the mux's `others => '0'` arm (:6286-6287) and reads $00 on real
// hardware — including registers that ARE writable (NR$04 config
// RAMPAGE, $29-$2B keymap, $35-$39/$75-$79 sprite attributes, $60/$63
// copper data). The dispatcher's default read returns the stored
// byte, so WireZeroReads pins the hardware behaviour at wiring time.
//
// Transcribed case by case from the VHDL; keep in lockstep with the
// read mux when tracking a core update. The wire_nrdecode conformance
// test enumerates all 256 registers against this table.
var nrReadMux = [256]bool{
	0x00: true, 0x01: true, 0x02: true, 0x03: true, 0x05: true,
	0x06: true, 0x07: true, 0x08: true, 0x09: true, 0x0A: true,
	0x0B: true, 0x0E: true, 0x0F: true,
	0x10: true, 0x11: true, 0x12: true, 0x13: true, 0x14: true,
	0x15: true, 0x16: true, 0x17: true, 0x18: true, 0x19: true,
	0x1A: true, 0x1B: true, 0x1C: true, 0x1E: true, 0x1F: true,
	0x20: true, 0x22: true, 0x23: true, 0x26: true, 0x27: true,
	0x28: true, 0x2C: true, 0x2D: true, 0x2E: true, 0x2F: true,
	0x30: true, 0x31: true, 0x32: true, 0x33: true, 0x34: true,
	0x40: true, 0x41: true, 0x42: true, 0x43: true, 0x44: true,
	0x4A: true, 0x4B: true, 0x4C: true,
	0x50: true, 0x51: true, 0x52: true, 0x53: true, 0x54: true,
	0x55: true, 0x56: true, 0x57: true,
	0x61: true, 0x62: true, 0x64: true, 0x68: true, 0x69: true,
	0x6A: true, 0x6B: true, 0x6C: true, 0x6E: true, 0x6F: true,
	0x70: true, 0x71: true, 0x7F: true,
	0x80: true, 0x81: true, 0x82: true, 0x83: true, 0x84: true,
	0x85: true, 0x86: true, 0x87: true, 0x88: true, 0x89: true,
	0x8A: true, 0x8C: true, 0x8E: true, 0x8F: true,
	0x90: true, 0x91: true, 0x92: true, 0x93: true, 0x98: true,
	0x99: true, 0x9A: true, 0x9B: true,
	0xA0: true, 0xA2: true, 0xA8: true, 0xA9: true,
	0xB0: true, 0xB1: true, 0xB2: true, 0xB8: true, 0xB9: true,
	0xBA: true, 0xBB: true,
	0xC0: true, 0xC2: true, 0xC3: true, 0xC4: true, 0xC5: true,
	0xC6: true, 0xC8: true, 0xC9: true, 0xCA: true, 0xCC: true,
	0xCD: true, 0xCE: true,
	0xD8: true, 0xD9: true, 0xDA: true,
	0xF0: true, 0xF8: true, 0xF9: true, 0xFA: true,
}

// nrLiveIdleZero marks mux registers whose read composes a LIVE
// source with no emulator-side driver, so the hardware read idles at
// $00 while our default storage would leak the last written byte:
//
//   - $2C/$2D/$2E: Raspberry Pi I2S audio samples (zxnext.vhd:6007-
//     6015) — no Pi is modelled, the audio inputs idle 0. (Writes to
//     these registers don't store anyway: their write cases are
//     commented out, :5321-5328.)
//   - $F0/$F8/$F9/$FA: the XDEV/XADC command interface exists only on
//     Issue 4/5 boards (the gen_xdev generate block, zxnext.vhd:7438+);
//     our board identity is Issue 3 (NR$0F = $01), where the backing
//     signals are undriven and read 0.
var nrLiveIdleZero = [256]bool{
	0x2C: true, 0x2D: true, 0x2E: true,
	0xF0: true, 0xF8: true, 0xF9: true, 0xFA: true,
}

// WireZeroReads installs `read = $00` handlers for every NextReg the
// FPGA read mux does not decode (plus the live-idle set above),
// matching the hardware's `others => '0'`. Runs LAST in Wire so it
// documents rather than overrides: it never touches a register whose
// read another Wire* helper composes. Raw()/debug access still sees
// the stored bytes.
func WireZeroReads(d *nextregs.Dispatcher) {
	zero := func(*nextregs.Dispatcher) byte { return 0 }
	for r := 0; r < 256; r++ {
		if !nrReadMux[r] || nrLiveIdleZero[r] {
			d.SetOnRead(byte(r), zero)
		}
	}
}
