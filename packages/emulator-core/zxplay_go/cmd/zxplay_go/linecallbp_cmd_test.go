package main

import (
	"strings"
	"testing"
)

// resetLineCallGlobals gives each test a clean slate: the armed state
// is package-level (see linecallbp_cmd.go) and would otherwise leak
// between tests.
func resetLineCallGlobals(t *testing.T) {
	t.Helper()
	lineCallAnchor.Store(0)
	lineCallBPs.Store(nil)
	lineCallStep.Store(false)
	lineCallSuppress.Store(false)
}

// atAnchor simulates the M1 fetch of the anchored per-line call with
// the given line number in HL (the --enable-break calling convention).
func atAnchor(d *remoteDebugger, anchor uint16, line uint16) bool {
	d.emu.cpu.H = byte(line >> 8)
	d.emu.cpu.L = byte(line)
	return d.checkLineCallBP(anchor)
}

func TestLineCallBP_CommandParsing(t *testing.T) {
	resetLineCallGlobals(t)
	d := newRemoteWithCPU(t)
	if got := d.cmdLineCallAnchor(nil); got != "OK linecall-anchor off" {
		t.Errorf("query unset = %q", got)
	}
	if got := d.cmdLineCallAnchor([]string{"$9333"}); got != "OK linecall-anchor $9333" {
		t.Errorf("set = %q", got)
	}
	if got := d.cmdLineCallAnchor(nil); got != "OK linecall-anchor $9333" {
		t.Errorf("query set = %q", got)
	}
	if got := d.cmdSetLineCallBP([]string{"7"}); got != "OK linecall-bp at line 7" {
		t.Errorf("set bp = %q", got)
	}
	if got := d.cmdSetLineCallBP([]string{"300"}); got != "OK linecall-bp at line 300" {
		t.Errorf("set bp 300 = %q", got)
	}
	if got := d.cmdListLineCallBPs(); got != "OK 7 300 (anchor $9333)" {
		t.Errorf("list = %q", got)
	}
	if got := d.cmdClearLineCallBP([]string{"7"}); got != "OK linecall-bp cleared at line 7" {
		t.Errorf("clear 7 = %q", got)
	}
	if got := d.cmdClearLineCallBP(nil); got != "OK linecall-bps cleared" {
		t.Errorf("clear all = %q", got)
	}
	if got := d.cmdLineCallAnchor([]string{"off"}); got != "OK linecall-anchor off" {
		t.Errorf("anchor off = %q", got)
	}
	for _, bad := range []string{"0", "65536", "abc"} {
		if got := d.cmdSetLineCallBP([]string{bad}); !strings.HasPrefix(got, "ERR bad line") {
			t.Errorf("set %q = %q, want ERR bad line", bad, got)
		}
	}
}

func TestLineCallBP_Dispatch(t *testing.T) {
	resetLineCallGlobals(t)
	d := newRemoteWithCPU(t)
	d.paused.Store(true)
	cases := []struct {
		line       string
		wantPrefix string
	}{
		{"linecall-anchor $8100", "OK linecall-anchor $8100"},
		{"set-linecall-bp 12", "OK linecall-bp at line 12"},
		{"list-linecall-bps", "OK 12 (anchor $8100)"},
		{"clear-linecall-bp 12", "OK linecall-bp cleared"},
		{"linecall-step off", "OK linecall-step disarmed"},
		{"linecall-anchor off", "OK linecall-anchor off"},
	}
	for _, c := range cases {
		if got := d.handleCommand(c.line); !strings.HasPrefix(got, c.wantPrefix) {
			t.Errorf("handleCommand(%q) = %q, want prefix %q", c.line, got, c.wantPrefix)
		}
	}
}

func TestLineCallBP_FiresOnArmedLineAtAnchorOnly(t *testing.T) {
	resetLineCallGlobals(t)
	d := newRemoteWithCPU(t)
	d.cmdLineCallAnchor([]string{"$9333"})
	d.cmdSetLineCallBP([]string{"7"})

	if atAnchor(d, 0x9000, 7) {
		t.Fatal("fired away from the anchor")
	}
	if atAnchor(d, 0x9333, 3) {
		t.Fatal("fired on an unarmed line")
	}
	if !atAnchor(d, 0x9333, 7) {
		t.Fatal("did not fire on the armed line at the anchor")
	}
	if !d.paused.Load() {
		t.Fatal("fire did not pause the CPU")
	}
}

func TestLineCallBP_SuppressesResumeRematchOnce(t *testing.T) {
	resetLineCallGlobals(t)
	d := newRemoteWithCPU(t)
	d.cmdLineCallAnchor([]string{"$9333"})
	d.cmdSetLineCallBP([]string{"7"})

	if !atAnchor(d, 0x9333, 7) {
		t.Fatal("did not fire")
	}
	// continue: paused clears, the CPU re-fetches the same anchor
	// instruction — must not re-fire.
	d.paused.Store(false)
	if atAnchor(d, 0x9333, 7) {
		t.Fatal("re-fired on the resume re-match")
	}
	// The next genuine entry to the armed line fires again.
	if !atAnchor(d, 0x9333, 7) {
		t.Fatal("did not fire on the next real line event")
	}
}

func TestLineCallBP_InertWithoutAnchor(t *testing.T) {
	resetLineCallGlobals(t)
	d := newRemoteWithCPU(t)
	d.cmdSetLineCallBP([]string{"7"})
	if atAnchor(d, 0x9333, 7) {
		t.Fatal("fired with no anchor set")
	}
	if got := d.cmdListLineCallBPs(); got != "OK 7 (no anchor - inert)" {
		t.Errorf("list = %q", got)
	}
}

func TestLineCallStep_OneShotAnyLine(t *testing.T) {
	resetLineCallGlobals(t)
	d := newRemoteWithCPU(t)
	if got := d.cmdLineCallStep(nil); got != "ERR no linecall-anchor set" {
		t.Fatalf("step without anchor = %q", got)
	}
	d.cmdLineCallAnchor([]string{"$9333"})
	d.resumeCh = make(chan struct{}, 1)
	d.paused.Store(true)
	if got := d.cmdLineCallStep(nil); got != "OK linecall-step armed" {
		t.Fatalf("arm = %q", got)
	}
	if d.paused.Load() {
		t.Fatal("linecall-step left the CPU paused")
	}
	if !atAnchor(d, 0x9333, 3) {
		t.Fatal("step did not fire at the next anchor call")
	}
	if lineCallStep.Load() {
		t.Fatal("step still armed after firing")
	}
	d.paused.Store(false)
	atAnchor(d, 0x9333, 4) // consume the resume re-match
	if atAnchor(d, 0x9333, 5) {
		t.Fatal("step fired twice")
	}
}

// Re-arming the anchor (a fresh program load) clears the one-shot
// flags, so leftovers cannot eat the new program's first hit.
func TestLineCallBP_AnchorRearmResetsOneShots(t *testing.T) {
	resetLineCallGlobals(t)
	d := newRemoteWithCPU(t)
	d.cmdLineCallAnchor([]string{"$9333"})
	d.cmdSetLineCallBP([]string{"7"})
	if !atAnchor(d, 0x9333, 7) {
		t.Fatal("did not fire")
	}
	// New build: anchor moves; suppress from the old hit must not
	// survive into the new arm.
	d.paused.Store(false)
	d.cmdLineCallAnchor([]string{"$A000"})
	if !atAnchor(d, 0xA000, 7) {
		t.Fatal("first hit after re-arm was eaten by stale suppress state")
	}
}
