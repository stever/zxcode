//go:build !js

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/storage"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
	"github.com/conorarmstrong/zx_go/pkg/config"
	"github.com/conorarmstrong/zx_go/pkg/debugger"
	"github.com/conorarmstrong/zx_go/pkg/keyboard"
	"github.com/conorarmstrong/zx_go/pkg/multiface"
	"github.com/conorarmstrong/zx_go/pkg/next/divmmc"
	"github.com/conorarmstrong/zx_go/pkg/next/install"
	"github.com/conorarmstrong/zx_go/pkg/next/nex"
	"github.com/conorarmstrong/zx_go/pkg/roms"
	"github.com/conorarmstrong/zx_go/pkg/rzx"
	"github.com/conorarmstrong/zx_go/pkg/sam"
	"github.com/conorarmstrong/zx_go/pkg/snapshot"
	"github.com/conorarmstrong/zx_go/pkg/ula"
	"github.com/conorarmstrong/zx_go/pkg/version"
	"github.com/conorarmstrong/zx_go/pkg/zxlog"
)

// GUI-only code: everything here builds the fyne desktop application
// (window, menus, dialogs, splash). Kept out of the js/wasm build so the
// fyne widget/theme/driver stack (and its ~7MB of embedded fonts) is not
// linked into zx.wasm — the browser host provides its own UI.

// showGUIError surfaces err in an error dialog when a window exists.
// The js build has a no-op stub: the browser host logs errors instead.
func (e *emulator) showGUIError(err error) {
	if e.window == nil {
		return
	}
	fyne.Do(func() { dialog.ShowError(err, e.window) })
}

// keyboardWidget implements desktop.Keyable to receive KeyDown/KeyUp
// events, and desktop.Mouseable/desktop.Hoverable to receive mouse
// button and motion events. It sits as a transparent overlay at the
// top of the content stack so it catches events before they reach
// the screen image underneath.
type keyboardWidget struct {
	widget.BaseWidget
	onKeyDown   func(*fyne.KeyEvent)
	onKeyUp     func(*fyne.KeyEvent)
	onTypedRune func(rune)
	onMouseMove func(dx, dy int)
	onMouseBtn  func(btn int, pressed bool)
	onFocusLost func()

	// lastMousePos holds the last MouseMoved position so we can
	// compute deltas. Reset on MouseIn so the first move after
	// re-entering the window doesn't produce a giant jump.
	lastMousePos fyne.Position
	haveLastPos  bool
}

func newKeyboardWidget(onKeyDown, onKeyUp func(*fyne.KeyEvent)) *keyboardWidget {
	kw := &keyboardWidget{
		onKeyDown: onKeyDown,
		onKeyUp:   onKeyUp,
	}
	kw.ExtendBaseWidget(kw)
	return kw
}

func (kw *keyboardWidget) KeyDown(key *fyne.KeyEvent) {
	if kw.onKeyDown != nil {
		kw.onKeyDown(key)
	}
}

func (kw *keyboardWidget) KeyUp(key *fyne.KeyEvent) {
	if kw.onKeyUp != nil {
		kw.onKeyUp(key)
	}
}

func (kw *keyboardWidget) TypedKey(key *fyne.KeyEvent) {
	// Ignore typed keys - we only care about physical key events
}

func (kw *keyboardWidget) TypedRune(r rune) {
	// Typed characters drive layout-independent symbol entry (see
	// emulator.handleTypedRune). Physical keys still drive letters/digits.
	if kw.onTypedRune != nil {
		kw.onTypedRune(r)
	}
}

func (kw *keyboardWidget) FocusGained() {}

// FocusLost fires when the emulator surface loses keyboard focus (window
// switch, dialog, menu). The OS stops delivering key-up events for anything
// currently held, so a held joystick direction or key would otherwise stick on
// (e.g. Sonic kept running right after focus returned). Release everything.
func (kw *keyboardWidget) FocusLost() {
	if kw.onFocusLost != nil {
		kw.onFocusLost()
	}
}

// MouseIn is called when the cursor enters the widget. Reset the
// last-position cache so the first MouseMoved afterwards doesn't
// deliver a stale delta.
func (kw *keyboardWidget) MouseIn(ev *desktop.MouseEvent) {
	kw.haveLastPos = false
}

// MouseOut clears the tracking state — no deltas produced while
// the cursor is outside the window.
func (kw *keyboardWidget) MouseOut() {
	kw.haveLastPos = false
}

// MouseMoved is called on every cursor movement inside the widget.
// We convert the absolute position to deltas against the previous
// sample and forward them to onMouseMove.
func (kw *keyboardWidget) MouseMoved(ev *desktop.MouseEvent) {
	if kw.onMouseMove == nil {
		return
	}
	if kw.haveLastPos {
		dx := int(ev.Position.X - kw.lastMousePos.X)
		dy := int(ev.Position.Y - kw.lastMousePos.Y)
		if dx != 0 || dy != 0 {
			kw.onMouseMove(dx, dy)
		}
	}
	kw.lastMousePos = ev.Position
	kw.haveLastPos = true
}

// MouseDown / MouseUp forward button press/release events to the
// onMouseBtn callback. Button index follows FUSE's Kempston
// convention: 0 = right button, 1 = left button.
func (kw *keyboardWidget) MouseDown(ev *desktop.MouseEvent) {
	if kw.onMouseBtn == nil {
		return
	}
	switch ev.Button {
	case desktop.MouseButtonPrimary:
		kw.onMouseBtn(1, true) // left → bit 1
	case desktop.MouseButtonSecondary:
		kw.onMouseBtn(0, true) // right → bit 0
	}
}

func (kw *keyboardWidget) MouseUp(ev *desktop.MouseEvent) {
	if kw.onMouseBtn == nil {
		return
	}
	switch ev.Button {
	case desktop.MouseButtonPrimary:
		kw.onMouseBtn(1, false)
	case desktop.MouseButtonSecondary:
		kw.onMouseBtn(0, false)
	}
}

func (kw *keyboardWidget) CreateRenderer() fyne.WidgetRenderer {
	return widget.NewSimpleRenderer(container.NewWithoutLayout())
}

var (
	_ desktop.Keyable   = (*keyboardWidget)(nil)
	_ desktop.Mouseable = (*keyboardWidget)(nil)
	_ desktop.Hoverable = (*keyboardWidget)(nil)
)

// savePlus3Disk opens a file save picker and writes the current disk in
// the given drive to a DSK file.
func savePlus3Disk(emu *emulator, w fyne.Window, drive int) {
	fd := dialog.NewFileSave(func(writer fyne.URIWriteCloser, err error) {
		if err != nil {
			dialog.ShowError(err, w)
			return
		}
		if writer == nil {
			return
		}
		path := writer.URI().Path()
		_ = writer.Close()
		if err := emu.peripherals.SavePlus3Disk(drive, path); err != nil {
			dialog.ShowError(fmt.Errorf("failed to save DSK: %w", err), w)
			return
		}
		driveName := "A"
		if drive == 1 {
			driveName = "B"
		}
		dialog.ShowInformation("Disk Saved",
			"Wrote drive "+driveName+" to "+filepath.Base(path)+".", w)
	}, w)
	fd.SetFilter(storage.NewExtensionFileFilter([]string{".dsk"}))
	fd.Show()
}

// insertInterface2Cartridge opens a file picker for a 16KB .rom
// cartridge image and inserts it into the Interface 2 cartridge
// slot. Refuses (with explanation) on non-48K models, since the
// IF2 only worked on the original 48K Spectrum. On success, the
// emulator is rebooted so the cartridge code starts executing
// from PC=0x0000.
func insertInterface2Cartridge(emu *emulator, w fyne.Window, currentModel roms.SpectrumModel) {
	if currentModel != roms.Model48K {
		dialog.ShowInformation("Interface 2",
			"Interface 2 ROM cartridges only work on the 48K Spectrum.\n"+
				"Switch the machine model from the Machine menu first.", w)
		return
	}
	fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
		if err != nil {
			dialog.ShowError(err, w)
			return
		}
		if reader == nil {
			return
		}
		path := reader.URI().Path()
		_ = reader.Close()
		if err := emu.peripherals.InsertInterface2Cartridge(path); err != nil {
			dialog.ShowError(fmt.Errorf("failed to insert cartridge: %w", err), w)
			return
		}
		emu.reboot()
		dialog.ShowInformation("Cartridge Inserted",
			"Inserted "+emu.peripherals.Interface2CartridgeName()+
				".\n\nThe emulator has been rebooted into the cartridge.", w)
	}, w)
	fd.SetFilter(storage.NewExtensionFileFilter([]string{".rom"}))
	fd.Show()
}

// ejectInterface2Cartridge removes any inserted Interface 2
// cartridge and reboots into the normal BASIC ROM.
func ejectInterface2Cartridge(emu *emulator, w fyne.Window) {
	if !emu.peripherals.IsInterface2CartridgeInserted() {
		dialog.ShowInformation("Interface 2",
			"No cartridge is currently inserted.", w)
		return
	}
	name := emu.peripherals.Interface2CartridgeName()
	emu.peripherals.RemoveInterface2Cartridge()
	emu.reboot()
	dialog.ShowInformation("Cartridge Ejected",
		"Ejected "+name+". The emulator has been rebooted into BASIC.", w)
}

// loadDiscipleDisk opens a file picker for an MGT/IMG/SAD disk image and
// mounts it in the DISCiPLE's drive (0 = 1, 1 = 2).
func loadDiscipleDisk(emu *emulator, w fyne.Window, drive int) {
	if !emu.peripherals.IsDiscipleEnabled() {
		dialog.ShowInformation("Load DISCiPLE Disk",
			"Enable the DISCiPLE interface first from the Peripherals menu.", w)
		return
	}
	fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
		if err != nil {
			dialog.ShowError(err, w)
			return
		}
		if reader == nil {
			return
		}
		path := reader.URI().Path()
		_ = reader.Close()
		if err := emu.peripherals.LoadDiscipleDisk(drive, path); err != nil {
			dialog.ShowError(fmt.Errorf("failed to load disk: %w", err), w)
			return
		}
		slog.Info("disk inserted", "interface", "DISCiPLE", "drive", drive+1, "path", path)
		dialog.ShowInformation("Disk Loaded",
			"Inserted "+filepath.Base(path)+" into DISCiPLE drive "+fmt.Sprintf("%d", drive+1)+".", w)
	}, w)
	fd.SetFilter(storage.NewExtensionFileFilter([]string{
		".mgt", ".img", ".sad", ".dsk", ".trd", ".d40", ".d80",
	}))
	fd.Show()
}

// loadPlus3Disk opens a file picker for a DSK image and mounts it in the
// given +3 FDC drive (0 = A, 1 = B). Refuses (with explanation) on
// non-+3/+2A models.
func loadPlus3Disk(emu *emulator, w fyne.Window, currentModel roms.SpectrumModel, drive int) {
	if currentModel != roms.ModelPlus3 && currentModel != roms.ModelPlus2A {
		dialog.ShowInformation("Load Disk",
			"DSK images can only be loaded on the +3 or +2A.\n"+
				"Switch the machine model from the Machine menu first.", w)
		return
	}
	fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
		if err != nil {
			dialog.ShowError(err, w)
			return
		}
		if reader == nil {
			return
		}
		path := reader.URI().Path()
		_ = reader.Close()
		if err := emu.peripherals.LoadPlus3Disk(drive, path); err != nil {
			dialog.ShowError(fmt.Errorf("failed to load DSK: %w", err), w)
			return
		}
		driveName := "A"
		if drive == 1 {
			driveName = "B"
		}
		slog.Info("disk inserted", "interface", "+3", "drive", driveName, "path", path)
		dialog.ShowInformation("Disk Loaded",
			"Inserted "+filepath.Base(path)+" into drive "+driveName+".", w)
	}, w)
	fd.SetFilter(storage.NewExtensionFileFilter([]string{
		".dsk", ".udi", ".mgt", ".img", ".trd", ".sad", ".d40", ".d80",
	}))
	fd.Show()
}

// loadTRDDisk shows a .TRD file picker and mounts the chosen image in the given
// Beta drive (0 = A, 1 = B), enabling TR-DOS on first use.
func loadTRDDisk(emu *emulator, w fyne.Window, drive int) {
	if !emu.betaSupported() {
		dialog.ShowInformation("Load TR-DOS Disk",
			"TR-DOS disks run on the Pentagon 128 (and the 48K/128K).\n"+
				"Switch the machine model from the Machine menu first.", w)
		return
	}
	fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
		if err != nil {
			dialog.ShowError(err, w)
			return
		}
		if reader == nil {
			return
		}
		path := reader.URI().Path()
		_ = reader.Close()
		var mountErr error
		_ = emu.withEmulationPaused(func() error {
			mountErr = emu.mountTRD(drive, path)
			return nil
		})
		if mountErr != nil {
			dialog.ShowError(fmt.Errorf("failed to load TRD: %w", mountErr), w)
			return
		}
		driveName := "A"
		if drive == 1 {
			driveName = "B"
		}
		slog.Info("disk inserted", "interface", "TR-DOS", "drive", driveName, "path", path)
		dialog.ShowInformation("TR-DOS Disk Loaded",
			"Inserted "+filepath.Base(path)+" into TR-DOS drive "+driveName+".\n"+
				"From BASIC, enter TR-DOS with: RANDOMIZE USR 15616  (or the 128 menu).", w)
	}, w)
	fd.SetFilter(storage.NewExtensionFileFilter([]string{".trd"}))
	fd.Show()
}

