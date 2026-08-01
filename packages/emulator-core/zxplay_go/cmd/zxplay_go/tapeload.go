package main

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/stever/zxplay_go/pkg/ula"
)

// loadTapeFile mounts a .tap/.tzx tape image into the emulator's ULA tape
// player and starts it playing — the headless-mode equivalent of the GUI's
// "Open .tap/.tzx" path (loadFileByPath in main.go). With the fast-load trap
// installed (see installTapeTrap), the guest's LD-BYTES calls then synthesise
// the load directly from the next block. Returns an error for a model with no
// ULA, an unreadable file, or an unsupported extension.
func loadTapeFile(emu *emulator, path string) error {
	if emu.ula == nil {
		return fmt.Errorf("tape loading needs a Spectrum ULA — the current model has none")
	}
	ext := strings.ToLower(filepath.Ext(path))
	tp := ula.NewTapePlayer()
	switch ext {
	case ".tap":
		if err := tp.LoadTAP(path); err != nil {
			return fmt.Errorf("load TAP: %w", err)
		}
	case ".tzx":
		if err := tp.LoadTZX(path); err != nil {
			return fmt.Errorf("load TZX: %w", err)
		}
	default:
		return fmt.Errorf("unsupported tape extension %q (want .tap or .tzx)", ext)
	}
	emu.ula.SetTapePlayer(tp)
	// ZX_GO_TAPE_NO_AUTOPLAY: mount without starting playback. Needed when the
	// guest takes a while to reach its loader (e.g. driving NextZXOS's menu to
	// "Tape Loader" with --press-key): auto-play from frame 0 would run the
	// whole tape past before anything listens. The LD-BYTES trap serves blocks
	// regardless of motor state.
	if os.Getenv("ZX_GO_TAPE_NO_AUTOPLAY") == "" {
		tp.Play()
	}
	slog.Info("tape loaded", "format", strings.TrimPrefix(ext, "."), "blocks", tp.BlockCount(), "path", path)
	return nil
}
