package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestApplyLaunchFile covers the extension→model table, the explicit-flag
// override, the --tape/--trd ride-along, and rejection of unknown or
// missing files.
func TestApplyLaunchFile(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte{0}, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	t.Run("model per extension", func(t *testing.T) {
		cases := []struct {
			name  string
			check func(f *cliFlags) bool
		}{
			{"game.nex", func(f *cliFlags) bool { return f.startInNext }},
			{"disk.trd", func(f *cliFlags) bool { return f.startInPentagon && f.trdPath != "" }},
			{"prog.p", func(f *cliFlags) bool { return f.startInZX81 }},
			{"prog.81", func(f *cliFlags) bool { return f.startInZX81 }},
			{"prog.o", func(f *cliFlags) bool { return f.startInZX80 }},
			{"prog.80", func(f *cliFlags) bool { return f.startInZX80 }},
			{"game.tap", func(f *cliFlags) bool {
				return f.tape != "" && !f.startInNext && !f.startInPentagon
			}},
			{"game.TZX", func(f *cliFlags) bool { return f.tape != "" }}, // case-insensitive
			{"snap.z80", func(f *cliFlags) bool {
				// Snapshots pick their model at load time (the file knows).
				return !f.startInNext && !f.startInZX81 && f.tape == ""
			}},
		}
		for _, c := range cases {
			f := &cliFlags{}
			p := mk(c.name)
			if err := applyLaunchFile(f, p); err != nil {
				t.Fatalf("%s: %v", c.name, err)
			}
			if f.launchFile != p {
				t.Errorf("%s: launchFile = %q, want %q", c.name, f.launchFile, p)
			}
			if !c.check(f) {
				t.Errorf("%s: flags not derived as expected: %+v", c.name, f)
			}
		}
	})

	t.Run("explicit model flag wins", func(t *testing.T) {
		f := &cliFlags{startInPentagon: true}
		if err := applyLaunchFile(f, mk("other.nex")); err != nil {
			t.Fatal(err)
		}
		if f.startInNext {
			t.Error(".nex overrode an explicit --pentagon")
		}
	})

	t.Run("explicit --trd wins over positional .trd", func(t *testing.T) {
		f := &cliFlags{trdPath: "flag.trd"}
		if err := applyLaunchFile(f, mk("pos.trd")); err != nil {
			t.Fatal(err)
		}
		if f.trdPath != "flag.trd" {
			t.Errorf("trdPath = %q, want the flag's disk", f.trdPath)
		}
	})

	t.Run("unknown extension rejected", func(t *testing.T) {
		err := applyLaunchFile(&cliFlags{}, mk("file.wav"))
		if err == nil || !strings.Contains(err.Error(), "unsupported file type") {
			t.Errorf("want unsupported-type error, got %v", err)
		}
	})

	t.Run("missing file rejected", func(t *testing.T) {
		if err := applyLaunchFile(&cliFlags{}, filepath.Join(dir, "absent.tap")); err == nil {
			t.Error("want error for missing file")
		}
	})
}
