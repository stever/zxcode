package main

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/stever/zxplay_go/pkg/next/nex"
	"github.com/stever/zxplay_go/pkg/roms"
	"github.com/stever/zxplay_go/pkg/rzx"
	"github.com/stever/zxplay_go/pkg/snapshot"
)

// launchExts lists every extension the positional-file launcher accepts,
// lowercase with the leading dot. Kept in sync with applyLaunchFile's
// switch and the dispatchers (dispatchLaunchFile in gui_desktop.go,
// runHeadless's launch block); also the source of truth for the MIME
// globs in desktop/zxplay_go-mime.xml.
var launchExts = []string{
	".tap", ".tzx", // tape images (auto-typed LOAD)
	".z80", ".sna", ".szx", // snapshots (model from the file)
	".rzx",      // input recordings
	".nex",      // Spectrum Next programs
	".trd",      // TR-DOS disks (Pentagon)
	".p", ".81", // ZX81 programs
	".o", ".80", // ZX80 programs
}

// applyLaunchFile validates the positional file argument and derives
// startup settings from its extension. An explicit model flag always
// wins — `zxplay_go --pentagon game.tap` boots the Pentagon — otherwise the
// extension picks the machine a double-clicked file needs (.nex can only
// run on the Next, .p only on the ZX81, …). Tape and TR-DOS files ride
// the existing --tape / --trd startup paths; everything else is kept in
// f.launchFile for the post-boot dispatcher.
func applyLaunchFile(f *cliFlags, path string) error {
	ext := strings.ToLower(filepath.Ext(path))
	supported := false
	for _, e := range launchExts {
		if ext == e {
			supported = true
			break
		}
	}
	if !supported {
		return fmt.Errorf("%s: unsupported file type %q (supported: %s)", path, ext, strings.Join(launchExts, " "))
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}

	modelChosen := f.startInNext || f.startInZX81 || f.startInZX80 || f.startInPentagon || f.startInSAM
	switch ext {
	case ".nex":
		if !modelChosen {
			f.startInNext = true
		}
	case ".trd":
		if !modelChosen {
			f.startInPentagon = true
		}
		// Same startup path as --trd (mounts in Beta drive A). An explicit
		// --trd alongside the positional file keeps the flag's disk.
		if f.trdPath == "" {
			f.trdPath = path
		}
	case ".p", ".81":
		if !modelChosen {
			f.startInZX81 = true
		}
	case ".o", ".80":
		if !modelChosen {
			f.startInZX80 = true
		}
	case ".tap", ".tzx":
		// Headless rides the --tape startup path (mount + play; the
		// LD-BYTES trap serves the blocks). The GUI dispatcher instead
		// uses loadAndRunTape, which also types the LOAD command.
		if f.tape == "" {
			f.tape = path
		}
	}
	f.launchFile = path
	return nil
}

// launchSnapshotModel peeks at a positional snapshot file to pick the
// start model (48K vs 128K) for headless runs, where the GUI's dynamic
// model switch isn't available. Returns ok=false for non-snapshot files
// or unreadable snapshots — the caller keeps its default then.
func launchSnapshotModel(path string) (roms.SpectrumModel, bool) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".z80", ".sna", ".szx":
	default:
		return 0, false
	}
	snap := snapshot.New()
	if err := snap.Load(path); err != nil {
		return 0, false
	}
	if snap.Memory.Is128K {
		return roms.Model128K, true
	}
	return roms.Model48K, true
}

// dispatchLaunchFileHeadless routes the positional file once the headless
// emulator exists. Tape and TR-DOS files were already handled through the
// --tape/--trd startup paths; this covers the rest with the same loaders
// the GUI dispatcher uses, minus the dialogs.
func dispatchLaunchFileHeadless(emu *emulator, path string) error {
	switch ext := strings.ToLower(filepath.Ext(path)); ext {
	case ".tap", ".tzx", ".trd":
		return nil // already mounted via the startup flags
	case ".z80", ".sna", ".szx":
		snap := snapshot.New()
		if err := snap.Load(path); err != nil {
			return fmt.Errorf("load snapshot: %w", err)
		}
		if err := applySnapshotToEmulator(emu, snap); err != nil {
			return fmt.Errorf("apply snapshot: %w", err)
		}
		slog.Info("headless: snapshot loaded", "format", getFormatName(snap.Format), "is128k", snap.Memory.Is128K, "path", path)
		return nil
	case ".rzx":
		file, err := rzx.ReadFile(path)
		if err != nil {
			return fmt.Errorf("load RZX: %w", err)
		}
		return emu.startRZXPlayback(file)
	case ".nex":
		if emu.sdImageSrc == nil {
			return fmt.Errorf(".nex loading needs a Spectrum Next SD card (none is configured)")
		}
		if _, err := nex.ParseFile(path); err != nil {
			return fmt.Errorf("parse NEX: %w", err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		go emu.importAndRunNex(filepath.Base(path), data)
		return nil
	case ".p", ".81":
		if emu.zx8x == nil {
			return fmt.Errorf(".p needs the ZX81 (drop the conflicting model flag)")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		emu.zx8x.InjectP(data)
		return nil
	case ".o", ".80":
		if emu.zx8x == nil {
			return fmt.Errorf(".o needs the ZX80 (drop the conflicting model flag)")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		emu.zx8x.InjectO(data)
		return nil
	default:
		return fmt.Errorf("unsupported file type %q", ext)
	}
}
