// Package mouse models the Spectrum Next's Kempston mouse: the PS/2
// mouse counters the board-level ps2_mouse.v accumulates, exposed on
// ports $FADF (buttons + wheel), $FBDF (X) and $FFDF (Y) — decode
// zxnext.vhd:2668-2670 (a(11:8) = $A/$B/$F with low byte $DF; a(15:12)
// are don't-care), read data :3541-3560.
//
// Counter semantics (ps2_mouse.v):
//   - X/Y are 8-bit wrapping accumulators of DPI-scaled deltas
//     (xcount/ycount, "delta X/Y movement" packets).
//   - The DPI control (NR$0A bits 1:0, o_MOUSE_CONTROL) scales each
//     delta: 00 = ×2, 01 = ×1 (the reset default), 10 = ÷2, 11 = ÷4
//     (sign-preserving shifts, ps2_mouse.v xydelta).
//   - The wheel is a 4-bit wrapping accumulator (zcount) surfaced in
//     $FADF bits 7:4.
//   - Button reverse (NR$0A bit 3) swaps the left/right buttons at
//     packet level (ps2_mouse.v mbutton).
//
// $FADF composition (zxnext.vhd:3560): wheel & '1' & not middle &
// not left & not right — buttons are ACTIVE-LOW.
package mouse

// Mouse is the Kempston mouse device. Hosts feed it deltas and button
// state; the ULA's port dispatch reads the counters. The zero value is
// a centred mouse with no buttons held.
type Mouse struct {
	x, y  byte
	wheel byte // low 4 bits meaningful
	left  bool
	right bool
	mid   bool

	// control returns the live NR$0A-derived control state: button
	// reverse (bit 3) and DPI (bits 1:0). nil = defaults (no reverse,
	// DPI 01 = ×1).
	control func() (reverse bool, dpi byte)
}

// New returns a fresh mouse.
func New() *Mouse { return &Mouse{} }

// SetControlSource installs the NR$0A control-state source (button
// reverse + DPI), matching o_MOUSE_CONTROL <= nr_0a_mouse_button_reverse
// & nr_0a_mouse_dpi (zxnext.vhd:1599).
func (m *Mouse) SetControlSource(f func() (reverse bool, dpi byte)) { m.control = f }

func (m *Mouse) controlState() (bool, byte) {
	if m.control == nil {
		return false, 0x01
	}
	return m.control()
}

// scale applies the DPI scaling of ps2_mouse.v's xydelta mux to one
// delta: 00 doubles, 01 passes through, 10 halves, 11 quarters —
// sign-preserving shifts, exactly like the sign-extended packet shifts.
func scale(delta int, dpi byte) int {
	switch dpi & 0x03 {
	case 0x00:
		return delta << 1
	case 0x01:
		return delta
	case 0x02:
		return delta >> 1
	default:
		return delta >> 2
	}
}

// Move accumulates a host movement delta into the X/Y counters (X
// grows rightwards, Y grows UPWARDS — the PS/2 convention the FPGA
// counters carry; hosts with screen-down Y coordinates negate dy).
func (m *Mouse) Move(dx, dy int) {
	_, dpi := m.controlState()
	m.x += byte(scale(dx, dpi))
	m.y += byte(scale(dy, dpi))
}

// Wheel accumulates wheel steps (positive = away from the user, the
// PS/2 Z convention).
func (m *Mouse) Wheel(dz int) { m.wheel += byte(dz) }

// SetButtons sets the three physical buttons (true = pressed).
func (m *Mouse) SetButtons(left, right, middle bool) {
	m.left, m.right, m.mid = left, right, middle
}

// SetButton sets one button by host index (0 = left, 1 = right,
// 2 = middle), matching the desktop frontend's button callback.
func (m *Mouse) SetButton(btn int, pressed bool) {
	switch btn {
	case 0:
		m.left = pressed
	case 1:
		m.right = pressed
	case 2:
		m.mid = pressed
	}
}

// ReadX serves port $FBDF (zxnext.vhd:3546).
func (m *Mouse) ReadX() byte { return m.x }

// ReadY serves port $FFDF (zxnext.vhd:3553).
func (m *Mouse) ReadY() byte { return m.y }

// ReadButtons serves port $FADF (zxnext.vhd:3560): wheel nibble,
// bit 3 = 1, then active-low middle/left/right — with NR$0A bit 3
// swapping left and right at the packet level (ps2_mouse.v mbutton).
func (m *Mouse) ReadButtons() byte {
	reverse, _ := m.controlState()
	l, r := m.left, m.right
	if reverse {
		l, r = r, l
	}
	v := m.wheel<<4 | 0x08
	if !m.mid {
		v |= 0x04
	}
	if !l {
		v |= 0x02
	}
	if !r {
		v |= 0x01
	}
	return v
}
