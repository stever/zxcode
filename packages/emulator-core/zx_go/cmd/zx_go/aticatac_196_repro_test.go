package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/palette"
)

// TestAtic196Repro (diagnostic, #196): screenshot the story-crawl window
// and early gameplay of the real Atic Atac release to pin down the
// missing-scroller-tiles / missing-closed-doors report. Reuses the #187
// harness input schedule (import @3000, fire @5000, SPACE @5060).
// Set ZX_GO_ATIC_PROBE=1 to run; ZX_GO_ATIC_PROBE_DIR chooses the
// screenshot directory.
func TestAtic196Repro(t *testing.T) {
	if os.Getenv("ZX_GO_ATIC_PROBE") == "" {
		t.Skip("diagnostic probe; set ZX_GO_ATIC_PROBE=1 to run")
	}
	nexData, err := os.ReadFile("/home/steve/Downloads/ZX Spectrum Next/Atic Atac/ATICATAC.NEX")
	if err != nil {
		t.Skipf("no local Atic Atac: %v", err)
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

	outDir := os.Getenv("ZX_GO_ATIC_PROBE_DIR")
	if outDir == "" {
		outDir = t.TempDir()
	} else if err := os.MkdirAll(outDir, 0755); err != nil {
		t.Fatalf("mkdir %s: %v", outDir, err)
	}
	t.Logf("screenshots -> %s", outDir)
	shot := func(frame int, tag string) {
		fp, err := os.Create(fmt.Sprintf("%s/f%06d_%s.png", outDir, frame, tag))
		if err != nil {
			return
		}
		defer fp.Close()
		_ = png.Encode(fp, emu.renderFrame())
	}

	// Input schedule via env: "frame:key,frame:key" where key is
	// fire (kempston, held 30 frames) or space (held 28 frames).
	type inputEv struct {
		frame int
		key   string
	}
	var events []inputEv
	if s := os.Getenv("ZX_GO_ATIC_INPUTS"); s != "" {
		for _, part := range splitCSV(s) {
			var f int
			var k string
			if _, err := fmt.Sscanf(part, "%d:%s", &f, &k); err == nil {
				events = append(events, inputEv{f, k})
			}
		}
	}
	// Mixer-register beam trace (ZX_GO_ATIC_MIXTRACE=<frame>): log every
	// NR$68/$15/$6B/$43 value change with the beam position for that
	// frame — mid-frame flips the post-hoc render would lose.
	mixTraceFrame := -1
	if s := os.Getenv("ZX_GO_ATIC_MIXTRACE"); s != "" {
		fmt.Sscanf(s, "%d", &mixTraceFrame)
	}
	frameNow := 0
	// Sprite attribute write trace (ZX_GO_ATIC_ATTRTRACE=<frame>): log
	// every attribute byte landed during that frame with the beam line —
	// proves/disproves raster-timed sprite multiplexing.
	if s := os.Getenv("ZX_GO_ATIC_ATTRTRACE"); s != "" {
		if s == "totals" {
			// Per-frame aggregate: count + line span of attr writes for
			// every frame, logged on the following frame.
			lastFrame := -1
			emu.nextSprites.SetAttrWriteObserver(func(spr, byteIdx int, val byte) {
				if frameNow != lastFrame {
					lastFrame = frameNow
					t.Logf("ATTRTOTAL frame %d: upload begins at line %d (spr %d byte %d <- $%02X)",
						frameNow, emu.ula.ActiveVideoLine(), spr, byteIdx, val)
				}
			})
		} else {
			var af int
			fmt.Sscanf(s, "%d", &af)
			writeCount := 0
			logsLeft := 3000
			emu.nextSprites.SetAttrWriteObserver(func(spr, byteIdx int, val byte) {
				if frameNow != af {
					if frameNow == af+1 && writeCount > 0 {
						t.Logf("frame %d: %d sprite attr bytes written total", af, writeCount)
						writeCount = 0
					}
					return
				}
				writeCount++
				if logsLeft > 0 {
					logsLeft--
					t.Logf("ATTR frame %d line %3d: spr %3d byte %d <- $%02X", frameNow, emu.ula.ActiveVideoLine(), spr, byteIdx, val)
				}
			})
		}
	}
	if mixTraceFrame >= 0 {
		last := [4]byte{0xFF, 0xFF, 0xFF, 0xFF}
		regs := [4]byte{0x68, 0x15, 0x6B, 0x43}
		logsLeft := 400
		emu.cpu.AddPreFetchHook("mixtrace-196", func(pc uint16) {
			if frameNow < mixTraceFrame-1 || frameNow > mixTraceFrame || logsLeft <= 0 {
				return
			}
			for i, r := range regs {
				v := emu.nextRegs.Raw(r)
				if v != last[i] {
					line := emu.ula.ActiveVideoLine()
					t.Logf("frame %d line %3d: NR%02X -> $%02X (pc=$%04X)", frameNow, line, r, v, pc)
					last[i] = v
					logsLeft--
				}
			}
		})
	}
	shotFrom, shotTo, shotEvery := 3000, 12000, 40
	for _, env := range []struct {
		name string
		dst  *int
	}{{"ZX_GO_ATIC_SHOT_FROM", &shotFrom}, {"ZX_GO_ATIC_SHOT_TO", &shotTo}, {"ZX_GO_ATIC_SHOT_EVERY", &shotEvery}} {
		if s := os.Getenv(env.name); s != "" {
			fmt.Sscanf(s, "%d", env.dst)
		}
	}

	for frame := 0; frame <= shotTo; frame++ {
		frameNow = frame
		if frame == 3000 {
			emu.importAndRunNex("Atic Atac/ATICATAC.NEX", nexData)
		}
		for _, ev := range events {
			kemp := byte(0)
			switch ev.key {
			case "right":
				kemp = 0x01
			case "left":
				kemp = 0x02
			case "down":
				kemp = 0x04
			case "up":
				kemp = 0x08
			}
			switch {
			case ev.key == "fire" && frame == ev.frame:
				emu.ula.SetKempstonButton(0x10, true)
			case ev.key == "fire" && frame == ev.frame+30:
				emu.ula.SetKempstonButton(0x10, false)
			case ev.key == "space" && frame == ev.frame:
				emu.kbd.PressMatrixKey(7, 0x01, true)
			case ev.key == "space" && frame == ev.frame+28:
				emu.kbd.PressMatrixKey(7, 0x01, false)
			case kemp != 0 && frame == ev.frame:
				emu.ula.SetKempstonButton(kemp, true)
			case kemp != 0 && frame == ev.frame+120:
				emu.ula.SetKempstonButton(kemp, false)
			}
		}
		runOneFrame(emu)
		if frame >= shotFrom && frame <= shotTo && frame%shotEvery == 0 {
			shot(frame, "map")
		}
		// Layer forensics at one frame (ZX_GO_ATIC_LAYERSHOT=<frame>):
		// re-render with individual layers disabled so the artefact can
		// be attributed to a layer, plus a NR$15 / palette-priority dump.
		if s := os.Getenv("ZX_GO_ATIC_LAYERSHOT"); s != "" {
			var lf int
			fmt.Sscanf(s, "%d", &lf)
			if frame == lf {
				shot(frame, "all")
				nr15 := emu.nextRegs.Raw(0x15)
				emu.nextRegs.WriteReg(0x15, nr15&^0x01)
				shot(frame, "nosprites")
				emu.nextRegs.WriteReg(0x15, nr15)
				if l2 := emu.nextLayer2; l2 != nil && l2.Enabled() {
					l2.SetEnabled(false)
					shot(frame, "nol2")
					l2.SetEnabled(true)
				}
				nr6b := emu.nextRegs.Raw(0x6B)
				if nr6b&0x80 != 0 {
					emu.nextRegs.WriteReg(0x6B, nr6b&^0x80)
					shot(frame, "notilemap")
					emu.nextRegs.WriteReg(0x6B, nr6b)
				}
				t.Logf("frame %d: NR15=$%02X NR6B=$%02X NR68=$%02X NR70=$%02X L2res=%d", frame,
					nr15, nr6b, emu.nextRegs.Raw(0x68), emu.nextRegs.Raw(0x70), emu.nextLayer2.Resolution())
				// Raw sprites-only render: what the engine itself
				// produces per row, bypassing the compositor entirely.
				if spr := emu.nextSprites; spr != nil {
					img := image.NewRGBA(image.Rect(0, 0, 320, 256))
					sprPal := emu.nextPalette.PaletteForLayer(palette.LayerSprites)
					var buf [320]byte
					for y := 0; y < 256; y++ {
						for i := range buf {
							buf[i] = 0
						}
						spr.RenderScanline(y, buf[:], 320)
						cov := spr.LineCoverage()
						for x := 0; x < 320; x++ {
							if x < len(cov) && cov[x] {
								r, g, b := sprPal.RGB(buf[x])
								img.SetRGBA(x, y, color.RGBA{r, g, b, 0xFF})
							} else {
								img.SetRGBA(x, y, color.RGBA{0xFF, 0x00, 0xFF, 0xFF})
							}
						}
					}
					if fp, err := os.Create(fmt.Sprintf("%s/f%06d_rawsprites.png", outDir, frame)); err == nil {
						_ = png.Encode(fp, img)
						fp.Close()
					}
					t.Logf("frame %d: raw sprite dump written; overtime status=$%02X", frame, spr.ReadStatus())
					for i := 0; i < 128; i++ {
						a := spr.Sprite(i)
						if a.Visible || a.X != 0 || a.Y != 0 || a.Pattern != 0 || a.Byte4 != 0 {
							t.Logf("  spr[%3d] X=%4d Y=%4d pat=%3d pal=%2d vis=%t mirX=%t mirY=%t rot=%t ext=%t b4=%08b",
								i, a.X, a.Y, a.Pattern, a.Palette, a.Visible, a.XMirror, a.YMirror, a.Rotate, a.Extended, a.Byte4)
						}
					}
				}
				// Raw tilemap-only render, INCLUDING below-flagged pixels
				// (marked by painting them normally; transparent = magenta).
				if tm := emu.nextTilemap; tm != nil {
					img := image.NewRGBA(image.Rect(0, 0, 320, 256))
					tmPal := emu.nextPalette.PaletteForLayer(palette.LayerTilemap)
					var scan, below [320]byte
					belowCount := 0
					for y := 0; y < 256; y++ {
						tm.RenderScanlineWithBelow(y, scan[:], below[:])
						for x := 0; x < 320; x++ {
							idx := scan[x]
							if idx&0x0F == emu.nextRegs.Raw(0x4C)&0x0F {
								img.SetRGBA(x, y, color.RGBA{0xFF, 0x00, 0xFF, 0xFF})
								continue
							}
							if below[x] != 0 {
								belowCount++
							}
							r, g, b := tmPal.RGB(idx)
							img.SetRGBA(x, y, color.RGBA{r, g, b, 0xFF})
						}
					}
					if fp, err := os.Create(fmt.Sprintf("%s/f%06d_rawtilemap.png", outDir, frame)); err == nil {
						_ = png.Encode(fp, img)
						fp.Close()
					}
					t.Logf("frame %d: raw tilemap dump written; %d below-flagged opaque pixels", frame, belowCount)
				}
				if l2Pal := emu.nextPalette.PaletteForLayer(palette.LayerLayer2); l2Pal != nil {
					n := 0
					for i := 0; i < 256; i++ {
						if p := l2Pal.Priority(byte(i)); p != 0 {
							n++
							if n <= 40 {
								t.Logf("  L2 pal[%02X] = %03X prio=%d", i, l2Pal.Get(byte(i)), p)
							}
						}
					}
					t.Logf("frame %d: %d L2 palette entries carry priority bits", frame, n)
				}
			}
		}
	}
}

func splitCSV(s string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			if i > start {
				out = append(out, s[start:i])
			}
			start = i + 1
		}
	}
	return out
}
