package main

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/keyboard"
	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/next/nextregs"
	"github.com/stever/zxplay_go/pkg/roms"
	"github.com/stever/zxplay_go/pkg/ula"
)

// newJoyEmulator builds the minimum emulator SetJoystickState touches: a
// ULA (for the Kempston/MD bits) and a keyboard (for the Sinclair and
// Cursor schemes). No Next ROMs, so this runs in CI.
func newJoyEmulator(t *testing.T, joy JoystickType) *emulator {
	t.Helper()
	mem, err := memory.New("", roms.Model48K)
	if err != nil {
		t.Fatalf("memory.New(Model48K): %v", err)
	}
	kbd := keyboard.New()
	return &emulator{mem: mem, kbd: kbd, ula: ula.New(mem, kbd), joystickType: joy}
}

// TestSetJoystickStateMapsVectorToKempston pins the bit order across the
// i_JOY -> Kempston boundary. The two layouts are deliberately identical
// in the low five bits, and this is the test that says so out loud: get
// it wrong and left/right (or up/down) silently swap.
func TestSetJoystickStateMapsVectorToKempston(t *testing.T) {
	cases := []struct {
		name string
		vec  uint16
		want byte
	}{
		{"right", 0x001, ula.KempstonRight},
		{"left", 0x002, ula.KempstonLeft},
		{"down", 0x004, ula.KempstonDown},
		{"up", 0x008, ula.KempstonUp},
		{"fire (MD B)", 0x010, ula.KempstonFire},
		{"up+right+fire", 0x019, ula.KempstonUp | ula.KempstonRight | ula.KempstonFire},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newJoyEmulator(t, JoystickKempston)
			e.SetJoystickState(tc.vec)
			if got := e.ula.KempstonState; got != tc.want {
				t.Fatalf("vec $%03X -> KempstonState $%02X; want $%02X", tc.vec, got, tc.want)
			}
		})
	}
}

// TestSetJoystickStateReleases is the whole reason input is state-based
// rather than edge-based: a direction must drop as soon as it leaves the
// host's snapshot, with no release event required. Held directions are
// what strand a game running into a wall forever.
func TestSetJoystickStateReleases(t *testing.T) {
	e := newJoyEmulator(t, JoystickKempston)

	e.SetJoystickState(0x001) // right
	if e.ula.KempstonState != ula.KempstonRight {
		t.Fatalf("right not applied: $%02X", e.ula.KempstonState)
	}

	// Straight from right to left in one snapshot — right must clear in
	// the same call that sets left, not linger.
	e.SetJoystickState(0x002)
	if e.ula.KempstonState != ula.KempstonLeft {
		t.Fatalf("right->left: KempstonState $%02X; want $%02X only",
			e.ula.KempstonState, byte(ula.KempstonLeft))
	}

	e.SetJoystickState(0)
	if e.ula.KempstonState != 0 {
		t.Fatalf("idle snapshot left $%02X held", e.ula.KempstonState)
	}
}

// TestSetJoystickStateFeedsMDExtras pins that the Megadrive-only buttons
// reach the ULA while staying out of the Kempston byte.
func TestSetJoystickStateFeedsMDExtras(t *testing.T) {
	e := newJoyEmulator(t, JoystickKempston)

	e.SetJoystickState(ula.MDJoyStart | ula.MDJoyX | 0x001)
	if got := e.ula.MDExtraState; got != ula.MDJoyStart|ula.MDJoyX {
		t.Fatalf("MDExtraState = $%03X; want $%03X", got, uint16(ula.MDJoyStart|ula.MDJoyX))
	}
	if got := e.ula.KempstonState; got != ula.KempstonRight {
		t.Fatalf("KempstonState = $%02X; want $%02X — extras must not leak down",
			got, byte(ula.KempstonRight))
	}

	e.SetJoystickState(0)
	if e.ula.MDExtraState != 0 {
		t.Fatalf("idle snapshot left MD extras $%03X held", e.ula.MDExtraState)
	}
}

