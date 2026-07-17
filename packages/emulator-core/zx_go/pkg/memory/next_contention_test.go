package memory

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// Per-access ULA memory contention on the Next (#181, Axis 10).
// FPGA truth:
//
//   - i_contention_en (zxnext.vhd:4481) = NOT NR$08-bit-6 AND NOT
//     Pentagon timing AND cpu_speed = "00" (3.5 MHz only).
//   - mem_contend (:4490-4494): only 8K pages 0-15 (16K banks 0-7)
//     can contend, with the set selected by the NR$03 machine timing —
//     48K: bank 5; 128K: odd banks; +3: banks >= 4 — following the
//     PAGE wherever it is mapped, MMU8 included.
//   - Port contention (zxula.vhd:596-604): 48K/128K timing only; the
//     +3-timing wait arm is memory-only.

// contentionStack builds a ModelNext memory with controllable clocks,
// positioned at the first contended fetch of paper row 0 (t = 14655,
// pattern slot 0 → 6 T of hold).
func contentionStack(t *testing.T) (*Memory, *uint64, *int) {
	t.Helper()
	m, err := New("", roms.ModelNext)
	if err != nil {
		t.Fatal(err)
	}
	var cpuT uint64 = 14655
	mult := 1
	m.TStates = &cpuT
	m.ContentionEnabled = true
	m.SpeedMultiplier = func() int { return mult }
	m.SetNextMachineTiming(3) // +3 timing, the Next's default
	return m, &cpuT, &mult
}

// contendCost measures the T-states ContendMemory adds for addr.
func contendCost(m *Memory, cpuT *uint64, addr uint16) uint64 {
	before := *cpuT
	m.ContendMemory(addr)
	return *cpuT - before
}

func TestNextContentionPlus3TimingPageSet(t *testing.T) {
	m, cpuT, _ := contentionStack(t)
	// +3 timing: 16K banks 4-7 contend. The classic map puts bank 5
	// at $4000 and bank 0 at $C000 (post-New defaults).
	if got := contendCost(m, cpuT, 0x4000); got != 6 {
		t.Errorf("bank 5 @ $4000 (+3 timing) cost = %d, want 6 (vhd:4493 banks>=4)", got)
	}
	*cpuT = 14655
	if got := contendCost(m, cpuT, 0xC000); got != 0 {
		t.Errorf("bank 0 @ $C000 (+3 timing) cost = %d, want 0", got)
	}
	// ROM never contends.
	*cpuT = 14655
	if got := contendCost(m, cpuT, 0x0100); got != 0 {
		t.Errorf("ROM @ $0100 cost = %d, want 0", got)
	}
}

func TestNextContentionFollowsTheMMUPage(t *testing.T) {
	m, cpuT, _ := contentionStack(t)
	// Map 8K page 10 (16K bank 5) into slot 6 ($C000): the access
	// contends THERE (the rule follows the page, not the address).
	m.SetMMU(6, 10)
	if got := contendCost(m, cpuT, 0xC100); got != 6 {
		t.Errorf("bank-5 page mapped @ $C000 cost = %d, want 6 (mem_active_page rule)", got)
	}
	// And an uncontended page mapped over $4000 does NOT contend.
	m.SetMMU(2, 0) // 8K page 0 (16K bank 0) at $4000
	*cpuT = 14655
	if got := contendCost(m, cpuT, 0x4100); got != 0 {
		t.Errorf("bank-0 page mapped @ $4000 cost = %d, want 0", got)
	}
}

func TestNextContentionTimingSelectsThePageSet(t *testing.T) {
	m, cpuT, _ := contentionStack(t)
	// 48K timing: bank 5 only — bank 7 (at $C000 via 7FFD bank select)
	// does not contend.
	m.SetNextMachineTiming(1)
	if got := contendCost(m, cpuT, 0x4000); got != 6 {
		t.Errorf("48K timing bank 5 cost = %d, want 6", got)
	}
	m.SetMMU(6, 14) // 8K page 14 = 16K bank 7 at $C000
	*cpuT = 14655
	if got := contendCost(m, cpuT, 0xC000); got != 0 {
		t.Errorf("48K timing bank 7 cost = %d, want 0 (bank 5 only, vhd:4491)", got)
	}
	// 128K timing: odd banks — bank 7 contends, bank 4 does not.
	m.SetNextMachineTiming(2)
	*cpuT = 14655
	if got := contendCost(m, cpuT, 0xC000); got != 6 {
		t.Errorf("128K timing bank 7 cost = %d, want 6 (odd banks, vhd:4492)", got)
	}
	m.SetMMU(6, 8) // 16K bank 4
	*cpuT = 14655
	if got := contendCost(m, cpuT, 0xC000); got != 0 {
		t.Errorf("128K timing bank 4 cost = %d, want 0", got)
	}
	// Pentagon timing: nothing contends.
	m.SetNextMachineTiming(4)
	*cpuT = 14655
	if got := contendCost(m, cpuT, 0x4000); got != 0 {
		t.Errorf("Pentagon timing cost = %d, want 0 (i_contention_en gate)", got)
	}
}

func TestNextContentionGates(t *testing.T) {
	m, cpuT, mult := contentionStack(t)
	// Turbo: no contention at any multiplier above 1 (vhd:4481).
	*mult = 8
	if got := contendCost(m, cpuT, 0x4000); got != 0 {
		t.Errorf("28 MHz cost = %d, want 0", got)
	}
	*mult = 1
	// NR$08 bit 6 (RAMContentionDisabled): none.
	m.RAMContentionDisabled = true
	*cpuT = 14655
	if got := contendCost(m, cpuT, 0x4000); got != 0 {
		t.Errorf("contention-disabled cost = %d, want 0", got)
	}
	m.RAMContentionDisabled = false
	// Outside the paper fetch window (border rows): none.
	*cpuT = 1000
	if got := contendCost(m, cpuT, 0x4000); got != 0 {
		t.Errorf("top-border cost = %d, want 0", got)
	}
	// The 8-slot pattern: slot 6 and 7 are free.
	*cpuT = 14655 + 6
	if got := contendCost(m, cpuT, 0x4000); got != 0 {
		t.Errorf("pattern slot 6 cost = %d, want 0", got)
	}
	*cpuT = 14655 + 1
	if got := contendCost(m, cpuT, 0x4000); got != 5 {
		t.Errorf("pattern slot 1 cost = %d, want 5", got)
	}
}

func TestNextPortContentionTimingGate(t *testing.T) {
	m, cpuT, _ := contentionStack(t)
	// +3 timing (the Next's default): NO port contention — the
	// zxula.vhd wait arm is memory-only (:604).
	before := *cpuT
	m.ContendPort(0x00FE)
	if got := *cpuT - before; got != 0 {
		t.Errorf("+3-timing port $FE cost = %d, want 0 (zxula.vhd:604 memory-only)", got)
	}
	// 128K timing: the ULA port contends (C:1, C:3 → 6+1+5+3 = 15 at
	// pattern slot 0... position advances between the two holds).
	m.SetNextMachineTiming(2)
	*cpuT = 14655
	before = *cpuT
	m.ContendPort(0x00FE)
	if got := *cpuT - before; got == 0 {
		t.Errorf("128K-timing port $FE cost = 0, want contended (zxula.vhd:600)")
	}
}
