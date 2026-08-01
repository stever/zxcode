package next

// The exhaustive NextReg decode conformance test: every one of the 256
// registers is probed against the FPGA's port $253B read mux
// (zxnext.vhd:5882-6289) and write decode (:5113-5666) on a fully
// wired machine (the production Wire umbrella + CTC + IM2 +
// compositor). This is the single structural test known-gaps.md called
// for: a register whose read composition or write mask drifts from the
// VHDL fails here by name, instead of waiting for a per-register spec
// test to be written (#153).
//
// Register classes:
//
//   - absent from the table       → not decoded by the read mux
//     (`others => '0'`, :6286): reads $00 before and after any write.
//   - stored (mask/or)            → the mux returns a stored field:
//     writing w reads back (w & mask) | or, probed with 4 patterns.
//   - custom                      → composed/live read (identity
//     constants, live latches, index-addressed windows): a dedicated
//     probe pins the composition.
//
// Deliberate model exceptions are probed AS IMPLEMENTED with the
// rationale in the entry's note (NR$00/$0F writable for game probes,
// $98-$9A pin-state storage). Everything else asserts the VHDL truth.

import (
	"fmt"
	"testing"

	"github.com/stever/zxplay_go/pkg/ay"
	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/next/compositor"
	"github.com/stever/zxplay_go/pkg/next/copper"
	"github.com/stever/zxplay_go/pkg/next/install/installtest"
	"github.com/stever/zxplay_go/pkg/next/keymap"
	"github.com/stever/zxplay_go/pkg/next/layer2"
	"github.com/stever/zxplay_go/pkg/next/nextregs"
	"github.com/stever/zxplay_go/pkg/next/palette"
	"github.com/stever/zxplay_go/pkg/next/rtc"
	"github.com/stever/zxplay_go/pkg/next/sprite"
	"github.com/stever/zxplay_go/pkg/next/tilemap"
	"github.com/stever/zxplay_go/pkg/next/uart"
	"github.com/stever/zxplay_go/pkg/roms"
	"github.com/stever/zxplay_go/pkg/z80"
)

// nrStubULA supplies the live inputs the composed reads consume:
// video line (NR$1E/$1F), extended keys / MD pads (NR$B0-$B2), the
// Timex video mode ($69 low bits) and the shared frame-INT disable
// latch (NR$22 bit 2 / $C4 bit 0).
type nrStubULA struct {
	videoLine        int
	extKeys          uint16
	joyL, joyR       uint16
	timexMode        byte
	frameIntDisabled bool
	ulaPlus          bool
}

func (s *nrStubULA) SetULANext(bool, byte)              {}
func (s *nrStubULA) SetULAOutputDisabled(bool)          {}
func (s *nrStubULA) SetULAScroll(_, _ byte)             {}
func (s *nrStubULA) SetULAFineScrollX(bool)             {}
func (s *nrStubULA) SetULAClipWindow(_, _, _, _ byte)   {}
func (s *nrStubULA) SetTimexVideoMode(v byte)           { s.timexMode = v & 0x3F }
func (s *nrStubULA) TimexVideoMode() byte               { return s.timexMode }
func (s *nrStubULA) ActiveVideoLine() int               { return s.videoLine }
func (s *nrStubULA) ExtendedKeys() uint16               { return s.extKeys }
func (s *nrStubULA) MDJoyLeft() uint16                  { return s.joyL }
func (s *nrStubULA) MDJoyRight() uint16                 { return s.joyR }
func (s *nrStubULA) SetULAFrameIntDisable(disable bool) { s.frameIntDisabled = disable }
func (s *nrStubULA) ULAFrameIntDisabled() bool          { return s.frameIntDisabled }
func (s *nrStubULA) SetULAPlusEnabled(on bool)          { s.ulaPlus = on }
func (s *nrStubULA) ULAPlusEnabled() bool               { return s.ulaPlus }
func (s *nrStubULA) ResetULAPlus()                      { s.ulaPlus = false }

type nrMachine struct {
	disp *nextregs.Dispatcher
	mem  *memory.Memory
	cpu  *z80.CPU
	ula  *nrStubULA
	pal  *palette.Bank
	cop  *copper.Copper
}

