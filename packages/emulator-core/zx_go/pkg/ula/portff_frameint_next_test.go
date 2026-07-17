package ula

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/keyboard"
	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/next"
	"github.com/conorarmstrong/zx_go/pkg/next/nextregs"
	"github.com/conorarmstrong/zx_go/pkg/roms"
	"github.com/conorarmstrong/zx_go/pkg/z80"
)

// Port $FF bit 6 — the ULA frame-INT disable latch (work item: Axis 4
// confirmed gap). The FPGA keeps ONE latch, port_ff_reg(6)
// (zxnext.vhd:3609-3635), with three writers:
//
//	port $FF write  → bit 6            (vhd:3615, full byte)
//	NR$22 write     → bit 2            (vhd:3619)
//	NR$C4 write     → NOT bit 0        (vhd:3621)
//
// and NR$69 writes leave it alone (vhd:3617, bits 5:0 only). It gates
// frame-INT GENERATION at the source (zxula_timing.vhd:551 int_ula) and
// reads back at NR$22 bit 2 (vhd:5992), NR$C4 bit 0 inverted (vhd:6239)
// and port $FF bit 6 under the NR$08-bit-2 gate (vhd:2813).
//
// These tests drive the real ULA + CPU through the same next.Wire*
// calls production uses, pinning the full shared-latch behaviour.

func newFrameIntStack(t *testing.T) (*ULA, *z80.CPU, *nextregs.Dispatcher, *memory.Memory) {
	t.Helper()
	mem, err := memory.New("", roms.ModelNext)
	if err != nil {
		t.Fatalf("memory.New(ModelNext): %v", err)
	}
	kbd := keyboard.New()
	u := New(mem, kbd)
	cpu := z80.New(mem, u)
	d := nextregs.New()
	u.SetNextRegs(d)
	// The same latch topology next.Wire installs: the ULA carries the
	// latch, its sink mirrors changes into the CPU's INT generator.
	u.SetFrameIntDisableSink(func(disable bool) { cpu.FrameIntDisabled = disable })
	next.WireCPUSpeed(d, cpu)
	next.WireLineInterrupt(d, cpu, u, nil)
	next.WireInterruptEnable0(d)
	next.WireULAControl(d, u, nil, mem)
	return u, cpu, d, mem
}

// TestPortFFBit6FrameIntDisable pins the headline gap: an IN-visible
// port $FF write with bit 6 set suppresses the ULA frame interrupt,
// and every read-back path sees the one latch.
func TestPortFFBit6FrameIntDisable(t *testing.T) {
	u, cpu, d, _ := newFrameIntStack(t)

	if cpu.FrameIntDisabled {
		t.Fatalf("fresh stack: FrameIntDisabled=true, want false")
	}

	u.WritePort(0x00FF, 0x40)
	if !cpu.FrameIntDisabled {
		t.Errorf("port $FF=$40: FrameIntDisabled=false, want true (vhd:3635 + zxula_timing.vhd:551)")
	}
	if got := d.ReadReg(0x22) & 0x04; got == 0 {
		t.Errorf("port $FF=$40: NR$22 read bit 2 clear, want set (vhd:5992 shared latch)")
	}
	if got := d.ReadReg(0xC4) & 0x01; got != 0 {
		t.Errorf("port $FF=$40: NR$C4 read bit 0 set, want clear (vhd:6239 ula_int_en)")
	}

	// NR$08 bit 2 opens the port-$FF Timex read-back: the full
	// port_ff_reg comes back, bit 6 included (vhd:2813).
	d.WriteReg(0x08, 0x04)
	if got, _ := u.ReadPort(0x00FF); got != 0x40 {
		t.Errorf("port $FF read-back = $%02X, want $40", got)
	}

	u.WritePort(0x00FF, 0x00)
	if cpu.FrameIntDisabled {
		t.Errorf("port $FF=$00: FrameIntDisabled=true, want false (re-enabled)")
	}
	if got := d.ReadReg(0x22) & 0x04; got != 0 {
		t.Errorf("port $FF=$00: NR$22 read bit 2 set, want clear")
	}
}

