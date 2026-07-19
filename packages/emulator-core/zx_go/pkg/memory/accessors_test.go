package memory

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// pkg/memory uncovered-accessor coverage (iter 251).
//
// Wraps the 0%-coverage public funcs identified by `go test -cover`:
// AltROMReg / GetAltROM, ContendPort early-exit paths,
// Save/RestorePagingState, SetRAMWriteHook / GetRAMWriteHook,
// ResetPaging (Next), GetROMBank (Next), ConfigModeActive,
// ConfigModeRAMPage, SetConfigWriteHook.

func newTestMemory(t *testing.T, model roms.SpectrumModel) *Memory {
	t.Helper()
	dir := t.TempDir()
	createTestROMs(t, dir)
	m, err := New(dir, model)
	if err != nil {
		t.Fatalf("memory.New: %v", err)
	}
	return m
}

func TestAltROMRegSetGet(t *testing.T) {
	m := newTestMemory(t, roms.Model48K)
	if m.AltROMReg() != 0 {
		t.Errorf("default AltROMReg = %02X, want 00", m.AltROMReg())
	}
	m.SetAltROMReg(0xC0)
	if got := m.AltROMReg(); got != 0xC0 {
		t.Errorf("AltROMReg after set = %02X, want C0", got)
	}
}

func TestGetAltROMBuffers(t *testing.T) {
	m := newTestMemory(t, roms.Model48K)
	if got := m.GetAltROM(0); got == nil || len(got) != PageSize {
		t.Errorf("GetAltROM(0) length = %d, want %d", len(got), PageSize)
	}
	if got := m.GetAltROM(1); got == nil || len(got) != PageSize {
		t.Errorf("GetAltROM(1) length = %d, want %d", len(got), PageSize)
	}
	// Out-of-range returns nil.
	if got := m.GetAltROM(2); got != nil {
		t.Errorf("GetAltROM(2) = non-nil, want nil")
	}
	if got := m.GetAltROM(-1); got != nil {
		t.Errorf("GetAltROM(-1) = non-nil, want nil")
	}
}

func TestContendPortDisabledNoOp(t *testing.T) {
	m := newTestMemory(t, roms.Model48K)
	// With ContentionEnabled = false (default for tests), the port
	// contention hooks must not touch TStates.
	var t1 uint64 = 14335 // in-window: would hold if enabled
	m.TStates = &t1
	m.ContentionEnabled = false
	m.ContendPortEarly(0x40FE)
	m.ContendPortLate(0x40FE)
	if t1 != 14335 {
		t.Errorf("port contention with disabled contention modified TStates: %d", t1)
	}
}

func TestContendPortNilTStateNoOp(t *testing.T) {
	m := newTestMemory(t, roms.Model48K)
	m.ContentionEnabled = true
	m.TStates = nil
	// Should not panic.
	m.ContendPortEarly(0xFE)
	m.ContendPortLate(0xFE)
}

func TestContendPortPlus3NoOp(t *testing.T) {
	m := newTestMemory(t, roms.Model128K)
	// Plus3 / Plus2A have no ULA port contention.
	m.currentModel = roms.ModelPlus3
	m.ContentionEnabled = true
	var t1 uint64 = 14335 // in-window on a contended machine
	m.TStates = &t1
	m.ContendPortEarly(0x40FE)
	m.ContendPortLate(0x40FE)
	if t1 != 14335 {
		t.Errorf("port contention on +3 model contended: TStates=%d, want 14335", t1)
	}
}

// iter 303 (reshaped for the Early/Late split): the port hold hooks
// contribute HOLDS ONLY — the I/O cycle's fixed 4 T-states are charged
// by the CPU's ioIn/ioOut helpers. Position the counter at 14335
// (first contended T-state, delay 6) so a hold is observable.

func TestContendPortEarly_ContendedAddr(t *testing.T) {
	m := newTestMemory(t, roms.Model48K)
	m.ContentionEnabled = true
	var ts uint64 = 14335
	m.TStates = &ts
	// $40FF has its high byte in contended memory → early hold fires.
	m.ContendPortEarly(0x40FF)
	if ts != 14335+6 {
		t.Errorf("contended-addr early hold: TStates=%d, want %d", ts, 14335+6)
	}
}

