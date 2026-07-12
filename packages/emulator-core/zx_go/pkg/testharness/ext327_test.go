package testharness

import (
	"path/filepath"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/install/installtest"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// These tests run the vendored .nex builds from
// Threetwosevensixseven/ZXSpectrumNextTests (MIT; provenance and licence
// in testdata/ext327/). All four are builds of the same DMACopy.asm in
// its four modes; the DMA modes must produce byte-identical memory
// results to the LDIR ground-truth modes. Each mode signs its run so a
// pass is unambiguous: border black = DMA ran, border blue = LDIR ran,
// and the fill modes use different attribute bytes (0x46 DMA, 0x42 LDIR).
//
// The programs are fully self-contained (org $8000, DI, own IM2 vector
// table, no OS calls), so they run on the harness Next with a fake
// distro ROM — no licensed assets, which keeps these live in CI. The
// conformance dashboard resolves the ext-327 DMACopy row from these
// tests (conformance/manifest.json).

const (
	ext327Pixels   = 0x1800 // ULA bitmap $4000-$57FF
	ext327Attrs    = 0x0300 // ULA attributes $5800-$5AFF
	ext327CopyLen  = 0x1B00 // bitmap + attributes, copied from $C000
	ext327BorderDM = 0      // black border = the DMA path executed
	ext327BorderLD = 1      // blue border = the LDIR path executed
)

func runExt327(t *testing.T, name string) *Harness {
	t.Helper()
	installtest.RedirectConfig(t)
	installFakeDistroForLoad(t)
	h, err := New(roms.ModelNext)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.CloseFiles)
	if err := h.LoadNEX(filepath.Join("testdata", "ext327", name)); err != nil {
		t.Fatal(err)
	}
	// The fill/copy runs long before the first frame ends; a few extra
	// frames prove the program settled into its HALT loop rather than
	// crashing into stray memory.
	h.RunFrames(5)
	return h
}

func assertExt327Fill(t *testing.T, h *Harness, wantAttr, wantBorder byte) {
	t.Helper()
	for i := 0; i < ext327Pixels; i++ {
		if got := h.Memory(uint16(0x4000 + i)); got != 0xAA {
			t.Fatalf("bitmap byte $%04X = %#02x, want 0xAA", 0x4000+i, got)
		}
	}
	for i := 0; i < ext327Attrs; i++ {
		if got := h.Memory(uint16(0x5800 + i)); got != wantAttr {
			t.Fatalf("attr byte $%04X = %#02x, want %#02x", 0x5800+i, got, wantAttr)
		}
	}
	if got := h.ULA().BorderColour; got != wantBorder {
		t.Fatalf("border = %d, want %d (the mode's signature)", got, wantBorder)
	}
}

func assertExt327Copy(t *testing.T, h *Harness, wantBorder byte) {
	t.Helper()
	blank := true
	for i := 0; i < ext327CopyLen; i++ {
		src := h.Memory(uint16(0xC000 + i))
		dst := h.Memory(uint16(0x4000 + i))
		if src != dst {
			t.Fatalf("copy mismatch at offset $%04X: screen $%04X = %#02x, source $%04X = %#02x",
				i, 0x4000+i, dst, 0xC000+i, src)
		}
		if src != 0 {
			blank = false
		}
	}
	if blank {
		t.Fatal("source screen at $C000 is all zero — the .nex banks did not load")
	}
	if got := h.ULA().BorderColour; got != wantBorder {
		t.Fatalf("border = %d, want %d (the mode's signature)", got, wantBorder)
	}
}

// TestExt327LDIRFill establishes the ground truth: the CPU-driven fill.
func TestExt327LDIRFill(t *testing.T) {
	h := runExt327(t, "LDIRFill.nex")
	assertExt327Fill(t, h, 0x42, ext327BorderLD)
}

// TestExt327DMAFill is the conformance claim: the zxnDMA fill must leave
// memory in the same state the LDIR fill does (attribute byte aside —
// the test program uses it to sign which path ran).
func TestExt327DMAFill(t *testing.T) {
	h := runExt327(t, "DMAFill.nex")
	assertExt327Fill(t, h, 0x46, ext327BorderDM)
}

func TestExt327LDIRCopy(t *testing.T) {
	h := runExt327(t, "LDIRCopy.nex")
	assertExt327Copy(t, h, ext327BorderLD)
}

func TestExt327DMACopy(t *testing.T) {
	h := runExt327(t, "DMACopy.nex")
	assertExt327Copy(t, h, ext327BorderDM)
}
