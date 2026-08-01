package main

import (
	"archive/zip"
	"image/png"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
)

// TestFolderGameZipDiag reproduces the browser's folder-game zip flow
// natively: unzip a real game zip (SHOVEL_ZIP), stage every non-.nex entry
// onto the SD card via putSDFile at its path relative to the .nex's folder,
// then importAndRunNex — exactly what GoEmulator.openNexGameZip does. Passes
// when the game reaches its entry point and paints a non-black frame (found
// Shovel Adventure's two launch blockers: 8.3-only staging, and the
// compositor dropping Layer 2 in the USL/ULS NR$15 priority modes). Gated by
// SHOVEL_DIAG since it needs the licensed Next ROMs + SD image + a game zip.
func TestFolderGameZipDiag(t *testing.T) {
	if os.Getenv("SHOVEL_DIAG") == "" {
		t.Skip("set SHOVEL_DIAG=1 (and SHOVEL_ZIP=<path>) to run")
	}
	zr, err := zip.OpenReader(os.Getenv("SHOVEL_ZIP"))
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	defer func() { _ = zr.Close() }()

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
		t.Skipf("Next ROMs / SD not installed: %v", err)
	}
	if emu.sdImageSrc == nil {
		t.Fatal("no SD image mounted (set ZX_GO_NEXT_SD_IMG)")
	}

	// Mirror GoEmulator.openNexGameZip's staging.
	var nexName, nexDir string
	var nexData []byte
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || strings.HasPrefix(f.Name, "__MACOSX/") {
			continue
		}
		if strings.HasSuffix(strings.ToLower(f.Name), ".nex") {
			nexDir = f.Name[:strings.LastIndex(f.Name, "/")+1]
			nexName = f.Name[strings.LastIndex(f.Name, "/")+1:]
			rc, _ := f.Open()
			nexData, _ = io.ReadAll(rc)
			_ = rc.Close()
		}
	}
	if nexData == nil {
		t.Fatal("no .nex in zip")
	}
	// The game's own folder on the card: the zip's folder name, else the
	// .nex basename — mirroring openNexGameZip. A bare name would take the
	// typed /zx.nex route (#184), not the game flow under test here.
	gameDir := ""
	if parts := strings.Split(strings.Trim(nexDir, "/"), "/"); len(parts) > 0 && parts[len(parts)-1] != "" {
		gameDir = parts[len(parts)-1]
	}
	if gameDir == "" {
		gameDir = strings.TrimSuffix(nexName, ".nex")
	}
	staged := 0
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || strings.HasPrefix(f.Name, "__MACOSX/") ||
			strings.HasSuffix(strings.ToLower(f.Name), ".nex") {
			continue
		}
		rel := strings.TrimPrefix(f.Name, nexDir)
		rc, _ := f.Open()
		data, _ := io.ReadAll(rc)
		_ = rc.Close()
		if err := emu.putSDFile(gameDir+"/"+rel, data); err != nil {
			t.Errorf("putSDFile %q: %v", gameDir+"/"+rel, err)
			continue
		}
		staged++
	}
	t.Logf("staged %d files (nex=%q gameDir=%q)", staged, nexName, gameDir)

	emu.importAndRunNex(gameDir+"/"+nexName, nexData)

	entered := false
	entry := uint16(uint16(nexData[15])<<8 | uint16(nexData[14])) // .nex header PC
	emu.cpu.AddPreFetchHook("entry", func(pc uint16) {
		if pc == entry {
			entered = true
		}
	})
	for f := 0; f < 12000; f++ {
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
	}
	if !entered {
		t.Fatalf("game never reached its entry $%04X (PC=$%04X)", entry, emu.cpu.PC)
	}

	frame := emu.renderFrame()
	nonBlack := 0
	b := frame.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bb, _ := frame.At(x, y).RGBA()
			if r|g|bb != 0 {
				nonBlack++
			}
		}
	}
	t.Logf("entry $%04X reached; rendered frame has %d non-black pixels", entry, nonBlack)
	if nonBlack == 0 {
		t.Error("game runs but the frame is all black (compositor dropped its layers?)")
	}
	if fp, err := os.Create(os.TempDir() + "/folder_game_diag.png"); err == nil {
		_ = png.Encode(fp, frame)
		_ = fp.Close()
		t.Log("wrote " + os.TempDir() + "/folder_game_diag.png")
	}
}