// TestSetJoystickStateSinclairInjectsKeys checks the non-Kempston
// schemes still work through the vector path on classic machines:
// Sinclair 1 is keys 6..0 (the Interface 2 / Next NR$05 mode 011
// layout — the naming was swapped with Sinclair 2 until #202), and a
// held direction must not re-inject its key every poll (60 presses
// a second would swamp the matrix and break auto-repeat-sensitive games).
func TestSetJoystickStateSinclairInjectsKeys(t *testing.T) {
	e := newJoyEmulator(t, JoystickSinclair1)

	// Sinclair 1 fire is key 0, read on the half-row port $EFFE (keys
	// 6-0) at bit 0. The matrix is active low: 0 means held.
	const port, bit = 0xEFFE, byte(0x01)
	held := func() bool {
		v, _ := e.ula.ReadPort(port)
		return v&bit == 0
	}

	if held() {
		t.Fatal("key 0 reads as held before any input")
	}
	e.SetJoystickState(0x010)
	if !held() {
		t.Fatal("Sinclair1 fire did not press key 0")
	}

	// Kempston bits must stay clear: this scheme is keyboard-only.
	if e.ula.KempstonState != 0 {
		t.Fatalf("Sinclair1 set Kempston bits $%02X", e.ula.KempstonState)
	}

	e.SetJoystickState(0)
	if held() {
		t.Fatal("Sinclair1 fire stayed pressed after release")
	}
}

// TestSetJoystickTypeReleasesHeldDirection pins the switch-time release.
// The stale bit would otherwise be unreachable: releases after the switch
// go to the NEW interface, which never set it.
func TestSetJoystickTypeReleasesHeldDirection(t *testing.T) {
	e := newJoyEmulator(t, JoystickKempston)
	e.SetJoystickState(0x001) // hold right

	e.setJoystickType(JoystickSinclair1)

	if e.ula.KempstonState != 0 {
		t.Fatalf("switching interface left Kempston $%02X held", e.ula.KempstonState)
	}
	if e.joyState != 0 {
		t.Fatalf("joyState = $%03X after switch; want 0 so the next poll re-dispatches", e.joyState)
	}
}

// TestKempstonInterfaceStaysFitted pins the fix for the Manic Miner case.
// Games probe for a Kempston by polling $1F in a tight loop and judging
// whether it reads consistently; the answer must therefore never change
// underneath them. It has to be true from construction (before any guest
// code runs) and must survive switching the pad to another scheme —
// choosing to play with Sinclair keys does not unplug the Kempston card.
func TestKempstonInterfaceStaysFitted(t *testing.T) {
	mem, err := memory.New("", roms.Model48K)
	if err != nil {
		t.Fatalf("memory.New: %v", err)
	}
	e, err := newEmulator(roms.Model48K)
	if err != nil {
		t.Skipf("newEmulator: %v", err)
	}
	_ = mem

	if !e.ula.KempstonEnabled {
		t.Fatal("Kempston interface not fitted at construction — a game's " +
			"detection loop would see floating garbage on its first reads")
	}
	// The very first read a guest makes must already be the real answer.
	if v, ok := e.ula.ReadPort(0x001F); !ok || v != 0x00 {
		t.Fatalf("first port $1F read = ($%02X, %v); want ($00, true)", v, ok)
	}

	e.setJoystickType(JoystickSinclair1)
	if !e.ula.KempstonEnabled {
		t.Fatal("selecting Sinclair un-fitted the Kempston interface")
	}
	e.setJoystickType(JoystickNone)
	if !e.ula.KempstonEnabled {
		t.Fatal("selecting None un-fitted the Kempston interface")
	}
}

// newNextJoyEmulator builds the minimum Next-model emulator the
// joystick routing touches: ULA + keyboard + a real NextReg
// dispatcher (so NR$05 round-trips and the membrane injection reads
// it). No Next ROMs, so this runs in CI.
func newNextJoyEmulator(t *testing.T, joy JoystickType) *emulator {
	t.Helper()
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	kbd := keyboard.New()
	u := ula.New(mem, kbd)
	disp := nextregs.New()
	u.SetNextRegs(disp)
	return &emulator{mem: mem, kbd: kbd, ula: u, nextRegs: disp, joystickType: joy}
}

