package ula

// Unit pins for the #183 stage-2 half-pixel ULA row: NR$68 bit 2
// fine-scroll-X as a +1 half-pixel shift in the barrel-shifter source
// map (zxula.vhd:199 px(8), :353 scroll_0 <= px(2:0) & px(8), applied
// at the 32-bit shift-register load :395), and copper MOVE palette
// visibility at half-pixel granularity — one MOVE per 2 copper cycles =
// one 14 MHz half-pixel (copper.vhd:100-109), each half-pixel's colour
// resolved through its own palette lookup (the sc(0)-multiplexed BRAM,
// zxnext.vhd:6981) with a write visible on the next lookup
// (opposite-edge read/write clocking, zxnext.vhd:6969-6977).

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/keyboard"
	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/next/copper"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// halfPaperPixel reads OUTPUT half-pixel hx of paper row y: the 640-wide
// Next frame puts the paper's left edge at output column 2*BorderLeft.
func halfPaperPixel(u *ULA, hx, y int) (r, g, b, a byte) {
	off := (NextBorderTop+y)*u.img.Stride + (2*BorderLeft+hx)*4
	return u.img.Pix[off], u.img.Pix[off+1], u.img.Pix[off+2], u.img.Pix[off+3]
}

// TestULAFineScrollXHalfPixelShift pins fine-scroll-X = +1 half-pixel:
// with NR$26 scroll (20,12) a lone ink pixel at source (26,100) renders
// at display pixel 6 — output half-pixels 12-13. Setting NR$68 bit 2
// adds one to the 14 MHz barrel-shift amount, moving the content LEFT
// by exactly one half-pixel: the ink now covers halves 11-12.
func TestULAFineScrollXHalfPixelShift(t *testing.T) {
	u, _, mem := newNextVideoULA(t)
	page := mem.GetPage(mem.ScreenPage)
	page[screenAddrForRowCol(100, 3)] = 0x20 // one ink pixel at source x=26
	page[0x1800+(100>>3)*32+3] = 0x17        // ink 7, paper 2
	u.SetULAScroll(20, 12)                   // display (6,88) -> source (26,100)

	u.Render()
	for hx, want := range map[int]byte{11: 18, 12: 7, 13: 7, 14: 18} {
		if r, _, _, _ := halfPaperPixel(u, hx, 88); r != want {
			t.Errorf("fine off: half %d = idx %d, want %d", hx, r, want)
		}
	}

	u.SetULAFineScrollX(true)
	u.Render()
	for hx, want := range map[int]byte{10: 18, 11: 7, 12: 7, 13: 18} {
		if r, _, _, _ := halfPaperPixel(u, hx, 88); r != want {
			t.Errorf("fine on: half %d = idx %d, want %d (+1 half-pixel left shift)", hx, r, want)
		}
	}
}

// halfPixelPaletteMock is liveULAMock with a mutation generation in the
// G channel: the copper's MOVE (via the RegWriter below) bumps gen, so
// each rendered half-pixel records WHICH palette state its own lookup
// saw.
type halfPixelPaletteMock struct {
	liveULAMock
	gen byte
}

func (m *halfPixelPaletteMock) ULARGBA(idx byte) (byte, byte, byte, bool) {
	return idx, m.gen, 0xCD, false
}

type genBumpWriter struct{ m *halfPixelPaletteMock }

func (w genBumpWriter) WriteReg(reg, val byte) { w.m.gen++ }

// newHalfPixelCopperULA builds a Next-composited ULA with the REAL
// cycle-paced copper carrying the given instruction words, started in
// mode 01 (run once from 0).
func newHalfPixelCopperULA(t *testing.T, words []uint16) (*ULA, *halfPixelPaletteMock) {
	t.Helper()
	dir := t.TempDir()
	createTestROMs(t, dir)
	mem, err := memory.New(dir, roms.Model48K)
	if err != nil {
		t.Fatalf("memory.New: %v", err)
	}
	u := New(mem, keyboard.New())
	m := &halfPixelPaletteMock{}
	u.SetNextCompositor(m)
	c := copper.New()
	c.SetRegWriter(genBumpWriter{m})
	c.SetWritePtrLow(0)
	for _, w := range words {
		c.WriteData(byte(w >> 8))
		c.WriteData(byte(w))
	}
	c.SetWritePtrLow(0)
	c.SetWritePtrHighAndMode(0x40) // mode 01: run once from instruction 0
	u.SetNextCopper(c)
	return u, m
}

// TestCopperMoveLandsOnHalfPixel pins the MOVE write's visibility grain:
// WAIT(line 50, X=4) releases at hcount (4<<3)+12 = 44 — display pixel
// 32 — and the immediately following MOVE's write is visible from that
// pixel's EVEN half-pixel (output half 64) onward. Interposing two
// NOOPs (2 copper cycles = one half-pixel, copper.vhd:104) delays the
// landing by exactly ONE half-pixel: visible from output half 65.
func TestCopperMoveLandsOnHalfPixel(t *testing.T) {
	const wait50x4 = 0x8000 | 4<<9 | 50
	const move = 0x0155 // MOVE NR$01, $55 (any nonzero reg: bumps gen)
	const noop = 0x0000
	const halt = 0xFFFF

	t.Run("immediate MOVE lands on the even half", func(t *testing.T) {
		u, _ := newHalfPixelCopperULA(t, []uint16{wait50x4, move, halt})
		u.Render()
		for hx, want := range map[int]byte{62: 0, 63: 0, 64: 1, 65: 1} {
			if _, g, _, _ := halfPaperPixel(u, hx, 50); g != want {
				t.Errorf("half %d saw palette generation %d, want %d", hx, g, want)
			}
		}
		// The row above never sees the write.
		if _, g, _, _ := halfPaperPixel(u, 300, 49); g != 0 {
			t.Errorf("row 49 saw generation %d, want 0", g)
		}
	})

	t.Run("two NOOPs delay the MOVE one half-pixel", func(t *testing.T) {
		u, _ := newHalfPixelCopperULA(t, []uint16{wait50x4, noop, noop, move, halt})
		u.Render()
		for hx, want := range map[int]byte{63: 0, 64: 0, 65: 1, 66: 1} {
			if _, g, _, _ := halfPaperPixel(u, hx, 50); g != want {
				t.Errorf("half %d saw palette generation %d, want %d", hx, g, want)
			}
		}
	})
}

// Compile-time: the real copper provides the fast-stride peek the walk
// keys on (#183 Option C).
var _ interface {
	CanRetireOnLine(vcount uint16) bool
} = (*copper.Copper)(nil)
