package keyboard

import (
	"testing"

	"fyne.io/fyne/v2"
)

// TestExtendedKeys pins the derivation of the Spectrum Next extended-key
// vector (i_KBD_EXTENDED_KEYS) from the classic-matrix composites the
// membrane folds each dedicated key into (membrane.vhd:236-249). Bit
// layout per the FPGA read-mux comment (zxnext.vhd:6203-6204):
// bits 15..8 = DOWN LEFT RIGHT DELETE . , " ; and bits 7..0 =
// EDIT BREAK INV TRU GRAPH CAPSLOCK UP EXTEND. One entry per key.
func TestExtendedKeys(t *testing.T) {
	type press struct {
		row  int
		mask byte
	}
	caps := press{0, 0x01}
	sym := press{7, 0x02}
	cases := []struct {
		name    string
		presses []press
		want    uint16
	}{
		{"EXTEND = CAPS+SYM", []press{caps, sym}, 1 << 0},
		{"UP = CAPS+7", []press{caps, {4, 0x08}}, 1 << 1},
		{"CAPS LOCK = CAPS+2", []press{caps, {3, 0x02}}, 1 << 2},
		{"GRAPH = CAPS+9", []press{caps, {4, 0x02}}, 1 << 3},
		{"TRUE VIDEO = CAPS+3", []press{caps, {3, 0x04}}, 1 << 4},
		{"INV VIDEO = CAPS+4", []press{caps, {3, 0x08}}, 1 << 5},
		{"BREAK = CAPS+SPACE", []press{caps, {7, 0x01}}, 1 << 6},
		{"EDIT = CAPS+1", []press{caps, {3, 0x01}}, 1 << 7},
		{"; = SYM+O", []press{sym, {5, 0x02}}, 1 << 8},
		{"\" = SYM+P", []press{sym, {5, 0x01}}, 1 << 9},
		{", = SYM+N", []press{sym, {7, 0x08}}, 1 << 10},
		{". = SYM+M", []press{sym, {7, 0x04}}, 1 << 11},
		{"DELETE = CAPS+0", []press{caps, {4, 0x01}}, 1 << 12},
		{"RIGHT = CAPS+8", []press{caps, {4, 0x04}}, 1 << 13},
		{"LEFT = CAPS+5", []press{caps, {3, 0x10}}, 1 << 14},
		{"DOWN = CAPS+6", []press{caps, {4, 0x10}}, 1 << 15},

		// Non-composites must not assert anything.
		{"idle", nil, 0},
		{"bare 7 (no CAPS)", []press{{4, 0x08}}, 0},
		{"bare CAPS", []press{caps}, 0},
		{"bare SYM", []press{sym}, 0},
		{"SYM+7 (not a fold pair)", []press{sym, {4, 0x08}}, 0},
	}
	for _, tc := range cases {
		kbd := New()
		for _, p := range tc.presses {
			kbd.PressMatrixKey(p.row, p.mask, true)
		}
		if got := kbd.ExtendedKeys(); got != tc.want {
			t.Errorf("%s: ExtendedKeys() = %016b, want %016b", tc.name, got, tc.want)
		}
	}
}

// TestExtendedKeysHostArrow verifies the host key path end-to-end: a host
// arrow key maps to its CAPS composite (initKeyMap) and so asserts the
// matching extended-key bit — this is how a game polling only NR $B0 sees
// the user's arrows.
func TestExtendedKeysHostArrow(t *testing.T) {
	kbd := New()
	kbd.HandleKeyEvent(&fyne.KeyEvent{Name: fyne.KeyUp}, true)
	if got := kbd.ExtendedKeys(); got != 1<<1 {
		t.Errorf("host Up: ExtendedKeys() = %016b, want UP bit only (%016b)", got, uint16(1<<1))
	}
	kbd.HandleKeyEvent(&fyne.KeyEvent{Name: fyne.KeyUp}, false)
	if got := kbd.ExtendedKeys(); got != 0 {
		t.Errorf("host Up released: ExtendedKeys() = %016b, want 0", got)
	}
}
