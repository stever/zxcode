package main

import (
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// TestBombJack202Probe (#202): "joystick has reverse controls". The
// game (Manuferhi 2022) reads its in-game controls EXCLUSIVELY from
// the keyboard matrix through configurable row/mask pairs at
// $6885(left)/$6887(right)/$6889(up)/$688B(down)/$688D(jump); its
// menu option "2 - JOYSTICK" sets them to the Sinclair 1 layout
// (6=left 7=right 8=down 9=up 0=jump on row $EFFE). A pad therefore
// only works through the Next's NR$05 membrane key-joystick injection
// (pkg/ula joymembrane.go) with joystick 1 in Sinclair 1 mode — the
// route this probe pins end-to-end:
//
//	stage game folder -> Browser launch -> menu key 2 (JOYSTICK)
//	-> menu key 0 (START) -> setJoystickType(Sinclair1) [NR$05=011]
//	-> SetJoystickState right/left -> Jack's X ($43DA) moves the
//	   commanded way.
//
// Before #202 the pad vector reached only the Kempston port (dead
// in-game here), and the frontend "Sinclair 1" label injected keys
// 1-5 (also dead) — the reported "reversed/overlapping" behaviour was
// the Cursor scheme's keys 5/6/7/8 landing on the game's 6/7/8/9
// reads (up->right, down->left, right->down), which is authentic
// Cursor-vs-Sinclair behaviour, not a mapping to preserve.
//
// Run: ZX_GO_BJ_PROBE=1 ZX_GO_NEXT_SD_IMG=<tbblue.mmc> \
//	go test ./cmd/zx_go/ -run TestBombJack202Probe -v
// Env: ZX_GO_BJ_ROOT (game folder), ZX_GO_BJ_DIR (screenshot dir).
func TestBombJack202Probe(t *testing.T) {
	if os.Getenv("ZX_GO_BJ_PROBE") == "" {
		t.Skip("diagnostic probe; set ZX_GO_BJ_PROBE=1 to run")
	}
	gameRoot := os.Getenv("ZX_GO_BJ_ROOT")
	if gameRoot == "" {
		gameRoot = os.Getenv("HOME") + "/Documents/ZX Spectrum/ZX Spectrum Next/Bomb Jack"
	}
	nexData, err := os.ReadFile(gameRoot + "/BombJack.nex")
	if err != nil {
		t.Skipf("no local Bomb Jack (set ZX_GO_BJ_ROOT): %v", err)
	}
	t.Setenv("ZX_GO_NO_FPGA_BOOTROM", "1")
	t.Setenv("ZX_GO_NEXT_DIRECT_BOOT", "1")
	t.Setenv("ZX_GO_RTC_FIXED", "2026-07-01T12:00:00Z")
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
		t.Skip("no SD image mounted (set ZX_GO_NEXT_SD_IMG)")
	}

	outDir := os.Getenv("ZX_GO_BJ_DIR")
	if outDir == "" {
		outDir = t.TempDir()
	} else if err := os.MkdirAll(outDir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", outDir, err)
	}
	t.Logf("output -> %s", outDir)

	frame := 0
	step := func() {
		emu.cpu.ExecuteFrame(emu.frameTStates())
		if emu.peripherals != nil {
			emu.peripherals.Frame()
		}
		if emu.kbd != nil {
			emu.kbd.Tick()
		}
		if emu.nexloadMacro != nil && emu.nexloadMacro.tick(emu) {
			emu.nexloadMacro = nil
		}
		frame++
	}
	shot := func(tag string) {
		fp, err := os.Create(fmt.Sprintf("%s/bj_%06d_%s.png", outDir, frame, tag))
		if err != nil {
			return
		}
		defer fp.Close()
		_ = png.Encode(fp, emu.renderFrame())
	}
	read16 := func(a uint16) uint16 {
		return uint16(emu.mem.Read(a)) | uint16(emu.mem.Read(a+1))<<8
	}
	// press holds a matrix key ~0.6s (the game's menu loop debounces
	// against its own redraws) then releases and settles.
	press := func(row int, mask byte) {
		for f := 0; f < 30; f++ {
			emu.kbd.PressMatrixKey(row, mask, true)
			step()
		}
		emu.kbd.PressMatrixKey(row, mask, false)
		for f := 0; f < 60; f++ {
			step()
		}
	}
	// waitFor runs frames until cond or timeout; returns success.
	waitFor := func(limit int, cond func() bool) bool {
		for f := 0; f < limit; f++ {
			if cond() {
				return true
			}
			step()
		}
		return cond()
	}

	// Stage the whole game folder under its own name and Browser-launch
	// the .nex — the browser game-zip flow (#178).
	const gameDir = "Bomb Jack"
	staged := 0
	err = filepath.Walk(gameRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(gameRoot, path)
		rel = filepath.ToSlash(rel)
		if rel == "BombJack.nex" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if perr := emu.putSDFile(gameDir+"/"+rel, data); perr != nil {
			t.Logf("putSDFile %s/%s: %v", gameDir, rel, perr)
		} else {
			staged++
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", gameRoot, err)
	}
	t.Logf("staged %d files under %s/", staged, gameDir)
	for f := 0; f < 3000; f++ {
		step()
	}
	emu.importAndRunNex(gameDir+"/BombJack.nex", nexData)
	if emu.nexloadMacro == nil {
		t.Fatal("importAndRunNex did not arm the Browser launch macro")
	}

	// Game up: its variable block loads with the keyboard defaults —
	// mode $6884=1, left=($6885)=$DF02 (key O).
	if !waitFor(12000, func() bool {
		return emu.nexloadMacro == nil && emu.mem.Read(0x6884) == 1 && read16(0x6885) == 0xDF02
	}) {
		shot("no-menu")
		t.Fatalf("game did not reach its menu state (frame %d, $6884=%d, $6885=$%04X)",
			frame, emu.mem.Read(0x6884), read16(0x6885))
	}
	t.Logf("game loaded at frame %d (mode=1, keyboard defaults)", frame)
	// The menu takes a beat to start polling after load.
	for f := 0; f < 400; f++ {
		step()
	}
	shot("menu")

	// "2 - JOYSTICK": the menu handler sets the mode flag $6884=2; the
	// active row/mask pairs are rewritten later, when the game starts.
	for tries := 0; emu.mem.Read(0x6884) != 2 && tries < 10; tries++ {
		press(3, 0x02) // key 2
	}
	if emu.mem.Read(0x6884) != 2 {
		shot("no-joystick-mode")
		t.Fatalf("JOYSTICK mode not selected: $6884=%d (want 2)", emu.mem.Read(0x6884))
	}
	t.Logf("JOYSTICK mode selected at frame %d", frame)

	// Route the pad like the fixed frontend does: Sinclair 1 -> NR$05
	// joy0=011 -> membrane injection presses 6/7/8/9/0.
	emu.setJoystickType(JoystickSinclair1)
	if got := emu.nextRegs.ReadReg(0x05) & 0xC8; got != 0xC0 {
		t.Fatalf("setJoystickType(Sinclair1) left NR$05 joy0=$%02X; want $C0 (mode 011)", got)
	}

	// "0 - START" — the pad's jump button IS key 0 (via the membrane
	// injection), so start via the vector itself: fire = i_JOY bit 4.
	// Applying the mode rewrites the pairs: left=($6885)=$EF10 (key 6).
	started := false
	for tries := 0; tries < 10 && !started; tries++ {
		emu.SetJoystickState(0x010)
		for f := 0; f < 30; f++ {
			step()
		}
		emu.SetJoystickState(0)
		started = waitFor(120, func() bool { return read16(0x6885) == 0xEF10 })
	}
	if !started {
		shot("no-start")
		t.Fatalf("game did not start via pad fire: $6885=$%04X (want $EF10 — Sinclair 1 left key applied)",
			read16(0x6885))
	}
	t.Logf("game started at frame %d (left=$EF10 = Sinclair key 6)", frame)
	// Let the round intro run in.
	for f := 0; f < 500; f++ {
		step()
	}
	shot("ingame")

	// Drive right, then left, and require Jack's X integer ($43DA) to
	// move the commanded way. 90 frames at 1.5px/frame is unmissable.
	x0 := int16(read16(0x43DA))
	emu.SetJoystickState(0x001) // right
	for f := 0; f < 90; f++ {
		step()
	}
	emu.SetJoystickState(0)
	x1 := int16(read16(0x43DA))
	for f := 0; f < 20; f++ {
		step()
	}
	emu.SetJoystickState(0x002) // left
	for f := 0; f < 90; f++ {
		step()
	}
	emu.SetJoystickState(0)
	x2 := int16(read16(0x43DA))
	shot("after-moves")
	t.Logf("Jack X: start=%d afterRight=%d afterLeft=%d", x0, x1, x2)
	if x1 <= x0 {
		t.Errorf("pad RIGHT did not move Jack right: X %d -> %d", x0, x1)
	}
	if x2 >= x1 {
		t.Errorf("pad LEFT did not move Jack left: X %d -> %d", x1, x2)
	}
}
