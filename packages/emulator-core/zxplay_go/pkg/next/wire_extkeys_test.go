package next

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/next/nextregs"
)

type fakeInputSource struct {
	ek, joyL, joyR uint16
}

func (f *fakeInputSource) ExtendedKeys() uint16 { return f.ek }
func (f *fakeInputSource) MDJoyLeft() uint16    { return f.joyL }
func (f *fakeInputSource) MDJoyRight() uint16   { return f.joyR }

// TestWireExtendedKeysB0B1Shuffle pins NR $B0/$B1 to the FPGA's read mux
// bit-for-bit (zxnext.vhd:6206-6212):
//
//	$B0 = ek(8) & ek(9) & ek(10) & ek(11) & ek(1) & ek(15 downto 13)
//	$B1 = ek(12) & ek(7 downto 2) & ek(0)
//
// by walking every single-bit i_KBD_EXTENDED_KEYS vector.
func TestWireExtendedKeysB0B1Shuffle(t *testing.T) {
	wantB0 := map[uint]byte{
		8: 0x80, 9: 0x40, 10: 0x20, 11: 0x10, // ; " , .
		1: 0x08, 15: 0x04, 14: 0x02, 13: 0x01, // UP DOWN LEFT RIGHT
	}
	wantB1 := map[uint]byte{
		12: 0x80,                                              // DELETE
		7:  0x40, 6: 0x20, 5: 0x10, 4: 0x08, 3: 0x04, 2: 0x02, // EDIT..CAPSLOCK
		0: 0x01, // EXTEND
	}
	src := &fakeInputSource{}
	d := nextregs.New()
	WireExtendedKeys(d, src)
	for bit := uint(0); bit < 16; bit++ {
		src.ek = 1 << bit
		if got := d.ReadReg(0xB0); got != wantB0[bit] {
			t.Errorf("ek bit %d: NR$B0 = $%02X, want $%02X", bit, got, wantB0[bit])
		}
		if got := d.ReadReg(0xB1); got != wantB1[bit] {
			t.Errorf("ek bit %d: NR$B1 = $%02X, want $%02X", bit, got, wantB1[bit])
		}
	}
}

// TestWireExtendedKeysB2Shuffle pins NR $B2 to the FPGA's read mux
// (zxnext.vhd:6214-6215):
//
//	$B2 = joyR(10 downto 8) & joyR(11) & joyL(10 downto 8) & joyL(11)
//
// i.e. each pad's Megadrive X Z Y MODE buttons (i_JOY bit order per
// zxnext.vhd:90-91: 11..0 = MODE X Z Y START A C B U D L R). The
// direction/fire bits 7..0 must NOT leak in.
func TestWireExtendedKeysB2Shuffle(t *testing.T) {
	wantL := map[uint]byte{10: 0x08, 9: 0x04, 8: 0x02, 11: 0x01}
	wantR := map[uint]byte{10: 0x80, 9: 0x40, 8: 0x20, 11: 0x10}
	src := &fakeInputSource{}
	d := nextregs.New()
	WireExtendedKeys(d, src)
	for bit := uint(0); bit < 12; bit++ {
		src.joyL, src.joyR = 1<<bit, 0
		if got := d.ReadReg(0xB2); got != wantL[bit] {
			t.Errorf("joyL bit %d: NR$B2 = $%02X, want $%02X", bit, got, wantL[bit])
		}
		src.joyL, src.joyR = 0, 1<<bit
		if got := d.ReadReg(0xB2); got != wantR[bit] {
			t.Errorf("joyR bit %d: NR$B2 = $%02X, want $%02X", bit, got, wantR[bit])
		}
	}
}

// TestWireExtendedKeysReadOnly pins that NR $B0-$B2 are composed from the
// live source on every read and a NextReg write cannot disturb them — the
// FPGA has no write case for these registers (zxnext.vhd:5575-5581).
func TestWireExtendedKeysReadOnly(t *testing.T) {
	src := &fakeInputSource{}
	d := nextregs.New()
	WireExtendedKeys(d, src)
	for _, reg := range []byte{0xB0, 0xB1, 0xB2} {
		d.WriteReg(reg, 0xFF)
		if got := d.ReadReg(reg); got != 0 {
			t.Errorf("NR$%02X after write $FF with idle inputs = $%02X, want $00", reg, got)
		}
	}
}