// loadSAMDisk shows an MGT/SAD/DSK file picker and inserts the chosen image into
// the given SAM Coupé drive (0 = drive 1, 1 = drive 2). SAM-only.
func loadSAMDisk(emu *emulator, w fyne.Window, drive int) {
	if emu.sam == nil {
		dialog.ShowInformation("Load SAM Disk",
			"SAM disks run on the SAM Coupé.\n"+
				"Switch to it from the Machine menu first.", w)
		return
	}
	fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
		if err != nil {
			dialog.ShowError(err, w)
			return
		}
		if reader == nil {
			return
		}
		path := reader.URI().Path()
		data, readErr := io.ReadAll(reader)
		_ = reader.Close()
		if readErr != nil {
			dialog.ShowError(fmt.Errorf("failed to read disk: %w", readErr), w)
			return
		}
		disk, derr := sam.LoadDisk(data)
		if derr != nil {
			dialog.ShowError(fmt.Errorf("failed to load SAM disk: %w", derr), w)
			return
		}
		_ = emu.withEmulationPaused(func() error {
			emu.sam.InsertDisk(drive, disk)
			return nil
		})
		slog.Info("disk inserted", "interface", "SAM", "drive", drive+1, "path", path)
		dialog.ShowInformation("Disk Loaded",
			fmt.Sprintf("Inserted %s into SAM drive %d.\n"+
				"From SAM BASIC, boot it with:  BOOT  (or load with LOAD).",
				filepath.Base(path), drive+1), w)
	}, w)
	fd.SetFilter(storage.NewExtensionFileFilter([]string{".mgt", ".sad", ".dsk", ".img"}))
	fd.Show()
}
func (e *emulator) run(a fyne.App, screen *canvas.Image) {
	// Start the key processor goroutine
	e.startKeyProcessor()

	// Main emulation loop - completely independent of UI events
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond) // 50Hz
		defer ticker.Stop()

		frameCount := 0
		lastRender := time.Now()

		for {
			select {
			case <-ticker.C:
				if !e.paused.Load() {
					// Honour the remote debugger's pause state.
					// WaitIfPaused is nil-safe and a no-op when
					// not paused, so the GUI hot path is unaffected
					// when --debugger-port wasn't supplied.
					e.rdbg.WaitIfPaused()
					// Execution paths: ZX80/ZX81 (CPU-generated video),
					// RZX playback, RZX recording, or normal frame.
					switch {
					case e.zx8x != nil:
						e.zx8x.RunFrame()
					case e.sam != nil:
						e.sam.RunFrame()
						if e.samAudio != nil {
							if e.samAudioBuf == nil {
								e.samAudioBuf = make([]int16, sam.SamplesPerFrame)
							}
							e.sam.GenerateAudioMono(e.samAudioBuf)
							e.samAudio.PushBeeperSamples(e.samAudioBuf)
						}
					case e.rzxPlayback.Load() != nil:
						playback := e.rzxPlayback.Load()
						e.cpu.ExecuteRZXFrame(uint64(playback.Instructions()))
						snapBlock, err := playback.Frame()
						switch {
						case errors.Is(err, rzx.ErrPlaybackFinished):
							e.stopRZXPlayback()
						case err != nil:
							slog.Error("RZX playback error", "err", err)
							e.stopRZXPlayback()
						case snapBlock != nil:
							// Intermediate snapshot — apply it before the next frame.
							snap, derr := rzx.DecodeSnapshot(snapBlock)
							if derr != nil {
								slog.Error("RZX intermediate snapshot decode failed; stopping playback", "err", derr)
								e.stopRZXPlayback()
								break
							}
							if aerr := applySnapshotToEmulator(e, snap); aerr != nil {
								slog.Error("RZX intermediate snapshot apply failed; stopping playback", "err", aerr)
								e.stopRZXPlayback()
							}
						}
					case e.rzxRecord.Load() != nil:
						recorder := e.rzxRecord.Load()
						before := e.cpu.InstructionCount()
						e.cpu.ExecuteFrame(frameTStatesForModel(e.model))
						delta := e.cpu.InstructionCount() - before
						if delta > 0xFFFF {
							slog.Warn("RZX record: frame instruction count exceeded 0xFFFF, clamping", "count", delta)
							delta = 0xFFFF
						}
						if err := recorder.StoreFrame(uint16(delta)); err != nil {
							slog.Error("RZX record StoreFrame", "err", err)
						}
						if recorder.AutosaveDue() {
							if snap, err := createSnapshotFromEmulator(e); err == nil {
								if block, err := rzx.EncodeSnapshot(snap, rzx.SnapshotFormatSZX, true); err == nil {
									recorder.AddAutosave(block, uint32(e.cpu.Tstates()))
								}
							}
						}
					default:
						// Fast tape loading: while a tape is actively loading,
						// run a burst of frames per tick so a real-time load
						// (custom turbo loaders go through the edge-timed loop
						// and can't be trap-accelerated) finishes in seconds
						// instead of minutes. Rendering still happens at 50 Hz.
						n := 1
						// Turbo only while a loader is actively reading tape
						// edges (high $FE read rate last tick) — not merely while
						// the tape has blocks left. Otherwise a multi-load game
						// keeps running at 64x at its menu (rapid attract cycling)
						// with audio muted.
						turbo := e.fastTape.Load() && e.tapeLoadingActive() && e.tapeReadActive
						if turbo {
							n = tapeTurboFramesPerTick
						}
						// Mute for the whole fast-tape load, not just the turbo
						// ticks: at every inter-block gap the read rate dips and
						// turbo would disengage for a tick, leaking one garbled
						// mid-load frame + re-arming the DC blocker — an audible
						// blip at each block boundary (the multi-load "stutter").
						// tapeAudioMuted stays true across those gaps; it clears
						// only when the tape auto-pauses (so music plays) or when
						// fast-tape is off (so the real loading sound is audible).
						if e.ula != nil {
							e.ula.SetFastLoad(e.tapeAudioMuted())
						}
						heavyReads := false
						for k := 0; k < n; k++ {
							var before uint64
							if e.ula != nil {
								before = e.ula.FEReadCount()
							}
							e.cpu.ExecuteFrame(frameTStatesForModel(e.model))
							if e.ula != nil && e.ula.FEReadCount()-before > tapeLoadReadThreshold {
								heavyReads = true
							}
							if k+1 < n && e.peripherals != nil {
								e.peripherals.Frame()
							}
						}
						// Drive next tick's turbo decision from this tick's read
						// rate. The first loading tick runs at 1x (n=1) and sees
						// the heavy reads, so turbo engages on the next tick.
						e.tapeReadActive = heavyReads

						// Loader-activity auto-pause: while the running program is
						// not reading tape edges (a multi-load game's menu, or
						// inter-block processing), pause the tape so it doesn't
						// advance past the next part — which would mis-load it
						// (garbled audio, no music). Resume the instant the loader
						// starts reading again. This also stops the residual
						// loading sound once a part has finished loading.
						if e.ula != nil && os.Getenv("ZX_GO_NO_TAPE_AUTOPAUSE") == "" {
							if tp := e.ula.GetTapePlayer(); tp != nil && tp.HasMoreBlocks() {
								if heavyReads {
									e.tapeIdleTicks = 0
									if !tp.IsPlaying() {
										tp.Resume()
									}
								} else if tp.IsPlaying() {
									e.tapeIdleTicks++
									if e.tapeIdleTicks > tapeAutoPauseTicks {
										tp.Stop()
									}
								}
							}
						}
					}

					frameCount++
					atomic.AddInt32(&e.frameCounter, 1)
					// Advance the typed-character symbol pulse (no-op when idle).
					if e.kbd != nil {
						e.kbd.Tick()
					}
					if e.peripherals != nil {
						e.peripherals.Frame()
					}

					// Advance the NextZXOS .nexload driver (File -> Open),
					// one step per executed frame; keys it presses are seen
					// by the next frame's keyboard scan.
					if e.nexloadMacro != nil {
						if e.nexloadMacro.tick(e) {
							e.nexloadMacro = nil
						}
					}

					// Enforce the user's CPU-speed override (no-op when Auto or
					// still loading) — see applyForcedCPUSpeed.
					e.applyForcedCPUSpeed()

					// Render at 50Hz
					now := time.Now()
					if now.Sub(lastRender) >= 20*time.Millisecond {
						newImage := e.renderFrame()

						// In plain mode, screen.Image already points at the
						// ULA's frame buffer (set at startup) and Render
						// mutated it in place — we just need to refresh.
						// In CRT mode we post-process into a 2x scratch
						// buffer and point screen.Image at that instead.
						displayImg := newImage
						if e.crtFilter.Load() {
							b := newImage.Bounds()
							want := image.Rect(0, 0, b.Dx()*2, b.Dy()*2)
							if e.crtScratch == nil || e.crtScratch.Bounds() != want {
								e.crtScratch = image.NewRGBA(want)
							}
							applyCRTFilterInto(e.crtScratch, newImage)
							displayImg = e.crtScratch
						}

						// Update UI on main thread
						fyne.Do(func() {
							if screen.Image != displayImg {
								screen.Image = displayImg
							}
							screen.Refresh()
						})

						lastRender = now
					}

				}
			case <-e.stopChan:
				return
			}
		}
	}()
}

// makeMicrodriveMenu builds an 8-drive Microdrive submenu. Each child
// is itself a submenu with Insert / Save / Eject / Write Protect.
// All four actions delegate to peripherals.PeripheralManager helpers
// so the menu code stays a thin shell over the package boundary.
func makeMicrodriveMenu(emu *emulator, w fyne.Window) *fyne.MenuItem {
	root := fyne.NewMenuItem("Microdrives", nil)

	slotCount := emu.peripherals.MicrodriveSlotCount()
	driveItems := make([]*fyne.MenuItem, slotCount)
	for i := 0; i < slotCount; i++ {
		slot := i // capture
		insert := fyne.NewMenuItem("Insert Cartridge...", func() {
			fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
				if err != nil {
					dialog.ShowError(err, w)
					return
				}
				if reader == nil {
					return
				}
				path := reader.URI().Path()
				_ = reader.Close()
				if err := emu.peripherals.LoadMicrodrive(slot, path); err != nil {
					dialog.ShowError(fmt.Errorf("load microdrive: %w", err), w)
					return
				}
				dialog.ShowInformation("Microdrive", fmt.Sprintf("Cartridge loaded into Drive %d:\n%s", slot+1, filepath.Base(path)), w)
			}, w)
			fd.SetFilter(storage.NewExtensionFileFilter([]string{".mdr"}))
			fd.Show()
		})
		save := fyne.NewMenuItem("Save Cartridge...", func() {
			if !emu.peripherals.MicrodriveCartridgeInserted(slot) {
				dialog.ShowInformation("Microdrive", fmt.Sprintf("Drive %d has no cartridge.", slot+1), w)
				return
			}
			fd := dialog.NewFileSave(func(writer fyne.URIWriteCloser, err error) {
				if err != nil {
					dialog.ShowError(err, w)
					return
				}
				if writer == nil {
					return
				}
				path := writer.URI().Path()
				_ = writer.Close()
				if !strings.HasSuffix(strings.ToLower(path), ".mdr") {
					path += ".mdr"
				}
				if err := emu.peripherals.SaveMicrodrive(slot, path); err != nil {
					dialog.ShowError(fmt.Errorf("save microdrive: %w", err), w)
					return
				}
				dialog.ShowInformation("Microdrive", fmt.Sprintf("Drive %d saved to:\n%s", slot+1, filepath.Base(path)), w)
			}, w)
			fd.SetFilter(storage.NewExtensionFileFilter([]string{".mdr"}))
			fd.Show()
		})
		eject := fyne.NewMenuItem("Eject", func() {
			emu.peripherals.EjectMicrodrive(slot)
		})
		wp := fyne.NewMenuItem("Toggle Write Protect", func() {
			emu.peripherals.SetMicrodriveWriteProtect(slot, !emu.peripherals.MicrodriveWriteProtected(slot))
		})

		driveItem := fyne.NewMenuItem(fmt.Sprintf("Drive %d", slot+1), nil)
		driveItem.ChildMenu = fyne.NewMenu("", insert, save, eject, wp)
		driveItems[i] = driveItem
	}
	root.ChildMenu = fyne.NewMenu("", driveItems...)
	return root
}

// scaleToWindowSize maps a percentage (100/125/150/200/300) to the fyne window
// size. The returned height is padded by the menu-bar height so the emulator
// image keeps its intended scale rather than being squashed by the menu. Unknown
// values fall back to 200%.
func scaleToWindowSize(scale int) (float32, float32) {
	w, h := float32(640), float32(480) // 200% — the existing default
	switch scale {
	case 100:
		w, h = 320, 240
	case 125:
		w, h = 400, 300
	case 150:
		w, h = 480, 360
	case 300:
		w, h = 960, 720
	}
	return w, h + menuBarHeight()
}

