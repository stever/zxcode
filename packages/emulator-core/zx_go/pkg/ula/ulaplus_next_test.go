package ula

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/keyboard"
	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/next"
	"github.com/conorarmstrong/zx_go/pkg/next/nextregs"
	"github.com/conorarmstrong/zx_go/pkg/next/palette"
	"github.com/conorarmstrong/zx_go/pkg/roms"
	"github.com/conorarmstrong/zx_go/pkg/z80"
)

// ULA+ ports $BF3B/$FF3B (#158 Axis 4). FPGA truth:
//
//   - $BF3B write: bits 7:6 select the group; the palette group (00)
//     also latches the 6-bit palette index (zxnext.vhd:4528-4536).
//     $BF3B reads $00 (decoded, no data source).
//   - $FF3B palette-group write: the GGGRRRBB byte swizzles to
//     RRRGGGBB (:4746) and lands as a 9-bit value (or-blue, :4919) in
//     ULA-palette entry 192+index (:6958), first/second selected by
//     NR$43's write-select bit 2.
//   - $FF3B palette-group read: the entry swizzled back
//     (dat(5:3) & dat(8:6) & dat(2:1), :4563).
//   - $FF3B mode-group (01) write bit 0 drives the LIVE ULA+ enable
//     (:4548-4549) — the same latch every NR$68 write's bit 3 sets
//     (:4550-4551) and NR$68's read bit 3 composes (:6093).
//   - Reset clears mode/index/enable (:4529-4530, :4547).

func newULAPlusStack(t *testing.T) (*ULA, *nextregs.Dispatcher, *palette.Bank, *memory.Memory) {
	t.Helper()
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	u := New(mem, keyboard.New())
	cpu := z80.New(mem, u)
	d := nextregs.New()
	u.SetNextRegs(d)
	bank := palette.NewBank()
	next.Wire(next.WireOpts{
		Dispatcher: d,
		Memory:     mem,
		CPU:        cpu,
		Palette:    bank,
		ULANext:    u,
	})
	return u, d, bank, mem
}

func TestULAPlusPaletteWriteReadSwizzle(t *testing.T) {
	u, _, bank, _ := newULAPlusStack(t)

	// Palette group, index 5.
	u.WritePort(0xBF3B, 0x05)
	// GGGRRRBB $E7: G=7, R=1, B=3 → 9-bit RRRGGGBBB = 001 111 111 = $07F.
	u.WritePort(0xFF3B, 0xE7)
	if got := bank.Palette(int(palette.PaletteULAFirst)).Get(0xC5); got != 0x07F {
		t.Errorf("ULA-first entry $C5 = $%03X, want $07F (swizzle vhd:4746 + or-blue :4919)", got)
	}
	// Read-back swizzles the entry back to GGGRRRBB.
	if got, _ := u.ReadPort(0xFF3B); got != 0xE7 {
		t.Errorf("$FF3B read-back = $%02X, want $E7 (vhd:4563)", got)
	}
	// $BF3B reads $00 — decoded (claims the bus) but no data source.
	if got, handled := u.ReadPort(0xBF3B); !handled || got != 0x00 {
		t.Errorf("$BF3B read = $%02X handled=%v, want $00 handled", got, handled)
	}
}

func TestULAPlusPaletteTargetsWriteSelectULAHalf(t *testing.T) {
	u, d, bank, _ := newULAPlusStack(t)

	// NR$43 write-select = ULA second (wsel bit 2 → NR$43 bit 6).
	d.WriteReg(0x43, 0x40)
	u.WritePort(0xBF3B, 0x00)
	u.WritePort(0xFF3B, 0x1C) // G=0,R=7,B=0 → 111 000 000 = $1C0
	if got := bank.Palette(int(palette.PaletteULASecond)).Get(0xC0); got != 0x1C0 {
		t.Errorf("ULA-second entry $C0 = $%03X, want $1C0 (vhd:6958 wsel(2) selects the half)", got)
	}
	if got := bank.Palette(int(palette.PaletteULAFirst)).Get(0xC0); got == 0x1C0 {
		t.Errorf("ULA-first entry $C0 also written — write-select ignored")
	}
}

func TestULAPlusModeGroupAndNR68ShareTheEnableLatch(t *testing.T) {
	u, d, _, _ := newULAPlusStack(t)

	// Mode group: enable via the port.
	u.WritePort(0xBF3B, 0x40)
	u.WritePort(0xFF3B, 0x01)
	if !u.ULAPlusEnabled() {
		t.Fatalf("mode-group write $01: ULA+ not enabled (vhd:4548-4549)")
	}
	if got := d.ReadReg(0x68) & 0x08; got == 0 {
		t.Errorf("NR$68 read bit 3 clear after port enable, want set (vhd:6093)")
	}
	// Mode-group read reflects the latch.
	if got, _ := u.ReadPort(0xFF3B); got != 0x01 {
		t.Errorf("$FF3B mode-group read = $%02X, want $01 (vhd:4566)", got)
	}
	// EVERY NR$68 write drives the latch from its bit 3 (vhd:4550-4551):
	// a write with bit 3 clear disables ULA+.
	d.WriteReg(0x68, 0x00)
	if u.ULAPlusEnabled() {
		t.Errorf("NR$68=$00 left ULA+ enabled, want disabled (vhd:4550-4551)")
	}
	d.WriteReg(0x68, 0x08)
	if !u.ULAPlusEnabled() {
		t.Errorf("NR$68=$08 did not enable ULA+ (vhd:4550-4551)")
	}
	if got := d.ReadReg(0x68); got != 0x08 {
		t.Errorf("NR$68 read = $%02X, want $08 (bit 3 = live latch)", got)
	}
}

func TestULAPlusResetClearsLatches(t *testing.T) {
	u, d, _, _ := newULAPlusStack(t)

	u.WritePort(0xBF3B, 0x40)
	u.WritePort(0xFF3B, 0x01)
	if !u.ULAPlusEnabled() {
		t.Fatalf("precondition: ULA+ enabled")
	}
	d.WriteReg(0x02, 0x01) // soft reset
	if u.ULAPlusEnabled() {
		t.Errorf("soft reset left ULA+ enabled, want cleared (vhd:4547)")
	}
	// Mode group reset to palette (00): a $FF3B write now writes the
	// palette (index 0), not the enable latch.
	u.WritePort(0xFF3B, 0x00)
	if u.ULAPlusEnabled() {
		t.Errorf("post-reset $FF3B write re-enabled ULA+ — mode group not reset (vhd:4529)")
	}
}

// TestULAPlusBorderDecode pins the border palette index under ULA+:
// the border attribute is "00" & border & border (zxula.vhd:418),
// decoded through the ULA+ paper path (:531-541) → entry $C8+border.
func TestULAPlusBorderDecode(t *testing.T) {
	u, _, _, _ := newULAPlusStack(t)
	res := &captureResolver{}
	st := ulaVideoState{ulaPlusEnabled: true}
	u.nextBorderColourRGBA(3, res, st)
	if res.last != 0xC8+3 {
		t.Errorf("ULA+ border index = $%02X, want $%02X", res.last, 0xC8+3)
	}
}

type captureResolver struct{ last byte }

func (c *captureResolver) ULARGBA(idx byte) (byte, byte, byte, bool) {
	c.last = idx
	return 0, 0, 0, false
}
