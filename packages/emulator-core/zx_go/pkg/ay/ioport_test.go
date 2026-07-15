package ay

import "testing"

// TestIOPortReadsFollowDirectionBits pins the FPGA ym2149 IO-port read
// mux (ym2149.vhd:241-249): INPUT mode (reg 7 bit 6/7 = 0) reads the
// external pins — all-ones on the Next (turbosound.vhd port_a_i/b_i
// pullups) — while OUTPUT mode reads the register latch. The Konami
// arcade lineage (RAMS Frogger) senses inputs through these ports, so
// the idle state must be $FF, not the power-on zero latch.
func TestIOPortReadsFollowDirectionBits(t *testing.T) {
	a := New()

	// Power-on: reg 7 has IO bits 0 (input mode) on the AY default.
	a.WriteRegister(RegMixer, 0x3F) // ports A+B input
	a.WriteRegister(RegIOA, 0x12)   // latch some values
	a.WriteRegister(RegIOB, 0x34)

	if got := a.ReadRegister(RegIOA); got != 0xFF {
		t.Errorf("input-mode IOA read = %02X, want FF (pullups)", got)
	}
	if got := a.ReadRegister(RegIOB); got != 0xFF {
		t.Errorf("input-mode IOB read = %02X, want FF (pullups)", got)
	}

	// Output mode: reads return the latch (reg AND $FF pins).
	a.WriteRegister(RegMixer, 0x3F|0xC0)
	if got := a.ReadRegister(RegIOA); got != 0x12 {
		t.Errorf("output-mode IOA read = %02X, want 12 (latch)", got)
	}
	if got := a.ReadRegister(RegIOB); got != 0x34 {
		t.Errorf("output-mode IOB read = %02X, want 34 (latch)", got)
	}

	// ReadSelected takes the same path.
	a.WriteRegister(RegMixer, 0x3F)
	a.SelectRegister(RegIOA)
	if got := a.ReadSelected(); got != 0xFF {
		t.Errorf("ReadSelected input-mode IOA = %02X, want FF", got)
	}
}
