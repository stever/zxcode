package memory

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
)

// The Axis 7 paging-priority conformance test (#158): one canary walk
// through every $0000-$3FFF read layer, pinning the priority order to
// the FPGA's final memory mux (zxnext.vhd:3084-3130 for the overlay
// order; :3037-3043/:3138 for the sram_pre_override term; :1856 for
// the bootrom read mask). From highest to lowest:
//
//	FPGA bootrom (read mask only)
//	> divMMC overlay (PeripheralRead — divmmc_rom_en/divmmc_ram_en first)
//	> Multiface overlay (MF + divMMC coexist; divMMC wins while paged in)
//	> Alt-ROM read redirect (UNLESS the 8K slot maps MMU RAM —
//	  sram_pre_override)
//	> config-mode RAMPAGE window
//	> MMU8 slot override
//	> classic ROM dispatch
//
// Each layer holds a distinctive canary byte; enabling a higher layer
// must change what the CPU reads, disabling it must reveal the next.
func TestNextPagingReadPriority(t *testing.T) {
	m, err := New("", roms.ModelNext)
	if err != nil {
		t.Fatal(err)
	}
	const probe = 0x0100

	read := func() byte { return m.Read(probe) }
	assert := func(want byte, layer string) {
		t.Helper()
		if got := read(); got != want {
			t.Errorf("%s: read = $%02X, want $%02X", layer, got, want)
		}
	}

	// Bottom: classic ROM dispatch (the embedded fallback ROM —
	// capture its byte as the baseline canary).
	classicROM := read()

	// Stage the Alt-ROM canary first (write redirect, bit 6), with no
	// higher layer active, then disarm. Reads stay classic meanwhile.
	m.SetAltROMReg(0xC0)
	m.Write(probe, 0x22)
	m.SetAltROMReg(0x00)
	assert(classicROM, "classic ROM after staging the Alt-ROM canary")

	// MMU8: map a RAM bank over slot 0 and plant a canary.
	m.SetMMU(0, 20)
	m.Write(probe, 0x11)
	assert(0x11, "MMU RAM over classic ROM")

	// Arm the Alt-ROM read redirect: the MMU-mapped RAM slot outranks
	// it (sram_pre_override(0)='0' in the MMU branch, vhd:3037-3043 →
	// sram_altrom_en killed, :3078).
	m.SetAltROMReg(0x80)
	assert(0x11, "MMU RAM outranks the Alt-ROM redirect")
	m.SetMMU(0, 0xFF) // slot back to ROM half → redirect shows
	assert(0x22, "Alt-ROM read redirect over classic ROM")

	// Config-mode RAMPAGE window: outranks the Alt-ROM redirect for
	// reads AND writes (the config branch also clears
	// sram_pre_override(0), vhd:3044-3050). RAMPAGE $30 = plain RAM
	// bank $20 (configModePageBacking) — pages $00-$03 alias the
	// classic ROM images themselves (that is how boot.bin installs
	// them), which would corrupt the baseline canary.
	m.EnterConfigMode()
	m.SetConfigModeRAMPage(0x30)
	m.SetAltROMReg(0xC0) // write-redirect armed — config must win anyway
	m.Write(probe, 0x33)
	m.SetAltROMReg(0x80)
	assert(0x33, "config-mode RAMPAGE over Alt-ROM")

	// Multiface overlay: outranks config mode and Alt-ROM.
	mfROM := make([]byte, 0x2000)
	mfROM[probe] = 0x44
	m.SetMultifaceROM(mfROM)
	m.SetMultifaceActive(true)
	assert(0x44, "Multiface overlay over config mode")

	// divMMC overlay (the PeripheralRead hook the pager installs):
	// divmmc_rom_en/divmmc_ram_en are tested FIRST in the FPGA mux
	// (vhd:3084-3130) — above the Multiface.
	divPaged := true
	m.PeripheralRead = func(addr uint16) (byte, bool) {
		if divPaged && addr < 0x4000 {
			return 0x55, true
		}
		return 0, false
	}
	assert(0x55, "divMMC overlay over Multiface")

	// FPGA bootrom: the read mask over everything (vhd:1856).
	boot := make([]byte, 0x2000)
	boot[probe] = 0x66
	m.SetFPGABootROM(boot)
	assert(0x66, "FPGA bootrom over divMMC")

	// Unwind top-down: each layer's removal reveals the next.
	m.ClearFPGABootROM()
	assert(0x55, "divMMC after bootrom cleared")
	divPaged = false
	assert(0x44, "Multiface after divMMC paged out")
	m.SetMultifaceActive(false)
	assert(0x33, "config mode after Multiface out")
	m.ClearConfigMode()
	assert(0x22, "Alt-ROM redirect after config exit (the config-mode write did not clobber the Alt-ROM buffer)")
	m.SetAltROMReg(0x00)
	assert(classicROM, "classic ROM after Alt-ROM disarmed")
}

// TestNextPagingBootromWritesFallThrough pins the bootrom WRITE
// behaviour: bootrom_en gates only the READ mux (zxnext.vhd:1856);
// with config mode active the write lands in the RAMPAGE window
// (boot.bin streams its images there while the bootrom still masks
// reads), and with config mode off a ROM-area write is dropped.
func TestNextPagingBootromWritesFallThrough(t *testing.T) {
	m, err := New("", roms.ModelNext)
	if err != nil {
		t.Fatal(err)
	}
	const probe = 0x0180
	boot := make([]byte, 0x2000)
	boot[probe] = 0x66
	m.SetFPGABootROM(boot)
	m.EnterConfigMode()
	m.SetConfigModeRAMPage(0)

	m.Write(probe, 0x33) // must land in the config page despite the bootrom
	if got := m.Read(probe); got != 0x66 {
		t.Errorf("bootrom read mask = $%02X, want $66", got)
	}
	m.ClearFPGABootROM()
	if got := m.Read(probe); got != 0x33 {
		t.Errorf("config page after bootrom clear = $%02X, want $33 (write fell through)", got)
	}

	// Config off + bootrom on: ROM-area writes are dropped.
	m.RearmFPGABootROM()
	m.ClearConfigMode()
	m.Write(probe, 0x77)
	m.ClearFPGABootROM()
	m.EnterConfigMode()
	if got := m.Read(probe); got != 0x33 {
		t.Errorf("config page = $%02X, want $33 (ROM-area write with config off must drop)", got)
	}
}
