package memory

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// BenchmarkRead measures the CPU-visible Read path per byte, fast-path
// hit vs miss — the dispatch the Z80 pays ~5 times per instruction
// (#187: under Go-wasm the readValue cascade dominated the 28 MHz
// frame budget). "ram" hits the readFast slot cache ($8000, plain RAM
// on every model); "ramSlow" forces the pre-cache dispatch for the
// same address by installing a no-op allReadHook (the cache's global
// gate), so the hit/miss delta is the fast path's per-read saving.
// "rom" reads $0100 — slots 0-1 are never cached, so this is the
// bottom-16K overlay-cascade cost games pay for ROM/OS calls.
func BenchmarkRead(b *testing.B) {
	testDir := b.TempDir()
	createBenchROMs(b, testDir)
	for _, cfg := range []struct {
		name string
		addr uint16
		slow bool
	}{{"ram", 0x8000, false}, {"ramSlow", 0x8000, true}, {"rom", 0x0100, false}} {
		b.Run(cfg.name, func(b *testing.B) {
			mem, err := New(testDir, roms.Model128K)
			if err != nil {
				b.Fatalf("New: %v", err)
			}
			if cfg.slow {
				mem.SetAllReadHook(func(addr uint16, val byte) {})
			}
			mem.Read(cfg.addr) // populate the cache outside the loop
			b.ResetTimer()
			var v byte
			for i := 0; i < b.N; i++ {
				v = mem.Read(cfg.addr + uint16(i&0x1FFF))
			}
			_ = v
		})
	}
}

// createBenchROMs stages minimal ROM images so New succeeds without
// the real ROM set (mirrors memory_test.go's createTestROMs, which is
// *testing.T-typed and unavailable to benchmarks).
func createBenchROMs(b *testing.B, dir string) {
	b.Helper()
	for _, name := range []string{"48.rom", "128-0.rom", "128-1.rom"} {
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, PageSize), 0644); err != nil {
			b.Fatal(err)
		}
	}
}
