package main

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// plus3dosProgram wraps tokenised +3 BASIC program bytes in a PLUS3DOS
// header with an autostart line, mirroring what the site's txt2bas emits
// (and the header layout used by neutralAutoexec).
func plus3dosProgram(prog []byte, autostartLine int) []byte {
	out := make([]byte, 128+len(prog))
	copy(out, "PLUS3DOS")
	out[8] = 0x1A
	out[9] = 1
	total := len(out)
	out[11] = byte(total)
	out[12] = byte(total >> 8)
	out[13] = byte(total >> 16)
	out[14] = byte(total >> 24)
	out[15] = 0 // +3 BASIC header: type 0 = Program
	out[16] = byte(len(prog))
	out[17] = byte(len(prog) >> 8)
	out[18] = byte(autostartLine)
	out[19] = byte(autostartLine >> 8)
	out[20] = out[16]
	out[21] = out[17] // vars offset = program length
	sum := 0
	for i := 0; i < 127; i++ {
		sum += int(out[i])
	}
	out[127] = byte(sum)
	copy(out[128:], prog)
	return out
}

// minimalNex builds the smallest valid .NEX V1.2: no loading screens, one
// 16K bank (bank 0, mapped at $C000 as the entry bank) whose first bytes are
// the program. The genuine NextZXOS .nexload dot command parses this.
func minimalNex(code []byte) []byte {
	out := make([]byte, 512+16384)
	copy(out, "NextV1.2")
	out[9] = 1                    // one bank in the file
	out[12], out[13] = 0xFE, 0xBF // SP $BFFE
	out[14], out[15] = 0x00, 0xC0 // PC $C000
	out[18] = 1                   // BankLoad[0]: bank 0 present
	out[139] = 0                  // entry bank 0 at $C000
	copy(out[512:], code)
	return out
}

// TestImportAndRunNexCycle mirrors TestImportAndRunBasCycle for the .nex
// route: importAndRunNex writes /zx.nex to the in-memory SD card, reboots,
// and the macro drives the genuine `.nexload` dot command — the path the
// site uses for sjasmplus/z88dk output. The loaded code POKEs a sentinel,
// proving the divMMC dot-command machinery works end to end under whichever
// boot mode the environment selects.
func TestImportAndRunNexCycle(t *testing.T) {
	prev := cliFlagsActive
	nf := cliFlags{}
	if prev != nil {
		nf = *prev
	}
	nf.noSound = true
	cliFlagsActive = &nf
	t.Cleanup(func() { cliFlagsActive = prev })

	emu, err := newNextEmulator()
	if err != nil {
		t.Skipf("Next ROMs not installed: %v", err)
	}
	if emu.sdImageSrc == nil {
		t.Skip("no SD image mounted (set ZX_GO_NEXT_SD_IMG); the load path needs one")
	}

	// LD A,123 ; LD ($8000),A ; JR $ — running at $C000, writes bank 2[0].
	emu.importAndRunNex("zx.nex", minimalNex([]byte{0x3E, 0x7B, 0x32, 0x00, 0x80, 0x18, 0xFE}))
	if emu.nexloadMacro == nil {
		t.Fatal("importAndRunNex did not arm the nexload macro")
	}

	sentinel := emu.mem.GetPage(2)
	sentinel[0] = 0

	const maxFrames = 6000
	frame := 0
	for ; frame < maxFrames && sentinel[0] != 123; frame++ {
		emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		if emu.kbd != nil {
			emu.kbd.Tick()
		}
		if emu.nexloadMacro != nil && emu.nexloadMacro.tick(emu) {
			emu.nexloadMacro = nil
		}
		emu.noteBootFrame()
	}
	if sentinel[0] != 123 {
		t.Fatalf(".nex never ran: bank2[0]=%d after %d frames (PC=%#04x, macro done=%v)",
			sentinel[0], frame, emu.cpu.PC, emu.nexloadMacro == nil)
	}
	t.Logf(".nex delivered and launched after %d frames", frame)
}