// menuBarHeight returns the vertical space the window's main menu bar occupies.
// Derived from the theme so it stays correct across themes / DPI: Fyne sizes the
// bar's items as text height plus inner padding above and below.
func menuBarHeight() float32 {
	th := fyne.CurrentApp().Settings().Theme()
	return th.Size(theme.SizeNameText) + 2*th.Size(theme.SizeNameInnerPadding)
}
func desktopMain() {
	flags := parseCLI()
	zxlog.Setup(flags.logLevel)
	zxlog.Banner()

	// Capture-Next-snapshot mode: connect to a reference Next
	// emulator's ZRCP debug protocol, dump its full state, write
	// to install dir, exit. Skips emulator startup entirely.
	if flags.captureNextSnapshot != "" {
		if err := runCaptureNextSnapshot(flags.captureNextSnapshot); err != nil {
			fmt.Fprintf(os.Stderr, "capture-next-snapshot failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	// First-divergence bisection mode (DEV): our Next boot vs a live
	// reference emulator, checkpointed at the n-th hit of an anchor PC.
	if flags.nextBisect != "" {
		if err := runNextBisectFromSpec(flags.nextBisect); err != nil {
			fmt.Fprintf(os.Stderr, "next-bisect failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	// Instruction-level PC-lockstep mode (DEV): step our Next and a live
	// reference emulator one instruction at a time from a matching checkpoint;
	// report the first instruction where the reference emulator doesn't follow our path.
	if flags.nextLockstep != "" {
		if err := runNextLockstepFromSpec(flags.nextLockstep); err != nil {
			fmt.Fprintf(os.Stderr, "next-lockstep failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	// NextReg read-back diff mode (DEV): dump every NextReg ($00-$FF)
	// read-back from our Next and a live reference emulator at a checkpoint and
	// report which differ — finds read-back faithfulness gaps.
	if flags.nextNRDiff != "" {
		if err := runNextNRDiffFromSpec(flags.nextNRDiff); err != nil {
			fmt.Fprintf(os.Stderr, "next-nrdiff failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	// Logical-memory diff mode (DEV): compare our Next's full 64 KB logical
	// memory image to a live reference emulator at a checkpoint. Aimed at the
	// last register-matched hit — a memory diff there isolates the stale
	// cell forking the path; no diff redirects the hunt to port inputs.
	if flags.nextMemDiff != "" {
		if err := runNextMemDiffFromSpec(flags.nextMemDiff); err != nil {
			fmt.Fprintf(os.Stderr, "next-memdiff failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	// Headless mode skips the entire Fyne / GUI path. Wire trace
	// hooks against a freshly-constructed emulator, run frames,
	// optionally dump state, exit.
	if flags.headless {
		// The SAM has its own memory/IO and isn't wired into runHeadless's
		// Spectrum-bound instrumentation; use its dedicated headless path.
		if flags.startInSAM {
			runSAMHeadless(flags)
			return
		}
		runHeadless(flags)
		return
	}

	a := app.NewWithID("com.conorarmstrong.zxgo")
	a.SetIcon(spectrumIcon())

	// Load persisted settings. Missing or corrupt config falls back
	// to defaults so a fresh install (or a future-incompatible file)
	// still launches.
	cfg, cfgErr := config.Load()
	if cfgErr != nil {
		slog.Warn("config load failed; using defaults", "err", cfgErr)
		cfg = &config.Config{}
	}
	// Hand off the SD-card paths to pkg/next/install so its
	// SDCardRoot / SDCardImage helpers find them. Done early
	// because setupNextSubsystems consults them.
	install.ConfiguredSDDir = cfg.NextSDDir
	install.ConfiguredSDImage = cfg.NextSDImage

	// Every launch starts in 48K — matches real Spectrum hardware
	// behaviour (cold boot is always 48K BASIC) and keeps Next mode
	// an opt-in per session, since it depends on user-installed
	// ROMs that may not be present on every machine. cfg.Model
	// is still persisted (the Machine menu writes it), but ignored
	// at startup. --next on the command line overrides this so
	// trace / debug runs can jump straight into Next mode.
	currentModel := roms.Model48K
	switch {
	case flags.startInNext:
		currentModel = roms.ModelNext
	case flags.startInZX81:
		currentModel = roms.ModelZX81
	case flags.startInZX80:
		currentModel = roms.ModelZX80
	case flags.startInPentagon:
		currentModel = roms.ModelPentagon
	case flags.startInSAM:
		currentModel = roms.ModelSAM
	}
	_ = cfg.Model
	currentScale := 200
	if cfg.Scale != 0 {
		currentScale = cfg.Scale
	}

	w := a.NewWindow(fmt.Sprintf("ZX Spectrum Emulator %s - %s", version.Version, roms.GetModelName(currentModel)))
	w.SetIcon(spectrumIcon())
	wScaleW, wScaleH := scaleToWindowSize(currentScale)
	w.Resize(fyne.NewSize(wScaleW, wScaleH))

	emu, err := newEmulator(currentModel)
	if err != nil {
		slog.Error("failed to create emulator", "err", err)
		os.Exit(1)
	}
	emu.window = w
	if flags.trdPath != "" {
		if err := emu.mountTRD(0, flags.trdPath); err != nil {
			slog.Error("failed to mount --trd image", "err", err)
			os.Exit(1)
		}
		slog.Info("mounted TR-DOS disk in drive A", "path", flags.trdPath)
	}
	// Wire trace hooks for the GUI emulator if any channels were
	// requested on the command line. closeFn flushes any open
	// trace-output file at process exit.
	_, closeTrace := installTraceHooks(emu, flags)
	defer closeTrace()

	// --trace-db in GUI mode: same ring recorder as headless so a
	// GUI-only crash flow can be captured and diffed against a
	// healthy headless boot.
	if flags.traceDB != "" {
		if tdb := newTraceDB(flags.traceDBKeep); tdb != nil {
			cpu := emu.cpu
			var dmcPager *divmmc.Pager
			if p, ok := emu.ula.NextDivMMC().(*divmmc.Pager); ok {
				dmcPager = p
			}
			emu.cpu.AddPreFetchHook("trace-db", func(pc uint16) {
				p7, p1, _ := emu.mem.GetPortState()
				bank := int((p7>>4)&1) | int((p1>>1)&2)
				alt := int(emu.mem.AltROMReg())
				dmc := 0
				if dmcPager != nil && dmcPager.IsPagedIn() {
					dmc = 1
				}
				tdb.record(traceDBRow{
					insn: cpu.InstructionCount(), pc: pc, sp: cpu.SP, bank: bank,
					alt: alt, dmc: dmc, frame: int(atomic.LoadInt32(&emu.frameCounter)),
					af: uint16(cpu.A)<<8 | uint16(cpu.F),
					bc: uint16(cpu.B)<<8 | uint16(cpu.C),
					de: uint16(cpu.D)<<8 | uint16(cpu.E),
					hl: uint16(cpu.H)<<8 | uint16(cpu.L),
					ix: cpu.IX, iy: cpu.IY,
				})
			})
			defer func() {
				if n, err := tdb.flushSQLite(flags.traceDB); err == nil {
					slog.Info("trace-db flushed", "path", flags.traceDB, "rows", n)
				}
			}()
			slog.Info("trace-db recording (GUI)", "path", flags.traceDB, "keep", flags.traceDBKeep)
		}
	}

	// Remote-debugger TCP server. Same wiring as headless — gated
	// by --debugger-port>0, the constructor returns nil when the
	// flag is off and WaitIfPaused is nil-safe. Installed before
	// the emulation goroutine starts so breakpoints set via
	// --debugger-pause-at-start fire on the very first M1 fetch.
	emu.rdbg = newRemoteDebugger(emu, flags.debuggerPort, flags.debuggerPauseAtStart, flags.debuggerHistory, flags.debuggerHistoryWide)
	if cfg.CRTFilter {
		emu.crtFilter.Store(true)
	}
	emu.joystickType = configStringToJoystick(cfg.Joystick)
	if emu.joystickType == JoystickKempston && emu.ula != nil {
		emu.ula.KempstonEnabled = true
	}
	if os.Getenv("ZX_GO_BORDER_TRACE") != "" && emu.ula != nil {
		var n int
		emu.ula.SetBorderTracer(func(port uint16, val byte, newBorder byte, scanline int) {
			if n < 200 {
				slog.Info("border-change",
					"port_full", fmt.Sprintf("$%04X", port),
					"port_lo", fmt.Sprintf("$%02X", byte(port)),
					"val", fmt.Sprintf("$%02X", val),
					"border", newBorder,
					"scanline", scanline,
					"pc", fmt.Sprintf("$%04X", emu.cpu.PC))
			}
			n++
		})
	}

	// saveConfig persists the current settings. Called from menu
	// handlers after they mutate state. Errors are logged but not
	// raised to the user — a failed persist shouldn't break the
	// emulation session.
	saveConfig := func() {
		cfg.Model = modelToConfigString(currentModel)
		cfg.Scale = currentScale
		cfg.Joystick = joystickToConfigString(emu.joystickType)
		cfg.CRTFilter = emu.crtFilter.Load()
		cfg.Disciple = emu.peripherals.IsDiscipleEnabled()
		cfg.Interface1 = emu.peripherals.IsInterface1Enabled()
		cfg.KempstonMouse = emu.peripherals.IsKempstonMouseEnabled()
		cfg.ZXPrinter = emu.peripherals.IsZXPrinterEnabled()
		cfg.SpecDrum = emu.speccyDAC != nil && emu.speccyDAC.SpecDrumEnabled()
		cfg.Covox = emu.speccyDAC != nil && emu.speccyDAC.CovoxEnabled()
		if emu.peripherals.IsMultifaceEnabled() {
			if mf := emu.peripherals.GetMultiface(); mf != nil {
				cfg.Multiface = multifaceVariantToConfigString(mf.GetVariant())
			}
		} else {
			cfg.Multiface = ""
		}
		if err := cfg.Save(); err != nil {
			slog.Warn("config save failed", "err", err)
		}
	}

	// Restore peripheral enable states. Best-effort — a missing
	// peripheral ROM (e.g. if1-2.rom) just logs and leaves the
	// peripheral disabled. DISCiPLE / Multiface / IF1 changes need
	// a cold-boot to install their hooks correctly, so reboot once
	// at the end if anything that affects boot was restored.
	peripheralNeedsReboot := false
	// Classic-bus peripherals (DISCiPLE, Multiface, IF1) do not
	// exist on Spectrum Next hardware and their port decodes clash
	// with the Next's I/O space — the DISCiPLE control port $1F
	// shadows the Kempston read the TBBLUE firmware polls during
	// boot, feeding it garbage and crashing the boot into a DI/HALT.
	// Skip restoring them when the current model is the Next.
	classicPeripheralsOK := currentModel != roms.ModelNext && !isZX8x(currentModel) && currentModel != roms.ModelSAM
	if cfg.Disciple && classicPeripheralsOK {
		if err := emu.peripherals.EnableDisciple("roms"); err != nil {
			slog.Warn("config: enable Disciple failed", "err", err)
		} else {
			dev := emu.peripherals.GetDisciple()
			emu.cpu.PreFetchHook = dev.PreFetchHook
			emu.cpu.PostFetchHook = dev.PostFetchHook
			peripheralNeedsReboot = true
		}
	}
	if cfg.Multiface != "" && classicPeripheralsOK {
		variant := configStringToMultifaceVariant(cfg.Multiface)
		if err := emu.peripherals.EnableMultiface(variant, "roms"); err != nil {
			slog.Warn("config: enable Multiface failed", "variant", cfg.Multiface, "err", err)
		} else {
			peripheralNeedsReboot = true
		}
	}
	if cfg.Interface1 {
		if err := emu.enableInterface1(); err != nil {
			slog.Warn("config: enable Interface 1 failed", "err", err)
		} else {
			peripheralNeedsReboot = true
		}
	}
	if cfg.KempstonMouse {
		emu.peripherals.EnableKempstonMouse()
	}
	if cfg.ZXPrinter {
		emu.peripherals.EnableZXPrinter()
	}
	if emu.speccyDAC != nil && classicPeripheralsOK {
		emu.speccyDAC.SetSpecDrum(cfg.SpecDrum)
		emu.speccyDAC.SetCovox(cfg.Covox)
	}
	if peripheralNeedsReboot {
		emu.reboot()
	}

	// Install fast tape loading trap (no-op until a tape is loaded).
	installTapeTrap(emu)

	// Use static image approach
	initialImage := emu.renderFrame()
	screen := canvas.NewImageFromImage(initialImage)
	screen.ScaleMode = canvas.ImageScalePixels

	// Create keyboard widget with event handlers. The mouse
	// callbacks route to the peripheral manager's Kempston mouse
	// — they're no-ops when the mouse isn't enabled, so the
	// handlers can always be installed.
	keyboardWidget := newKeyboardWidget(
		emu.handleKeyDown,
		emu.handleKeyUp,
	)
	keyboardWidget.onTypedRune = emu.handleTypedRune
	keyboardWidget.onFocusLost = emu.releaseAllInput
	keyboardWidget.onMouseMove = func(dx, dy int) {
		emu.peripherals.KempstonMouseMove(dx, dy)
	}
	keyboardWidget.onMouseBtn = func(btn int, pressed bool) {
		emu.peripherals.KempstonMouseButton(btn, pressed)
	}

	// Create model selection callback
	// var-declared (not :=) so the body can reference switchModel
	// itself — the ROM-download retry path re-invokes it on success.
	// rebuildEmulatorCore swaps the running emulator's machine core in place
	// (keeping the goroutines, channels and window). It is used when a model
	// switch crosses the ZX80/ZX81 boundary, because those machines have no ULA
	// or peripheral manager and so cannot use the in-place mem.SwitchModel path
	// that switches between Spectrum models.
	rebuildEmulatorCore := func(newModel roms.SpectrumModel) {
		wasPaused := emu.paused.Load()
		if !emu.paused.Load() {
			emu.togglePause()
		}
		if currentModel == roms.ModelNext {
			unwireNextSubsystems(emu)
		}
		fresh, err := newEmulator(newModel)
		if err != nil {
			dialog.ShowError(fmt.Errorf("failed to switch to %s: %w", roms.GetModelName(newModel), err), w)
			if !wasPaused {
				emu.togglePause()
			}
			return
		}
		// Stop the outgoing machine's audio devices before swapping the core,
		// so we don't leak the old SAM SAA player (or the old ULA's player when
		// crossing into a machine that has no ULA).
		if emu.samAudio != nil {
			_ = emu.samAudio.Close()
			emu.samAudio, emu.samAudioBuf = nil, nil
		}
		if emu.ula != nil && fresh.ula == nil {
			emu.ula.Close()
		}
		emu.cpu = fresh.cpu
		emu.mem = fresh.mem
		emu.ula = fresh.ula
		emu.kbd = fresh.kbd
		emu.peripherals = fresh.peripherals
		emu.zx8x = fresh.zx8x
		emu.sam = fresh.sam
		emu.samAudio = fresh.samAudio
		// fresh.speccyDAC is non-nil only for classic-Spectrum targets
		// (nil for ZX80/ZX81/SAM) — carry it over so the Peripherals
		// menu's SpecDrum/Covox items track the NEW core's DAC instead
		// of staying nil/stale from before the switch.
		emu.speccyDAC = fresh.speccyDAC
		// betaDisk is always nil on a freshly-built core (lazily created
		// by ensureBeta on first TR-DOS mount) — drop any stale interface
		// left over from before the switch. Without this, a Beta
		// interface mounted before crossing into ZX80/ZX81/SAM and back
		// would be "reused" by ensureBeta without ever being rewired to
		// the new mem/ula/cpu, so a later TRD mount would silently not
		// take effect.
		emu.betaDisk = fresh.betaDisk
		emu.model = newModel
		emu.nextEsxdos, emu.nextDAC, emu.nextRegs = fresh.nextEsxdos, fresh.nextDAC, fresh.nextRegs
		emu.nextPalette, emu.nextTilemap, emu.nextCopper = fresh.nextPalette, fresh.nextTilemap, fresh.nextCopper
		emu.nextSprites, emu.nextLayer2 = fresh.nextSprites, fresh.nextLayer2
		currentModel = newModel
		saveConfig()
		w.SetTitle(fmt.Sprintf("ZX Spectrum Emulator %s - %s", version.Version, roms.GetModelName(newModel)))
		if !wasPaused {
			emu.togglePause()
		}
		slog.Info("model switched (core rebuilt)", "model", roms.GetModelName(newModel))
		dialog.ShowInformation("Model Changed", fmt.Sprintf("Successfully switched to %s.", roms.GetModelName(newModel)), w)
	}

	var switchModel func(newModel roms.SpectrumModel)
	switchModel = func(newModel roms.SpectrumModel) {
		slog.Info("switching model", "to", roms.GetModelName(newModel))

		// Pre-flight for ModelNext: surface a friendly dialog when
		// the distro ROM isn't installed, rather than letting the
		// memory layer error out with a wrapped sentinel the user
		// has to decode. We do this BEFORE pausing or touching any
		// subsystem state so a "no, I'll install it first" path
		// leaves the running emulator completely undisturbed.
		if newModel == roms.ModelNext {
			if _, err := install.LoadROM(install.DistroROM); err != nil {
				slog.Warn("Spectrum Next switch: distro ROM not installed — offering download", "err", err)
				// The NextZXOS ROMs are licensed and NOT bundled with
				// the emulator. Offer to fetch them from the official
				// source; on success, retry the switch.
				offerNextROMDownload(w, func() { switchModel(newModel) })
				return
			}
		}

		// Crossing the ZX80/ZX81 or SAM Coupé boundary changes the machine type
		// entirely (own memory/IO, no Spectrum ULA), so rebuild the core instead
		// of the in-place Spectrum↔Spectrum paging swap below.
		if isZX8x(newModel) || emu.zx8x != nil || newModel == roms.ModelSAM || emu.sam != nil {
			rebuildEmulatorCore(newModel)
			return
		}

		// Pause emulation during switch
		wasPaused := emu.paused.Load()
		if !emu.paused.Load() {
			emu.togglePause()
		}

		// Tear down Next-only wiring BEFORE the memory swap when
		// leaving the Next: divMMC, esxDOS, Layer 2 etc all hold
		// pointers into the current memory map and need to be
		// detached before mem.SwitchModel reshuffles the bank
		// allocations.
		wasNext := currentModel == roms.ModelNext
		if wasNext && newModel != roms.ModelNext {
			unwireNextSubsystems(emu)
		}

		if err := emu.mem.SwitchModel(newModel); err != nil {
			slog.Error("failed to switch model", "err", err)
			dialog.ShowError(fmt.Errorf("failed to switch to %s: %w", roms.GetModelName(newModel), err), w)
			// Best-effort revert: if we detached Next subsystems
			// above, re-attach them so the user is back where they
			// started rather than in a half-wired state.
			if wasNext && newModel != roms.ModelNext {
				if rerr := wireNextSubsystems(emu); rerr != nil {
					slog.Error("failed to re-wire Next subsystems after switch failure", "err", rerr)
				}
			}
			if !wasPaused {
				emu.togglePause()
			}
			return
		}
		// emu.model must track the switch immediately: the emulation
		// goroutine's run loop reads it every frame (frameTStatesForModel)
		// to pick the per-model T-state budget, independently of
		// currentModel (a UI-only bookkeeping variable below).
		emu.model = newModel

		// Bring Next-only wiring up AFTER the memory swap when
		// entering the Next: the subsystems' divMMC ROM mapping,
		// Layer 2 framebuffer, and 8K MMU all expect the
		// ModelNext bank layout to already be in place.
		if newModel == roms.ModelNext && !wasNext {
			// Tear down edge-connector peripherals that clash with
			// the Next's I/O space first — a lingering DISCiPLE
			// (port $1F) crashes the firmware boot.
			disableClassicBusPeripherals(emu)
			if err := wireNextSubsystems(emu); err != nil {
				slog.Error("failed to wire Next subsystems", "err", err)
				dialog.ShowError(fmt.Errorf("failed to enable Next subsystems: %w", err), w)
				if !wasPaused {
					emu.togglePause()
				}
				return
			}
		}

		// Interface 2 cartridges are 48K-only. If the user switches
		// to a 128K-series model while a cartridge is inserted,
		// eject it — otherwise the cartridge ROM would shadow the
		// 128K ROM and break the new machine.
		if newModel != roms.Model48K && emu.peripherals.IsInterface2CartridgeInserted() {
			emu.peripherals.RemoveInterface2Cartridge()
		}

		currentModel = newModel
		saveConfig()

		// Automatic reboot after model switch
		emu.reboot()
		// Re-apply the per-model frame-INT timing (reboot's CPU reset keeps
		// the fields, but the model just changed).
		configureClassicIntTiming(emu.cpu, newModel)

		// Update window title to show current model
		w.SetTitle(fmt.Sprintf("ZX Spectrum Emulator %s - %s", version.Version, roms.GetModelName(currentModel)))

		// Resume emulation if it was running
		if !wasPaused {
			emu.togglePause()
		}

		slog.Info("model switched", "model", roms.GetModelName(currentModel))
		dialog.ShowInformation("Model Changed", fmt.Sprintf("Successfully switched to %s\n\nThe emulator has been automatically rebooted with the new ROM.", roms.GetModelName(currentModel)), w)
	}

	// ensureModelForSnapshot puts the machine on a stock 128K before applying
	// a plain 128K snapshot loaded from a user file, when the current model
	// can't run one as-is:
	//   - 48K has no bank paging at all, so the banks can't be placed;
	//   - +2A/+3 use a different paging scheme (port $1FFD) that a plain 128K
	//     snapshot doesn't carry, so it pages wrongly and crashes a few
	//     seconds in.
	// 128K/+2/Pentagon already page a 128K snapshot correctly, so they're left
	// alone. Reuses the fully-wired model switch (ROM reload + AY re-wire).
	// Only file loads need this; in-session restores (RZX/quick-save) already
	// match the running model.
	ensureModelForSnapshot := func(snap *snapshot.Snapshot) {
		if !snap.Memory.Is128K {
			return
		}
		switch emu.mem.GetCurrentModel() {
		case roms.Model48K, roms.ModelPlus2A, roms.ModelPlus3:
			switchModel(roms.Model128K)
		}
	}

	// loadFileByPath auto-detects file type by extension and routes
	// to the appropriate loader. Used by the unified "Open File..."
	// menu item, the Recent submenu, and the drag-and-drop window
	// handler. On success the path is prepended to cfg.RecentFiles
	// and a config save is triggered; the caller decides whether to
	// refresh the recent submenu UI.
	loadFileByPath := func(path string) (string, error) {
		ext := strings.ToLower(filepath.Ext(path))
		// On the ZX80/ZX81 (no ULA) only the native program formats are
		// loadable; Spectrum tape/disk/snapshot formats would dereference the
		// nil ula, so reject them with a clear message.
		if emu.zx8x != nil {
			switch ext {
			case ".p", ".81", ".o", ".80":
			default:
				return "", fmt.Errorf("%s files are Spectrum-only — switch to a Spectrum model first (the ZX80/ZX81 load .p/.o programs)", ext)
			}
		}
		switch ext {
		case ".tap":
			tp := ula.NewTapePlayer()
			if err := tp.LoadTAP(path); err != nil {
				return "", fmt.Errorf("load TAP: %w", err)
			}
			emu.ula.SetTapePlayer(tp)
			tp.Play()
			slog.Info("tape loaded", "format", "TAP", "blocks", tp.BlockCount(), "path", path)
			return "tape", nil
		case ".tzx":
			tp := ula.NewTapePlayer()
			if err := tp.LoadTZX(path); err != nil {
				return "", fmt.Errorf("load TZX: %w", err)
			}
			emu.ula.SetTapePlayer(tp)
			tp.Play()
			slog.Info("tape loaded", "format", "TZX", "blocks", tp.BlockCount(), "path", path)
			return "tape", nil
		case ".z80", ".sna", ".szx":
			snap := snapshot.New()
			if err := snap.Load(path); err != nil {
				return "", fmt.Errorf("load snapshot: %w", err)
			}
			ensureModelForSnapshot(snap)
			if err := applySnapshotToEmulator(emu, snap); err != nil {
				return "", fmt.Errorf("apply snapshot: %w", err)
			}
			slog.Info("snapshot loaded", "format", getFormatName(snap.Format), "is128k", snap.Memory.Is128K, "path", path)
			return "snapshot", nil
		case ".p", ".81":
			if emu.zx8x == nil || emu.model != roms.ModelZX81 {
				return "", fmt.Errorf("switch to the ZX81 first (Machine → Sinclair ZX81) before loading a .P program")
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return "", fmt.Errorf("read .P: %w", err)
			}
			wasPaused := emu.paused.Load()
			if !wasPaused {
				emu.togglePause()
			}
			emu.zx8x.InjectP(data)
			if !wasPaused {
				emu.togglePause()
			}
			return "ZX81 program", nil
		case ".o", ".80":
			if emu.zx8x == nil || emu.model != roms.ModelZX80 {
				return "", fmt.Errorf("switch to the ZX80 first (Machine → Sinclair ZX80) before loading a .O program")
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return "", fmt.Errorf("read .O: %w", err)
			}
			wasPaused := emu.paused.Load()
			if !wasPaused {
				emu.togglePause()
			}
			emu.zx8x.InjectO(data)
			if !wasPaused {
				emu.togglePause()
			}
			return "ZX80 program", nil
		case ".rzx":
			file, err := rzx.ReadFile(path)
			if err != nil {
				return "", fmt.Errorf("load RZX: %w", err)
			}
			if err := emu.startRZXPlayback(file); err != nil {
				return "", fmt.Errorf("start RZX playback: %w", err)
			}
			return "RZX recording", nil
		case ".nex":
			if currentModel != roms.ModelNext {
				return "", fmt.Errorf(".nex requires Spectrum Next mode (Machine → ZX Spectrum Next, then restart)")
			}
			if emu.sdImageSrc == nil {
				return "", fmt.Errorf(".nex loading needs a Spectrum Next SD card (none is configured)")
			}
			// Validate the file before offering to copy it.
			if _, err := nex.ParseFile(path); err != nil {
				return "", fmt.Errorf("parse NEX: %w", err)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return "", fmt.Errorf("read NEX: %w", err)
			}
			// .nex games are loaded through NextZXOS's own .nexload (so
			// games that depend on the OS run exactly as on hardware),
			// which requires the file on the SD card. Confirm the copy
			// with the user, then import and launch.
			emu.confirmImportNex(filepath.Base(path), data)
			return "Loading " + filepath.Base(path) + " via NextZXOS…", nil
		default:
			return "", fmt.Errorf("unrecognised file extension %q (supported: .tap .tzx .z80 .sna .szx .rzx; .nex requires Next mode)", ext)
		}
	}

	// recentSubmenu is rebuilt from cfg.RecentFiles after each
	// successful load. The menu items array is replaced wholesale
	// rather than mutated so Fyne re-lays out the menu on Refresh.
	recentSubmenu := fyne.NewMenuItem("Recent", nil)
	recentSubmenu.ChildMenu = fyne.NewMenu("")

	var refreshRecentMenu func()
	refreshRecentMenu = func() {
		if len(cfg.RecentFiles) == 0 {
			empty := fyne.NewMenuItem("(empty)", nil)
			empty.Disabled = true
			recentSubmenu.ChildMenu.Items = []*fyne.MenuItem{empty}
			return
		}
		// Recent files in MRU order, then a separator, then
		// "Clear Recent Files" so a corrupt/stale MRU isn't
		// trapped behind manual config.json editing.
		items := make([]*fyne.MenuItem, 0, len(cfg.RecentFiles)+2)
		for _, p := range cfg.RecentFiles {
			p := p // capture
			item := fyne.NewMenuItem(filepath.Base(p), func() {
				if _, err := loadFileByPath(p); err != nil {
					dialog.ShowError(err, w)
					return
				}
				cfg.AddRecent(p)
				saveConfig()
				refreshRecentMenu()
				fyne.Do(func() { w.MainMenu().Refresh() })
			})
			items = append(items, item)
		}
		items = append(items, fyne.NewMenuItemSeparator())
		items = append(items, fyne.NewMenuItem("Clear Recent Files", func() {
			cfg.RecentFiles = nil
			saveConfig()
			refreshRecentMenu()
			fyne.Do(func() { w.MainMenu().Refresh() })
		}))
		recentSubmenu.ChildMenu.Items = items
	}
	refreshRecentMenu()

	// Window-wide drag-and-drop: any URI dropped on the window
	// dispatches to loadFileByPath. Multiple files are loaded in
	// order; the last successful one wins (snapshots can replace
	// the running state, tapes replace each other, etc.).
	w.SetOnDropped(func(_ fyne.Position, items []fyne.URI) {
		for _, u := range items {
			path := u.Path()
			if _, err := loadFileByPath(path); err != nil {
				dialog.ShowError(err, w)
				continue
			}
			cfg.AddRecent(path)
		}
		saveConfig()
		refreshRecentMenu()
		fyne.Do(func() { w.MainMenu().Refresh() })
	})

	mainMenu := fyne.NewMainMenu(
		fyne.NewMenu("File",
			fyne.NewMenuItem("Quick Save State (F2)", func() {
				if err := emu.quickSaveState(); err != nil {
					dialog.ShowError(err, w)
				} else {
					dialog.ShowInformation("Quick Save", "State saved.\nPress F4 (or Quick Load State) to restore.", w)
				}
			}),
			fyne.NewMenuItem("Quick Load State (F4)", func() {
				if err := emu.quickLoadState(); err != nil {
					dialog.ShowError(err, w)
				}
			}),
			fyne.NewMenuItemSeparator(),
			fyne.NewMenuItem("Open File...", func() {
				fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
					if err != nil {
						dialog.ShowError(err, w)
						return
					}
					if reader == nil {
						return
					}
					path := reader.URI().Path()
					_ = reader.Close()
					kind, err := loadFileByPath(path)
					if err != nil {
						dialog.ShowError(err, w)
						return
					}
					cfg.AddRecent(path)
					saveConfig()
					refreshRecentMenu()
					fyne.Do(func() { w.MainMenu().Refresh() })
					dialog.ShowInformation("Opened", fmt.Sprintf("Loaded %s from:\n%s", kind, filepath.Base(path)), w)
				}, w)
				fd.SetFilter(storage.NewExtensionFileFilter([]string{".tap", ".tzx", ".z80", ".sna", ".szx", ".rzx", ".nex", ".p", ".81", ".o", ".80"}))
				fd.Show()
			}),
			recentSubmenu,
			fyne.NewMenuItemSeparator(),
			fileSubmenu("Snapshots & ROM",
				fyne.NewMenuItem("Load ROM...", func() {
					fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if reader == nil {
							return
						}
						romPath := reader.URI().Path()
						_ = reader.Close()

						// Read the ROM file
						data, readErr := os.ReadFile(romPath)
						if readErr != nil {
							dialog.ShowError(fmt.Errorf("failed to read ROM: %w", readErr), w)
							return
						}

						// Validate size: 16KB for system ROMs, 8KB for peripheral ROMs
						if len(data) != 16384 && len(data) != 8192 {
							dialog.ShowError(fmt.Errorf("invalid ROM size: %d bytes (expected 16384 or 8192)", len(data)), w)
							return
						}

						// Pause, load the ROM into slot 0, reboot
						wasPaused := emu.paused.Load()
						if !emu.paused.Load() {
							emu.togglePause()
						}

						if len(data) == 16384 {
							// Replace the current model's primary ROM
							page := emu.mem.GetROMPage(0)
							if page != nil {
								copy(page, data)
							}
						}

						emu.reboot()

						if !wasPaused {
							emu.togglePause()
						}

						slog.Info("loaded ROM", "path", romPath, "size", len(data))
						dialog.ShowInformation("ROM Loaded", fmt.Sprintf("Loaded %s\n(%d bytes)\n\nEmulator rebooted.", reader.URI().Name(), len(data)), w)
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".rom"}))
					fd.Show()
				}),
				fyne.NewMenuItem("Load Snapshot...", func() {
					slog.Debug("load snapshot dialog opened")
					fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if reader == nil {
							return
						}
						slog.Info("snapshot selected", "path", reader.URI().Path())

						// Load the snapshot
						snap := snapshot.New()
						if err := snap.Load(reader.URI().Path()); err != nil {
							dialog.ShowError(fmt.Errorf("failed to load snapshot: %w", err), w)
							_ = reader.Close()
							return
						}

						// Bring the machine up to 128K first if this is a 128K
						// snapshot (a 48K machine can't page its banks).
						ensureModelForSnapshot(snap)

						// Apply snapshot to emulator
						if err := applySnapshotToEmulator(emu, snap); err != nil {
							dialog.ShowError(fmt.Errorf("failed to apply snapshot: %w", err), w)
							_ = reader.Close()
							return
						}

						slog.Info("snapshot loaded", "format", getFormatName(snap.Format))
						dialog.ShowInformation("Snapshot Loaded", fmt.Sprintf("Successfully loaded %s snapshot from:\n%s", getFormatName(snap.Format), reader.URI().Name()), w)
						_ = reader.Close()
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".z80", ".sna", ".szx"}))
					fd.Show()
				}),
				fyne.NewMenuItem("Save Snapshot...", func() {
					slog.Debug("save snapshot dialog opened")
					fd := dialog.NewFileSave(func(writer fyne.URIWriteCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if writer == nil {
							return
						}
						slog.Info("snapshot save location selected", "path", writer.URI().Path())

						// Create snapshot from current emulator state
						snap, err := createSnapshotFromEmulator(emu)
						if err != nil {
							dialog.ShowError(fmt.Errorf("failed to create snapshot: %w", err), w)
							_ = writer.Close()
							return
						}

						// Save the snapshot
						if err := snap.Save(writer.URI().Path()); err != nil {
							dialog.ShowError(fmt.Errorf("failed to save snapshot: %w", err), w)
							_ = writer.Close()
							return
						}

						slog.Info("snapshot saved", "format", getFormatName(snap.Format))
						dialog.ShowInformation("Snapshot Saved", fmt.Sprintf("Successfully saved %s snapshot to:\n%s", getFormatName(snap.Format), writer.URI().Name()), w)
						_ = writer.Close()
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".z80", ".sna", ".szx"}))
					fd.Show()
				}),
			),
			fileSubmenu("Spectrum Next",
				fyne.NewMenuItem("Install Next ROMs...", func() { installNextROM(w) }),
				fyne.NewMenuItem("Set Next SD Card Directory...", func() {
					fd := dialog.NewFolderOpen(func(uri fyne.ListableURI, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if uri == nil {
							return
						}
						dir := uri.Path()
						cfg.NextSDDir = dir
						cfg.NextSDImage = "" // dir takes precedence — clear image
						install.ConfiguredSDDir = dir
						install.ConfiguredSDImage = ""
						if err := cfg.Save(); err != nil {
							slog.Warn("config save failed", "err", err)
						}
						dialog.ShowInformation("Next SD Card",
							"SD card directory set to:\n"+dir+
								"\n\nRestart ModelNext (Machine menu) to pick up the change.",
							w)
					}, w)
					fd.Show()
				}),
				fyne.NewMenuItem("Set Next SD Card Image (.img/.mmc)...", func() {
					fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if reader == nil {
							return
						}
						path := reader.URI().Path()
						_ = reader.Close()
						cfg.NextSDImage = path
						cfg.NextSDDir = "" // image takes precedence — clear dir
						install.ConfiguredSDImage = path
						install.ConfiguredSDDir = ""
						if err := cfg.Save(); err != nil {
							slog.Warn("config save failed", "err", err)
						}
						dialog.ShowInformation("Next SD Card",
							"SD card image set to:\n"+path+
								"\n\nRestart ModelNext (Machine menu) to pick up the change.",
							w)
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".img", ".mmc", ".IMG", ".MMC"}))
					fd.Show()
				}),
				fyne.NewMenuItem("Clear Next SD Card Setting", func() {
					cfg.NextSDDir = ""
					cfg.NextSDImage = ""
					install.ConfiguredSDDir = ""
					install.ConfiguredSDImage = ""
					if err := cfg.Save(); err != nil {
						slog.Warn("config save failed", "err", err)
					}
					dialog.ShowInformation("Next SD Card",
						"SD card setting cleared. The emulator will fall back to "+
							"its default search (roms/next/sd if present).", w)
				}),
			),
			fileSubmenu("Tapes, Disks & Cartridges",
				fyne.NewMenuItem("Load Tape (TAP)...", func() {
					fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if reader == nil {
							return
						}
						tp := ula.NewTapePlayer()
						if err := tp.LoadTAP(reader.URI().Path()); err != nil {
							dialog.ShowError(fmt.Errorf("failed to load TAP: %w", err), w)
							_ = reader.Close()
							return
						}
						emu.ula.SetTapePlayer(tp)
						tp.Play()
						slog.Info("tape loaded", "format", "TAP", "blocks", tp.BlockCount(), "path", reader.URI().Path())
						dialog.ShowInformation("Tape Loaded", fmt.Sprintf("Loaded %d blocks from:\n%s\n\nTape is now playing.", tp.BlockCount(), reader.URI().Name()), w)
						_ = reader.Close()
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".tap"}))
					fd.Show()
				}),
				fyne.NewMenuItem("Load Tape (TZX)...", func() {
					fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if reader == nil {
							return
						}
						tp := ula.NewTapePlayer()
						if err := tp.LoadTZX(reader.URI().Path()); err != nil {
							dialog.ShowError(fmt.Errorf("failed to load TZX: %w", err), w)
							_ = reader.Close()
							return
						}
						emu.ula.SetTapePlayer(tp)
						tp.Play()
						slog.Info("tape loaded", "format", "TZX", "blocks", tp.BlockCount(), "path", reader.URI().Path())
						dialog.ShowInformation("Tape Loaded", fmt.Sprintf("Loaded %d blocks from:\n%s\n\nTape is now playing.", tp.BlockCount(), reader.URI().Name()), w)
						_ = reader.Close()
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".tzx"}))
					fd.Show()
				}),
				fyne.NewMenuItem("Insert Interface 2 Cartridge...", func() {
					insertInterface2Cartridge(emu, w, currentModel)
				}),
				fyne.NewMenuItem("Eject Interface 2 Cartridge", func() {
					ejectInterface2Cartridge(emu, w)
				}),
				fyne.NewMenuItem("Load DISCiPLE Disk 1...", func() {
					loadDiscipleDisk(emu, w, 0)
				}),
				fyne.NewMenuItem("Load DISCiPLE Disk 2...", func() {
					loadDiscipleDisk(emu, w, 1)
				}),
				fyne.NewMenuItem("Load Disk A...", func() {
					loadPlus3Disk(emu, w, currentModel, 0)
				}),
				fyne.NewMenuItem("Load Disk B...", func() {
					loadPlus3Disk(emu, w, currentModel, 1)
				}),
				fyne.NewMenuItem("Load TR-DOS Disk A (.TRD)...", func() {
					loadTRDDisk(emu, w, 0)
				}),
				fyne.NewMenuItem("Load TR-DOS Disk B (.TRD)...", func() {
					loadTRDDisk(emu, w, 1)
				}),
				fyne.NewMenuItem("Eject TR-DOS Disk A", func() {
					emu.ejectTRD(0)
				}),
				fyne.NewMenuItem("Eject TR-DOS Disk B", func() {
					emu.ejectTRD(1)
				}),
				fyne.NewMenuItem("Load SAM Disk 1 (.mgt/.sad)...", func() {
					loadSAMDisk(emu, w, 0)
				}),
				fyne.NewMenuItem("Load SAM Disk 2 (.mgt/.sad)...", func() {
					loadSAMDisk(emu, w, 1)
				}),
				fyne.NewMenuItem("Save Disk A (DSK)...", func() {
					savePlus3Disk(emu, w, 0)
				}),
				fyne.NewMenuItem("Save Disk B (DSK)...", func() {
					savePlus3Disk(emu, w, 1)
				}),
				fyne.NewMenuItem("Eject Disk A", func() {
					emu.peripherals.EjectPlus3Disk(0)
				}),
				fyne.NewMenuItem("Eject Disk B", func() {
					emu.peripherals.EjectPlus3Disk(1)
				}),
				func() *fyne.MenuItem {
					wpA := false
					item := fyne.NewMenuItem("Write Protect Disk A", nil)
					item.Action = func() {
						wpA = !wpA
						emu.peripherals.SetPlus3WriteProtect(0, wpA)
						if wpA {
							item.Label = "Unprotect Disk A"
						} else {
							item.Label = "Write Protect Disk A"
						}
						fyne.Do(func() { w.MainMenu().Refresh() })
					}
					return item
				}(),
				func() *fyne.MenuItem {
					wpB := false
					item := fyne.NewMenuItem("Write Protect Disk B", nil)
					item.Action = func() {
						wpB = !wpB
						emu.peripherals.SetPlus3WriteProtect(1, wpB)
						if wpB {
							item.Label = "Unprotect Disk B"
						} else {
							item.Label = "Write Protect Disk B"
						}
						fyne.Do(func() { w.MainMenu().Refresh() })
					}
					return item
				}(),
				func() *fyne.MenuItem {
					speedlockOn := false
					item := fyne.NewMenuItem("Enable Speedlock Workaround", nil)
					item.Action = func() {
						speedlockOn = !speedlockOn
						emu.peripherals.SetPlus3Speedlock(speedlockOn)
						if speedlockOn {
							item.Label = "Disable Speedlock Workaround"
						} else {
							item.Label = "Enable Speedlock Workaround"
						}
						fyne.Do(func() { w.MainMenu().Refresh() })
					}
					return item
				}(),
			),
			fileSubmenu("Recording (RZX)",
				fyne.NewMenuItem("Open RZX Recording...", func() {
					fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if reader == nil {
							return
						}
						path := reader.URI().Path()
						_ = reader.Close()
						file, err := rzx.ReadFile(path)
						if err != nil {
							dialog.ShowError(fmt.Errorf("failed to load RZX: %w", err), w)
							return
						}
						if err := emu.startRZXPlayback(file); err != nil {
							dialog.ShowError(fmt.Errorf("failed to start RZX playback: %w", err), w)
							return
						}
						dialog.ShowInformation("RZX Playback", fmt.Sprintf("Playing back:\n%s", filepath.Base(path)), w)
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".rzx"}))
					fd.Show()
				}),
				fyne.NewMenuItem("Stop RZX Playback", func() {
					emu.stopRZXPlayback()
				}),
				fyne.NewMenuItem("Start RZX Recording...", func() {
					fd := dialog.NewFileSave(func(writer fyne.URIWriteCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if writer == nil {
							return
						}
						path := writer.URI().Path()
						_ = writer.Close()
						if !strings.HasSuffix(strings.ToLower(path), ".rzx") {
							path += ".rzx"
						}
						if err := emu.startRZXRecording(path, false); err != nil {
							dialog.ShowError(fmt.Errorf("start RZX recording: %w", err), w)
							return
						}
						dialog.ShowInformation("RZX Recording", fmt.Sprintf("Recording to:\n%s", filepath.Base(path)), w)
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".rzx"}))
					fd.Show()
				}),
				fyne.NewMenuItem("Stop RZX Recording", func() {
					if err := emu.stopRZXRecording(); err != nil {
						dialog.ShowError(fmt.Errorf("stop RZX recording: %w", err), w)
						return
					}
					dialog.ShowInformation("RZX Recording", "Recording stopped and saved.", w)
				}),
				fyne.NewMenuItem("RZX Rollback (last snapshot)", func() {
					if err := emu.rzxRollbackToLastSnapshot(); err != nil {
						dialog.ShowError(fmt.Errorf("RZX rollback: %w", err), w)
					}
				}),
			),
			makeMicrodriveMenu(emu, w),
			fileSubmenu("ZX Printer",
				fyne.NewMenuItem("Save ZX Printer Output (PNG)...", func() {
					if !emu.peripherals.IsZXPrinterEnabled() {
						dialog.ShowInformation("ZX Printer", "ZX Printer is not enabled.\nEnable it from the Peripherals menu first.", w)
						return
					}
					printer := emu.peripherals.ZXPrinter()
					if printer.Rows() == 0 {
						dialog.ShowInformation("ZX Printer", "Nothing has been printed yet.", w)
						return
					}
					fd := dialog.NewFileSave(func(writer fyne.URIWriteCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if writer == nil {
							return
						}
						path := writer.URI().Path()
						_ = writer.Close()
						if !strings.HasSuffix(strings.ToLower(path), ".png") {
							path += ".png"
						}
						if err := printer.Save(path); err != nil {
							dialog.ShowError(fmt.Errorf("save printer output: %w", err), w)
							return
						}
						dialog.ShowInformation("ZX Printer", fmt.Sprintf("Saved %d rows to:\n%s", printer.Rows(), filepath.Base(path)), w)
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".png"}))
					fd.Show()
				}),
				fyne.NewMenuItem("Clear ZX Printer Output", func() {
					if !emu.peripherals.IsZXPrinterEnabled() {
						return
					}
					emu.peripherals.ZXPrinter().Clear()
				}),
			),
			fileSubmenu("Save Tape",
				fyne.NewMenuItem("Save Tape (TAP)...", func() {
					tp := emu.ula.GetTapePlayer()
					if tp == nil || tp.BlockCount() == 0 {
						dialog.ShowInformation("Save Tape", "No tape loaded.", w)
						return
					}
					fd := dialog.NewFileSave(func(writer fyne.URIWriteCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if writer == nil {
							return
						}
						path := writer.URI().Path()
						_ = writer.Close()
						if err := tp.SaveTAP(path); err != nil {
							dialog.ShowError(fmt.Errorf("failed to save TAP: %w", err), w)
							return
						}
						dialog.ShowInformation("Tape Saved", fmt.Sprintf("Saved %d block(s) to:\n%s", tp.BlockCount(), writer.URI().Name()), w)
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".tap"}))
					fd.Show()
				}),
				fyne.NewMenuItem("Save Tape (TZX)...", func() {
					tp := emu.ula.GetTapePlayer()
					if tp == nil || tp.BlockCount() == 0 {
						dialog.ShowInformation("Save Tape", "No tape loaded.", w)
						return
					}
					fd := dialog.NewFileSave(func(writer fyne.URIWriteCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if writer == nil {
							return
						}
						path := writer.URI().Path()
						_ = writer.Close()
						if err := tp.SaveTZX(path); err != nil {
							dialog.ShowError(fmt.Errorf("failed to save TZX: %w", err), w)
							return
						}
						dialog.ShowInformation("Tape Saved", fmt.Sprintf("Saved %d block(s) to:\n%s", tp.BlockCount(), writer.URI().Name()), w)
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".tzx"}))
					fd.Show()
				}),
				fyne.NewMenuItem("Stop Tape", func() {
					if emu.ula != nil {
						emu.ula.SetTapePlayer(nil)
						emu.ula.TapeIn = false
					}
				}),
				func() *fyne.MenuItem {
					item := fyne.NewMenuItem("Fast Tape Loading", nil)
					item.Checked = emu.fastTape.Load()
					item.Action = func() {
						emu.fastTape.Store(!emu.fastTape.Load())
						item.Checked = emu.fastTape.Load()
						fyne.Do(func() { w.MainMenu().Refresh() })
					}
					return item
				}(),
				fyne.NewMenuItem("Tape Browser...", func() {
					tp := emu.ula.GetTapePlayer()
					if tp == nil {
						dialog.ShowInformation("Tape Browser", "No tape loaded.", w)
						return
					}
					blocks := tp.Blocks()
					if len(blocks) == 0 {
						dialog.ShowInformation("Tape Browser", "Tape contains no blocks.", w)
						return
					}
					current := tp.CurrentBlock()
					items := make([]string, len(blocks))
					for i, b := range blocks {
						marker := "  "
						if i == current {
							marker = "▶ "
						}
						if b.Title != "" {
							items[i] = fmt.Sprintf("%s%3d  %-10s  %5d B  %q", marker, b.Index, b.Type, b.Length, b.Title)
						} else {
							items[i] = fmt.Sprintf("%s%3d  %-10s  %5d B  flag=0x%02X", marker, b.Index, b.Type, b.Length, b.FlagByte)
						}
					}
					list := widget.NewList(
						func() int { return len(items) },
						func() fyne.CanvasObject { return widget.NewLabel("") },
						func(id widget.ListItemID, obj fyne.CanvasObject) {
							obj.(*widget.Label).SetText(items[id])
						},
					)
					selected := current
					list.OnSelected = func(id widget.ListItemID) { selected = id }
					list.Select(current)

					content := container.NewBorder(
						widget.NewLabel(fmt.Sprintf("%d blocks  •  current: %d", len(blocks), current)),
						nil, nil, nil,
						list,
					)
					d := dialog.NewCustomConfirm(
						"Tape Browser",
						"Jump to selected",
						"Close",
						content,
						func(ok bool) {
							if !ok {
								return
							}
							tp.SeekToBlock(selected)
							tp.Play()
						},
						w,
					)
					d.Resize(fyne.NewSize(520, 400))
					d.Show()
				}),
			),
			fyne.NewMenuItemSeparator(),
			func() *fyne.MenuItem {
				item := fyne.NewMenuItem("Start Recording (WAV)...", nil)
				item.Action = func() {
					if emu.ula.IsRecording() {
						if err := emu.ula.StopRecording(); err != nil {
							dialog.ShowError(fmt.Errorf("failed to stop recording: %w", err), w)
							return
						}
						item.Label = "Start Recording (WAV)..."
						fyne.Do(func() { w.MainMenu().Refresh() })
						dialog.ShowInformation("Recording", "Recording stopped.", w)
						return
					}
					fd := dialog.NewFileSave(func(writer fyne.URIWriteCloser, err error) {
						if err != nil {
							dialog.ShowError(err, w)
							return
						}
						if writer == nil {
							return
						}
						path := writer.URI().Path()
						// We only need the path; close the writer and open
						// our own file inside the audio package.
						_ = writer.Close()
						if err := emu.ula.StartRecording(path); err != nil {
							dialog.ShowError(fmt.Errorf("failed to start recording: %w", err), w)
							return
						}
						item.Label = "Stop Recording"
						fyne.Do(func() { w.MainMenu().Refresh() })
					}, w)
					fd.SetFilter(storage.NewExtensionFileFilter([]string{".wav"}))
					fd.Show()
				}
				return item
			}(),
			fyne.NewMenuItem("Save Screenshot...", func() {
				fd := dialog.NewFileSave(func(writer fyne.URIWriteCloser, err error) {
					if err != nil {
						dialog.ShowError(err, w)
						return
					}
					if writer == nil {
						return
					}
					path := writer.URI().Path()
					werr := writeScreenshotPNG(emu, writer)
					_ = writer.Close()
					if werr != nil {
						dialog.ShowError(fmt.Errorf("failed to write PNG: %w", werr), w)
						return
					}
					// Auto-add the .png extension when the user didn't
					// type one — fyne saves to the exact name given, so
					// rename the just-written file.
					path = ensureFileExt(path, ".png")
					dialog.ShowInformation("Screenshot Saved", "Saved screenshot to:\n"+filepath.Base(path), w)
				}, w)
				fd.SetFilter(storage.NewExtensionFileFilter([]string{".png"}))
				fd.Show()
			}),
		),
		fyne.NewMenu("Machine",
			fyne.NewMenuItem("48K", func() { switchModel(roms.Model48K) }),
			fyne.NewMenuItem("128K", func() { switchModel(roms.Model128K) }),
			fyne.NewMenuItem("+2", func() { switchModel(roms.ModelPlus2) }),
			fyne.NewMenuItem("+2A", func() { switchModel(roms.ModelPlus2A) }),
			fyne.NewMenuItem("+3", func() { switchModel(roms.ModelPlus3) }),
			fyne.NewMenuItem("Pentagon 128", func() { switchModel(roms.ModelPentagon) }),
			fyne.NewMenuItem("SAM Coupé", func() { switchModel(roms.ModelSAM) }),
			fyne.NewMenuItemSeparator(),
			fyne.NewMenuItem("Sinclair ZX81", func() { switchModel(roms.ModelZX81) }),
			fyne.NewMenuItem("Sinclair ZX80", func() { switchModel(roms.ModelZX80) }),
			fyne.NewMenuItemSeparator(),
			nextMenuItem(switchModel),
			cpuSpeedMenuItem(emu),
		),
		fyne.NewMenu("View",
			fyne.NewMenuItem("100% (320x240)", func() {
				w.SetFullScreen(false)
				w.Resize(fyne.NewSize(scaleToWindowSize(100)))
				currentScale = 100
				saveConfig()
			}),
			fyne.NewMenuItem("125% (400x300)", func() {
				w.SetFullScreen(false)
				w.Resize(fyne.NewSize(scaleToWindowSize(125)))
				currentScale = 125
				saveConfig()
			}),
			fyne.NewMenuItem("150% (480x360)", func() {
				w.SetFullScreen(false)
				w.Resize(fyne.NewSize(scaleToWindowSize(150)))
				currentScale = 150
				saveConfig()
			}),
			fyne.NewMenuItem("200% (640x480)", func() {
				w.SetFullScreen(false)
				w.Resize(fyne.NewSize(scaleToWindowSize(200)))
				currentScale = 200
				saveConfig()
			}),
			fyne.NewMenuItem("300% (960x720)", func() {
				w.SetFullScreen(false)
				w.Resize(fyne.NewSize(scaleToWindowSize(300)))
				currentScale = 300
				saveConfig()
			}),
			fyne.NewMenuItemSeparator(),
			fyne.NewMenuItem("Full Screen", func() {
				w.SetFullScreen(true)
			}),
			func() *fyne.MenuItem {
				initialLabel := "Enable CRT Filter"
				if emu.crtFilter.Load() {
					initialLabel = "Disable CRT Filter"
				}
				item := fyne.NewMenuItem(initialLabel, nil)
				item.Action = func() {
					on := !emu.crtFilter.Load()
					emu.crtFilter.Store(on)
					if on {
						item.Label = "Disable CRT Filter"
					} else {
						item.Label = "Enable CRT Filter"
					}
					saveConfig()
					fyne.Do(func() { w.MainMenu().Refresh() })
				}
				return item
			}(),
		),
		func() *fyne.Menu {
			discipleItem := fyne.NewMenuItem("Enable Disciple", nil)
			mf1Item := fyne.NewMenuItem("Enable Multiface 1", nil)
			mf128Item := fyne.NewMenuItem("Enable Multiface 128", nil)
			mf3Item := fyne.NewMenuItem("Enable Multiface 3", nil)
			if1Item := fyne.NewMenuItem("Enable Interface 1", nil)
			joyNoneItem := fyne.NewMenuItem("Joystick: None", nil)
			joyKempstonItem := fyne.NewMenuItem("Joystick: Kempston", nil)
			joySinclair1Item := fyne.NewMenuItem("Joystick: Sinclair (left, 1-5)", nil)
			joySinclair2Item := fyne.NewMenuItem("Joystick: Sinclair (right, 6-0)", nil)
			joyCursorItem := fyne.NewMenuItem("Joystick: Cursor / Protek", nil)
			kempMouseItem := fyne.NewMenuItem("Enable Kempston Mouse", nil)
			zxPrinterItem := fyne.NewMenuItem("Enable ZX Printer", nil)
			specDrumItem := fyne.NewMenuItem("Enable SpecDrum", nil)
			covoxItem := fyne.NewMenuItem("Enable Covox", nil)

			updateLabels := func() {
				if emu.peripherals.IsDiscipleEnabled() {
					discipleItem.Label = "Disable Disciple"
				} else {
					discipleItem.Label = "Enable Disciple"
				}
				if emu.peripherals.IsMultifaceEnabled() {
					mf1Item.Label = "Disable Multiface"
					mf128Item.Disabled = true
					mf3Item.Disabled = true
				} else {
					mf1Item.Label = "Enable Multiface 1"
					mf128Item.Label = "Enable Multiface 128"
					mf3Item.Label = "Enable Multiface 3"
					mf128Item.Disabled = false
					mf3Item.Disabled = false
				}
				if emu.peripherals.IsInterface1Enabled() {
					if1Item.Label = "Disable Interface 1"
				} else {
					if1Item.Label = "Enable Interface 1"
				}
				// IF1 is 48K-only — grey the menu out on other models.
				if1Item.Disabled = !emu.peripherals.CanEnableInterface1() && !emu.peripherals.IsInterface1Enabled()
				// Show a check next to the active joystick by re-labelling.
				marker := func(t JoystickType, base string) string {
					if emu.joystickType == t {
						return "✓ " + base
					}
					return "  " + base
				}
				joyNoneItem.Label = marker(JoystickNone, "Joystick: None")
				joyKempstonItem.Label = marker(JoystickKempston, "Joystick: Kempston")
				joySinclair1Item.Label = marker(JoystickSinclair1, "Joystick: Sinclair (left, 1-5)")
				joySinclair2Item.Label = marker(JoystickSinclair2, "Joystick: Sinclair (right, 6-0)")
				joyCursorItem.Label = marker(JoystickCursor, "Joystick: Cursor / Protek")
				if emu.peripherals.IsKempstonMouseEnabled() {
					kempMouseItem.Label = "Disable Kempston Mouse"
				} else {
					kempMouseItem.Label = "Enable Kempston Mouse"
				}
				if emu.peripherals.IsZXPrinterEnabled() {
					zxPrinterItem.Label = "Disable ZX Printer"
				} else {
					zxPrinterItem.Label = "Enable ZX Printer"
				}
				// SpecDrum / Covox are classic-Spectrum DACs (nil on Next/ZX8x).
				specDrumItem.Disabled = emu.speccyDAC == nil
				covoxItem.Disabled = emu.speccyDAC == nil
				if emu.speccyDAC != nil && emu.speccyDAC.SpecDrumEnabled() {
					specDrumItem.Label = "Disable SpecDrum"
				} else {
					specDrumItem.Label = "Enable SpecDrum"
				}
				if emu.speccyDAC != nil && emu.speccyDAC.CovoxEnabled() {
					covoxItem.Label = "Disable Covox"
				} else {
					covoxItem.Label = "Enable Covox"
				}
			}

			discipleItem.Action = func() {
				if emu.peripherals.IsDiscipleEnabled() {
					emu.cpu.PreFetchHook = nil
					emu.cpu.PostFetchHook = nil
					emu.peripherals.DisableDisciple()
					emu.reboot()
				} else {
					if err := emu.peripherals.EnableDisciple("roms"); err != nil {
						dialog.ShowError(fmt.Errorf("failed to enable Disciple: %w", err), w)
					} else {
						dev := emu.peripherals.GetDisciple()
						emu.cpu.PreFetchHook = dev.PreFetchHook
						emu.cpu.PostFetchHook = dev.PostFetchHook
						emu.reboot() // cold boot GDOS
					}
				}
				saveConfig()
				fyne.Do(func() {
					updateLabels()
					w.MainMenu().Refresh()
				})
			}

			toggleMF := func(variant multiface.MultifaceType) {
				if emu.peripherals.IsMultifaceEnabled() {
					emu.peripherals.DisableMultiface()
				} else {
					if err := emu.peripherals.EnableMultiface(variant, "roms"); err != nil {
						dialog.ShowError(fmt.Errorf("failed to enable %s: %w", multiface.GetVariantName(variant), err), w)
					}
				}
				saveConfig()
				fyne.Do(func() {
					updateLabels()
					w.MainMenu().Refresh()
				})
			}

			mf1Item.Action = func() { toggleMF(multiface.Multiface1) }
			mf128Item.Action = func() { toggleMF(multiface.Multiface128) }
			mf3Item.Action = func() { toggleMF(multiface.Multiface3) }

			if1Item.Action = func() {
				if emu.peripherals.IsInterface1Enabled() {
					emu.disableInterface1()
				} else {
					if err := emu.enableInterface1(); err != nil {
						dialog.ShowError(fmt.Errorf("failed to enable Interface 1: %w", err), w)
					}
				}
				saveConfig()
				fyne.Do(func() {
					updateLabels()
					w.MainMenu().Refresh()
				})
			}

			selectJoystick := func(t JoystickType) {
				// Release whatever's currently held on the active interface
				// so a held direction doesn't stick in the keyboard matrix
				// (Sinclair/Cursor) or as a Kempston port bit when switching.
				for dir := 0; dir < 5; dir++ {
					emu.dispatchJoystick(dir, false)
				}
				if emu.joystickType == JoystickKempston {
					emu.ula.KempstonEnabled = false
				}
				emu.joystickType = t
				if t == JoystickKempston {
					emu.ula.KempstonEnabled = true
				}
				saveConfig()
				fyne.Do(func() {
					updateLabels()
					w.MainMenu().Refresh()
				})
			}

			joyNoneItem.Action = func() { selectJoystick(JoystickNone) }
			joyKempstonItem.Action = func() { selectJoystick(JoystickKempston) }
			joySinclair1Item.Action = func() { selectJoystick(JoystickSinclair1) }
			joySinclair2Item.Action = func() { selectJoystick(JoystickSinclair2) }
			joyCursorItem.Action = func() { selectJoystick(JoystickCursor) }

			kempMouseItem.Action = func() {
				if emu.peripherals.IsKempstonMouseEnabled() {
					emu.peripherals.DisableKempstonMouse()
				} else {
					emu.peripherals.EnableKempstonMouse()
				}
				saveConfig()
				fyne.Do(func() {
					updateLabels()
					w.MainMenu().Refresh()
				})
			}

			zxPrinterItem.Action = func() {
				if emu.peripherals.IsZXPrinterEnabled() {
					emu.peripherals.DisableZXPrinter()
				} else {
					emu.peripherals.EnableZXPrinter()
				}
				saveConfig()
				fyne.Do(func() {
					updateLabels()
					w.MainMenu().Refresh()
				})
			}

			specDrumItem.Action = func() {
				if emu.speccyDAC == nil {
					return
				}
				emu.speccyDAC.SetSpecDrum(!emu.speccyDAC.SpecDrumEnabled())
				saveConfig()
				fyne.Do(func() {
					updateLabels()
					w.MainMenu().Refresh()
				})
			}

			covoxItem.Action = func() {
				if emu.speccyDAC == nil {
					return
				}
				emu.speccyDAC.SetCovox(!emu.speccyDAC.CovoxEnabled())
				saveConfig()
				fyne.Do(func() {
					updateLabels()
					w.MainMenu().Refresh()
				})
			}

			updateLabels()
			return fyne.NewMenu("Peripherals",
				discipleItem,
				fyne.NewMenuItemSeparator(),
				mf1Item, mf128Item, mf3Item,
				fyne.NewMenuItemSeparator(),
				if1Item,
				fyne.NewMenuItemSeparator(),
				joyNoneItem,
				joyKempstonItem,
				joySinclair1Item,
				joySinclair2Item,
				joyCursorItem,
				fyne.NewMenuItemSeparator(),
				kempMouseItem,
				zxPrinterItem,
				fyne.NewMenuItemSeparator(),
				specDrumItem,
				covoxItem,
			)
		}(),
		fyne.NewMenu("Emulator",
			fyne.NewMenuItem("Reboot", emu.reboot),
			fyne.NewMenuItem("Pause/Resume", emu.togglePause),
			fyne.NewMenuItem("Enter Poke...", func() {
				entry := widget.NewMultiLineEntry()
				entry.SetPlaceHolder("ADDR VALUE\n5C3A FF\n0x4000,0x55\n; comments allowed")
				entry.SetMinRowsVisible(8)
				form := dialog.NewCustomConfirm(
					"Enter Pokes",
					"Apply",
					"Cancel",
					container.NewBorder(
						widget.NewLabel("One poke per line. Address and value are hexadecimal."),
						nil, nil, nil,
						entry,
					),
					func(ok bool) {
						if !ok {
							return
						}
						pokes, perr := parsePokes(entry.Text)
						if perr != nil {
							dialog.ShowError(perr, w)
							return
						}
						for _, p := range pokes {
							emu.mem.Write(p.Addr, p.Val)
						}
						dialog.ShowInformation("Pokes Applied", fmt.Sprintf("Applied %d poke(s).", len(pokes)), w)
					},
					w,
				)
				form.Resize(fyne.NewSize(420, 320))
				form.Show()
			}),
			fyne.NewMenuItem("Debugger", func() {
				dbg := debugger.NewWithBreakpoints(emu.cpu, emu.mem, a, emu.sharedBreakpoints())
				// Share the register-watchpoint set with the telnet
				// debugger so a watch set on either surface fires and
				// is listed on both (the GUI Watchpoints tab).
				dbg.SetRegWatches(emu.sharedRegWatches())
				// Share the time-travel ring (GUI Time-Travel tab and
				// the telnet tt-* commands drive emu.timeTravel).
				dbg.SetTimeTravel(ttController{emu: emu})
				dbg.SetCallbacks(
					func() { emu.paused.Store(true) },
					func() { emu.cpu.StepInstruction() },
					func() { emu.paused.Store(false) },
					func() bool { return emu.paused.Load() },
				)
				// Step Over: run past a CALL/RST/PUSH-NN to its return,
				// else single-step. Runs synchronously while paused
				// (bounded so a non-returning call can't hang the UI),
				// reusing the same call-detection as telnet step-over.
				dbg.SetStepOver(func() {
					c := emu.cpu
					read := func(a uint16) byte { return emu.mem.Read(a) }
					lines := debugger.Disassemble(read, c.PC, 1)
					if len(lines) == 0 || len(lines[0].Bytes) == 0 ||
						!isCallLike(lines[0].Bytes[0], lines[0].Bytes) {
						c.StepInstruction()
						return
					}
					target := c.PC + uint16(len(lines[0].Bytes))
					const stepCap = 20_000_000
					for i := 0; i < stepCap; i++ {
						c.StepInstructionWithIRQ()
						if c.PC == target {
							break
						}
					}
				})
				// Wire breakpoints + register watchpoints: the CPU checks
				// both before each instruction and auto-pauses on a hit.
				emu.cpu.BreakpointCheck = func(pc uint16) bool {
					if dbg.CheckBreakpoint() || dbg.CheckWatchpoints() {
						emu.paused.Store(true)
						return true
					}
					return false
				}
				// Surface Spectrum Next state in the debugger when this
				// emulator instance was built as ModelNext.
				if currentModel == roms.ModelNext {
					dbg.SetNextProvider(newNextDebugProvider(emu))
					dbg.SetNextRegAccessor(emu.nextRegs)
				}
				// Hand the visual debugger the same BankAccessor the
				// telnet bank-peek / bank-poke commands use so the two
				// surfaces share behaviour.
				dbg.SetBankAccessor(&emuBanks{mem: emu.mem, emu: emu})
				// Wire M1-fetch history. If the telnet debugger
				// already started one, reuse it (single ring, two
				// surfaces); otherwise allocate a default-sized wide
				// ring for the visual debugger (interactive
				// investigation always wants IX/IY/HL visible).
				if emu.debugHistory == nil {
					emu.debugHistory = debugger.NewHistoryWide(4096)
					emu.cpu.AddPreFetchHook("visual-debugger-history", func(pc uint16) {
						c := emu.cpu
						emu.debugHistory.Push(debugger.HistoryEntry{
							PC: pc, SP: c.SP, A: c.A, F: c.F,
							IFFIM: debugger.PackIFFIM(c.IFF1, c.IFF2, c.Halted, int(c.IM)),
							Insns: c.InstructionCount(),
							BC:    c.BC(), DE: c.DE(), HL: c.HL(),
							IX: c.IX, IY: c.IY,
							Source: debugger.PCSource(c.BranchSource), SourceFrom: c.BranchFrom,
						})
						c.BranchSource = 0
						c.BranchFrom = 0
					})
				}
				dbg.SetHistory(emu.debugHistory)
				dbg.Show()
			}),
			fyne.NewMenuItemSeparator(),
			fyne.NewMenuItem("ROM Info", func() {
				info := "Loaded ROMs:\n"
				for _, romType := range emu.mem.GetROMManager().GetLoadedROMs() {
					info += "• " + roms.GetROMTypeName(romType) + "\n"
				}
				info += "\nCurrent Model: " + roms.GetModelName(currentModel)
				dialog.ShowInformation("ROM Information", info, w)
			}),
			fyne.NewMenuItem("Peripheral Status", func() {
				status := emu.peripherals.GetStatus()
				info := "Peripheral Status:\n\n"

				if discipleEnabled, ok := status["disciple_enabled"].(bool); ok && discipleEnabled {
					info += "Disciple: Enabled\n"
					if romPaged, ok := status["disciple_rom_paged"].(bool); ok && romPaged {
						info += "  ROM: Paged In\n"
					} else {
						info += "  ROM: Paged Out\n"
					}
					if inhibited, ok := status["disciple_inhibited"].(bool); ok && inhibited {
						info += "  Status: Inhibited\n"
					}
				} else {
					info += "Disciple: Disabled\n"
				}

				if multifaceEnabled, ok := status["multiface_enabled"].(bool); ok && multifaceEnabled {
					if variant, ok := status["multiface_variant"].(string); ok {
						info += fmt.Sprintf("Multiface: %s\n", variant)
					}
					if romPaged, ok := status["multiface_rom_paged"].(bool); ok && romPaged {
						info += "  ROM: Paged In\n"
					} else {
						info += "  ROM: Paged Out\n"
					}
					if invisible, ok := status["multiface_invisible"].(bool); ok && invisible {
						info += "  Mode: Stealth\n"
					}
					if redButton, ok := status["multiface_red_button"].(bool); ok && redButton {
						info += "  Red Button: Pressed\n"
					}
				} else {
					info += "Multiface: Disabled\n"
				}

				info += "\nKeyboard Status: " + emu.kbd.GetKeyStatus()

				dialog.ShowInformation("Peripheral Status", info, w)
			}),
			fyne.NewMenuItem("Custom Keymap...", func() {
				// Read whatever override file is on disk so the dialog
				// reflects the user's most recent edits, even if they
				// changed it externally.
				path := userKeymapPath()
				if path == "" {
					dialog.ShowError(fmt.Errorf("could not determine home directory"), w)
					return
				}
				existing, _ := os.ReadFile(path)
				if len(existing) == 0 {
					existing = []byte("{\n  \"F1\": [{\"row\": 0, \"mask\": 1}, {\"row\": 7, \"mask\": 1}]\n}\n")
				}
				entry := widget.NewMultiLineEntry()
				entry.SetText(string(existing))
				entry.SetMinRowsVisible(12)
				help := widget.NewLabel(
					"JSON map of fyne key name -> matrix entries.\n" +
						"Each entry is {\"row\": 0..7, \"mask\": 1|2|4|8|16}.\n" +
						"Saved to " + path + " and applied immediately.",
				)
				form := dialog.NewCustomConfirm(
					"Custom Keymap",
					"Save & Apply",
					"Cancel",
					container.NewBorder(help, nil, nil, nil, entry),
					func(ok bool) {
						if !ok {
							return
						}
						// Validate JSON before writing.
						var raw map[string][]keyboard.MappingEntry
						if err := json.Unmarshal([]byte(entry.Text), &raw); err != nil {
							dialog.ShowError(fmt.Errorf("invalid keymap JSON: %w", err), w)
							return
						}
						// Ensure the directory exists, then write the file.
						if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
							dialog.ShowError(fmt.Errorf("create config dir: %w", err), w)
							return
						}
						if err := keyboard.SaveOverrides(path, raw); err != nil {
							dialog.ShowError(err, w)
							return
						}
						for name, entries := range raw {
							emu.kbd.SetMapping(fyne.KeyName(name), entries)
						}
						dialog.ShowInformation("Custom Keymap", fmt.Sprintf("Applied %d override(s).", len(raw)), w)
					},
					w,
				)
				form.Resize(fyne.NewSize(520, 420))
				form.Show()
			}),
			fyne.NewMenuItem("Trigger NMI (F12)", func() {
				emu.kbd.SimulateNMI()
			}),
		),
		fyne.NewMenu("Help",
			fyne.NewMenuItem("About zx_go", func() {
				dialog.ShowInformation("About zx_go",
					version.String()+"\n"+
						"built "+version.Date()+"\n\n"+
						"A hardware-faithful ZX Spectrum emulator\n"+
						"(48K / 128K / +2 / +2A / +3 / Next).\n\n"+
						"by "+version.Author+"\n"+
						version.RepoURL+"\n\n"+
						"The NextZXOS ROMs are licensed by their authors and\n"+
						"are not bundled; the emulator can download them from\n"+
						"the official Spectrum Next distribution on request.",
					w)
			}),
		),
	)
	w.SetMainMenu(mainMenu)

	// 4:3 aspect ratio container with black letterbox/pillarbox bars
	blackBG := canvas.NewRectangle(color.Black)
	aspectScreen := container.New(&aspectRatioLayout{ratio: 4.0 / 3.0}, screen)
	content := container.NewStack(blackBG, aspectScreen, keyboardWidget)

	// Show the splash artwork briefly, then swap to the real
	// content and grab keyboard focus. The emulation goroutine
	// starts running underneath the splash so by the time the
	// user is looking at the emulator the first frames are warm.
	emu.run(a, screen)
	emu.togglePause() // Start in a running state

	showSplash(w, func() {
		w.SetContent(content)
		w.Canvas().Focus(keyboardWidget)
	})

	// Set up cleanup on window close
	w.SetOnClosed(func() {
		emu.cleanup()
	})

	w.ShowAndRun()

	// GUI shutdown: persist opted-in SD writes (no-op unless
	// --sd-writeback and the guest actually wrote).
	emu.flushSDWriteback()
}

