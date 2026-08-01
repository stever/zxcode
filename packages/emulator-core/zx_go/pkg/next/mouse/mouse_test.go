package mouse

import "testing"

// Counters and $FADF composition per ps2_mouse.v + zxnext.vhd:3541-3560.

func TestCountersWrapAndScale(t *testing.T) {
	m := New()
	// Default control (nil source) = DPI 01, ×1.
	m.Move(10, -3)
	if m.ReadX() != 10 || m.ReadY() != 0xFD {
		t.Fatalf("×1 move → X=%02X Y=%02X, want 0A/FD", m.ReadX(), m.ReadY())
	}

	ctrl := struct {
		rev bool
		dpi byte
	}{false, 0x00}
	m.SetControlSource(func() (bool, byte) { return ctrl.rev, ctrl.dpi })

	// DPI 00 doubles (xydelta = {d[7:1],0}).
	m2 := New()
	m2.SetControlSource(func() (bool, byte) { return ctrl.rev, ctrl.dpi })
	m2.Move(5, 0)
	if m2.ReadX() != 10 {
		t.Fatalf("×2 move → X=%02X, want 0A", m2.ReadX())
	}
	// DPI 10 halves with sign preservation (arithmetic shift).
	ctrl.dpi = 0x02
	m2.Move(-4, 0)
	if m2.ReadX() != 8 {
		t.Fatalf("÷2 move → X=%02X, want 08 (10 - 2)", m2.ReadX())
	}
	// DPI 11 quarters.
	ctrl.dpi = 0x03
	m2.Move(8, 0)
	if m2.ReadX() != 10 {
		t.Fatalf("÷4 move → X=%02X, want 0A (8 + 2)", m2.ReadX())
	}
	// 8-bit wrap.
	ctrl.dpi = 0x01
	m2.Move(300, 0)
	if want := byte((10 + 300) & 0xFF); m2.ReadX() != want {
		t.Fatalf("wrap → X=%02X, want %02X", m2.ReadX(), want)
	}
}

func TestButtonsActiveLowAndReverse(t *testing.T) {
	rev := false
	m := New()
	m.SetControlSource(func() (bool, byte) { return rev, 0x01 })

	// Idle: wheel 0, bit 3 set, all buttons released (active-low 1s).
	if got := m.ReadButtons(); got != 0x0F {
		t.Fatalf("idle $FADF = %02X, want 0F", got)
	}
	// Left pressed → bit 1 clears (zxnext.vhd:3560 ordering:
	// b2=middle, b1=left, b0=right).
	m.SetButtons(true, false, false)
	if got := m.ReadButtons(); got != 0x0D {
		t.Fatalf("left held $FADF = %02X, want 0D", got)
	}
	// Button reverse (NR$0A bit 3) swaps left/right.
	rev = true
	if got := m.ReadButtons(); got != 0x0E {
		t.Fatalf("left held, reversed $FADF = %02X, want 0E", got)
	}
	rev = false
	m.SetButtons(false, false, true)
	if got := m.ReadButtons(); got != 0x0B {
		t.Fatalf("middle held $FADF = %02X, want 0B", got)
	}
}

func TestWheelNibble(t *testing.T) {
	m := New()
	m.Wheel(3)
	if got := m.ReadButtons() >> 4; got != 3 {
		t.Fatalf("wheel nibble = %X, want 3", got)
	}
	m.Wheel(-5)
	if got := m.ReadButtons() >> 4; got != 0xE {
		t.Fatalf("wheel nibble after -5 = %X, want E (3-5 wrapped)", got)
	}
}
