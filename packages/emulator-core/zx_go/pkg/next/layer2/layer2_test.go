package layer2

import "testing"

// fakeBanks is a fixed-size 256-bank fake BankReader, with bank 0
// initialised to a recognisable pattern: bank[i].byte[j] = (i*256+j) & 0xFF
// so cross-bank reads can be verified.
type fakeBanks struct {
	banks [256][16384]byte
}

func (f *fakeBanks) GetPage(bank int) []byte {
	if bank < 0 || bank >= 256 {
		return nil
	}
	return f.banks[bank][:]
}

func newFakeBanks() *fakeBanks {
	f := &fakeBanks{}
	for b := 0; b < 256; b++ {
		for j := 0; j < 16384; j++ {
			f.banks[b][j] = byte((b*7 + j) & 0xFF) // distinctive per-bank pattern
		}
	}
	return f
}

func TestLayer2DisabledFillsZeros(t *testing.T) {
	f := newFakeBanks()
	l := New(f)
	l.SetActiveBank(9) // some non-zero bank
	dst := make([]byte, Width)
	for i := range dst {
		dst[i] = 0xFF
	}
	l.RenderScanline(0, dst)
	for i, b := range dst {
		if b != 0 {
			t.Errorf("dst[%d] = %#x after disabled render, want 0", i, b)
			break
		}
	}
}

func TestLayer2RenderScanlineCopiesFromActiveBank(t *testing.T) {
	f := newFakeBanks()
	l := New(f)
	l.SetActiveBank(9)
	l.SetEnabled(true)

	// Row 0: bank 9, offset 0, 256 bytes.
	dst := make([]byte, Width)
	l.RenderScanline(0, dst)
	for i := 0; i < Width; i++ {
		want := byte((9*7 + i) & 0xFF)
		if dst[i] != want {
			t.Errorf("row 0 col %d: got %#x, want %#x", i, dst[i], want)
		}
	}

	// Row 64: spills into bank 10, offset 0.
	l.RenderScanline(64, dst)
	for i := 0; i < Width; i++ {
		want := byte((10*7 + i) & 0xFF)
		if dst[i] != want {
			t.Errorf("row 64 col %d: got %#x, want %#x", i, dst[i], want)
			break
		}
	}

	// Row 128: bank 11.
	l.RenderScanline(128, dst)
	for i := 0; i < Width; i++ {
		want := byte((11*7 + i) & 0xFF)
		if dst[i] != want {
			t.Errorf("row 128 col %d: got %#x, want %#x", i, dst[i], want)
			break
		}
	}
}

func TestLayer2RenderScanlineRejectsBadInputs(t *testing.T) {
	f := newFakeBanks()
	l := New(f)
	l.SetEnabled(true)
	dst := make([]byte, Width)

	// Y out of range — no-op.
	for _, y := range []int{-1, Height, 1000} {
		for i := range dst {
			dst[i] = 0xAB
		}
		l.RenderScanline(y, dst)
		for _, b := range dst {
			if b != 0xAB {
				t.Errorf("RenderScanline(y=%d) modified dst", y)
				break
			}
		}
	}

	// Short dst — no-op.
	short := make([]byte, 10)
	l.RenderScanline(0, short)
}

func TestLayer2SetActiveBankMasksHighBit(t *testing.T) {
	l := New(newFakeBanks())
	l.SetActiveBank(0xFF)
	if l.ActiveBank() != 0x7F {
		t.Errorf("SetActiveBank(0xFF): ActiveBank = %#x, want 0x7F", l.ActiveBank())
	}
}

func TestLayer2ShadowBank(t *testing.T) {
	l := New(newFakeBanks())
	l.SetShadowBank(42)
	if l.ShadowBank() != 42 {
		t.Errorf("ShadowBank = %d, want 42", l.ShadowBank())
	}
	// Render still uses ACTIVE bank.
	l.SetEnabled(true)
	dst := make([]byte, Width)
	l.RenderScanline(0, dst)
	// Default activeBank=0; bank 0 byte 0 = 0.
	if dst[0] != 0 {
		t.Errorf("dst[0] = %#x; render should use active bank not shadow", dst[0])
	}
}