// installNextROM is the File → "Install Next ROMs..." action. It
// asks for a Next ROM file (one of the blobs from the official
// NextZXOS distro plus optionally the FPGA bootrom), copies it
// under the user's config directory, computes its SHA-256, and
// reports back. The destination basename is preserved exactly,
// because pkg/memory.setupNext looks up each ROM by a fixed
// filename — installing the wrong-named file (e.g. someone
// renames enNextZX.rom to next.rom) won't be picked up.
func installNextROM(w fyne.Window) {
	fd := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
		if err != nil {
			dialog.ShowError(err, w)
			return
		}
		if reader == nil {
			return
		}
		path := reader.URI().Path()
		_ = reader.Close()

		result, err := install.InstallROM(path)
		if err != nil {
			dialog.ShowError(fmt.Errorf("failed to install %s: %w", path, err), w)
			return
		}

		// Recognise the well-known filenames so the user knows
		// what role the file fills. The installer preserves the
		// source basename, so picking enNextZX.rom installs as
		// enNextZX.rom — the lookup happens against this fixed
		// name in pkg/memory.setupNext.
		base := filepath.Base(path)
		var role string
		switch base {
		case install.DistroROM:
			role = "✓ Recognised: NextZXOS firmware (REQUIRED for ModelNext)."
		case install.DivMMCROM:
			role = "✓ Recognised: divMMC / esxDOS overlay (enables SD-card and dot-commands)."
		case install.FPGABootROM:
			role = "✓ Recognised: FPGA boot loader (enables proper cold-boot path)."
		default:
			role = fmt.Sprintf(
				"⚠️ Filename %q is not one the emulator looks up. Expected one of:\n • %s\n • %s\n • %s\nFile was installed anyway in case you know what you're doing.",
				base, install.DistroROM, install.DivMMCROM, install.FPGABootROM)
		}

		msg := fmt.Sprintf(
			"%s\n\nInstalled %d bytes to:\n%s\n\nSHA-256:\n%s\n\n"+
				"Record this digest. A future release will gate "+
				"ZX Spectrum Next boot on a pinned set of known-good "+
				"hashes; until then this UI just copies and reports.",
			role, result.Size, result.DestPath, result.SHA256)
		if result.VersionWarning != "" {
			msg += "\n\n⚠️ VERSION MISMATCH WARNING\n\n" + result.VersionWarning
		}
		dialog.ShowInformation("Next ROM Installed", msg, w)
	}, w)
	fd.SetFilter(storage.NewExtensionFileFilter([]string{".rom", ".ROM"}))
	fd.Show()
}

