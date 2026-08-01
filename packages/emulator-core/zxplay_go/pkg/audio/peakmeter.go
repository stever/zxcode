package audio

// lastPeak tracks the largest |sample| pushed to any AudioSystem since the last
// LastPeak() read. Diagnostic only (used by the wasm build to confirm the
// emulator is generating non-silent beeper audio).
var lastPeak int16

// LastPeak returns the peak |beeper sample| observed since the previous call,
// then resets the meter.
func LastPeak() int16 {
	p := lastPeak
	lastPeak = 0
	return p
}
