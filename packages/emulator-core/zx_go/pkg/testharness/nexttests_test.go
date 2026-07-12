package testharness

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// These tests run the vendored classic-machine (.sna) test programs from
// MrKWatkins/ZXSpectrumNextTests (MIT; provenance and licence in
// testdata/nexttests/). Each program self-reports on the Spectrum screen;
// assertions OCR the screen (ScreenText) and pin the verdicts to the
// suite's real-hardware reference photographs.
//
// Where the program exposes a behaviour zx_go knowingly lacks, the test
// SKIPS with the gap reference instead of failing, so the suite stays
// green while the conformance dashboard shows the row as a documented
// gap (docs/architecture/known-gaps.md). If the gap gets fixed the skip
// turns into a hard assertion failure-on-regression by flipping the
// branch below.

func runNexttestsSNA(t *testing.T, name string, frames int) *Harness {
	t.Helper()
	h, err := New(roms.Model48K)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.CloseFiles)
	// The block-flags test probes the Kempston port ($1F) expecting
	// bit 7 low; without the interface the floating bus answers.
	h.ULA().KempstonEnabled = true
	if err := h.LoadSnapshot(filepath.Join("testdata", "nexttests", name)); err != nil {
		t.Fatal(err)
	}
	h.RunFrames(frames)
	return h
}

func screenLine(text, marker string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, marker) {
			return line
		}
	}
	return ""
}

// TestNexttestsZ80BlockFlags — flags of IM2-interrupted repeating block
// instructions (LDxR/CPxR/INxR/OTxR), per David Banks's research. The
// program prints expected=measured pairs; on real hardware
// (z80_block_flags_test_v5_shrek_zx128.jpg) every pair matches, giving
// four '=' per result row.
func TestNexttestsZ80BlockFlags(t *testing.T) {
	h := runNexttestsSNA(t, "z80bltst.sna", 400)
	text := h.ScreenText()
	rows := 0
	mismatched := 0
	for _, line := range strings.Split(text, "\n") {
		if !strings.Contains(line, " F: ") {
			continue
		}
		rows++
		if strings.Count(line, "=") != 4 {
			mismatched++
		}
	}
	if rows < 15 {
		t.Fatalf("expected at least 15 result rows, OCR found %d:\n%s", rows, text)
	}
	if mismatched > 0 {
		t.Fatalf("interrupted-block-instruction flags diverge from real hardware "+
			"in %d of %d rows (blockRepeatFlags regression):\n%s", mismatched, rows, text)
	}
}

// TestNexttestsZ80IntSkipBasics — the parts of the interrupt-acceptance
// test zx_go must get right today: NOP blocks accept ~one interrupt per
// frame, DI inhibits completely, SCF/CCF chains behave, and LD A,I / LD
// A,R read IFF2 as one during the interrupt window.
func TestNexttestsZ80IntSkipBasics(t *testing.T) {
	h := runNexttestsSNA(t, "int_skip.sna", 400)
	text := h.ScreenText()
	if line := screenLine(text, "NOP"); !strings.Contains(line, "5") {
		t.Errorf("NOP benchmark row missing or implausible: %q", line)
	}
	if line := screenLine(text, "DI "); !strings.Contains(line, "|   0 |OK") {
		t.Errorf("DI row should count 0 with OK verdict: %q", line)
	}
	if line := screenLine(text, "SCF+CCF"); !strings.Contains(line, "OK") {
		t.Errorf("SCF+CCF row should be OK: %q", line)
	}
	for _, want := range []string{"LD A,I IFF2 reading: correct", "LD A,R IFF2 reading: correct"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q", want)
		}
	}
	if t.Failed() {
		t.Logf("screen text:\n%s", text)
	}
}

// TestNexttestsZ80IntSkipInhibition — interrupt acceptance must be
// inhibited after DD/FD prefix bytes and across EI chains (a narrow
// /INT pulse expiring inside the block is missed, never delivered
// late), and the level-triggered pulse must re-enter the ISR at least
// twice per signal. Implemented via the classic narrow-pulse frame INT
// (frameIntPulse); hard regression guard.
func TestNexttestsZ80IntSkipInhibition(t *testing.T) {
	h := runNexttestsSNA(t, "int_skip.sna", 400)
	text := h.ScreenText()
	var errs []string
	for _, block := range []string{"DD ", "FD ", "DDFD", "EI "} {
		if line := screenLine(text, block); strings.Contains(line, "ERR") {
			errs = append(errs, fmt.Sprintf("%s block allows ISR", strings.TrimSpace(block)))
		}
	}
	if line := screenLine(text, "ISR entries"); strings.Contains(line, ": 1") || strings.Contains(line, ":  1") {
		errs = append(errs, "only 1 ISR entry per /INT signal (hardware: 2+ while the pulse holds)")
	}
	if len(errs) > 0 {
		t.Fatalf("interrupt-window regression: %s\nscreen:\n%s", strings.Join(errs, "; "), text)
	}
}

// TestNexttestsCcfScfStability — SCF/CCF outcomes must be deterministic
// frame over frame (a random-flags CPU shows an error square and drops
// the "No error" report).
func TestNexttestsCcfScfStability(t *testing.T) {
	h := runNexttestsSNA(t, "ccffrm.sna", 400)
	if text := h.ScreenText(); !strings.Contains(text, "No error") {
		t.Fatalf("expected the 'No error' verdict:\n%s", text)
	}
}

// TestNexttestsDIHalt — HALT with interrupts disabled must hang forever:
// the program sets the border green, executes DI + HALT, and would set
// the border red if execution ever continued.
func TestNexttestsDIHalt(t *testing.T) {
	h := runNexttestsSNA(t, "DIHalt.sna", 400)
	const green = 4
	if got := h.ULA().BorderColour; got != green {
		t.Fatalf("border = %d, want %d (green): DI+HALT must never resume", got, green)
	}
	h.RunFrames(200)
	if got := h.ULA().BorderColour; got != green {
		t.Fatalf("border = %d after further frames, want %d (green)", got, green)
	}
}