// TestPutSDFileRuntimeLoad drives the runtime-asset side of the BAS delivery:
// putSDFile stages a raw (headerless) project file at the card root — as the
// site does for a NextBASIC project's extra files — and the delivered program
// LOADs it by its relative name at runtime. The loaded bytes landing at $8000
// prove both the staging write and that root-relative names resolve from the
// command-line LOAD context.
func TestPutSDFileRuntimeLoad(t *testing.T) {
	prev := cliFlagsActive
	nf := cliFlags{}
	if prev != nil {
		nf = *prev
	}
	nf.noSound = true
	cliFlagsActive = &nf
	t.Cleanup(func() { cliFlagsActive = prev })

	emu, err := newNextEmulator()
	if err != nil {
		t.Skipf("Next ROMs not installed: %v", err)
	}
	if emu.sdImageSrc == nil {
		t.Skip("no SD image mounted (set ZX_GO_NEXT_SD_IMG); the load path needs one")
	}

	if err := emu.putSDFile("bad name that cannot fit 8.3.spr", []byte{1}); err == nil {
		t.Fatal("putSDFile accepted a name that does not fit 8.3")
	}

	asset := []byte{123, 45, 67}
	if err := emu.putSDFile("spr.bin", asset); err != nil {
		t.Fatalf("putSDFile: %v", err)
	}

	// 10 LOAD "spr.bin" CODE 32768 — tokenised +3 BASIC.
	prog := []byte{
		0x00, 0x0A, // line 10 (big-endian)
		0x17, 0x00, // line length 23 (little-endian)
		0xEF, // LOAD
		'"', 's', 'p', 'r', '.', 'b', 'i', 'n', '"',
		0xAF,                    // CODE
		'3', '2', '7', '6', '8', // 32768
		0x0E, 0x00, 0x00, 0x00, 0x80, 0x00,
		0x0D,
	}
	if err := emu.importAndRunBas(plus3dosProgram(prog, 10)); err != nil {
		t.Fatalf("importAndRunBas: %v", err)
	}

	sentinel := emu.mem.GetPage(2)
	sentinel[0], sentinel[1], sentinel[2] = 0, 0, 0

	const maxFrames = 6000
	frame := 0
	for ; frame < maxFrames && sentinel[0] != 123; frame++ {
		emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		if emu.kbd != nil {
			emu.kbd.Tick()
		}
		if emu.nexloadMacro != nil && emu.nexloadMacro.tick(emu) {
			emu.nexloadMacro = nil
		}
		emu.noteBootFrame()
	}
	if sentinel[0] != 123 || sentinel[1] != 45 || sentinel[2] != 67 {
		t.Fatalf("asset never loaded: bank2[0:3]=%v after %d frames (PC=%#04x, macro done=%v)",
			sentinel[0:3], frame, emu.cpu.PC, emu.nexloadMacro == nil)
	}
	t.Logf("staged asset LOADed at runtime after %d frames", frame)
}

// TestPutSDFileFolderRuntimeLoad is the project-folders variant of the
// runtime-asset test: putSDFile stages a file under a subdirectory (creating
// it on the card) and the delivered program LOADs it by the same relative
// path — the layout a project's download ZIP produces when unzipped onto a
// real card. Also checks that a directory segment that cannot fit 8.3 is
// rejected up front (directory lookup is by 8.3 short name, so a ~ alias
// would silently never match the program's literal path).
func TestPutSDFileFolderRuntimeLoad(t *testing.T) {
	prev := cliFlagsActive
	nf := cliFlags{}
	if prev != nil {
		nf = *prev
	}
	nf.noSound = true
	cliFlagsActive = &nf
	t.Cleanup(func() { cliFlagsActive = prev })

	emu, err := newNextEmulator()
	if err != nil {
		t.Skipf("Next ROMs not installed: %v", err)
	}
	if emu.sdImageSrc == nil {
		t.Skip("no SD image mounted (set ZX_GO_NEXT_SD_IMG); the load path needs one")
	}

	if err := emu.putSDFile("toolongdirname99/spr.bin", []byte{1}); err == nil {
		t.Fatal("putSDFile accepted a directory that does not fit 8.3")
	}
	if err := emu.putSDFile("gfx//spr.bin", []byte{1}); err == nil {
		t.Fatal("putSDFile accepted an empty path segment")
	}

	asset := []byte{123, 45, 67}
	if err := emu.putSDFile("gfx/spr.bin", asset); err != nil {
		t.Fatalf("putSDFile: %v", err)
	}

	// 10 LOAD "gfx/spr.bin" CODE 32768 — tokenised +3 BASIC.
	prog := []byte{
		0x00, 0x0A, // line 10 (big-endian)
		0x1B, 0x00, // line length 27 (little-endian)
		0xEF, // LOAD
		'"', 'g', 'f', 'x', '/', 's', 'p', 'r', '.', 'b', 'i', 'n', '"',
		0xAF,                    // CODE
		'3', '2', '7', '6', '8', // 32768
		0x0E, 0x00, 0x00, 0x00, 0x80, 0x00,
		0x0D,
	}
	if err := emu.importAndRunBas(plus3dosProgram(prog, 10)); err != nil {
		t.Fatalf("importAndRunBas: %v", err)
	}

	sentinel := emu.mem.GetPage(2)
	sentinel[0], sentinel[1], sentinel[2] = 0, 0, 0

	const maxFrames = 6000
	frame := 0
	for ; frame < maxFrames && sentinel[0] != 123; frame++ {
		emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		if emu.kbd != nil {
			emu.kbd.Tick()
		}
		if emu.nexloadMacro != nil && emu.nexloadMacro.tick(emu) {
			emu.nexloadMacro = nil
		}
		emu.noteBootFrame()
	}
	if sentinel[0] != 123 || sentinel[1] != 45 || sentinel[2] != 67 {
		t.Fatalf("folder asset never loaded: bank2[0:3]=%v after %d frames (PC=%#04x, macro done=%v)",
			sentinel[0:3], frame, emu.cpu.PC, emu.nexloadMacro == nil)
	}
	t.Logf("folder-staged asset LOADed at runtime after %d frames", frame)
}

