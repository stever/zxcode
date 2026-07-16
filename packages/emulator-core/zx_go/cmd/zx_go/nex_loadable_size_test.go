package main

import (
	"os"
	"testing"
)

// nexLoadableSize must report the loader-visible byte count, not the file
// size: self-streaming games append payload .nexload never reads, and a
// loadBytes taken from the file size would park the launch macro's
// waitLoad step (and the loading ring) against a transfer that never
// comes.
func TestNexLoadableSize(t *testing.T) {
	// The test fixture: header + one bank, no screens — fully loadable.
	min := minimalNex([]byte{0x00})
	if got := nexLoadableSize(min); got != len(min) {
		t.Fatalf("minimalNex loadable = %d, want %d", got, len(min))
	}

	// Unparseable data falls back to its own length.
	junk := make([]byte, 1000)
	if got := nexLoadableSize(junk); got != 1000 {
		t.Fatalf("junk loadable = %d, want 1000", got)
	}

	// A synthetic append-payload file: minimalNex plus a huge appendix.
	// The loadable size must stay the header+bank prefix.
	appended := append(append([]byte{}, min...), make([]byte, 1<<20)...)
	if got := nexLoadableSize(appended); got != len(min) {
		t.Fatalf("appended loadable = %d, want %d", got, len(min))
	}

	// The real-world case when the file is present locally: Atic Atac's
	// 111MB .nex is 3 banks + screens + a ~111MB streaming appendix.
	data, err := os.ReadFile("/home/steve/Downloads/ZX Spectrum Next/Atic Atac/ATICATAC.NEX")
	if err != nil {
		t.Skipf("no local Atic Atac: %v", err)
	}
	got := nexLoadableSize(data)
	if got >= 1<<20 {
		t.Fatalf("Atic Atac loadable = %d, want well under 1MB (banks+screens only)", got)
	}
	t.Logf("Atic Atac: file %d bytes, loadable %d", len(data), got)
}
