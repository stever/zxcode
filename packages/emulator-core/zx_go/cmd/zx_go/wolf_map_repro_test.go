package main

import (
	"fmt"
	"image/png"
	"os"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// TestWolfMapRepro reproduces work item #92: the Lone Wolf Layer 2 map screen
// renders without the ULA title row that the game's Layer 2 clip window
// (Y1=8) should let show through. Scratch diagnostic, gated by WOLF_MAP_DIAG.
//
//	WOLF_MAP_DIAG=1 WOLF_MAP_NEX=.../lonewolf.nex WOLF_MAP_OUT=/tmp/out \
//	  go test ./cmd/zx_go/ -run TestWolfMapRepro -v
func TestWolfMapRepro(t *testing.T) {
	if os.Getenv("WOLF_MAP_DIAG") == "" {
		t.Skip("set WOLF_MAP_DIAG=1 to run")
	}
	nexPath := os.Getenv("WOLF_MAP_NEX")
	outDir := os.Getenv("WOLF_MAP_OUT")
	if nexPath == "" || outDir == "" {
		t.Fatal("set WOLF_MAP_NEX and WOLF_MAP_OUT")
	}
	data, err := os.ReadFile(nexPath)
	if err != nil {
		t.Fatalf("read .nex: %v", err)
	}

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
		t.Fatal("sdImageSrc nil")
	}
	emu.importAndRunNex("lonewolf.nex", data)

	shot := func(frame int, tag string) {
		p := fmt.Sprintf("%s/wolf-%05d-%s.png", outDir, frame, tag)
		fp, err := os.Create(p)
		if err != nil {
			t.Fatalf("create %s: %v", p, err)
		}
		_ = png.Encode(fp, emu.renderFrame())
		_ = fp.Close()
		t.Logf("shot %s", p)
	}

	press := func(name string, on bool) {
		mp, ok := pressKeyMap[name]
		if !ok {
			t.Fatalf("unknown key %s", name)
		}
		emu.kbd.PressMatrixKey(mp.row, mp.mask, on)
	}

	// Key schedule (frame -> key event). Timings found empirically via the
	// periodic shots below.
	type ev struct {
		frame int
		key   string
		down  bool
	}
	var schedule []ev
	if s := os.Getenv("WOLF_MAP_KEYS"); s != "" {
		// Format: key@frame,key@frame — each held for 10 frames.
		for _, pk := range parsePressKeySpec(s) {
			schedule = append(schedule,
				ev{pk.frame, pk.name, true},
				ev{pk.frame + 10, pk.name, false})
		}
	}

	const totalFrames = 12000
	for f := 0; f < totalFrames; f++ {
		for _, e := range schedule {
			if e.frame == f {
				press(e.key, e.down)
			}
		}
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
		if f%500 == 499 {
			shot(f, "periodic")
		}
	}
	shot(totalFrames, "final")
}
