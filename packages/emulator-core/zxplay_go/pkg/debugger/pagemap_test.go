package debugger

import (
	"image/color"
	"os"
	"path/filepath"
	"testing"

	"fyne.io/fyne/v2/test"

	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/roms"
)

// init wires up a Fyne test app so canvas.Refresh() calls have
// somewhere to dispatch to. Without this, tests that exercise the
// widget's mutation paths panic inside Fyne's drawing pipeline.
func init() { _ = test.NewApp() }

// makeTestMemory creates a Memory bound to a test ROM directory so
// PageMapWidget.Refresh has real values to read.
func makeTestMemory(t *testing.T, model roms.SpectrumModel) *memory.Memory {
	t.Helper()
	dir := t.TempDir()
	romBytes := make([]byte, 16*1024)
	if err := os.WriteFile(filepath.Join(dir, "48.rom"), romBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "128-0.rom"), romBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "128-1.rom"), romBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	mem, err := memory.New(dir, model)
	if err != nil {
		t.Fatalf("memory.New: %v", err)
	}
	return mem
}

func TestPageMapWidget_Classic48K(t *testing.T) {
	mem := makeTestMemory(t, roms.Model48K)
	w := NewPageMapWidget(mem)
	w.Refresh()

	// 48K has no paging hardware, so no bank numbers.
	expect := []struct {
		idx      int
		rangeStr string
		bankStr  string
	}{
		{0, "$0000-$3FFF", "ROM"},
		{1, "$4000-$7FFF", "RAM (screen, contended)"},
		{2, "$8000-$BFFF", "RAM"},
		{3, "$C000-$FFFF", "RAM"},
	}
	for _, e := range expect {
		got := w.classic[e.idx]
		if got.rangeT.Text != e.rangeStr {
			t.Errorf("cell %d range = %q, want %q", e.idx, got.rangeT.Text, e.rangeStr)
		}
		if got.bankT.Text != e.bankStr {
			t.Errorf("cell %d bank = %q, want %q", e.idx, got.bankT.Text, e.bankStr)
		}
	}
}

func TestPageMapWidget_Classic128K(t *testing.T) {
	mem := makeTestMemory(t, roms.Model128K)
	w := NewPageMapWidget(mem)
	w.Refresh()

	// 128K reset layout: ROM 0 / RAM 5 / RAM 2 / RAM 0, with bank
	// numbers shown because paging is real hardware here.
	expect := []struct {
		idx     int
		bankStr string
	}{
		{0, "ROM 0 (128)"},
		{1, "RAM 5 (screen)"},
		{2, "RAM 2"},
		{3, "RAM 0"},
	}
	for _, e := range expect {
		if got := w.classic[e.idx].bankT.Text; got != e.bankStr {
			t.Errorf("cell %d bank = %q, want %q", e.idx, got, e.bankStr)
		}
	}

	// Reset state: 7FFD is zero, so displaying bank 5 and unlocked.
	wantFoot := "7FFD=$00 · showing 5 · unlocked"
	if got := w.classicFoot.Text; got != wantFoot {
		t.Errorf("footer = %q, want %q", got, wantFoot)
	}
}

func TestPageMapWidget_Classic48KHasNoFooter(t *testing.T) {
	mem := makeTestMemory(t, roms.Model48K)
	w := NewPageMapWidget(mem)
	w.Refresh()
	if got := w.classicFoot.Text; got != "" {
		t.Errorf("48K footer = %q, want empty", got)
	}
}

func TestPageMapWidget_ClassicScreenIsGreen(t *testing.T) {
	mem := makeTestMemory(t, roms.Model48K)
	w := NewPageMapWidget(mem)
	w.Refresh()
	// Slot 1 holds RAM 5 = the screen. Background should be green.
	got := w.classic[1].bg.FillColor.(color.NRGBA)
	want := pagemapColors.screen
	if got != want {
		t.Errorf("screen cell bg = %v, want %v", got, want)
	}
	// Slot 0 holds ROM. Background should be blue.
	got = w.classic[0].bg.FillColor.(color.NRGBA)
	if got != pagemapColors.rom {
		t.Errorf("ROM cell bg = %v, want rom blue", got)
	}
}

// fakeNextProvider lets us drive the Next-mode tests with
// controlled MMU and divMMC state.
type fakeNextProvider struct {
	slots       [8]int
	divmmcState string
	regs        map[uint8]byte
}

func (f *fakeNextProvider) MMUSlots() [8]int    { return f.slots }
func (f *fakeNextProvider) DivMMCState() string { return f.divmmcState }
func (f *fakeNextProvider) NextRegs() map[uint8]byte {
	if f.regs == nil {
		return map[uint8]byte{}
	}
	return f.regs
}

func TestPageMapWidget_NextLayout(t *testing.T) {
	// Use 48K mem (avoids needing Next ROMs); SetNextProvider drives the
	// view regardless of the underlying model so testing 8-slot layout
	// works fine.
	mem := makeTestMemory(t, roms.Model48K)
	w := NewPageMapWidget(mem)
	provider := &fakeNextProvider{
		slots:       [8]int{0xFF, 0xFF, 10, 11, 4, 5, 0xDE, 0xDF},
		divmmcState: "paged=false mapram=true automap=true",
	}
	w.SetNextProvider(provider)
	// In test mode the underlying Memory's currentModel is 48K, so
	// Refresh() will still call refreshClassic. Force the 8-slot
	// path by directly invoking refreshNext.
	w.refreshNext()

	expectRange := []string{
		"$0000-$1FFF", "$2000-$3FFF", "$4000-$5FFF", "$6000-$7FFF",
		"$8000-$9FFF", "$A000-$BFFF", "$C000-$DFFF", "$E000-$FFFF",
	}
	for i, want := range expectRange {
		if got := w.next[i].rangeT.Text; got != want {
			t.Errorf("cell %d range = %q, want %q", i, got, want)
		}
	}
	// Slot 0/1 are ROM (0xFF sentinel).
	if w.next[0].bankT.Text != "ROM" {
		t.Errorf("slot 0 bank = %q, want ROM", w.next[0].bankT.Text)
	}
	// Slot 2 holds bank 10 (= screen half).
	if w.next[2].bankT.Text != "bank 10 (screen)" {
		t.Errorf("slot 2 bank = %q, want bank 10 (screen)", w.next[2].bankT.Text)
	}
	// Slot 6/7 hold high banks ($DE/$DF).
	if w.next[6].bg.FillColor != pagemapColors.high {
		t.Errorf("slot 6 (bank $DE) should be 'high' purple")
	}
}

func TestPageMapWidget_DivMMCOverlayAmber(t *testing.T) {
	mem := makeTestMemory(t, roms.Model48K)
	w := NewPageMapWidget(mem)
	provider := &fakeNextProvider{
		slots:       [8]int{0xFF, 0xFF, 10, 11, 4, 5, 0xDE, 0xDF},
		divmmcState: "paged=true mapram=true automap=true",
	}
	w.SetNextProvider(provider)
	w.refreshNext()
	if w.next[0].bankT.Text != "divMMC overlay" {
		t.Errorf("slot 0 with overlay paged in should say 'divMMC overlay', got %q",
			w.next[0].bankT.Text)
	}
	if w.next[0].bg.FillColor != pagemapColors.divmmc {
		t.Errorf("slot 0 with overlay should be amber")
	}
}

func TestContainsField(t *testing.T) {
	if !containsField("paged=true mapram=false", "paged=true") {
		t.Errorf("expected match for paged=true")
	}
	if containsField("paged=false", "paged=true") {
		t.Errorf("paged=false should not match paged=true")
	}
}
