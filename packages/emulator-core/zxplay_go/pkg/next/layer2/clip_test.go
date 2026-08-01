package layer2

import "testing"

// The NR$18 clip window gates Layer 2 per DISPLAY pixel. Coordinates are
// raw register values; in the wide modes the X pair is doubled (the FPGA
// compares against the 320-wide column counter). Defaults {0,FF,0,BF}.

func TestClipBoundsDefaultFullWindow(t *testing.T) {
	l := New(&fakeBanks{})
	x0, x1, ok := l.ClipBounds(0)
	if !ok || x0 != 0 || x1 != 255 {
		t.Fatalf("default row 0 = [%d,%d] ok=%v, want [0,255] true", x0, x1, ok)
	}
	if _, _, ok := l.ClipBounds(191); !ok {
		t.Fatal("default row 191 clipped, want visible")
	}
}

func TestClipBounds256TopClip(t *testing.T) {
	// The Lone Wolf map screen case (work item #92): Y1=8 leaves the top
	// char row to the ULA title bar.
	l := New(&fakeBanks{})
	l.SetClip(0, 255, 8, 191)
	for y := 0; y < 8; y++ {
		if _, _, ok := l.ClipBounds(y); ok {
			t.Fatalf("row %d visible, want clipped (Y1=8)", y)
		}
	}
	x0, x1, ok := l.ClipBounds(8)
	if !ok || x0 != 0 || x1 != 255 {
		t.Fatalf("row 8 = [%d,%d] ok=%v, want [0,255] true", x0, x1, ok)
	}
}

func TestClipBoundsXWindow256(t *testing.T) {
	l := New(&fakeBanks{})
	l.SetClip(16, 47, 0, 191)
	x0, x1, ok := l.ClipBounds(10)
	if !ok || x0 != 16 || x1 != 47 {
		t.Fatalf("got [%d,%d] ok=%v, want [16,47] true", x0, x1, ok)
	}
}

func TestClipBoundsWideModesDoubleX(t *testing.T) {
	l := New(&fakeBanks{})
	l.SetClip(10, 100, 0, 255)

	l.SetResolution(1) // 320x256
	x0, x1, ok := l.ClipBounds(200)
	if !ok || x0 != 20 || x1 != 201 {
		t.Fatalf("320 mode: got [%d,%d] ok=%v, want [20,201] true", x0, x1, ok)
	}

	l.SetResolution(2) // 640x256: same doubled column compare, 2 px per column
	x0, x1, ok = l.ClipBounds(200)
	if !ok || x0 != 40 || x1 != 403 {
		t.Fatalf("640 mode: got [%d,%d] ok=%v, want [40,403] true", x0, x1, ok)
	}
}

func TestClipBoundsWideDefaultY2ClipsBottom(t *testing.T) {
	// The register default Y2=191 clips wide-mode rows 192-255 until the
	// program widens the window — documented Next behaviour.
	l := New(&fakeBanks{})
	l.SetResolution(1)
	if _, _, ok := l.ClipBounds(192); ok {
		t.Fatal("wide row 192 visible with default Y2=191, want clipped")
	}
}

func TestClipBoundsClampsToLineWidth(t *testing.T) {
	l := New(&fakeBanks{})
	l.SetResolution(1)
	l.SetClip(0, 255, 0, 255)
	_, x1, ok := l.ClipBounds(0)
	if !ok || x1 != 319 {
		t.Fatalf("got x1=%d ok=%v, want 319 true (clamped to 320-wide line)", x1, ok)
	}
}

func TestClipBoundsDegenerateWindow(t *testing.T) {
	l := New(&fakeBanks{})
	l.SetClip(200, 100, 0, 191)
	if _, _, ok := l.ClipBounds(0); ok {
		t.Fatal("X1 > X2 window visible, want fully clipped")
	}
}
