package ula

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/keyboard"
	"github.com/stever/zxplay_go/pkg/memory"
	"github.com/stever/zxplay_go/pkg/roms"
)

// Multiface 3 paging-register readback. Per the FPGA source
// (zxnext.vhd:2612-2616 + the mf_port_dat mux at ~line 2960, and
// multiface.vhd:43-44 "Port read 7F3F: return 7ffd / 1F3F: return 1ffd"):
// while the Multiface is active (invisible off) in MF+3 mode, an IN whose
// LOW byte is $3F returns a paging register selected by A15:12 —
//
//	$7F3F -> port $7FFD (full byte)
//	$1F3F -> port $1FFD (low nibble: bits 7-4 = 0)
//
// NextZXOS's 128K-BASIC launch fires the MF NMI; its handler reads $7F3F and
// $1F3F to snapshot paging into MF RAM ($3FCC/$3FFF), which a later routine
// tests via `cp $04; jr nz` (MF ROM $01F6) to decide whether to continue to
// the Sinclair 128 menu or abort — so these reads must return the real
// paging registers, not open bus.
func TestMultifacePagingReadback(t *testing.T) {
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	u := New(mem, keyboard.New())

	mem.PageMemory(0x14)      // $7FFD = $14
	mem.PageMemoryPlus3(0x05) // $1FFD = $05
	got7, _, _ := mem.GetPortState()
	if got7 != 0x14 {
		t.Fatalf("setup: $7FFD = %#x, want $14", got7)
	}

	// MF INACTIVE: $7F3F must NOT return the paging reg (open-bus float).
	mem.SetMultifaceActive(false)
	if v, handled := u.ReadPort(0x7F3F); handled && v == 0x14 {
		t.Fatalf("MF inactive: $7F3F returned paging reg %#x (want open bus, unhandled)", v)
	}

	// MF ACTIVE: $7F3F -> $7FFD full byte; $1F3F -> $1FFD low nibble.
	mem.SetMultifaceActive(true)
	if v, handled := u.ReadPort(0x7F3F); !handled || v != 0x14 {
		t.Fatalf("MF active: $7F3F = %#x handled=%v, want $14", v, handled)
	}
	if v, handled := u.ReadPort(0x1F3F); !handled || v != 0x05 {
		t.Fatalf("MF active: $1F3F = %#x handled=%v, want $05", v, handled)
	}
}

// Layer 2 port $123B readback. Per the FPGA source (zxnext.vhd:3933),
// an IN from $123B returns the COMPOSED control state — segment & "00" &
// shadow & rd_en & layer2_en & wr_en — not the raw last-written byte:
// a bank-offset write (bit 4 set, :3921-3922) loads a separate register
// and leaves the control read-back untouched. The 128K launch's MF NMI
// handler reads $123B to snapshot the Layer 2 state, so this must return
// the real state, not open bus (which reads as bit1=1, "Layer 2
// visible", and would leave Layer 2 visibly enabled at the menu).
func TestLayer2PortReadback(t *testing.T) {
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	u := New(mem, keyboard.New())
	f := &fakeNextRegs{regs: map[byte]byte{}}
	u.SetNextRegs(f)

	// Reset value is 0 (not open-bus $FF).
	if v, handled := u.ReadPort(0x123B); !handled || v != 0x00 {
		t.Fatalf("default $123B read = %#x handled=%v, want $00", v, handled)
	}
	// A control write ($42: segment 01, visible) reads back composed —
	// which for a control write equals the written byte.
	u.WritePort(0x123B, 0x42)
	if v, handled := u.ReadPort(0x123B); !handled || v != 0x42 {
		t.Fatalf("$123B read after write $42 = %#x handled=%v, want $42", v, handled)
	}
	// A bank-offset write (bit 4 set) must NOT disturb the control
	// read-back — the MrKWatkins Layer2Port test interleaves offset
	// writes with control state and reads the state back.
	u.WritePort(0x123B, 0x13)
	if v, handled := u.ReadPort(0x123B); !handled || v != 0x42 {
		t.Fatalf("$123B read after offset write $13 = %#x handled=%v, want $42 (control preserved)", v, handled)
	}
	// Layer 2 enable via NR$69 bit 7 is the same live register: the
	// composed read reflects it (zxnext.vhd:3924-3926).
	f.regs[0x69] = 0x00
	if v, _ := u.ReadPort(0x123B); v&0x02 != 0 {
		t.Fatalf("$123B read = %#x, want bit1 clear after NR$69 bit7 cleared", v)
	}
}

// A $123B control write must not touch the ULA shadow display (NR$69
// bit 6 / port $7FFD bit 3): the port's bit 3 selects which BANK the
// over-ROM paging window maps (NR$13 vs NR$12) — a pure memory-paging
// bit (zxnext.vhd:3919), with no path to the display source. The
// MrKWatkins Layer2Colours test ends with a shadow-paging write
// ($123B = $0B) and its ULA screen must stay on bank 5; aliasing the
// bit to the shadow DISPLAY blanked the whole scene onto the empty
// bank-7 screen.
func TestLayer2PortShadowBitIsPagingOnly(t *testing.T) {
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	u := New(mem, keyboard.New())
	f := &fakeNextRegs{regs: map[byte]byte{}}
	u.SetNextRegs(f)

	mem.ScreenPage = 5
	u.WritePort(0x123B, 0x0B) // write-enable + visible + shadow paging
	if f.regs[0x69]&0x40 != 0 {
		t.Errorf("NR$69 after $123B=$0B = %#x — bit 6 (shadow display) must not be set", f.regs[0x69])
	}
	if f.regs[0x69]&0x80 == 0 {
		t.Errorf("NR$69 after $123B=$0B = %#x — bit 7 (Layer 2 visible) must be set", f.regs[0x69])
	}
	// The offset form (bit 4 set) must not fan anything into NR$69: the
	// FPGA's write path only loads the offset register (zxnext.vhd:3922).
	f.regs[0x69] = 0x80
	u.WritePort(0x123B, 0x10|0x03)
	if f.regs[0x69] != 0x80 {
		t.Errorf("NR$69 after offset write = %#x, want $80 (untouched)", f.regs[0x69])
	}
}
