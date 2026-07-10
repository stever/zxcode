package dac

import "testing"

// GenerateFrame reconstructs the DAC waveform sample-accurately from timed
// writes, with the same level→amplitude mapping as the legacy MixInto.
func TestBankGenerateFrameEventTimed(t *testing.T) {
	b := New()
	// All four channels to full at t=0 (mixed level 0xFF), then silent at the
	// half-frame point.
	for _, p := range []uint16{0x0F, 0x1F, 0xF9, 0xFB} {
		b.WritePort(p, 0xFF)
	}
	b.Record(0) // mixed = 255
	for _, p := range []uint16{0x0F, 0x1F, 0xF9, 0xFB} {
		b.WritePort(p, 0x00)
	}
	b.Record(4) // mixed = 0

	const samples, tstates = 4, 8
	got := b.GenerateFrame(samples, tstates)
	hi := (int16(255) - 128) * dacMixAmplitude
	lo := (int16(0) - 128) * dacMixAmplitude
	if got[0] != hi {
		t.Errorf("sample 0 = %d, want %d (mixed 255)", got[0], hi)
	}
	if got[samples-1] != lo {
		t.Errorf("last sample = %d, want %d (mixed 0)", got[samples-1], lo)
	}
	// Next frame, no events: the held level (0) carries over.
	if g := b.GenerateFrame(samples, tstates); g[0] != lo {
		t.Errorf("carried sample 0 = %d, want %d", g[0], lo)
	}
}

// TestBankGenerateFrameCarriesEventAtBoundary verifies a write recorded exactly
// at (or past) the end of the frame's T-state span still lands: its level must
// carry into the next frame rather than being silently dropped because it fell
// outside every sample's [start, end) window this frame. Mirrors the same
// regression test in pkg/audiodac.
func TestBankGenerateFrameCarriesEventAtBoundary(t *testing.T) {
	b := New()
	for _, p := range []uint16{0x0F, 0x1F, 0xF9, 0xFB} {
		b.WritePort(p, 0x40)
	}
	b.Record(0) // mixed = 0x40

	const samples, tstates = 4, 8
	for _, p := range []uint16{0x0F, 0x1F, 0xF9, 0xFB} {
		b.WritePort(p, 0xC0)
	}
	b.Record(tstates) // exactly at the frame boundary

	b.GenerateFrame(samples, tstates)
	got := b.GenerateFrame(samples, tstates)

	want := (int16(0xC0) - 128) * dacMixAmplitude
	if got[0] != want {
		t.Errorf("level written at the frame boundary was lost: next-frame sample 0 = %d, want %d", got[0], want)
	}
}