// TestFrameIntDisableSharedLatchWriters pins last-writer-wins across
// the three writers, and that NR$69 (bits 5:0 only) never touches it.
func TestFrameIntDisableSharedLatchWriters(t *testing.T) {
	u, cpu, d, _ := newFrameIntStack(t)
	d.WriteReg(0x08, 0x04) // open the port-$FF read-back gate

	readBit6 := func() byte {
		v, _ := u.ReadPort(0x00FF)
		return v & 0x40
	}

	// NR$22 bit 2 sets the latch → port $FF read-back sees it.
	d.WriteReg(0x22, 0x04)
	if !cpu.FrameIntDisabled || readBit6() == 0 {
		t.Errorf("NR$22=$04: disabled=%v portFF.6=$%02X, want true/$40 (vhd:3619)",
			cpu.FrameIntDisabled, readBit6())
	}

	// NR$C4 bit 0 = 1 (ULA INT enable) clears it.
	d.WriteReg(0xC4, 0x01)
	if cpu.FrameIntDisabled || readBit6() != 0 {
		t.Errorf("NR$C4=$01: disabled=%v portFF.6=$%02X, want false/$00 (vhd:3621 inverted)",
			cpu.FrameIntDisabled, readBit6())
	}

	// NR$C4 bit 0 = 0 sets it again.
	d.WriteReg(0xC4, 0x00)
	if !cpu.FrameIntDisabled {
		t.Errorf("NR$C4=$00: FrameIntDisabled=false, want true")
	}

	// NR$69 writes only bits 5:0 (vhd:3617) — the latch survives.
	d.WriteReg(0x69, 0x00)
	if !cpu.FrameIntDisabled || readBit6() == 0 {
		t.Errorf("NR$69=$00 after disable: disabled=%v portFF.6=$%02X, want true/$40 (bit 6 untouched)",
			cpu.FrameIntDisabled, readBit6())
	}

	// Port $FF write (bit 6 clear) wins last.
	u.WritePort(0x00FF, 0x06) // hi-res mode, INT enabled
	if cpu.FrameIntDisabled {
		t.Errorf("port $FF=$06: FrameIntDisabled=true, want false")
	}
	if got := d.ReadReg(0x22) & 0x04; got != 0 {
		t.Errorf("port $FF=$06: NR$22 read bit 2 set, want clear")
	}
}

// TestFrameIntDisableResetClears pins the reset behaviour: the FPGA
// clears port_ff_reg in the shared reset block (zxnext.vhd:3611),
// asserted for hard AND soft NR$02 resets — a stale disable across a
// reset would leave the machine INT-less. The machine-level ULA reset
// clears it too.
func TestFrameIntDisableResetClears(t *testing.T) {
	u, cpu, d, mem := newFrameIntStack(t)
	next.WireReset(d, mem, cpu, nil, u)

	u.WritePort(0x00FF, 0x40)
	if !cpu.FrameIntDisabled {
		t.Fatalf("port $FF=$40: FrameIntDisabled=false, want true")
	}
	d.WriteReg(0x02, 0x01) // NR$02 soft reset
	if cpu.FrameIntDisabled {
		t.Errorf("after NR$02 soft reset: FrameIntDisabled=true, want false (vhd:3611)")
	}
	if got := d.ReadReg(0x22) & 0x04; got != 0 {
		t.Errorf("after soft reset: NR$22 read bit 2 set, want clear")
	}

	u.WritePort(0x00FF, 0x40)
	u.Reset() // machine-level reset (reset button / model switch)
	if cpu.FrameIntDisabled {
		t.Errorf("after ULA.Reset: FrameIntDisabled=true, want false")
	}
}