// iter 364: Enabled() getter mirrors SetEnabled().
func TestLayer2EnabledGetter(t *testing.T) {
	l := New(newFakeBanks())
	if l.Enabled() {
		t.Error("new Layer2 should be disabled by default")
	}
	l.SetEnabled(true)
	if !l.Enabled() {
		t.Error("Enabled() = false after SetEnabled(true)")
	}
	l.SetEnabled(false)
	if l.Enabled() {
		t.Error("Enabled() = true after SetEnabled(false)")
	}
}

// TestLayer2_640ColumnMajor4bpp verifies the 640×256 4bpp column-major
// render: byte(c,y)=base+c*256+y, high nibble = left pixel, low = right.
func TestLayer2_640ColumnMajor4bpp(t *testing.T) {
	f := newFakeBanks()
	l := New(f)
	l.SetEnabled(true)
	l.SetResolution(2) // 640×256 4bpp
	l.SetActiveBank(0)
	if l.LineWidth() != 640 || l.LineHeight() != 256 {
		t.Fatalf("dims = %d×%d, want 640×256", l.LineWidth(), l.LineHeight())
	}
	dst := make([]byte, 640)
	l.RenderScanline(171, dst)
	// Col 0, y=171: byte=(0*7+171)&0xFF=0xAB → pixels 0xA, 0xB.
	if dst[0] != 0xA || dst[1] != 0xB {
		t.Errorf("col 0: dst[0,1]=%#x,%#x, want 0xA,0xB", dst[0], dst[1])
	}
	// Col 64 (bank 1), y=171: byte=(1*7+171)&0xFF=0xB2 → 0xB, 0x2.
	if dst[128] != 0xB || dst[129] != 0x2 {
		t.Errorf("col 64: dst[128,129]=%#x,%#x, want 0xB,0x2", dst[128], dst[129])
	}
}

// TestLayer2_PaletteOffset640 verifies the NR$70 palette offset is added
// to each pixel's high nibble (FPGA layer2.vhd:203).
func TestLayer2_PaletteOffset640(t *testing.T) {
	f := newFakeBanks()
	l := New(f)
	l.SetEnabled(true)
	l.SetResolution(2) // 640×256 4bpp
	l.SetPaletteOffset(3)
	l.SetActiveBank(0)
	dst := make([]byte, 640)
	l.RenderScanline(171, dst) // col 0 byte 0xAB → nibbles 0xA, 0xB
	// offset 3 → high nibble: applyOffset(0x0A)=0x3A, applyOffset(0x0B)=0x3B.
	if dst[0] != 0x3A || dst[1] != 0x3B {
		t.Errorf("640 offset 3: dst[0,1]=%#x,%#x, want 0x3A,0x3B", dst[0], dst[1])
	}
}

// TestLayer2MidFrameScrollFold pins the raster-stamped scroll fold
// (#187, Atic Atac's cinematic): a CPU that raster-waits and rewrites
// the X scroll mid-frame must split the layer — rows whose raster line
// precedes the write render with the old scroll, rows at/after it with
// the new one. The FPGA samples the scroll registers combinationally
// per pixel (layer2.vhd:152/:156), never once per frame.
func TestLayer2MidFrameScrollFold(t *testing.T) {
	f := newFakeBanks()
	l := New(f)
	l.SetActiveBank(9)
	l.SetEnabled(true)

	line := 0
	l.SetRasterLineSource(func() int { return line })

	// Frame execution: scroll 0 at the top, X scroll 8 written at raw
	// raster line 100 (paper row 36).
	line = 100
	l.SetScrollX(8)

	// Render bracket, as ULA.Render drives it.
	l.FoldScrollStamps(false)
	dst := make([]byte, Width)

	// Paper row 0 (raster 64, before the write): frame-start scroll 0.
	l.RenderScanline(0, dst)
	if want := byte((9*7 + 0) & 0xFF); dst[0] != want {
		t.Errorf("row 0 col 0: got %#x, want %#x (pre-write scroll 0)", dst[0], want)
	}
	// Paper row 40 (raster 104, after the write): scroll 8.
	l.RenderScanline(40, dst)
	if want := byte((9*7 + 40*256 + 8) & 0xFF); dst[0] != want {
		t.Errorf("row 40 col 0: got %#x, want %#x (post-write scroll 8)", dst[0], want)
	}
	l.EndScrollCapture()

	// Live registers unchanged by the render bracket.
	if l.ScrollX() != 8 {
		t.Errorf("live ScrollX = %d after render, want 8", l.ScrollX())
	}

	// Next render with no new writes: the fold deactivates (log
	// consumed) and every row uses the live scroll again.
	l.FoldScrollStamps(false)
	l.RenderScanline(0, dst)
	if want := byte((9*7 + 8) & 0xFF); dst[0] != want {
		t.Errorf("next-frame row 0 col 0: got %#x, want %#x (live scroll 8)", dst[0], want)
	}
	l.EndScrollCapture()
}

