package ula

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/keyboard"
	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// newNextJoyULA builds a ModelNext ULA with a NextReg dispatcher fake
// holding the given NR$05 read-back byte (the spec-correct stored
// form WireJoystickMode produces: bits 7:6 = joy0[1:0], bit 3 =
// joy0[2], bits 5:4 = joy1[1:0], bit 1 = joy1[2]).
func newNextJoyULA(t *testing.T, nr05 byte) *ULA {
	t.Helper()
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	u := New(mem, keyboard.New())
	u.SetNextRegs(&fakeNextRegs{regs: map[byte]byte{0x05: nr05}})
	return u
}

// TestNextJoyPort37Idle pins that port $37 (the second Kempston /
// MD-pad port) is ALWAYS decoded on the Next — zxnext.vhd:2547 decodes
// the low address byte, and the read mux (:2830, :3506) idles at $00
// when NR$05 routes no stick there. It must never fall through to the
// floating bus: Atic Atac's input scanner ORs IN($1F) with IN($37)
// every frame, and a floating $FF reads as every button held, so its
// title screen never sees the fire edge that starts the game.
func TestNextJoyPort37Idle(t *testing.T) {
	u := newNextJoyULA(t, 0x70) // production reset seed: joy0=Kempston@$1F, joy1 off-port
	val, ok := u.ReadPort(0x0037)
	if !ok || val != 0x00 {
		t.Fatalf("Next port $37 idle = ($%02X, %v); want ($00, true) — decoded idle, not floating bus", val, ok)
	}
	// The FPGA decode uses cpu_a(7:0) only — the high byte must not matter.
	val, ok = u.ReadPort(0xFF37)
	if !ok || val != 0x00 {
		t.Fatalf("Next port $FF37 = ($%02X, %v); want ($00, true) — low-byte-only decode", val, ok)
	}
}

// TestNextJoyPortRouting pins the NR$05 routing (zxnext.vhd:3472-3494):
// mode "001" puts the stick's Kempston bits on $1F, mode "100" moves
// them to $37 (and off $1F), and the MD mode "101" keeps $1F live
// (mdL_1f_en feeds joyL_1f_en).
func TestNextJoyPortRouting(t *testing.T) {
	press := func(u *ULA) {
		u.SetKempstonButton(KempstonFire, true)
		u.SetKempstonButton(KempstonRight, true)
	}
	const want = byte(KempstonFire | KempstonRight) // $11

	// joy0 = "001": Kempston on $1F, $37 idle.
	u := newNextJoyULA(t, 0x70)
	press(u)
	if val, _ := u.ReadPort(0x001F); val != want {
		t.Fatalf("joy0=001: port $1F = $%02X; want $%02X", val, want)
	}
	if val, _ := u.ReadPort(0x0037); val != 0x00 {
		t.Fatalf("joy0=001: port $37 = $%02X; want $00", val)
	}

	// joy0 = "100" (Kempston 2): stick on $37, $1F idle.
	// Stored byte: joy0[1:0]="00" -> bits 7:6 = 00, joy0[2]=1 -> bit 3.
	u = newNextJoyULA(t, 0x08)
	press(u)
	if val, _ := u.ReadPort(0x0037); val != want {
		t.Fatalf("joy0=100: port $37 = $%02X; want $%02X", val, want)
	}
	if val, _ := u.ReadPort(0x001F); val != 0x00 {
		t.Fatalf("joy0=100: port $1F = $%02X; want $00", val)
	}

	// joy0 = "101" (MD pad on $1F): Kempston bits still read on $1F;
	// the MD-only START/A bits 7:6 stay idle (no emulator-side pad
	// source yet — see the MD-pad work item).
	u = newNextJoyULA(t, 0x48)
	press(u)
	if val, _ := u.ReadPort(0x001F); val != want {
		t.Fatalf("joy0=101 (MD): port $1F = $%02X; want $%02X", val, want)
	}
}