// newNRMachine wires the full production NextReg surface (Wire +
// WireCTC + WireIM2 + WireCompositor) around stub live sources, then
// selects the +3 personality (NR$03 = $B3) so the machine sits in the
// standard post-boot state: config mode off, classic paging live.
func newNRMachine(t *testing.T) *nrMachine {
	t.Helper()
	installtest.RedirectConfig(t)
	mem, err := memory.New(wireTestROMs(t), roms.ModelNext)
	if err != nil {
		t.Fatal(err)
	}
	cpu := z80.New(mem, stubULA{})
	disp := nextregs.New()
	ula := &nrStubULA{}
	l2 := layer2.New(mem)
	pal := palette.NewBank()
	cop := copper.New()
	cop.SetRegWriter(disp)
	Wire(WireOpts{
		Dispatcher: disp,
		Memory:     mem,
		CPU:        cpu,
		AYEngine:   ay.NewEngine(),
		Layer2:     l2,
		Palette:    pal,
		Priority:   NewLayerPriority(),
		Sprites:    sprite.New(),
		Copper:     cop,
		RTC:        rtc.New(),
		Keymap:     keymap.New(),
		Tilemap:    tilemap.New(mem),
		ULANext:    ula,
	})
	comp := compositor.New(pal, l2)
	WireCompositor(disp, comp)
	ctc := WireCTC(disp, cpu)
	WireIM2(disp, cpu, ctc)
	// The UART is port-mapped, not NextReg-mapped — nothing to wire
	// on the dispatcher; construct one to mirror production.
	_ = uart.New()
	disp.WriteReg(0x03, 0xB3)
	return &nrMachine{disp: disp, mem: mem, cpu: cpu, ula: ula, pal: pal, cop: cop}
}

type nrCase struct {
	vhdl   string                           // read-mux / write-decode citation
	mask   byte                             // stored probe: read = (w & mask) | or
	or     byte                             //
	stored bool                             // mask/or probe applies
	custom func(t *testing.T, m *nrMachine) //
	note   string                           // model exception / behaviour note
}

func storedReg(vhdl string, mask, or byte) nrCase {
	return nrCase{vhdl: vhdl, mask: mask, or: or, stored: true}
}

// probeClipWindow pins the NR$18-$1B clip-window semantics: a write
// stores coord[idx] then advances idx (:5242-5276); a read returns
// coord[idx] WITHOUT advancing (:5947-5975); NR$1C bit `bit` resets
// this window's idx (:5278-5290) and its packed read exposes it.
func probeClipWindow(reg byte, shift uint, defY2 byte) func(*testing.T, *nrMachine) {
	return func(t *testing.T, m *nrMachine) {
		m.disp.WriteReg(reg, 0x11) // x1, idx 0→1
		m.disp.WriteReg(reg, 0x22) // x2, idx 1→2
		m.disp.WriteReg(reg, 0x33) // y1, idx 2→3
		if got := m.disp.ReadReg(reg); got != defY2 {
			t.Errorf("read at idx 3 = $%02X, want default y2 $%02X (read must not advance)", got, defY2)
		}
		if got := m.disp.ReadReg(0x1C) >> shift & 0x03; got != 3 {
			t.Errorf("NR$1C idx field = %d, want 3", got)
		}
		m.disp.WriteReg(0x1C, 1<<(shift/2)) // reset this window's idx
		if got := m.disp.ReadReg(reg); got != 0x11 {
			t.Errorf("read after idx reset = $%02X, want $11 (x1)", got)
		}
	}
}

