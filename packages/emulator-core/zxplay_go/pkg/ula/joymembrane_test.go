package ula

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/keyboard"
	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/roms"
)

// The membrane key-joystick injection (joymembrane.go) models the
// FPGA's membrane_stick module: pads routed to a keyboard mode by
// NR$05 press membrane keys, visible in port $FE reads. The default
// mappings are pinned against ram/init/keyjoy_64_6.coe:
//
//	Sinclair 1 (011): 6=L 7=R 8=D 9=U 0=B  (row $EFFE)
//	Sinclair 2 (000): 1=L 2=R 3=D 4=U 5=B  (row $F7FE)
//	Cursor     (010): 5=L 8=R 6=D 7=U 0=B
//
// NR$05 stored bytes below use the read-back layout WireJoystickMode
// keeps: bits 7:6 = joy0[1:0], bit 3 = joy0[2].

// feRead returns the keyboard bits (4:0) of a port $FE read.
func feRead(u *ULA, addr uint16) byte {
	val, _ := u.ReadPort(addr)
	return val & 0x1F
}

func TestJoyMembraneSinclair1(t *testing.T) {
	u := newNextJoyULA(t, 0xC0) // joy0 = 011 Sinclair 1
	cases := []struct {
		bit  byte
		want byte // active-low mask expected on row $EFFE
		key  string
	}{
		{KempstonRight, 0x08, "7"},
		{KempstonLeft, 0x10, "6"},
		{KempstonDown, 0x04, "8"},
		{KempstonUp, 0x02, "9"},
		{KempstonFire, 0x01, "0"},
	}
	for _, c := range cases {
		u.KempstonState = c.bit
		if got := feRead(u, 0xEFFE); got != 0x1F&^c.want {
			t.Errorf("Sinclair 1 joy bit $%02X: row $EFFE = $%02X; want key %s ($%02X low)",
				c.bit, got, c.key, 0x1F&^c.want)
		}
		// The 1-5 row stays untouched.
		if got := feRead(u, 0xF7FE); got != 0x1F {
			t.Errorf("Sinclair 1 joy bit $%02X leaked into row $F7FE: $%02X", c.bit, got)
		}
	}
	// Sinclair mode leaves the Kempston port idle (NR$05 routes the
	// stick off-port).
	u.KempstonState = KempstonFire
	if val, _ := u.ReadPort(0x001F); val != 0x00 {
		t.Errorf("Sinclair 1 mode: port $1F = $%02X; want $00", val)
	}
}

func TestJoyMembraneSinclair2(t *testing.T) {
	u := newNextJoyULA(t, 0x00) // joy0 = 000 Sinclair 2
	cases := []struct {
		bit  byte
		want byte
		key  string
	}{
		{KempstonRight, 0x02, "2"},
		{KempstonLeft, 0x01, "1"},
		{KempstonDown, 0x04, "3"},
		{KempstonUp, 0x08, "4"},
		{KempstonFire, 0x10, "5"},
	}
	for _, c := range cases {
		u.KempstonState = c.bit
		if got := feRead(u, 0xF7FE); got != 0x1F&^c.want {
			t.Errorf("Sinclair 2 joy bit $%02X: row $F7FE = $%02X; want key %s ($%02X low)",
				c.bit, got, c.key, 0x1F&^c.want)
		}
		if got := feRead(u, 0xEFFE); got != 0x1F {
			t.Errorf("Sinclair 2 joy bit $%02X leaked into row $EFFE: $%02X", c.bit, got)
		}
	}
}

func TestJoyMembraneCursor(t *testing.T) {
	u := newNextJoyULA(t, 0x80) // joy0 = 010 Cursor
	// L -> 5 (row $F7FE bit 4); R -> 8, D -> 6, U -> 7, B -> 0 (row $EFFE).
	u.KempstonState = KempstonLeft
	if got := feRead(u, 0xF7FE); got != 0x1F&^0x10 {
		t.Errorf("Cursor left: row $F7FE = $%02X; want key 5 low", got)
	}
	u.KempstonState = KempstonRight | KempstonUp | KempstonDown | KempstonFire
	if got := feRead(u, 0xEFFE); got != 0x1F&^(0x04|0x08|0x10|0x01) {
		t.Errorf("Cursor R+U+D+B: row $EFFE = $%02X; want keys 8,7,6,0 low", got)
	}
}

