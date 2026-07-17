package next

import "testing"

// Frame-geometry conformance: FrameGeometryFor transcribes the FPGA's
// per-mode video timing constants (video/zxula_timing.vhd:146-311).
// Each row's expectations are computed directly from the VHDL constants:
//
//	tPerLine   = (c_max_hc+1)/2
//	lines      = c_max_vc+1
//	frameT     = lines * tPerLine
//	intAssert  = (c_int_v*(c_max_hc+1) + c_int_h)/2   (int at hc=c_int_h,
//	             vc=c_int_v — zxula_timing.vhd:547-555)
//	paperStart = (c_min_vactive*(c_max_hc+1) + c_int_h)/2
//	pulse      = 32 (48K/+3) / 36 (128K/Pentagon)  (zxnext.vhd:2013-2033)
func TestFrameGeometryFor(t *testing.T) {
	cases := []struct {
		name       string
		timing     byte
		sixtyHz    bool
		tPerLine   int
		lines      int
		frameT     int
		intAssert  int
		pulse      int
		minVActive int
		paperStart int
	}{
		// 48K 50 Hz (zxula_timing.vhd:252-278): c_max_hc=447,
		// c_max_vc=311, c_int_h=116, c_int_v=0, min_vactive=64.
		{"48K 50Hz t=000", 0x00, false, 224, 312, 69888, 58, 32, 64, (64*448 + 116) / 2},
		{"48K 50Hz t=001", 0x01, false, 224, 312, 69888, 58, 32, 64, 14394},
		// 48K 60 Hz (:282-306): c_max_vc=263, min_vactive=40.
		{"48K 60Hz", 0x01, true, 224, 264, 59136, 58, 32, 40, (40*448 + 116) / 2},
		// 128K 50 Hz (:180-214): c_max_hc=455, c_max_vc=310,
		// c_int_h=136+4-12=128, c_int_v=1, min_vactive=64.
		{"128K 50Hz", 0x02, false, 228, 311, 70908, 292, 36, 64, (64*456 + 128) / 2},
		// +3 50 Hz: c_int_h=136+2-12=126 (:189). The boot default:
		// paperStart must equal the reference-validated 14655 anchor
		// (pkg/memory contention, #175).
		{"+3 50Hz", 0x03, false, 228, 311, 70908, 291, 32, 64, 14655},
		// 128K/+3 60 Hz (:216-244): c_int_v=0, c_max_vc=263,
		// min_vactive=40.
		{"128K 60Hz", 0x02, true, 228, 264, 60192, 64, 36, 40, (40*456 + 128) / 2},
		{"+3 60Hz", 0x03, true, 228, 264, 60192, 63, 32, 40, (40*456 + 126) / 2},
		// Pentagon (:150-176): c_max_hc=447, c_max_vc=319,
		// c_int_h=448+3-12=439, c_int_v=319, min_vactive=80.
		// i_50_60 is not consulted (single row).
		{"Pentagon 50Hz", 0x04, false, 224, 320, 71680, 71675, 36, 80, (80*448 + 439) / 2},
		{"Pentagon 60Hz ignored", 0x04, true, 224, 320, 71680, 71675, 36, 80, (80*448 + 439) / 2},
		// Decode priority is the VHDL's if-chain (:150/:178): bit 2
		// selects Pentagon whatever the low bits.
		{"timing 101 = Pentagon", 0x05, false, 224, 320, 71680, 71675, 36, 80, 18139},
		{"timing 111 = Pentagon", 0x07, false, 224, 320, 71680, 71675, 36, 80, 18139},
		// Only bits 2:0 select (NR$03 timing field arrives pre-masked).
		{"high bits masked", 0xB3, false, 228, 311, 70908, 291, 32, 64, 14655},
	}
	for _, c := range cases {
		g := FrameGeometryFor(c.timing, c.sixtyHz)
		if got := g.TStatesPerLine(); got != c.tPerLine {
			t.Errorf("%s: TStatesPerLine = %d, want %d", c.name, got, c.tPerLine)
		}
		if g.Lines != c.lines {
			t.Errorf("%s: Lines = %d, want %d", c.name, g.Lines, c.lines)
		}
		if got := g.FrameTStates(); got != c.frameT {
			t.Errorf("%s: FrameTStates = %d, want %d", c.name, got, c.frameT)
		}
		if got := g.IntAssertTstate(); got != c.intAssert {
			t.Errorf("%s: IntAssertTstate = %d, want %d", c.name, got, c.intAssert)
		}
		if g.PulseTstates != c.pulse {
			t.Errorf("%s: PulseTstates = %d, want %d", c.name, g.PulseTstates, c.pulse)
		}
		if g.MinVActive != c.minVActive {
			t.Errorf("%s: MinVActive = %d, want %d", c.name, g.MinVActive, c.minVActive)
		}
		if got := g.PaperStartTstate(); got != c.paperStart {
			t.Errorf("%s: PaperStartTstate = %d, want %d", c.name, got, c.paperStart)
		}
	}
}

// The boot-default row (+3 timing, 50 Hz) must reproduce the legacy
// hardcoded constants EXACTLY — the boot goldens pin the whole default
// path to these values (228 T/line, 311 lines, 70908 T/frame, INT at
// t=291 for 32 T, contention paper anchor 14655).
func TestFrameGeometryDefaultMatchesLegacyConstants(t *testing.T) {
	g := FrameGeometryFor(0x03, false)
	if g.TStatesPerLine() != 228 || g.Lines != 311 || g.FrameTStates() != 70908 ||
		g.IntAssertTstate() != 291 || g.PulseTstates != 32 ||
		g.MinVActive != 64 || g.PaperStartTstate() != 14655 {
		t.Fatalf("+3 50Hz geometry drifted from the legacy constants: %+v", g)
	}
}