// nrDecodeCases: every register the FPGA read mux decodes. Registers
// absent here read $00 (the mux's `others => '0'`) — asserted by the
// runner.
var nrDecodeCases = map[byte]nrCase{
	0x00: {vhdl: ":5885 g_machine_id", note: "deliberately writable (game probe, see readOnlyIdentity)",
		custom: func(t *testing.T, m *nrMachine) {
			if got := m.disp.ReadReg(0x00); got != 0x0A {
				t.Errorf("machine id = $%02X, want $0A", got)
			}
			// DOCUMENTED DIVERGENCE: hardware reads the bitstream
			// constant regardless of writes; we honour probe writes
			// (Nextoid) — dispatcher.go readOnlyIdentity rationale.
			m.disp.WriteReg(0x00, 0x08)
			if got := m.disp.ReadReg(0x00); got != 0x08 {
				t.Errorf("probe write not honoured: $%02X (see readOnlyIdentity note)", got)
			}
		}},
	0x01: {vhdl: ":5888 g_version (bitstream constant)",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0x01, 0xFF)
			if got := m.disp.ReadReg(0x01); got != 0x32 {
				t.Errorf("core version = $%02X, want $32 (write-ignored)", got)
			}
		}},
	0x02: {vhdl: ":5891 bus_reset & 00 & iotrap & mf_nmi & divmmc_nmi & reset_type(1:0)",
		custom: func(t *testing.T, m *nrMachine) {
			if got := m.disp.ReadReg(0x02); got != 0x02 {
				t.Errorf("default = $%02X, want $02 (reset_type '010' — one soft reset applied, no bootrom)", got)
			}
			m.disp.WriteReg(0x02, 0x80) // latch bus_reset, no trigger bits
			if got := m.disp.ReadReg(0x02); got != 0x82 {
				t.Errorf("after $80 write = $%02X, want $82", got)
			}
			m.disp.WriteReg(0x02, 0x01) // soft reset: shift-history 010 → 001
			if got := m.disp.ReadReg(0x02); got != 0x01 {
				t.Errorf("after soft reset = $%02X, want $01 (:1736 shift-history)", got)
			}
		}},
	0x03: {vhdl: ":5894 palette_sub_idx & machine_timing & user_dt_lock & machine_type",
		custom: func(t *testing.T, m *nrMachine) {
			// Fixture selected +3 ($B3): timing 011, type 011. Bit 7 is
			// the LIVE NR$44 half-pair latch, idle 0.
			if got := m.disp.ReadReg(0x03); got != 0x33 {
				t.Errorf("post-boot = $%02X, want $33", got)
			}
			m.disp.WriteReg(0x44, 0x5A) // half-written pair → sub_idx 1
			if got := m.disp.ReadReg(0x03); got != 0xB3 {
				t.Errorf("mid-pair = $%02X, want $B3 (bit 7 = live sub_idx, :5403)", got)
			}
			m.disp.WriteReg(0x40, 0x00) // NR$40 clears sub_idx (:5376)
			if got := m.disp.ReadReg(0x03); got != 0x33 {
				t.Errorf("after NR$40 = $%02X, want $33", got)
			}
		}},
	0x05: storedReg(":5897 read / :5156-5158 + :5837/:5849 write (joy bits + 50/60 + scandouble)", 0xFF, 0),
	0x06: storedReg(":5900 read / :5161-5170 write; bit 2 config-gated (frozen 0 out of config)", 0xFB, 0),
	0x07: {vhdl: ":5903 '00' & cpu_speed & '00' & nr_07_cpu_speed",
		custom: func(t *testing.T, m *nrMachine) {
			for _, w := range []byte{0x03, 0x42, 0x00} {
				m.disp.WriteReg(0x07, w)
				want := (w&0x03)<<4 | w&0x03
				if got := m.disp.ReadReg(0x07); got != want {
					t.Errorf("write $%02X → $%02X, want $%02X (current speed echoes target)", w, got, want)
				}
			}
		}},
	0x08: {vhdl: ":5906 (not port_7ffd_locked) & stored bits 6:0",
		custom: func(t *testing.T, m *nrMachine) {
			m.mem.PagingEnabled = false // classic lock via 7FFD bit 5
			m.disp.WriteReg(0x08, 0x00)
			if got := m.disp.ReadReg(0x08); got != 0x00 {
				t.Errorf("locked, write $00 → $%02X, want $00", got)
			}
			m.disp.WriteReg(0x08, 0xD5) // bit 7 = 1 clears the lock (:3654)
			if got := m.disp.ReadReg(0x08); got != 0xD5 {
				t.Errorf("unlock write $D5 → $%02X, want $D5 (bit 7 = live NOT locked)", got)
			}
			m.disp.WriteReg(0x08, 0x55) // bit 7 = 0 leaves the lock alone
			if got := m.disp.ReadReg(0x08); got != 0xD5&0x80|0x55 {
				t.Errorf("write $55 → $%02X, want $D5 (still unlocked)", got)
			}
		}},
	0x09: storedReg(":5909 read / :5185-5188 write; bit 3 = one-shot MAPRAM clear, reads 0", 0xF7, 0),
	0x0A: storedReg(":5912 read / :5191-5198; bits 7:5 config-gated (frozen 0), bit 2 zero", 0x1B, 0),
	0x0B: storedReg(":5915 en & '0' & iomode & '000' & iomode_0", 0xB1, 0),
	0x0E: {vhdl: ":5918 g_sub_version (bitstream constant)",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0x0E, 0xFF)
			if got := m.disp.ReadReg(0x0E); got != 0x03 {
				t.Errorf("sub-version = $%02X, want $03 (write-ignored)", got)
			}
		}},
	0x0F: {vhdl: ":5921 '0000' & g_board_issue", note: "writable like NR$00 (probe symmetry); hardware reads the constant",
		custom: func(t *testing.T, m *nrMachine) {
			if got := m.disp.ReadReg(0x0F); got != 0x01 {
				t.Errorf("board id = $%02X, want $01 (Issue 3)", got)
			}
		}},
	0x10: {vhdl: ":5924 '0' & nr_10_coreid & i_SPKEY_BUTTONS(1:0)",
		custom: func(t *testing.T, m *nrMachine) {
			if got := m.disp.ReadReg(0x10); got != 0x04 {
				t.Errorf("default = $%02X, want $04 (coreid '00001', buttons idle)", got)
			}
			m.disp.WriteReg(0x10, 0xFF) // flashboot/coreid writes don't reach the read
			if got := m.disp.ReadReg(0x10); got != 0x04 {
				t.Errorf("after write = $%02X, want $04 (composed, not stored)", got)
			}
		}},
	0x11: {vhdl: ":5927 read / :5208-5217 write (config-mode-gated)",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0x11, 0x05) // out of config mode: ignored
			if got := m.disp.ReadReg(0x11); got != 0x00 {
				t.Errorf("out-of-config write leaked: $%02X, want $00", got)
			}
		}},
	0x12: storedReg(":5930 '0' & layer2_active_bank(6:0)", 0x7F, 0),
	0x13: storedReg(":5933 '0' & layer2_shadow_bank(6:0)", 0x7F, 0),
	0x14: storedReg(":5936 global transparent RGB, full byte", 0xFF, 0),
	0x15: storedReg(":5939 sprite/layer control, full byte", 0xFF, 0),
	0x16: storedReg(":5942 layer2 scroll X low", 0xFF, 0),
	0x17: storedReg(":5945 layer2 scroll Y", 0xFF, 0),
	0x18: {vhdl: ":5947-5953 clip idx window", custom: probeClipWindow(0x18, 0, 0xBF)},
	0x19: {vhdl: ":5955-5961 clip idx window", custom: probeClipWindow(0x19, 2, 0xBF)},
	0x1A: {vhdl: ":5963-5969 clip idx window", custom: probeClipWindow(0x1A, 4, 0xBF)},
	0x1B: {vhdl: ":5971-5977 clip idx window (tilemap default y2 $FF)", custom: probeClipWindow(0x1B, 6, 0xFF)},
	0x1C: {vhdl: ":5980 tm_idx & ula_idx & spr_idx & l2_idx / write :5278-5290",
		custom: func(t *testing.T, m *nrMachine) {
			for _, reg := range []byte{0x18, 0x19, 0x1A, 0x1B} {
				m.disp.WriteReg(reg, 0x00) // bump each idx once
			}
			if got := m.disp.ReadReg(0x1C); got != 0x55 {
				t.Errorf("packed indices = $%02X, want $55", got)
			}
			m.disp.WriteReg(0x1C, 0x0F)
			if got := m.disp.ReadReg(0x1C); got != 0x00 {
				t.Errorf("after reset-all = $%02X, want $00", got)
			}
		}},
	0x1E: {vhdl: ":5983 '0000000' & cvc(8)",
		custom: func(t *testing.T, m *nrMachine) {
			m.ula.videoLine = 0x1AB
			if got := m.disp.ReadReg(0x1E); got != 0x01 {
				t.Errorf("video line MSB = $%02X, want $01", got)
			}
		}},
	0x1F: {vhdl: ":5986 cvc(7:0)",
		custom: func(t *testing.T, m *nrMachine) {
			m.ula.videoLine = 0x1AB
			if got := m.disp.ReadReg(0x1F); got != 0xAB {
				t.Errorf("video line LSB = $%02X, want $AB", got)
			}
		}},
	0x20: {vhdl: ":5989 status(0) & status(11) & '00' & status(6:3) — live INT status, not the written byte",
		custom: func(t *testing.T, m *nrMachine) {
			if got := m.disp.ReadReg(0x20); got != 0 {
				t.Errorf("idle = $%02X, want $00", got)
			}
			// Pulse mode (NR$C0 bit 0 = 0) holds the IM2 chain reset, so
			// software requests don't latch (the hw-mode paths are pinned
			// by TestWireIM2*).
			m.disp.WriteReg(0x20, 0xFF)
			if got := m.disp.ReadReg(0x20); got != 0 {
				t.Errorf("after unq write in pulse mode = $%02X, want $00", got)
			}
		}},
	0x22: {vhdl: ":5992 (not pulse_int_n) & '0000' & ff_int_disable & line_en & line(8)",
		note: "bit 7 (live INT line) not composed — reads 0",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0x22, 0x07)
			if got := m.disp.ReadReg(0x22); got != 0x07 {
				t.Errorf("write $07 → $%02X, want $07 (latch + enable + MSB)", got)
			}
			if !m.ula.frameIntDisabled {
				t.Error("bit 2 write did not reach the shared frame-INT latch")
			}
			m.disp.WriteReg(0x22, 0x00)
			if got := m.disp.ReadReg(0x22); got != 0x00 {
				t.Errorf("write $00 → $%02X, want $00", got)
			}
		}},
	0x23: storedReg(":5995 line interrupt LSB", 0xFF, 0),
	0x26: storedReg(":5998 ULA scroll X", 0xFF, 0),
	0x27: storedReg(":6001 ULA scroll Y", 0xFF, 0),
	0x28: {vhdl: ":6004 nr_stored_palette_value (write side is the PS/2 keymap MSB, :6301)",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0x28, 0x77) // keymap address write — invisible to the read
			if got := m.disp.ReadReg(0x28); got != 0x00 {
				t.Errorf("after keymap write = $%02X, want $00", got)
			}
			m.disp.WriteReg(0x44, 0x5A) // stage a palette first-half byte
			if got := m.disp.ReadReg(0x28); got != 0x5A {
				t.Errorf("staged palette byte = $%02X, want $5A", got)
			}
			m.disp.WriteReg(0x44, 0x01) // completing the pair keeps the staged byte
			if got := m.disp.ReadReg(0x28); got != 0x5A {
				t.Errorf("after pair complete = $%02X, want $5A", got)
			}
		}},
	// $2C-$2E: in the mux, but they read the Raspberry Pi I2S audio
	// inputs (:6007-6015) — no Pi is modelled, so they idle $00 and
	// writes don't store (write cases commented out, :5321-5328).
	0x2C: {vhdl: ":6007 pi_audio_L(9:2) — live, idles 0", custom: probeZero(0x2C)},
	0x2D: {vhdl: ":6011 i2s_sample & '000000' — live, idles 0", custom: probeZero(0x2D)},
	0x2E: {vhdl: ":6014 pi_audio_R(9:2) — live, idles 0", custom: probeZero(0x2E)},
	0x2F: storedReg(":6018 '000000' & tm_scrollx(9:8)", 0x03, 0),
	0x30: storedReg(":6021 tm_scrollx(7:0)", 0xFF, 0),
	0x31: storedReg(":6024 tm_scrolly", 0xFF, 0),
	0x32: storedReg(":6027 lores_scrollx", 0xFF, 0),
	0x33: storedReg(":6030 lores_scrolly", 0xFF, 0),
	0x34: {vhdl: ":6033 '0' & sprite_mirror_id",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0x34, 0x05)
			if got := m.disp.ReadReg(0x34); got != 0x05 {
				t.Errorf("select 5 → $%02X, want $05", got)
			}
			m.disp.WriteReg(0x34, 0xFF)
			if got := m.disp.ReadReg(0x34); got != 0x7F {
				t.Errorf("select $FF → $%02X, want $7F (7-bit id)", got)
			}
			m.disp.WriteReg(0x75, 0x00) // $75 alias auto-increments the mirror
			if got := m.disp.ReadReg(0x34); got != 0x00 {
				t.Errorf("after $75 auto-inc = $%02X, want $00 (wrap)", got)
			}
		}},
	0x40: {vhdl: ":6036 nr_palette_idx",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0x40, 0x70)
			if got := m.disp.ReadReg(0x40); got != 0x70 {
				t.Errorf("index = $%02X, want $70", got)
			}
			m.disp.WriteReg(0x41, 0x11) // 8-bit write auto-increments
			if got := m.disp.ReadReg(0x40); got != 0x71 {
				t.Errorf("index after $41 write = $%02X, want $71 (:5380)", got)
			}
		}},
	0x41: {vhdl: ":6039 nr_palette_dat(8:1) at the current index, no auto-inc on read",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0x40, 0x10)
			m.disp.WriteReg(0x41, 0xAA) // entry $10 = $AA<<1|1, index → $11
			m.disp.WriteReg(0x40, 0x10)
			if got := m.disp.ReadReg(0x41); got != 0xAA {
				t.Errorf("read-back = $%02X, want $AA", got)
			}
			if got := m.disp.ReadReg(0x40); got != 0x10 {
				t.Errorf("index moved on read: $%02X, want $10", got)
			}
		}},
	0x42: storedReg(":6042 ulanext_format", 0xFF, 0),
	0x43: storedReg(":6045 palette control, full byte", 0xFF, 0),
	0x44: {vhdl: ":6048 nr_palette_dat(10:9) & '00000' & dat(0)",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0x40, 0x20)
			m.disp.WriteReg(0x44, 0xFF) // 9-bit pair: hi
			m.disp.WriteReg(0x44, 0xC1) // lo: priority 11 + LSB 1, index → $21
			m.disp.WriteReg(0x40, 0x20)
			if got := m.disp.ReadReg(0x44); got != 0xC1 {
				t.Errorf("read-back = $%02X, want $C1 (priority bits 7:6 + value LSB)", got)
			}
		}},
	0x4A: storedReg(":6051 fallback RGB", 0xFF, 0),
	0x4B: storedReg(":6054 sprite transparent index", 0xFF, 0),
	0x4C: storedReg(":6057 '0000' & tm transparent index", 0x0F, 0),
	0x50: storedReg(":6060 MMU0", 0xFF, 0),
	0x51: storedReg(":6063 MMU1", 0xFF, 0),
	0x52: storedReg(":6066 MMU2", 0xFF, 0),
	0x53: storedReg(":6069 MMU3", 0xFF, 0),
	0x54: storedReg(":6072 MMU4", 0xFF, 0),
	0x55: storedReg(":6075 MMU5", 0xFF, 0),
	0x56: storedReg(":6078 MMU6", 0xFF, 0),
	0x57: storedReg(":6081 MMU7", 0xFF, 0),
	0x60: {vhdl: "no read case (:6286 → $00); write advances the copper byte address (:5418-5424)",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0x61, 0x00)
			m.disp.WriteReg(0x62, 0x00)
			m.disp.WriteReg(0x60, 0x12)
			m.disp.WriteReg(0x60, 0x34)
			if got := m.disp.ReadReg(0x60); got != 0x00 {
				t.Errorf("read = $%02X, want $00 (not in the read mux)", got)
			}
			if got := m.disp.ReadReg(0x61); got != 0x02 {
				t.Errorf("cursor after two data writes = $%02X, want $02", got)
			}
		}},
	0x61: storedReg(":6084 copper addr(7:0) — live cursor", 0xFF, 0),
	0x62: storedReg(":6087 mode & '000' & addr(10:8)", 0xC7, 0),
	0x63: {vhdl: "no read case; 16-bit copper data write advances the address (:5433-5437)",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0x61, 0x10)
			m.disp.WriteReg(0x62, 0x00)
			m.disp.WriteReg(0x63, 0x00)
			if got := m.disp.ReadReg(0x63); got != 0x00 {
				t.Errorf("read = $%02X, want $00 (not in the read mux)", got)
			}
			if got := m.disp.ReadReg(0x61); got != 0x11 {
				t.Errorf("cursor after $63 write = $%02X, want $11", got)
			}
		}},
	0x64: storedReg(":6090 copper vertical offset", 0xFF, 0),
	0x68: storedReg(":6093; bit 3 = the live ULA+ enable latch EVERY write drives (:4550-4551) — round-trips; bit 1 hard zero", 0xFD, 0),
	0x69: storedReg(":6096 composed from port $123B / $7FFD shadow / port $FF Timex — live alias", 0xFF, 0),
	0x6A: storedReg(":6099 '00' & radastan & xor & palette offset", 0x3F, 0),
	0x6B: storedReg(":6102 tm_en & tm_control", 0xFF, 0),
	0x6C: storedReg(":6105 tm default attribute", 0xFF, 0),
	0x6E: storedReg(":6108 base_7 & '0' & base(5:0) — bit 6 dropped", 0xBF, 0),
	0x6F: storedReg(":6111 tiles_7 & '0' & tiles(5:0) — bit 6 dropped", 0xBF, 0),
	0x70: storedReg(":6114 '00' & resolution & palette offset", 0x3F, 0),
	0x71: storedReg(":6117 '0000000' & scrollx_msb", 0x01, 0),
	0x7F: storedReg(":6120 user register 0", 0xFF, 0),
	0x80: storedReg(":6123 expbus control", 0xFF, 0),
	0x81: storedReg(":6126; bit 7 = i_BUS_ROMCS_n (no bus → 0), bits 2:0 forced off (:5496)", 0x78, 0),
	0x82: storedReg(":6129 internal port enable 0", 0xFF, 0),
	0x83: storedReg(":6132 internal port enable 1", 0xFF, 0),
	0x84: storedReg(":6135 internal port enable 2", 0xFF, 0),
	0x85: storedReg(":6138 reset_type & '000' & enables", 0x8F, 0),
	0x86: storedReg(":6141 bus port enable 0", 0xFF, 0),
	0x87: storedReg(":6144 bus port enable 1", 0xFF, 0),
	0x88: storedReg(":6147 bus port enable 2", 0xFF, 0),
	0x89: storedReg(":6150 reset_type & '000' & enables", 0x8F, 0),
	0x8A: storedReg(":6153 '00' & bus port propagate", 0x3F, 0),
	0x8C: storedReg(":6156 altrom (active high nibble + staged low nibble)", 0xFF, 0),
	0x8E: {vhdl: ":6159 composed live from port_dffd/7ffd/1ffd paging state",
		custom: func(t *testing.T, m *nrMachine) {
			// Fresh +3 personality: all paging ports 0 → only the
			// hard-one bit 3 reads set.
			if got := m.disp.ReadReg(0x8E); got != 0x08 {
				t.Errorf("default = $%02X, want $08 (bit 3 hard '1')", got)
			}
			m.disp.WriteReg(0x8E, 0x78) // bit 3 = 1: set RAM bank 7 (bits 6:4)
			if got := m.disp.ReadReg(0x8E); got != 0x78 {
				t.Errorf("after bank-7 write = $%02X, want $78 (live 7FFD read-back)", got)
			}
			m.disp.WriteReg(0x8E, 0x07) // bit 3 = 0: keep the bank; +3 special config 3
			if got := m.disp.ReadReg(0x8E); got != 0x7F {
				t.Errorf("special-mode write = $%02X, want $7F (1FFD bits + rom composite, bank 7 kept)", got)
			}
		}},
	0x8F: storedReg(":6162 '000000' & mapping_mode; behaviour (profi/pentagon) unmodelled", 0x03, 0),
	0x90: storedReg(":6165; write drops GPIO 1:0 output enables (:5537)", 0xFC, 0),
	0x91: storedReg(":6168 pi gpio output enable 1", 0xFF, 0),
	0x92: storedReg(":6171 pi gpio output enable 2", 0xFF, 0),
	0x93: storedReg(":6174 '0000' & pi gpio output enable 3", 0x0F, 0),
	0x98: storedReg(":6177 i_GPIO(7:0) — stored byte models the driven pin state (no Pi)", 0xFF, 0),
	0x99: storedReg(":6180 i_GPIO(15:8) — pin-state model", 0xFF, 0),
	0x9A: storedReg(":6183 i_GPIO(23:16) — pin-state model", 0xFF, 0),
	0x9B: storedReg(":6186 '0000' & i_GPIO(27:24)", 0x0F, 0),
	0xA0: storedReg(":6189 '00' & en(5:3) & '00' & en(0)", 0x39, 0),
	0xA2: storedReg(":6192 ctl(7:6) & '0' & ctl(4:2) & '1' & ctl(0) — bit 1 hard one", 0xDD, 0x02),
	0xA8: storedReg(":6198 '0000000' & esp_gpio0_en", 0x01, 0),
	0xA9: {vhdl: ":6201 '00000' & ESP_GPIO2 & '0' & ESP_GPIO0 — live pins",
		custom: func(t *testing.T, m *nrMachine) {
			if got := m.disp.ReadReg(0xA9); got != 0x05 {
				t.Errorf("idle = $%02X, want $05 (pins pulled up)", got)
			}
			m.disp.WriteReg(0xA9, 0x00) // drive low — but output not enabled
			if got := m.disp.ReadReg(0xA9); got != 0x05 {
				t.Errorf("driven low, output disabled = $%02X, want $05", got)
			}
			m.disp.WriteReg(0xA8, 0x01) // enable GPIO0 output
			if got := m.disp.ReadReg(0xA9); got != 0x04 {
				t.Errorf("driven low, output enabled = $%02X, want $04", got)
			}
			m.disp.WriteReg(0xA9, 0x01)
			if got := m.disp.ReadReg(0xA9); got != 0x05 {
				t.Errorf("driven high = $%02X, want $05", got)
			}
		}},
	0xB0: {vhdl: ":6208 extended keys shuffle",
		custom: func(t *testing.T, m *nrMachine) {
			if got := m.disp.ReadReg(0xB0); got != 0 {
				t.Errorf("idle = $%02X, want $00", got)
			}
			m.ula.extKeys = 1 << 8 // ';' → read bit 7
			if got := m.disp.ReadReg(0xB0); got != 0x80 {
				t.Errorf("ek(8) → $%02X, want $80", got)
			}
		}},
	0xB1: {vhdl: ":6212 extended keys shuffle",
		custom: func(t *testing.T, m *nrMachine) {
			m.ula.extKeys = 1 << 12 // DELETE → read bit 7
			if got := m.disp.ReadReg(0xB1); got != 0x80 {
				t.Errorf("ek(12) → $%02X, want $80", got)
			}
		}},
	0xB2: {vhdl: ":6215 MD-pad extra buttons shuffle",
		custom: func(t *testing.T, m *nrMachine) {
			m.ula.joyR = 1 << 10 // right pad X → read bit 7
			m.ula.joyL = 1 << 11 // left pad MODE → read bit 0
			if got := m.disp.ReadReg(0xB2); got != 0x81 {
				t.Errorf("joy vectors → $%02X, want $81", got)
			}
		}},
	0xB8: storedReg(":6218 divmmc ep 0 (no divMMC wired in this fixture: plain storage)", 0xFF, 0),
	0xB9: storedReg(":6221 divmmc ep valid 0", 0xFF, 0),
	0xBA: storedReg(":6224 divmmc ep timing 0", 0xFF, 0),
	0xBB: storedReg(":6227 divmmc ep 1", 0xFF, 0),
	0xC0: {vhdl: ":6230 vector & '0' & stackless & z80_im_mode & int_mode",
		custom: func(t *testing.T, m *nrMachine) {
			m.disp.WriteReg(0xC0, 0xE9)
			if got := m.disp.ReadReg(0xC0); got != 0xE9 {
				t.Errorf("write $E9 → $%02X, want $E9 (IM 0)", got)
			}
			m.cpu.IM = 2
			if got := m.disp.ReadReg(0xC0); got != 0xED {
				t.Errorf("IM 2 → $%02X, want $ED (live bits 2:1)", got)
			}
			m.cpu.IM = 0
		}},
	0xC2: storedReg(":6233 retn address LSB (guest-writable, :2064)", 0xFF, 0),
	0xC3: storedReg(":6236 retn address MSB (guest-writable, :2066)", 0xFF, 0),
	0xC4: {vhdl: ":6239 expbus_en & '00000' & ula_int_en(1:0) — aliases NR$22/port $FF",
		custom: func(t *testing.T, m *nrMachine) {
			if got := m.disp.ReadReg(0xC4); got != 0x81 {
				t.Errorf("default = $%02X, want $81 (:5096 reset)", got)
			}
			m.disp.WriteReg(0xC4, 0x00) // bit 0 = 0 → frame INT disabled via shared latch
			if got := m.disp.ReadReg(0xC4); got != 0x00 {
				t.Errorf("write $00 → $%02X, want $00", got)
			}
			if !m.ula.frameIntDisabled {
				t.Error("NR$C4 bit 0 = 0 did not disable via the shared latch (:3621)")
			}
			m.disp.WriteReg(0xC4, 0xFF)
			if got := m.disp.ReadReg(0xC4); got != 0x83 {
				t.Errorf("write $FF → $%02X, want $83 (reserved bits zero)", got)
			}
		}},
	0xC5: storedReg(":6242 ctc_int_en — 4 channels on this core, bits 7:4 hard '0000' (:4093)", 0x0F, 0),
	0xC6: storedReg(":6245 '0' & en_654 & '0' & en_210", 0x77, 0),
	0xC8: {vhdl: ":6248 '000000' & status(0) & status(11) — write-1-to-clear",
		custom: probeIntStatus(0xC8)},
	0xC9: {vhdl: ":6251 status(10:3) — write-1-to-clear", custom: probeIntStatus(0xC9)},
	0xCA: {vhdl: ":6254 UART framing/error status — sources unwired, idle 0",
		custom: probeIntStatus(0xCA)},
	0xCC: storedReg(":6257 dma_int_en_0(7) & '00000' & (1:0)", 0x83, 0),
	0xCD: storedReg(":6260 dma_int_en_1, full byte", 0xFF, 0),
	0xCE: storedReg(":6263 '0' & en_654 & '0' & en_210", 0x77, 0),
	0xD8: storedReg(":6266 '0000000' & fdc iotrap en", 0x01, 0),
	0xD9: storedReg(":6269 iotrap_write (stored :3894)", 0xFF, 0),
	0xDA: storedReg(":6272 '000000' & iotrap cause", 0x03, 0),
	// $F0/$F8-$FA: decoded by the read mux but backed by the XDEV/XADC
	// block that exists only on Issue 4/5 boards (gen block :7438+);
	// our identity is Issue 3 (NR$0F = $01) → undriven, read $00.
	0xF0: {vhdl: ":6275 xdev cmd — Issue 4/5 only, reads 0 on Issue 3", custom: probeZero(0xF0)},
	0xF8: {vhdl: ":6278 '0' & xadc_daddr — Issue 4/5 only", custom: probeZero(0xF8)},
	0xF9: {vhdl: ":6281 xadc_d0 — Issue 4/5 only", custom: probeZero(0xF9)},
	0xFA: {vhdl: ":6284 xadc_d1 — Issue 4/5 only", custom: probeZero(0xFA)},
}

