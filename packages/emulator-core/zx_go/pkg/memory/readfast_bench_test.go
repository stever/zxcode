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
// "rom" reads $0100 — ROM pages are never cached (only plain RAM
// mappings are, including MMU RAM in slots 0-1 since #187's bottom-16K
// extension), so this is the overlay-cascade cost of ROM/OS calls.
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

// BenchmarkReadWriteBottomMMU measures the #187 Atic Atac shape: Next
// model, game code MMU-mapped into the bottom 16K (slots 0/1). "read"/
// "write" hit the fast tables; the "Slow" variants force the pre-cache
// overlay-cascade dispatch (the cost every bottom-16K access paid
// before the bottom extension) via the value-neutral global gates.
func BenchmarkReadWriteBottomMMU(b *testing.B) {
	for _, cfg := range []struct {
		name  string
		slow  bool
		write bool
	}{{"read", false, false}, {"readSlow", true, false}, {"write", false, true}, {"writeSlow", true, true}} {
		b.Run(cfg.name, func(b *testing.B) {
			mem, err := New("", roms.ModelNext)
			if err != nil {
				b.Fatalf("New: %v", err)
			}
			mem.SetMMU(0, 16)
			mem.SetMMU(1, 17)
			if cfg.slow {
				mem.SetAllReadHook(func(addr uint16, val byte) {})
				mem.SetWriteObserver(func(addr uint16, val byte, pc uint16) {})
			}
			mem.Read(0x0100)
			mem.Write(0x0100, 0)
			b.ResetTimer()
			var v byte
			for i := 0; i < b.N; i++ {
				a := uint16(i & 0x3FFF)
				if cfg.write {
					mem.Write(a, byte(i))
				} else {
					v = mem.Read(a)
				}
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
