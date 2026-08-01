package ula

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/keyboard"
	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/next"
	"github.com/stever/zxplay_go/pkg/next/nextregs"
	"github.com/stever/zxplay_go/pkg/roms"
)

// TestNextExtendedKeysFullStack drives the real keyboard + ULA input
// state through next.WireExtendedKeys — the production wiring path (the
// ULA is the ExtendedKeysSource next.Wire hands to it) — and pins the
// NR $B0-$B2 read-backs a Next game polls (Warhawk reads these ~40k
// times per menu wait instead of the $FE matrix).
func TestNextExtendedKeysFullStack(t *testing.T) {
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	kbd := keyboard.New()
	u := New(mem, kbd)
	d := nextregs.New()
	next.WireExtendedKeys(d, u)

	// Idle: all three registers read 0 (active high, nothing pressed).
	for _, reg := range []byte{0xB0, 0xB1, 0xB2} {
		if got := d.ReadReg(reg); got != 0 {
			t.Errorf("idle NR$%02X = $%02X, want $00", reg, got)
		}
	}

	// UP (the dedicated key's CAPS+7 composite) → NR$B0 bit 3.
	kbd.PressMatrixKey(0, 0x01, true) // CAPS SHIFT
	kbd.PressMatrixKey(4, 0x08, true) // 7
	if got := d.ReadReg(0xB0); got != 0x08 {
		t.Errorf("CAPS+7 held: NR$B0 = $%02X, want $08 (UP)", got)
	}
	if got := d.ReadReg(0xB1); got != 0x00 {
		t.Errorf("CAPS+7 held: NR$B1 = $%02X, want $00", got)
	}

	// BREAK (CAPS+SPACE) → NR$B1 bit 5.
	kbd.PressMatrixKey(4, 0x08, false)
	kbd.PressMatrixKey(7, 0x01, true) // SPACE
	if got := d.ReadReg(0xB1); got != 0x20 {
		t.Errorf("CAPS+SPACE held: NR$B1 = $%02X, want $20 (BREAK)", got)
	}
	kbd.ReleaseAll()

	// Kempston directions/fire are i_JOY bits 4..0 — NOT the Megadrive
	// X Z Y MODE buttons NR$B2 reads, so $B2 stays idle.
	u.SetKempstonButton(KempstonFire|KempstonUp, true)
	if got := d.ReadReg(0xB2); got != 0x00 {
		t.Errorf("Kempston fire+up held: NR$B2 = $%02X, want $00 (no MD extra buttons)", got)
	}

	// A host pad's Megadrive-only buttons DO reach NR$B2. Left-pad bits
	// land in the low nibble (wire.go:1169): X->bit 3, Z->bit 2, Y->bit 1,
	// MODE->bit 0; the high nibble is the right pad, which isn't modelled.
	u.SetMDExtraButtons(MDJoyX | MDJoyMode)
	if got := d.ReadReg(0xB2); got != 0x09 {
		t.Errorf("MD X+MODE held: NR$B2 = $%02X, want $09", got)
	}
	// START/A/C are port-$1F buttons, not NR$B2 ones — setting them must
	// not disturb the register.
	u.SetMDExtraButtons(MDJoyStart | MDJoyA | MDJoyC)
	if got := d.ReadReg(0xB2); got != 0x00 {
		t.Errorf("MD START+A+C held: NR$B2 = $%02X, want $00 (port buttons only)", got)
	}
}