// offerNextROMDownload asks the user whether to fetch the NextZXOS
// ROMs from the official source. The ROMs are licensed and are NOT
// bundled with the emulator. On confirmation it downloads the
// official distro archive (install.DownloadNextROMs), shows live
// progress, installs enNextZX.rom + enNxtmmc.rom and the SD-card
// tree, and on success invokes onSuccess (which retries the model
// switch). Errors are surfaced; the running emulator is untouched
// until the switch is retried.
func offerNextROMDownload(w fyne.Window, onSuccess func()) {
	msg := "The Spectrum Next needs the NextZXOS ROMs, which are\n" +
		"licensed and NOT bundled with this emulator.\n\n" +
		"Download them now from the official Spectrum Next\n" +
		"distribution?\n\n" +
		install.DistroURL() + "\n\n" +
		"This fetches the official archive and installs the ROMs\n" +
		"plus the SD-card contents. (You can also install them\n" +
		"manually via File → Install Next ROMs…)"
	dialog.NewConfirm("Download Spectrum Next ROMs?", msg, func(ok bool) {
		if !ok {
			return
		}
		runNextROMDownload(w, onSuccess)
	}, w).Show()
}

// runNextROMDownload performs the download on a background goroutine
// with a cancellable progress dialog, then installs + reports.
func runNextROMDownload(w fyne.Window, onSuccess func()) {
	prog := widget.NewProgressBar()
	status := widget.NewLabel("Connecting…")
	content := container.NewVBox(status, prog)
	ctx, cancel := context.WithCancel(context.Background())
	dlg := dialog.NewCustom("Downloading Spectrum Next ROMs", "Cancel",
		content, w)
	dlg.SetOnClosed(cancel)
	dlg.Show()

	go func() {
		res, err := install.DownloadNextROMs(ctx, nil, install.DistroURL(),
			func(done, total int64) {
				fyne.Do(func() {
					if total > 0 {
						prog.SetValue(float64(done) / float64(total))
						status.SetText(fmt.Sprintf("Downloaded %.1f / %.1f MB",
							float64(done)/1e6, float64(total)/1e6))
					} else {
						status.SetText(fmt.Sprintf("Downloaded %.1f MB…",
							float64(done)/1e6))
					}
				})
			})
		fyne.Do(func() {
			dlg.Hide()
			cancel()
			if err != nil {
				dialog.ShowError(fmt.Errorf("download failed: %w", err), w)
				return
			}
			dialog.ShowInformation("Spectrum Next ROMs installed",
				fmt.Sprintf("Installed: %s\nSD-card files: %d\n\nStarting the Spectrum Next…",
					strings.Join(res.InstalledROMs, ", "), res.SDFiles), w)
			if onSuccess != nil {
				onSuccess()
			}
		})
	}()
}

// confirmImportNex asks the user to confirm copying a .nex onto the SD card
// (required so NextZXOS's own loader can run it), then — on accept — imports
// and launches it. fileName is the base name; data is the file's bytes.
func (e *emulator) confirmImportNex(fileName string, data []byte) {
	if e.window == nil {
		// No window (headless): import directly.
		go e.importAndRunNex(fileName, data)
		return
	}
	msg := fmt.Sprintf(
		"To load %q the way a real Spectrum Next does — through NextZXOS's own loader, so games that depend on the operating system work correctly — a copy must be written to your SD card (in a folder named after the file).\n\n"+
			"Your original file is left untouched. The machine will reset to load it.\n\n"+
			"Copy to the SD card and load now?",
		fileName)
	dialog.NewConfirm("Load .nex via NextZXOS", msg, func(ok bool) {
		if ok {
			go e.importAndRunNex(fileName, data)
		}
	}, e.window).Show()
}