// TestJoyMembraneKempstonNoDefaultInjection pins that the port modes
// press no keys out of the box: their keymap walk covers only the
// excess buttons (bits 5-11) through user slots that default to
// no-action (keyjoy_64_6.coe entries 16+ = 000111).
func TestJoyMembraneKempstonNoDefaultInjection(t *testing.T) {
	for _, nr05 := range []byte{0x40 /*001 Kempston 1*/, 0x48 /*101 MD 1*/, 0x59 /*production seed*/} {
		u := newNextJoyULA(t, nr05)
		u.KempstonState = 0x1F
		u.SetMDExtraButtons(0x0FE0)
		for _, row := range []uint16{0xF7FE, 0xEFFE, 0xFEFE, 0x7FFE} {
			if got := feRead(u, row); got != 0x1F {
				t.Errorf("NR$05=$%02X: row $%04X = $%02X; want $1F (no membrane injection)", nr05, row, got)
			}
		}
	}
}

// TestJoyMembraneUserDefined programs the joymap user slots via
// SetJoyKeymap and pins the user mode (111) walk over all 12 buttons,
// plus the Kempston-mode excess-button walk (bits 5-11 through the
// same slots — "excess buttons on the pad will generate keypresses if
// so programmed", ports.txt).
func TestJoyMembraneUserDefined(t *testing.T) {
	var joymap [512]byte
	for i := range joymap {
		joymap[i] = 0b000111 // no action
	}
	joymap[0] = 0b111100  // left button 0 (R)     -> row 7 col 4 (B)
	joymap[7] = 0b000001  // left button 7 (START) -> row 0 col 1 (Z)
	joymap[11] = 0b010010 // left button 11 (MODE) -> row 2 col 2 (E)
	read := func(idx uint16) byte { return joymap[idx&0x1FF] }

	u := newNextJoyULA(t, 0xC8) // joy0 = 111 User Defined
	u.SetJoyKeymap(read)
	u.KempstonState = KempstonRight
	if got := feRead(u, 0x7FFE); got != 0x1F&^0x10 {
		t.Errorf("user map R: row $7FFE = $%02X; want col 4 (B) low", got)
	}
	u.KempstonState = 0
	u.SetMDExtraButtons(MDJoyStart | MDJoyMode)
	if got := feRead(u, 0xFEFE); got != 0x1F&^0x02 {
		t.Errorf("user map START: row $FEFE = $%02X; want col 1 (Z) low", got)
	}
	if got := feRead(u, 0xFBFE); got != 0x1F&^0x04 {
		t.Errorf("user map MODE: row $FBFE = $%02X; want col 2 (E) low", got)
	}

	// Kempston 1 routing: directions stay port-only, but the
	// programmed START (bit 7) slot still fires.
	u = newNextJoyULA(t, 0x40)
	u.SetJoyKeymap(read)
	u.KempstonState = KempstonRight
	u.SetMDExtraButtons(MDJoyStart)
	if got := feRead(u, 0x7FFE); got != 0x1F {
		t.Errorf("kempston mode: direction leaked into membrane: row $7FFE = $%02X", got)
	}
	if got := feRead(u, 0xFEFE); got != 0x1F&^0x02 {
		t.Errorf("kempston mode: programmed START not injected: row $FEFE = $%02X", got)
	}
}

// TestJoyMembraneMultiRow pins the AND-compose across a multi-row
// scan address (e.g. $00FE selects every row), and that real keyboard
// state and joystick injection merge.
func TestJoyMembraneMultiRow(t *testing.T) {
	u := newNextJoyULA(t, 0xC0) // Sinclair 1
	u.KempstonState = KempstonLeft | KempstonFire
	if got := feRead(u, 0x00FE); got != 0x1F&^(0x10|0x01) {
		t.Errorf("all-rows read = $%02X; want keys 6 and 0 low", got)
	}
}

// TestJoyMembraneIOModeGate pins the i_joy_en_n gate: NR$0B bit 7
// (joystick I/O mode) parks the whole injector
// (zxnext_top_issue4.vhd:1855 wires i_joy_en_n to the io-mode enable).
func TestJoyMembraneIOModeGate(t *testing.T) {
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	u := New(mem, keyboard.New())
	u.SetNextRegs(&fakeNextRegs{regs: map[byte]byte{0x05: 0xC0, 0x0B: 0x80}})
	u.KempstonState = KempstonLeft
	if got := feRead(u, 0xEFFE); got != 0x1F {
		t.Errorf("I/O mode: injection still active: row $EFFE = $%02X", got)
	}
}

// TestJoyMembraneClassicModelsUntouched pins that classic machines
// never see the injector — it's Next FPGA hardware.
func TestJoyMembraneClassicModelsUntouched(t *testing.T) {
	mem, err := memory.New("", roms.Model48K)
	if err != nil {
		t.Skipf("48K ROM unavailable: %v", err)
	}
	u := New(mem, keyboard.New())
	u.SetNextRegs(&fakeNextRegs{regs: map[byte]byte{0x05: 0xC0}})
	u.KempstonEnabled = true
	u.KempstonState = KempstonLeft
	if got := feRead(u, 0xEFFE); got != 0x1F {
		t.Errorf("48K: membrane injection appeared: row $EFFE = $%02X", got)
	}
}