// TestNextJoystickTypeWritesNR05 pins that on the Next a frontend
// joystick selection is expressed as the machine's own NR$05
// joystick-1 mode (nextreg.txt: 011=Sinclair 1, 000=Sinclair 2,
// 010=Cursor; Kempston maps to the MD-1 superset 101), leaving the
// 50/60 Hz + scandoubler bits and joystick 2 untouched, and that None
// leaves the machine's configuration alone.
func TestNextJoystickTypeWritesNR05(t *testing.T) {
	cases := []struct {
		joy  JoystickType
		want byte // joy0 field of the read-back byte (bits 7:6 and 3)
	}{
		{JoystickKempston, 0x48},  // 101 -> bits 7:6 = 01, bit 3 = 1
		{JoystickSinclair1, 0xC0}, // 011
		{JoystickSinclair2, 0x00}, // 000
		{JoystickCursor, 0x80},    // 010
	}
	for _, c := range cases {
		e := newNextJoyEmulator(t, JoystickNone)
		// Seed the production boot value ($59: joy0=MD 1, joy1=001,
		// bit 0 scandoubler) so preservation is visible.
		e.nextRegs.WriteReg(0x05, 0x59)
		e.setJoystickType(c.joy)
		got := e.nextRegs.ReadReg(0x05)
		if got&0xC8 != c.want {
			t.Errorf("type %v: NR$05 joy0 field = $%02X; want $%02X (NR$05=$%02X)",
				c.joy, got&0xC8, c.want, got)
		}
		if got&^0xC8 != 0x59&^0xC8 {
			t.Errorf("type %v: NR$05 non-joy0 bits changed: $%02X -> $%02X",
				c.joy, byte(0x59)&^byte(0xC8), got&^0xC8)
		}
	}

	e := newNextJoyEmulator(t, JoystickNone)
	e.nextRegs.WriteReg(0x05, 0x59)
	e.setJoystickType(JoystickNone)
	if got := e.nextRegs.ReadReg(0x05); got != 0x59 {
		t.Errorf("type None rewrote NR$05: $59 -> $%02X (must leave the machine's config alone)", got)
	}
}

// TestNextSinclairRidesVectorAndMembrane is the #202 end-to-end pin:
// on the Next a Sinclair selection must NOT frontend-inject keys —
// the vector feeds the ULA's i_JOY state and the FPGA-modelled
// membrane injection presses the keys per NR$05. Bomb Jack's JOYSTICK
// option reads row $EFFE directly (6=left 7=right 9=up 0=fire).
func TestNextSinclairRidesVectorAndMembrane(t *testing.T) {
	e := newNextJoyEmulator(t, JoystickNone)
	e.setJoystickType(JoystickSinclair1)

	e.SetJoystickState(0x002) // left
	if e.ula.KempstonState != ula.KempstonLeft {
		t.Fatalf("Next Sinclair1: vector did not reach the ULA (KempstonState=$%02X)", e.ula.KempstonState)
	}
	v, _ := e.ula.ReadPort(0xEFFE)
	if v&0x10 != 0 {
		t.Fatalf("Next Sinclair1 left: row $EFFE = $%02X; want key 6 (bit 4) low", v)
	}
	// The key must come from the membrane injection, not a frontend
	// keyboard press: the raw matrix stays idle.
	if got := e.kbd.Scan(0xEFFE); got&0x1F != 0x1F {
		t.Fatalf("frontend injected a real key press on the Next: matrix=$%02X", got&0x1F)
	}

	// Switching to Kempston re-routes NR$05; the same vector now
	// appears on port $1F and leaves the membrane alone.
	e.setJoystickType(JoystickKempston)
	e.SetJoystickState(0x002)
	if v, _ := e.ula.ReadPort(0x001F); v&0x02 == 0 {
		t.Fatalf("Next Kempston: port $1F = $%02X; want left (bit 1) set", v)
	}
	if v, _ := e.ula.ReadPort(0xEFFE); v&0x1F != 0x1F {
		t.Fatalf("Next Kempston: membrane still pressed: row $EFFE = $%02X", v)
	}
}

func TestJoystickTypeFromName(t *testing.T) {
	cases := map[string]JoystickType{
		"None":      JoystickNone,
		"":          JoystickNone,
		"Kempston":  JoystickKempston,
		"kempston":  JoystickKempston,
		"Sinclair1": JoystickSinclair1,
		"Sinclair2": JoystickSinclair2,
		"Cursor":    JoystickCursor,
	}
	for name, want := range cases {
		got, ok := joystickTypeFromName(name)
		if !ok || got != want {
			t.Errorf("joystickTypeFromName(%q) = (%v, %v); want (%v, true)", name, got, ok, want)
		}
	}
	if _, ok := joystickTypeFromName("Atari"); ok {
		t.Error("joystickTypeFromName(\"Atari\") accepted an unknown name")
	}
}