// probeZero asserts a register reads $00 before and after writes —
// the behaviour of every register the read mux doesn't decode, and of
// mux registers whose live source has no emulator-side driver.
func probeZero(reg byte) func(*testing.T, *nrMachine) {
	return func(t *testing.T, m *nrMachine) {
		if got := m.disp.ReadReg(reg); got != 0 {
			t.Errorf("default read = $%02X, want $00", got)
		}
		m.disp.WriteReg(reg, 0xFF)
		if got := m.disp.ReadReg(reg); got != 0 {
			t.Errorf("read after $FF write = $%02X, want $00", got)
		}
	}
}

// probeIntStatus asserts the sticky interrupt-status registers idle
// at 0 and stay 0 across write-1-to-clear writes when nothing is
// pending (the pending/clear behaviour itself is pinned by
// TestWireIM2* and pkg/next/im2 tests).
func probeIntStatus(reg byte) func(*testing.T, *nrMachine) {
	return func(t *testing.T, m *nrMachine) {
		if got := m.disp.ReadReg(reg); got != 0 {
			t.Errorf("idle status = $%02X, want $00", got)
		}
		m.disp.WriteReg(reg, 0xFF)
		if got := m.disp.ReadReg(reg); got != 0 {
			t.Errorf("after clear-write = $%02X, want $00", got)
		}
	}
}