// TestLayer2MidFramePaletteOffsetFold pins the raster-stamped NR$70
// palette-offset fold (#187, Atic Atac's moon/character-select screen):
// the game band-fades its Layer 2 credits text by rewriting the palette
// offset per raster band (offset 7 outside the band, 0 inside — the
// FPGA re-latches NR$70 per 7 MHz pixel, layer2.vhd:105-116). A
// once-per-frame offset renders the whole band with the end-of-frame
// value and blacks the text out.
func TestLayer2MidFramePaletteOffsetFold(t *testing.T) {
	f := newFakeBanks()
	l := New(f)
	l.SetActiveBank(9)
	l.SetEnabled(true)
	l.SetResolution(1)
	l.SetPaletteOffset(7)

	line := 0
	l.SetRasterLineSource(func() int { return line })
	// Band open at raster 128, close at raster 254 (Atic Atac's shape).
	line = 128
	l.SetPaletteOffset(0)
	line = 254
	l.SetPaletteOffset(7)

	l.FoldScrollStamps(false)
	dst := make([]byte, 320)
	off7 := func(b byte) byte { return (((b>>4)+7)&0x0F)<<4 | (b & 0x0F) }

	// Wide row 95 (raster 127, above the band): offset 7.
	raw := byte((9*7 + 95) & 0xFF)
	l.RenderScanline(95, dst)
	if dst[0] != off7(raw) {
		t.Errorf("row 95 col 0: got %#x, want %#x (offset 7)", dst[0], off7(raw))
	}
	// Wide row 96 (raster 128, band start): offset 0 — raw index.
	raw = byte((9*7 + 96) & 0xFF)
	l.RenderScanline(96, dst)
	if dst[0] != raw {
		t.Errorf("row 96 col 0: got %#x, want %#x (offset 0)", dst[0], raw)
	}
	// Wide row 222 (raster 254, band end): offset 7 again.
	raw = byte((9*7 + 222) & 0xFF)
	l.RenderScanline(222, dst)
	if dst[0] != off7(raw) {
		t.Errorf("row 222 col 0: got %#x, want %#x (offset 7)", dst[0], off7(raw))
	}
	l.EndScrollCapture()

	// Live register keeps the end-of-frame value.
	if l.PaletteOffset() != 7 {
		t.Errorf("live PaletteOffset = %d, want 7", l.PaletteOffset())
	}
}

// TestLayer2WideModeScrollFoldAnchor pins the wide-mode raster anchor:
// in 320×256 (res 1) the layer row 0 scans at raw raster 32, so a write
// stamped at raster 200 splits at layer row 168.
func TestLayer2WideModeScrollFoldAnchor(t *testing.T) {
	f := newFakeBanks()
	l := New(f)
	l.SetActiveBank(9)
	l.SetEnabled(true)
	l.SetResolution(1)

	line := 0
	l.SetRasterLineSource(func() int { return line })
	line = 200
	l.SetScrollY(1)

	l.FoldScrollStamps(false)
	dst := make([]byte, 320)

	// Wide row 167 (raster 199): pre-write scroll Y 0. Column-major
	// wide layout: byte offset = x*256 + y.
	l.RenderScanline(167, dst)
	if want := byte((9*7 + 167) & 0xFF); dst[0] != want {
		t.Errorf("wide row 167 col 0: got %#x, want %#x (pre-write Y 0)", dst[0], want)
	}
	// Wide row 168 (raster 200): post-write scroll Y 1.
	l.RenderScanline(168, dst)
	if want := byte((9*7 + 169) & 0xFF); dst[0] != want {
		t.Errorf("wide row 168 col 0: got %#x, want %#x (post-write Y 1)", dst[0], want)
	}
	l.EndScrollCapture()
}
