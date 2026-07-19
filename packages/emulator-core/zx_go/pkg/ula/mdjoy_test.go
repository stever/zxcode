package ula

import "testing"

// TestMDJoyLeftComposesKempstonAndExtras pins the split ownership of the
// 12-bit i_JOY_LEFT vector: bits 4..0 come from KempstonState (they ARE
// the Kempston byte — same bit order, zxnext.vhd:3479) and bits 11..5
// from MDExtraState. Getting the halves in the wrong order would leave
// NR $B2 reporting the wrong buttons while every direction still worked,
// which is exactly the kind of drift that survives manual testing.
func TestMDJoyLeftComposesKempstonAndExtras(t *testing.T) {
	u := newNextJoyULA(t, 0x70)

	u.SetKempstonButton(KempstonFire|KempstonUp, true)
	u.SetMDExtraButtons(MDJoyStart | MDJoyX)

	const want = 0x010 | 0x008 | MDJoyStart | MDJoyX
	if got := u.MDJoyLeft(); got != want {
		t.Fatalf("MDJoyLeft() = $%03X; want $%03X", got, want)
	}

	// The two halves must be independently clearable.
	u.SetMDExtraButtons(0)
	if got := u.MDJoyLeft(); got != 0x018 {
		t.Fatalf("after clearing extras MDJoyLeft() = $%03X; want $018", got)
	}
}

// TestSetMDExtraButtonsIgnoresLowBits pins that the MD-extra setter
// cannot reach the direction/fire bits. The host hands the same 12-bit
// vector to both halves of the state, so without this mask a caller
// passing the full vector would write the directions twice — once via
// dispatchJoystick (which honours the selected interface) and once
// straight into the ULA, bypassing a Sinclair/Cursor selection entirely.
func TestSetMDExtraButtonsIgnoresLowBits(t *testing.T) {
	u := newNextJoyULA(t, 0x70)
	u.SetMDExtraButtons(0x0FFF) // every bit, directions included
	if u.KempstonState != 0 {
		t.Fatalf("KempstonState = $%02X; want $00 — extras must not touch directions", u.KempstonState)
	}
	if u.MDExtraState != 0x0FE0 {
		t.Fatalf("MDExtraState = $%03X; want $FE0", u.MDExtraState)
	}
}

// TestKempstonPortReadCounter pins the diagnostic counter, and — more
// importantly — that adding it did NOT change what a read returns. The
// counter sits in front of the enabled check on a hot path, so a mistake
// here would silently make port $1F answer for machines with no Kempston
// interface, breaking 48K titles that read it expecting the floating bus.
func TestKempstonPortReadCounter(t *testing.T) {
	u := newNextJoyULA(t, 0x70)
	u.KempstonEnabled = false
	// A Next always decodes $1F, so use a classic machine to see the
	// disabled path.
	u.mem = nil

	before := u.KempstonPortReads
	u.ReadPort(0x001F)
	u.ReadPort(0x001F)
	if got := u.KempstonPortReads - before; got != 2 {
		t.Fatalf("counted %d Kempston reads; want 2 — must count with no interface attached", got)
	}

	// The while-held subset is what tells "we never delivered input" apart
	// from "the game had the input and ignored it".
	before = u.KempstonReadsWhileHeld
	u.ReadPort(0x001F)
	if got := u.KempstonReadsWhileHeld - before; got != 0 {
		t.Fatalf("counted %d held-reads with nothing pressed; want 0", got)
	}
	u.SetKempstonButton(KempstonRight, true)
	u.ReadPort(0x001F)
	u.ReadPort(0x001F)
	if got := u.KempstonReadsWhileHeld - before; got != 2 {
		t.Fatalf("counted %d held-reads while right was held; want 2", got)
	}
	u.SetKempstonButton(KempstonRight, false)

	// Non-Kempston ports must not be counted.
	before = u.KempstonPortReads
	u.ReadPort(0xFFFE)
	u.ReadPort(0x00FE)
	if got := u.KempstonPortReads - before; got != 0 {
		t.Fatalf("counted %d reads on non-Kempston ports; want 0", got)
	}
}

// TestNextJoyPortMDButtons is the port-side half of the MD-pad wiring:
// with a real button source the MD mode's bits 7:6 (START/A) now carry
// data instead of idling. Complements TestNextJoyPortRouting, which
// pinned them idle back when nothing could set them.
func TestNextJoyPortMDButtons(t *testing.T) {
	// joy0 = "101": MD pad on $1F.
	u := newNextJoyULA(t, 0x48)
	u.SetKempstonButton(KempstonRight, true)
	u.SetMDExtraButtons(MDJoyStart | MDJoyA | MDJoyC | MDJoyMode)

	// Bits 5:0 = C + Right; bits 7:6 = START + A. MODE is bit 11 and has
	// no port representation at all — it is NR $B2 only.
	const want = byte(0x80 | 0x40 | 0x20 | 0x01)
	if val, _ := u.ReadPort(0x001F); val != want {
		t.Fatalf("MD mode port $1F = $%02X; want $%02X", val, want)
	}

	// In plain Kempston mode the START/A bits are gated off, but C (bit 5)
	// still passes: the FPGA feeds i_JOY(5:0) to the Kempston read.
	u = newNextJoyULA(t, 0x70) // joy0 = "001"
	u.SetKempstonButton(KempstonRight, true)
	u.SetMDExtraButtons(MDJoyStart | MDJoyA | MDJoyC)
	if val, _ := u.ReadPort(0x001F); val != 0x21 {
		t.Fatalf("Kempston mode port $1F = $%02X; want $21 (C passes, START/A gated)", val)
	}
}
