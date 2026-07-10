package roms

import "testing"

// TestFrameTStates pins the per-model ULA frame lengths the audio
// reconstruction depends on. A wrong value here drops end-of-frame
// speaker events (heard as a 50Hz buzz on sustained tones).
func TestFrameTStates(t *testing.T) {
	cases := []struct {
		model SpectrumModel
		want  int
	}{
		{Model48K, 69888},  // 312 lines x 224 T
		{Model128K, 70908}, // 311 x 228
		{ModelPlus2, 70908},
		{ModelPlus2A, 70908},
		{ModelPlus3, 70908},
		{ModelNext, 70908},     // boots in +3/128K timing
		{ModelPentagon, 71680}, // 320 x 224, no contention
	}
	for _, c := range cases {
		if got := c.model.FrameTStates(); got != c.want {
			t.Errorf("%s: FrameTStates() = %d, want %d", GetModelName(c.model), got, c.want)
		}
	}
}
