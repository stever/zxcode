package testharness

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
)

// These tests run Patrik Rak's z80test suite v1.2a (raxoft/z80test, MIT;
// provenance in testdata/z80test/). Each program computes a CRC over an
// exhaustive run of every instruction and compares it against values
// captured from a real 48K Spectrum with a Zilog Z80, printing a per-test
// verdict and a final summary line. Stricter than zexall: the ccf variant
// needs the flags-after-SCF/CCF behaviour (the Q register), and the
// memptr variant needs full MEMPTR emulation via BIT n,(HL).
//
// The taps carry the standard loader (CLEAR 32767 : LOAD "" CODE :
// RANDOMIZE USR 32768); the harness loads the CODE block directly and
// calls the entry the same way, with the return address parked on a
// self-jump so the result screen survives the final RET.

const (
	z80testEntry = 0x8000
	z80testPark  = 0x7F00 // JR $ — where the suite's final RET lands
)

// tapCodeBlock returns the payload and load address of the first CODE
// block in a .tap file.
func tapCodeBlock(t *testing.T, path string) (data []byte, addr uint16) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var wantLen, wantAddr uint16
	for i := 0; i+2 <= len(raw); {
		n := int(binary.LittleEndian.Uint16(raw[i:]))
		i += 2
		if i+n > len(raw) {
			t.Fatalf("truncated tap block at %d", i)
		}
		blk := raw[i : i+n]
		i += n
		if len(blk) < 2 {
			continue
		}
		switch {
		case blk[0] == 0x00 && len(blk) >= 18 && blk[1] == 3: // CODE header
			wantLen = binary.LittleEndian.Uint16(blk[12:14])
			wantAddr = binary.LittleEndian.Uint16(blk[14:16])
		case blk[0] == 0xFF && wantLen > 0 && len(blk) == int(wantLen)+2:
			return blk[1 : len(blk)-1], wantAddr
		}
	}
	t.Fatalf("no CODE block found in %s", path)
	return nil, 0
}

// runZ80Test boots a 48K to BASIC, injects the tap's CODE block, and
// calls the entry point the way RANDOMIZE USR does. It returns once the
// program prints its summary line ("Result:" wording per v1.2a) or the
// frame budget runs out.
func runZ80Test(t *testing.T, tap string, maxFrames int) *Harness {
	t.Helper()
	if testing.Short() {
		t.Skip("z80test variants take minutes of emulated time; skipped under -short like zexall")
	}
	h, err := New(roms.Model48K)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.CloseFiles)
	if _, err := h.RunUntilText("1982", 600); err != nil {
		t.Fatalf("48K did not boot to BASIC: %v", err)
	}
	h.RunFrames(5) // settle: banner detected mid-print on a contended boot
	data, addr := tapCodeBlock(t, filepath.Join("testdata", "z80test", tap))
	for i, b := range data {
		h.WriteMemory(addr+uint16(i), b)
	}
	// Park the final RET on a self-jump so the result screen persists.
	h.WriteMemory(z80testPark, 0x18)   // JR
	h.WriteMemory(z80testPark+1, 0xFE) // -2
	cpu := h.CPU()
	cpu.SP = z80testPark - 2
	h.WriteMemory(cpu.SP, byte(z80testPark&0xFF))
	h.WriteMemory(cpu.SP+1, byte(z80testPark>>8))
	cpu.PC = z80testEntry
	// Run until the summary line, defeating the ROM's "scroll?" prompt by
	// topping up the SCR-CT system variable ($5C8C) every frame.
	for frame := 0; frame < maxFrames; frame += 10 {
		h.WriteMemory(0x5C8C, 0xFF)
		h.RunFrames(10)
		if strings.Contains(h.ScreenText(), "Result:") {
			return h
		}
	}
	t.Fatalf("no result summary after %d frames\nscreen:\n%s", maxFrames, h.ScreenText())
	return nil
}

// assertZ80Test passes on a clean run and otherwise either fails or
// skips with the documented-gap reference, depending on expectation.
func assertZ80Test(t *testing.T, h *Harness, knownGap string) {
	t.Helper()
	text := h.ScreenText()
	line := screenLine(text, "Result:")
	if strings.Contains(line, "all tests passed") {
		return
	}
	if knownGap != "" {
		t.Skipf("known gap: %s — %q (see known-gaps.md, ZX Play #141)", knownGap, strings.TrimSpace(line))
	}
	t.Fatalf("z80test reported failures: %q\nscreen:\n%s", strings.TrimSpace(line), text)
}

func TestZ80TestDoc(t *testing.T) {
	h := runZ80Test(t, "z80doc.tap", 40000)
	assertZ80Test(t, h, "")
}

func TestZ80TestDocFlags(t *testing.T) {
	h := runZ80Test(t, "z80docflags.tap", 40000)
	assertZ80Test(t, h, "")
}

// The flags/full/ccf variants exercise the Q register (SCF/CCF
// YF/XF), the full OUTx flag model, and the block-repeat flag effects
// — all implemented in pkg/z80 (qflags.go, blockRepeatFlags) and
// asserted hard here as regression guards.
func TestZ80TestFlags(t *testing.T) {
	h := runZ80Test(t, "z80flags.tap", 40000)
	assertZ80Test(t, h, "")
}

func TestZ80TestFull(t *testing.T) {
	h := runZ80Test(t, "z80full.tap", 40000)
	assertZ80Test(t, h, "")
}

func TestZ80TestCcf(t *testing.T) {
	h := runZ80Test(t, "z80ccf.tap", 40000)
	assertZ80Test(t, h, "")
}

// The memptr variant passes outright — MEMPTR emulation is deeper than
// the "zexall depth" wording in pkg/z80 suggests.
func TestZ80TestMemptr(t *testing.T) {
	h := runZ80Test(t, "z80memptr.tap", 40000)
	assertZ80Test(t, h, "")
}
