package testharness

import (
	"path/filepath"
	"testing"

	"github.com/stever/zxplay_go/pkg/next/install/installtest"
	"github.com/stever/zxplay_go/pkg/roms"
)

// BenchmarkNextRender measures the live Next render path (the
// applyNextCompositor walk + the wide passes) — the performance gate
// for the #183 per-half-pixel pipeline work. Three scenes:
//
//   - CopperIdle: Graphics/Layer2Colours — every layer active
//     (L2 + sprites + ULA, raster-stamped NR$15 bands), NO copper
//     program. The fast-stride case: this scene must stay at
//     (near) its baseline through every pipeline stage.
//   - CopperHeavy: base/Copper — ~1011 copper instructions live
//     per frame, per-pixel RunToCycle interleave across the paper.
//     The slow-stride (event-paced) case.
//   - HiRes: Graphics/LayersMixingHiRes — stable Timex hi-res, the
//     512-half-pixel re-composite (renderWideTimexHiRes before the
//     unification, the fused 640-wide path after).
//
// Each iteration is one full re-render of the settled scene (the
// harness "stale render" path — no CPU execution, so the timing
// isolates the render walk; the copper still runs its per-line
// cycle pacing inside it).
func BenchmarkNextRender(b *testing.B) {
	scenes := []struct {
		name   string
		snx    string
		frames int
	}{
		{"CopperIdle", "L2Colour.snx", 200},
		{"CopperHeavy", "Copper.snx", 200},
		{"HiRes", "LmxHiRes.snx", 200},
	}
	for _, sc := range scenes {
		b.Run(sc.name, func(b *testing.B) {
			installtest.RedirectConfig(b)
			installFakeDistroForLoad(b)
			h, err := New(roms.ModelNext)
			if err != nil {
				b.Fatal(err)
			}
			b.Cleanup(h.CloseFiles)
			if err := h.LoadSnapshot(filepath.Join("testdata", "nexttests", sc.snx)); err != nil {
				b.Fatal(err)
			}
			h.RunFrames(sc.frames)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				h.ULA().Render()
			}
		})
	}
}
