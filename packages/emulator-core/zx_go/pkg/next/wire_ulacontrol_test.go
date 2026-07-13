package next

// Wiring tests for WireULAControl (NR$26/$27 ULA scroll, NR$68 ULA
// control, NR$69 Display Control fan-out), the WireClipWindows NR$1A
// push and the WirePalette NR$43 bit-1 select push — the register
// surface the MrKWatkins ULA conformance group exercises.

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/layer2"
	"github.com/conorarmstrong/zx_go/pkg/next/nextregs"
	"github.com/conorarmstrong/zx_go/pkg/next/palette"
)

// fakeULAVideoSink records every push. Also implements ULANextSink +
// ULAPaletteSelectSink so it can stand in for pkg/ula.ULA in WirePalette.
type fakeULAVideoSink struct {
	scrollX, scrollY byte
	disabled, fine   bool
	clip             [4]byte
	timex            byte
	timexSet         bool
	nextEnabled      bool
	nextFormat       byte
	second           bool
}

func (f *fakeULAVideoSink) SetULAOutputDisabled(d bool)          { f.disabled = d }
func (f *fakeULAVideoSink) SetULAScroll(x, y byte)               { f.scrollX, f.scrollY = x, y }
func (f *fakeULAVideoSink) SetULAFineScrollX(on bool)            { f.fine = on }
func (f *fakeULAVideoSink) SetULAClipWindow(x1, x2, y1, y2 byte) { f.clip = [4]byte{x1, x2, y1, y2} }
func (f *fakeULAVideoSink) SetTimexVideoMode(v byte)             { f.timex = v; f.timexSet = true }
func (f *fakeULAVideoSink) SetULANext(enabled bool, format byte) {
	f.nextEnabled, f.nextFormat = enabled, format
}
func (f *fakeULAVideoSink) SetULAPaletteSecond(second bool) { f.second = second }

// TestSpec_NR26_NR27_ULAScrollPush — zxnext.vhd:5304-5307: NR$26/$27
// write the ULA scroll registers; both push into the sink together.
func TestSpec_NR26_NR27_ULAScrollPush(t *testing.T) {
	d := nextregs.New()
	sink := &fakeULAVideoSink{}
	WireULAControl(d, sink, nil, nil)

	d.WriteReg(0x26, 233)
	if sink.scrollX != 233 || sink.scrollY != 0 {
		t.Errorf("after NR$26=233: sink scroll = (%d,%d), want (233,0)", sink.scrollX, sink.scrollY)
	}
	d.WriteReg(0x27, 165)
	if sink.scrollX != 233 || sink.scrollY != 165 {
		t.Errorf("after NR$27=165: sink scroll = (%d,%d), want (233,165)", sink.scrollX, sink.scrollY)
	}
	if d.ReadReg(0x26) != 233 || d.ReadReg(0x27) != 165 {
		t.Errorf("read-back = ($%02X,$%02X), want ($E9,$A5)", d.ReadReg(0x26), d.ReadReg(0x27))
	}
}

// TestSpec_NR68_ULAControlPush — NR$68 bit 7 = disable ULA output, bit 2
// = fine scroll X (zxnext.vhd:5443-5449).
func TestSpec_NR68_ULAControlPush(t *testing.T) {
	d := nextregs.New()
	sink := &fakeULAVideoSink{}
	WireULAControl(d, sink, nil, nil)

	d.WriteReg(0x68, 0x84)
	if !sink.disabled || !sink.fine {
		t.Errorf("NR$68=$84: disabled=%v fine=%v, want both true", sink.disabled, sink.fine)
	}
	d.WriteReg(0x68, 0x00)
	if sink.disabled || sink.fine {
		t.Errorf("NR$68=$00: disabled=%v fine=%v, want both false", sink.disabled, sink.fine)
	}
}

// TestSpec_NR69_DisplayControlFanOut — a NR$69 write fans out to Layer 2
// enable (bit 7 → port $123B alias, zxnext.vhd:3924), shadow display
// (bit 6 → port $7FFD bit 3, :3658) and the Timex port-$FF bits (5:0,
// :3617).
func TestSpec_NR69_DisplayControlFanOut(t *testing.T) {
	d := nextregs.New()
	sink := &fakeULAVideoSink{}
	l2 := layer2.New(nil)
	WireULAControl(d, sink, l2, nil)

	d.WriteReg(0x69, 0x86)
	if !l2.Enabled() {
		t.Errorf("NR$69 bit 7: Layer 2 not enabled")
	}
	if sink.timex != 0x06 {
		t.Errorf("NR$69 bits 5:0: timex = $%02X, want $06", sink.timex)
	}
	d.WriteReg(0x69, 0x00)
	if l2.Enabled() {
		t.Errorf("NR$69=0: Layer 2 still enabled")
	}
	if sink.timex != 0 {
		t.Errorf("NR$69=0: timex = $%02X, want $00", sink.timex)
	}
}

// TestSpec_NR1A_ULAClipPush — the NR$1A clip coordinates push into the
// live ULA render (zxula.vhd:562), including the wiring-time default and
// the NR$1C index reset.
func TestSpec_NR1A_ULAClipPush(t *testing.T) {
	d := nextregs.New()
	sink := &fakeULAVideoSink{}
	WireClipWindows(d, nil, nil, nil, sink)

	if sink.clip != [4]byte{0x00, 0xFF, 0x00, 0xBF} {
		t.Errorf("wiring default clip = %v, want {0,255,0,191}", sink.clip)
	}
	d.WriteReg(0x1C, 0x04) // reset ULA clip index
	for _, v := range []byte{8, 239, 8, 175} {
		d.WriteReg(0x1A, v)
	}
	if sink.clip != [4]byte{8, 239, 8, 175} {
		t.Errorf("clip after writes = %v, want {8,239,8,175}", sink.clip)
	}
}

// TestSpec_NR43_ULAPaletteSelectPush — NR$43 bit 1 (displayed ULA
// palette) pushes through ULAPaletteSelectSink so the ULA can
// raster-stamp mid-frame flips.
func TestSpec_NR43_ULAPaletteSelectPush(t *testing.T) {
	d := nextregs.New()
	sink := &fakeULAVideoSink{}
	WirePalette(d, palette.NewBank(), sink)

	d.WriteReg(0x43, 0x02)
	if !sink.second {
		t.Errorf("NR$43=$02: second-palette push missing")
	}
	d.WriteReg(0x43, 0x00)
	if sink.second {
		t.Errorf("NR$43=$00: select not pushed back to first")
	}
}