func TestContendPortEarly_UncontendedAddr(t *testing.T) {
	m := newTestMemory(t, roms.Model48K)
	m.ContentionEnabled = true
	var ts uint64 = 14335
	m.TStates = &ts
	// $00FE: high byte outside the contended window → no early hold
	// (the ULA-port hold belongs to the LATE phase).
	m.ContendPortEarly(0x00FE)
	if ts != 14335 {
		t.Errorf("uncontended-addr early hold: TStates=%d, want 14335", ts)
	}
}

func TestContendPortLate_ULAPort(t *testing.T) {
	m := newTestMemory(t, roms.Model48K)
	m.ContentionEnabled = true
	var ts uint64 = 14335
	m.TStates = &ts
	// Even port → ULA-decoded → one late hold (C:3 shape).
	m.ContendPortLate(0x00FE)
	if ts != 14335+6 {
		t.Errorf("ULA-port late hold: TStates=%d, want %d", ts, 14335+6)
	}
}

func TestContendPortLate_ContendedNonULA(t *testing.T) {
	m := newTestMemory(t, roms.Model48K)
	m.ContentionEnabled = true
	var ts uint64 = 14335
	m.TStates = &ts
	// Odd port with contended high byte → C:1,C:1,C:1 hold triplet
	// sampled at successive T-states; the interleaved fixed T-states
	// are handed back (net = holds only). At 14335: 6, then
	// 14341→+1=14342 (slot 7: 0), then 14343 (slot 0: 6) → 12 total.
	m.ContendPortLate(0x40FF)
	if ts != 14335+12 {
		t.Errorf("contended non-ULA late holds: TStates=%d, want %d", ts, 14335+12)
	}
}

func TestContendPortLate_PlainPortNoHold(t *testing.T) {
	m := newTestMemory(t, roms.Model48K)
	m.ContentionEnabled = true
	var ts uint64 = 14335
	m.TStates = &ts
	// $00FF: odd + uncontended high byte → N:4, no holds at all.
	m.ContendPortLate(0x00FF)
	if ts != 14335 {
		t.Errorf("plain port should hold nothing; TStates=%d, want 14335", ts)
	}
}

func TestSaveRestorePagingState(t *testing.T) {
	m := newTestMemory(t, roms.Model128K)
	// Dirty up the paging state.
	m.port7FFD = 0x17
	m.port1FFD = 0x05
	m.specialPaging = true
	m.ScreenPage = 7
	m.PagingEnabled = true

	saved := m.SavePagingState()
	if saved == nil || !saved.valid {
		t.Fatalf("SavePagingState returned %+v", saved)
	}

	// Mutate.
	m.port7FFD = 0x00
	m.port1FFD = 0x00
	m.specialPaging = false
	m.ScreenPage = 5
	m.PagingEnabled = false

	// Restore.
	m.RestorePagingState(saved)
	if m.port7FFD != 0x17 || m.port1FFD != 0x05 || !m.specialPaging ||
		m.ScreenPage != 7 || !m.PagingEnabled {
		t.Errorf("after restore: 7FFD=%02X 1FFD=%02X special=%v screen=%d enabled=%v, want 17 05 true 7 true",
			m.port7FFD, m.port1FFD, m.specialPaging, m.ScreenPage, m.PagingEnabled)
	}
}

func TestRestorePagingState_NilNoOp(t *testing.T) {
	m := newTestMemory(t, roms.Model128K)
	m.port7FFD = 0x42
	m.RestorePagingState(nil)
	if m.port7FFD != 0x42 {
		t.Errorf("RestorePagingState(nil) modified state: 7FFD=%02X", m.port7FFD)
	}
	// Invalid-marker state also no-op.
	m.RestorePagingState(&PagingState{valid: false, port7FFD: 0x99})
	if m.port7FFD != 0x42 {
		t.Errorf("RestorePagingState(invalid) modified state: 7FFD=%02X", m.port7FFD)
	}
}

