//go:build !js

package main

import (
	"image"
	"image/color"
	"testing"
)

// crtCols builds the destination->source column map crtFrame would build.
func crtCols(srcW, dstW int) []int32 {
	cols := make([]int32, dstW)
	for x := range cols {
		cols[x] = int32(x * srcW / dstW)
	}
	return cols
}

// crtSource paints a frame whose every pixel encodes its own coordinates,
// so a scaled output identifies exactly which source pixel it came from:
// red = x&0xFF, green = y&0xFF, blue = 0xFF (halved to 0x7F in a gap row).
// Alpha repeats the row, unhalved — the filter never dims it, so it reads
// back the source row even out of a gap row.
func crtSource(w, h int) *image.RGBA {
	src := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			src.SetRGBA(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 0xFF, A: uint8(y)})
		}
	}
	return src
}

// naiveCRT is the specification applyCRTFilterInto optimises: every
// destination pixel resolved independently, no row reuse.
func naiveCRT(src *image.RGBA, dstW, dstH int) *image.RGBA {
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	scanlines := dstH >= 2*sh
	for y := range dstH {
		srcY := y * sh / dstH
		dark := scanlines && (y+1)*sh/dstH != srcY
		for x := range dstW {
			c := src.RGBAAt(x*sw/dstW, srcY)
			if dark {
				c.R, c.G, c.B = c.R/2, c.G/2, c.B/2
			}
			dst.SetRGBA(x, y, c)
		}
	}
	return dst
}

// TestCRTFilterMatchesDisplayGrid is the regression for the diagonal seam:
// the filter's output must be EXACTLY the display rectangle it was given.
// Any other size leaves fyne's GL_NEAREST texture to be stretched over the
// quad, and a stretch that puts samples on texel boundaries resolves them
// differently in the quad's two triangles — the top-left/bottom-right
// diagonal across the picture. 640x256 doubled to 512 rows over the 300%
// preset's 768 device rows was the reported case.
func TestCRTFilterMatchesDisplayGrid(t *testing.T) {
	src := crtSource(640, 256)
	const dw, dh = 960, 768
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	applyCRTFilterInto(dst, src, crtCols(640, dw))

	if got := dst.Bounds(); got != image.Rect(0, 0, dw, dh) {
		t.Fatalf("output bounds = %v, want the display rect %v", got, image.Rect(0, 0, dw, dh))
	}
	// 768 device rows over 256 source rows: every source scanline gets a
	// 3-row band, lit, lit, gap. No row is ever a resampling coin flip.
	for y := range dh {
		wantSrcY := uint8(y / 3)
		wantB := uint8(0xFF)
		if y%3 == 2 {
			wantB = 0x7F
		}
		c := dst.RGBAAt(0, y)
		if c.A != wantSrcY || c.B != wantB {
			t.Fatalf("row %d: source row %d, blue %#02x; want source row %d, blue %#02x",
				y, c.A, c.B, wantSrcY, wantB)
		}
	}
}

// TestCRTFilterScanlineCadence covers the vertical scales the View menu's
// presets produce, including the ones where the old fixed 2x buffer could
// not land on the display grid at all.
func TestCRTFilterScanlineCadence(t *testing.T) {
	const sh = 256
	for _, tc := range []struct {
		name    string
		dstH    int
		wantDim []bool // brightness pattern of the first rows
	}{
		{"200% - 2 device rows per scanline", 512, []bool{false, true, false, true}},
		{"300% - 3 device rows per scanline", 768, []bool{false, false, true, false, false, true}},
		{"400% - 4 device rows per scanline", 1024, []bool{false, false, false, true, false, false, false, true}},
		// Below 2x there is no spare row for a gap: the frame is scaled
		// plain rather than losing half the picture to the filter.
		{"100% - no room for scanlines", 256, []bool{false, false, false, false}},
		{"150% - no room for scanlines", 384, []bool{false, false, false, false}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := crtSource(640, sh)
			dst := image.NewRGBA(image.Rect(0, 0, 640, tc.dstH))
			applyCRTFilterInto(dst, src, crtCols(640, 640))
			for y, wantDark := range tc.wantDim {
				gotDark := dst.RGBAAt(0, y).B == 0x7F
				if gotDark != wantDark {
					t.Errorf("row %d: dark = %v, want %v", y, gotDark, wantDark)
				}
			}
		})
	}
}

// TestCRTFilterEqualsNaive checks the row-reuse fast path (identical
// consecutive rows are copied, not rebuilt) against the per-pixel
// specification, across integer and fractional scales in both axes.
func TestCRTFilterEqualsNaive(t *testing.T) {
	for _, tc := range []struct{ sw, sh, dw, dh int }{
		{640, 256, 960, 768},   // Next, 300% preset
		{640, 256, 1280, 1024}, // Next, 400%
		{320, 240, 960, 720},   // classic, 300%
		{320, 240, 1000, 823},  // freely resized window
		{320, 240, 200, 150},   // window smaller than the frame
	} {
		src := crtSource(tc.sw, tc.sh)
		dst := image.NewRGBA(image.Rect(0, 0, tc.dw, tc.dh))
		applyCRTFilterInto(dst, src, crtCols(tc.sw, tc.dw))
		want := naiveCRT(src, tc.dw, tc.dh)
		for y := range tc.dh {
			for x := range tc.dw {
				if got, exp := dst.RGBAAt(x, y), want.RGBAAt(x, y); got != exp {
					t.Fatalf("%dx%d -> %dx%d: pixel (%d,%d) = %v, want %v",
						tc.sw, tc.sh, tc.dw, tc.dh, x, y, got, exp)
				}
			}
		}
	}
}

// TestCRTFilterRejectsBadSizes: a short column map or an empty image must
// leave the destination alone rather than panic in the render goroutine.
func TestCRTFilterRejectsBadSizes(t *testing.T) {
	src := crtSource(640, 256)
	sentinel := color.RGBA{R: 0x11, G: 0x22, B: 0x33, A: 0x44}
	dst := image.NewRGBA(image.Rect(0, 0, 960, 768))
	dst.SetRGBA(0, 0, sentinel)

	applyCRTFilterInto(dst, src, crtCols(640, 100)) // map too short
	if dst.RGBAAt(0, 0) != sentinel {
		t.Error("wrote to the destination with an undersized column map")
	}
	applyCRTFilterInto(dst, image.NewRGBA(image.Rect(0, 0, 0, 0)), crtCols(640, 960))
	if dst.RGBAAt(0, 0) != sentinel {
		t.Error("wrote to the destination from an empty source")
	}
}
