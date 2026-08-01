package roms

// FrameTStates returns the ULA frame length in 3.5 MHz T-states for a machine
// model: 48K = 312 lines × 224 T = 69888; the 128K family (128K/+2/+2A/+3) and
// the Spectrum Next (which boots in +3/128K timing) = 311 × 228 = 70908;
// Pentagon 128 = 320 × 224 = 71680 (no contention). Matches the per-model
// convention in z80.ExecuteFrame, the 70908 stepFrameBudget used by
// StepInstructionWithIRQ, and the FPGA frame geometry (zxula_timing.vhd
// c_max_hc/c_max_vc → (456·311)/2 = 70908). The per-frame audio waveform
// reconstruction (ULA flushAudioFrame) integrates events over exactly this
// window, so a wrong length drops end-of-frame speaker/DAC/tape events.
func (m SpectrumModel) FrameTStates() int {
	switch m {
	case Model48K:
		return 69888
	case ModelPentagon:
		return 71680
	default:
		return 70908
	}
}