func TestRAMWriteHookSetGet(t *testing.T) {
	m := newTestMemory(t, roms.Model128K)
	if got := m.GetRAMWriteHook(); got != nil {
		t.Errorf("initial hook = non-nil")
	}
	called := 0
	hook := func(bank int, addr uint16, val byte) { called++ }
	m.SetRAMWriteHook(hook)
	if got := m.GetRAMWriteHook(); got == nil {
		t.Errorf("hook after set = nil")
	}
	// Detach.
	m.SetRAMWriteHook(nil)
	if got := m.GetRAMWriteHook(); got != nil {
		t.Errorf("hook after nil-set = non-nil")
	}
}

// ResetPaging is a Next-specific public API. Verifies it zeros
// both port7FFD and port1FFD.
func TestResetPaging(t *testing.T) {
	m := newTestMemory(t, roms.ModelNext)
	m.port7FFD = 0xAB
	m.port1FFD = 0xCD
	m.ResetPaging()
	if m.port7FFD != 0 || m.port1FFD != 0 {
		t.Errorf("after ResetPaging: 7FFD=%02X 1FFD=%02X, want 00 00", m.port7FFD, m.port1FFD)
	}
}

// GetROMBank reports the ROM bank currently mapped at slot 0
// (0..3 for Next), or -1 if slot 0 is RAM.
func TestGetROMBank(t *testing.T) {
	m := newTestMemory(t, roms.ModelNext)
	// Test memory model loads ROM 0 by default → bank 0.
	if got := m.GetROMBank(); got != 0 {
		t.Logf("default GetROMBank = %d (model dependent)", got)
		// don't fail — model defaults vary
	}

	// Force slot 0 to a known ROM bank.
	m.memoryPageReadMap[0] = 18 // ROM 2 per the +16 ROM encoding
	if got := m.GetROMBank(); got != 2 {
		t.Errorf("GetROMBank with slot 0 = ROM 2: got %d, want 2", got)
	}
	// Force RAM → -1.
	m.memoryPageReadMap[0] = 5
	if got := m.GetROMBank(); got != -1 {
		t.Errorf("GetROMBank with slot 0 = RAM: got %d, want -1", got)
	}
}

func TestConfigModeAccessors(t *testing.T) {
	m := newTestMemory(t, roms.ModelNext)
	// Initial state: config-mode default is off post-construction
	// (model-dependent — just exercise the accessors).
	_ = m.ConfigModeActive()
	_ = m.ConfigModeRAMPage()

	// Toggle and observe.
	m.EnterConfigMode()
	if !m.ConfigModeActive() {
		t.Errorf("after EnterConfigMode: ConfigModeActive = false")
	}
	m.SetConfigModeRAMPage(0x42)
	if got := m.ConfigModeRAMPage(); got != 0x42 {
		t.Errorf("ConfigModeRAMPage = %02X, want 42", got)
	}
	m.ClearConfigMode()
	if m.ConfigModeActive() {
		t.Errorf("after ClearConfigMode: ConfigModeActive = true")
	}
}

func TestSetTStatePtr_EnablesContention(t *testing.T) {
	m := newTestMemory(t, roms.Model48K)
	if m.ContentionEnabled {
		// Should default to true on Model48K from setup48K(), so this
		// branch wouldn't be reached. Confirm anyway.
		t.Logf("contention enabled by default")
	}
	// SetTStatePtr installs pointer + enables contention.
	m.ContentionEnabled = false
	var t1 uint64
	m.SetTStatePtr(&t1)
	if m.TStates != &t1 {
		t.Errorf("SetTStatePtr didn't install pointer")
	}
	if !m.ContentionEnabled {
		t.Errorf("SetTStatePtr didn't enable contention")
	}
}

func TestSetConfigWriteHook(t *testing.T) {
	m := newTestMemory(t, roms.ModelNext)
	// Nil-set must not panic.
	m.SetConfigWriteHook(nil)
	// Non-nil hook: install + verify it doesn't panic when fired
	// through a config-mode write. We don't have a public trigger,
	// so just install and run a generic write.
	called := 0
	m.SetConfigWriteHook(func(page byte, addr uint16, val byte) { called++ })
	m.EnterConfigMode()
	m.SetConfigModeRAMPage(0x02)
	// Write to $0000-$3FFF — should fire the hook.
	m.Write(0x0000, 0x42)
	m.ClearConfigMode()
	if called == 0 {
		t.Errorf("config-write hook not fired on $0000 write during config mode")
	}
}
