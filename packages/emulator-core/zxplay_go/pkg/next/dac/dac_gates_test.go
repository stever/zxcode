package dac

import "testing"

// The DAC decode personalities follow the internal port enables
// (zxnext.vhd:2437-2443) and the NR$08 bit-3 master gate (:2461);
// per-channel alias composition is port_dac_A/B/C/D (:2657-2664).
func TestDecodeGates(t *testing.T) {
	b := New()
	enabled := map[uint]bool{}
	dacOn := true
	b.SetDecodeGates(
		func(bit uint) bool { return enabled[bit] },
		func() bool { return dacOn },
	)

	all := func(on bool) {
		for bit := uint(17); bit <= 23; bit++ {
			enabled[bit] = on
		}
	}

	// Master gate off: nothing decodes even fully enabled.
	all(true)
	dacOn = false
	if b.WritePort(0xDF, 0x40) {
		t.Fatal("$DF decoded with the NR$08 DAC gate off")
	}
	dacOn = true

	// SpecDrum $DF → A+D under bit 23 alone.
	all(false)
	enabled[enMonoDF] = true
	if !b.WritePort(0xDF, 0x40) {
		t.Fatal("$DF not decoded with bit 23 set")
	}
	if b.Level(ChannelA) != 0x40 || b.Level(ChannelD) != 0x40 {
		t.Fatalf("$DF → A=%02X D=%02X, want 40/40", b.Level(ChannelA), b.Level(ChannelD))
	}

	// $FB: soundrive-2 has precedence (D only); with sd2 off the
	// mono-AD personality takes it A+D; with both off it is nobody's.
	b.Reset()
	all(false)
	enabled[enSD2] = true
	enabled[enMonoFB] = true
	b.WritePort(0xFB, 0x33)
	if b.Level(ChannelA) != 0 || b.Level(ChannelD) != 0x33 {
		t.Fatalf("$FB with sd2 on → A=%02X D=%02X, want 00/33 (sd2 precedence)",
			b.Level(ChannelA), b.Level(ChannelD))
	}
	enabled[enSD2] = false
	b.WritePort(0xFB, 0x44)
	if b.Level(ChannelA) != 0x44 || b.Level(ChannelD) != 0x44 {
		t.Fatalf("$FB with sd2 off → A=%02X D=%02X, want 44/44 (mono AD)",
			b.Level(ChannelA), b.Level(ChannelD))
	}
	enabled[enMonoFB] = false
	if b.WritePort(0xFB, 0x55) {
		t.Fatal("$FB decoded with both its personalities off")
	}

	// $0F: served by soundrive-1 OR covox-stereo — either bit alone.
	b.Reset()
	all(false)
	enabled[enStBC] = true
	if !b.WritePort(0x0F, 0x66) || b.Level(ChannelB) != 0x66 {
		t.Fatal("$0F not decoded under the covox-stereo bit alone")
	}
	all(false)
	enabled[enSD1] = true
	if !b.WritePort(0x0F, 0x77) || b.Level(ChannelB) != 0x77 {
		t.Fatal("$0F not decoded under the soundrive-1 bit alone")
	}

	// nil gates (power-on wiring): everything decodes.
	b2 := New()
	if !b2.WritePort(0xDF, 0x11) || b2.Level(ChannelA) != 0x11 {
		t.Fatal("ungated bank must keep the power-on decode")
	}
}