// TestImportAndRunBasCycle drives the site's full compile-and-run delivery
// end to end: importAndRunBas writes the program to the in-memory SD card,
// reboots, and its keystroke macro types `load "/zx.bas"` at the NextZXOS
// command line; the autostart line then RUNs it. The program POKEs a
// sentinel into bank 2, proving the whole chain executed. Frames are driven
// exactly as the wasm zxFrame path does (per-frame macro tick +
// noteBootFrame), so this also covers the boot fast-forward bookkeeping
// through a real macro run. It runs under whichever boot mode the
// environment selects — the default FPGA-bootrom path, or direct-core boot
// with ZX_GO_NO_FPGA_BOOTROM=1 + ZX_GO_NEXT_DIRECT_BOOT=1.
func TestImportAndRunBasCycle(t *testing.T) {
	prev := cliFlagsActive
	nf := cliFlags{}
	if prev != nil {
		nf = *prev
	}
	nf.noSound = true
	cliFlagsActive = &nf
	t.Cleanup(func() { cliFlagsActive = prev })

	emu, err := newNextEmulator()
	if err != nil {
		t.Skipf("Next ROMs not installed: %v", err)
	}
	if emu.sdImageSrc == nil {
		t.Skip("no SD image mounted (set ZX_GO_NEXT_SD_IMG); the load path needs one")
	}

	// 10 POKE 32768,123 — tokenised +3 BASIC. Numbers are ASCII digits
	// followed by the 5-byte integer form ($0E 00 sign lo hi 00).
	prog := []byte{
		0x00, 0x0A, // line 10 (big-endian)
		0x17, 0x00, // line length 23 (little-endian)
		0xF4,                    // POKE
		'3', '2', '7', '6', '8', // 32768
		0x0E, 0x00, 0x00, 0x00, 0x80, 0x00,
		0x2C,          // ,
		'1', '2', '3', // 123
		0x0E, 0x00, 0x00, 0x7B, 0x00, 0x00,
		0x0D,
	}
	if err := emu.importAndRunBas(plus3dosProgram(prog, 10)); err != nil {
		t.Fatalf("importAndRunBas: %v", err)
	}
	if emu.nexloadMacro == nil {
		t.Fatal("importAndRunBas did not arm the command-line macro")
	}

	sentinel := emu.mem.GetPage(2)
	sentinel[0] = 0

	// Drive frames the way wasm_js.go zxFrame does. Generous cap: boot +
	// typing is ~700-1000 frames depending on boot mode, plus load/run.
	const maxFrames = 6000
	frame := 0
	for ; frame < maxFrames && sentinel[0] != 123; frame++ {
		emu.cpu.ExecuteFrame(frameTStatesForModel(roms.ModelNext))
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		if emu.kbd != nil {
			emu.kbd.Tick()
		}
		if emu.nexloadMacro != nil && emu.nexloadMacro.tick(emu) {
			emu.nexloadMacro = nil
		}
		emu.noteBootFrame()
	}
	if sentinel[0] != 123 {
		t.Fatalf("program never ran: bank2[0]=%d after %d frames (PC=%#04x, macro done=%v)",
			sentinel[0], frame, emu.cpu.PC, emu.nexloadMacro == nil)
	}
	t.Logf("program delivered and RUN after %d frames", frame)
}