// TestNRDecodeConformance is the exhaustive per-register decode audit:
// all 256 NextRegs against the FPGA read mux and write masks, each on
// a fresh fully wired machine so probe side effects cannot leak
// between registers.
func TestNRDecodeConformance(t *testing.T) {
	for r := 0; r < 256; r++ {
		reg := byte(r)
		c, inMux := nrDecodeCases[reg]
		name := fmt.Sprintf("NR%02X", reg)
		t.Run(name, func(t *testing.T) {
			m := newNRMachine(t)
			// Cross-check the case table against the wiring-level mux
			// table (nrdecode.go) so the two cannot drift: every mux
			// register needs a case, every stored case must be in the
			// mux. (Custom cases MAY cover non-mux registers whose
			// writes have observable side effects, e.g. $60/$63.)
			if nrReadMux[reg] && !inMux {
				t.Fatalf("register is in nrReadMux but has no case entry")
			}
			if c.stored && !nrReadMux[reg] {
				t.Fatalf("stored case for a register outside nrReadMux")
			}
			switch {
			case !inMux:
				probeZero(reg)(t, m)
			case c.custom != nil:
				c.custom(t, m)
			case c.stored:
				for _, w := range []byte{0xFF, 0xAA, 0x55, 0x00} {
					m.disp.WriteReg(reg, w)
					want := w&c.mask | c.or
					if got := m.disp.ReadReg(reg); got != want {
						t.Errorf("write $%02X → read $%02X, want $%02X (%s)", w, got, want, c.vhdl)
					}
				}
			default:
				t.Fatalf("case entry has neither probe nor custom (%s)", c.vhdl)
			}
		})
	}
}
