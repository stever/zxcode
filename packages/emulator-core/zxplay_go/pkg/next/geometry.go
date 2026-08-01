package next

// Per-mode frame geometry, transcribed from the FPGA's video timing
// constant table (video/zxula_timing.vhd:146-311). The zxula_timing
// entity selects one row of constants from (i_timing, i_50_60) and runs
// the 7 MHz hc/vc counters against it: hc counts 0..c_max_hc per line
// (zxula_timing.vhd:314-327), vc counts 0..c_max_vc lines per frame
// (:329-343). Two 7 MHz hc ticks = one 3.5 MHz T-state, so a line is
// (c_max_hc+1)/2 T-states and a frame Lines*(c_max_hc+1)/2 T-states.
//
// The selected row is the EFFECTIVE timing (eff_nr_03_machine_timing /
// eff_nr_05_5060), latched from the guest-written NR$03/NR$05 values
// once per frame at vsync — "changes to video timing occur during
// vsync" (zxnext.vhd:6693-6706). WireFrameGeometry models that latch:
// NR writes retune the mirrors immediately, and the CPU samples its
// INT timing / frame budget at each frame origin (z80.ExecuteFrame),
// so the new geometry takes effect from the next frame.
type FrameGeometry struct {
	// HCounts is the number of 7 MHz hc ticks per scanline
	// (c_max_hc+1): 456 for 128K/+3 timing (c_max_hc=455,
	// zxula_timing.vhd:196/:230), 448 for 48K and Pentagon (c_max_hc=447,
	// :262/:290/:160).
	HCounts int
	// Lines is the number of scanlines per frame (c_max_vc+1):
	// 311 (128K/+3 50 Hz, :204), 312 (48K 50 Hz, :270), 264 (any
	// 60 Hz, :238/:298), 320 (Pentagon, :168).
	Lines int
	// IntH / IntV are the (hc, vc) coordinate at which the frame INT
	// pulse asserts (c_int_h / c_int_v — the int_ula process compares
	// hc/vc against them, zxula_timing.vhd:547-555).
	IntH, IntV int
	// MinVActive is the first paper scanline (c_min_vactive, the
	// 256x192 active area's top row): 64 at 50 Hz (:203/:269),
	// 40 at 60 Hz (:237/:297), 80 on Pentagon (:167). The paper-
	// relative cvc counter resets to the copper offset when vc
	// reaches it (:458-468).
	MinVActive int
	// PulseTstates is the frame-INT pulse width in CPU cycles:
	// 32 for 48K/+3 timing, 36 for 128K/Pentagon
	// (zxnext.vhd:2013-2033, pulse_count_end).
	PulseTstates int
}

// TStatesPerLine is the scanline length in 3.5 MHz T-states
// ((c_max_hc+1)/2): 228 for 128K/+3, 224 for 48K/Pentagon.
func (g FrameGeometry) TStatesPerLine() int { return g.HCounts / 2 }

// FrameTStates is the frame length in 3.5 MHz T-states:
// 70908 (128K/+3 50 Hz), 69888 (48K 50 Hz), 71680 (Pentagon),
// 60192 (128K/+3 60 Hz), 59136 (48K 60 Hz).
func (g FrameGeometry) FrameTStates() int { return g.Lines * g.HCounts / 2 }

// IntAssertTstate is the frame-relative T-state (3.5 MHz, origin
// hc=0/vc=0) of the frame-INT pulse: (c_int_v*(c_max_hc+1)+c_int_h)/2.
func (g FrameGeometry) IntAssertTstate() int { return (g.IntV*g.HCounts + g.IntH) / 2 }

// PaperStartTstate is the frame-relative T-state at which the memory-
// contention paper window opens on paper row 0. It keeps the anchor
// relation validated against the reference emulator for the +3 boot
// timing (#175: INT asserts at t=291 and paper row 0 contends 63 full
// lines later, 291 + 63*228 = 14655): the window opens on line
// c_min_vactive at the same horizontal phase as the INT column, i.e.
// (c_min_vactive*(c_max_hc+1) + c_int_h)/2.
func (g FrameGeometry) PaperStartTstate() int { return (g.MinVActive*g.HCounts + g.IntH) / 2 }

// FrameGeometryFor maps the NR$03 machine-timing field (bits 2:0) and
// the NR$05 bit-2 50/60 Hz selection to the FPGA's frame geometry row.
//
// Decode priority matches the VHDL exactly (zxula_timing.vhd:150-311):
// i_timing(2)=1 selects Pentagon regardless of the low bits, else
// i_timing(1)=1 selects 128K/+3 (i_timing(0) picks the c_int_h flavour),
// else 48K. Pentagon has a single row — i_50_60 is not consulted (and
// the stored NR$05 flag itself is forced to 0 while Pentagon timing is
// selected, zxnext.vhd:5834-5836; WireFrameGeometry mirrors that).
func FrameGeometryFor(nr03MachineTiming byte, sixtyHz bool) FrameGeometry {
	t := nr03MachineTiming & 0x07
	switch {
	case t&0x04 != 0:
		// Pentagon (zxula_timing.vhd:150-176): c_max_hc=447,
		// c_int_h=448+3-12=439, c_int_v=319, c_max_vc=319,
		// c_min_vactive=80. Always 50 Hz.
		return FrameGeometry{HCounts: 448, Lines: 320, IntH: 439, IntV: 319,
			MinVActive: 80, PulseTstates: 36}
	case t&0x02 != 0:
		// 128K/+3 (zxula_timing.vhd:178-246): c_max_hc=455;
		// c_int_h = 136+4-12=128 (128K, t=010) or 136+2-12=126
		// (+3, t=011).
		intH := 128
		pulse := 36
		if t&0x01 != 0 {
			intH = 126
			pulse = 32
		}
		if sixtyHz {
			// 60 Hz (:216-244): c_int_v=0, c_max_vc=263,
			// c_min_vactive=40.
			return FrameGeometry{HCounts: 456, Lines: 264, IntH: intH, IntV: 0,
				MinVActive: 40, PulseTstates: pulse}
		}
		// 50 Hz (:180-214): c_int_v=1, c_max_vc=310, c_min_vactive=64.
		return FrameGeometry{HCounts: 456, Lines: 311, IntH: intH, IntV: 1,
			MinVActive: 64, PulseTstates: pulse}
	default:
		// 48K (zxula_timing.vhd:248-311): c_max_hc=447,
		// c_int_h=128+0-12=116, c_int_v=0.
		if sixtyHz {
			// 60 Hz (:280-306): c_max_vc=263, c_min_vactive=40.
			return FrameGeometry{HCounts: 448, Lines: 264, IntH: 116, IntV: 0,
				MinVActive: 40, PulseTstates: 32}
		}
		// 50 Hz (:252-278): c_max_vc=311, c_min_vactive=64.
		return FrameGeometry{HCounts: 448, Lines: 312, IntH: 116, IntV: 0,
			MinVActive: 64, PulseTstates: 32}
	}
}
