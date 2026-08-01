package next

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/next/layer2"
	"github.com/stever/zxplay_go/pkg/next/nextregs"
)

// TestWireLayer2SeedsBanksFromResetDefaults pins that wiring publishes the
// register file's power-on NR$12 / NR$13 into the live Layer 2 object.
//
// nextregs.New() plants the tbblue_reset_common defaults (NR$12 = $08,
// NR$13 = $0B) straight into the backing array without going through
// write(), so the OnWrite handlers never fire at construction. Before the
// seed, a machine that booted and never wrote NR$12 read back bank 8 from
// the register file while the renderer sat on its Go zero value, bank 0 —
// and displayed ZX RAM banks 0-2 as Layer 2 (#197).
func TestWireLayer2SeedsBanksFromResetDefaults(t *testing.T) {
	d := nextregs.New()
	l2 := layer2.New(nil)

	if got := l2.ActiveBank(); got != 0 {
		t.Fatalf("precondition: fresh Layer2 active bank = %d, want 0", got)
	}

	WireLayer2(d, l2, nil)

	if got, want := l2.ActiveBank(), d.Raw(0x12); got != want {
		t.Errorf("active bank after wiring = %d, want NR$12 default %d", got, want)
	}
	if got, want := l2.ShadowBank(), d.Raw(0x13); got != want {
		t.Errorf("shadow bank after wiring = %d, want NR$13 default %d", got, want)
	}
	if got := l2.ActiveBank(); got != 0x08 {
		t.Errorf("active bank = %d, want the FPGA reset default 8", got)
	}
	if got := l2.ShadowBank(); got != 0x0B {
		t.Errorf("shadow bank = %d, want the FPGA reset default 11", got)
	}
}
