package main

import (
	"encoding/binary"
	"os"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/roms"
)

// Real-time tape playback regressions for #192 (Exolon / Firelord: Hewson
// custom loaders that enter the ROM's edge-timing loops directly, so the
// $0556 fast-load trap never sees their blocks and the tape must genuinely
// play). Three properties are locked here:
//
//  1. The tape clock is MONOTONIC: tapeLevel's catch-up must consume all
//     machine time elapsed between port-$FE reads, across frame boundaries.
//     (The CPU's raw T-state counter wraps to frame-relative every frame;
//     riding it dropped the inter-frame gap for sparse-polling loaders and
//     crawled the tape at ~2%.)
//  2. The loader-activity auto-pause parks an unpolled deck so boot/menu
//     time cannot roll the tape past content nothing is listening to, and
//     resumes it losslessly when a loader polls again.
//  3. Fast-tape turbo engages on loader-heavy $FE read rates (the browser
//     zxFrame path bursts tapeTurboFramesPerTick frames per display tick).

// longBlockTAP builds a single-block TAP whose data block is big enough that
// its pilot+data far outlasts the frames a test runs.
func longBlockTAP(dataLen int) []byte {
	block := make([]byte, dataLen+2)
	block[0] = 0xFF
	for i := 1; i <= dataLen; i++ {
		block[i] = byte(i)
	}
	var out []byte
	var lenBuf [2]byte
	binary.LittleEndian.PutUint16(lenBuf[:], uint16(len(block)))
	out = append(out, lenBuf[:]...)
	out = append(out, block...)
	return out
}

// TestTapeClockMonotonicSparsePolls: with auto-pause disabled and only the
// ROM's ~8 keyboard-scan $FE reads per frame touching the tape, 100 frames of
// machine time must advance the tape by ~100 frames of tape time. Before the
// monotonic tape clock (#192) the frame-boundary wrap discarded nearly the
// whole frame for such sparse polling and this advanced by only a few
// percent.
func TestTapeClockMonotonicSparsePolls(t *testing.T) {
	t.Setenv("ZX_GO_NO_TAPE_AUTOPAUSE", "1")
	emu, err := newEmulator(roms.Model48K)
	if err != nil {
		t.Fatal(err)
	}
	// Boot to the © prompt so the ISR keyboard scan is running.
	for i := 0; i < 200; i++ {
		runOneFrameHeadless(emu, roms.Model48K)
	}
	tp, err := newTapePlayerFromBytes(longBlockTAP(4000))
	if err != nil {
		t.Fatal(err)
	}
	emu.ula.SetTapePlayer(tp)
	tp.Play()

	const frames = 100
	for i := 0; i < frames; i++ {
		runOneFrameHeadless(emu, roms.Model48K)
	}
	_, _, _, _, tapeT, _ := tp.DebugState()
	wall := uint64(frames * roms.Model48K.FrameTStates())
	if tapeT < wall*95/100 {
		t.Errorf("tape advanced %d T over %d frames; want >= 95%% of the %d T of machine time (frame-wrap clock loss, #192)",
			tapeT, frames, wall)
	}
}

// TestTapeAutoPauseParksUnpolledDeck: with nothing but the keyboard scan
// reading $FE, the loader-activity auto-pause must stop the deck within its
// idle window, preserving the block for whenever a loader starts listening —
// the guard that stops boot/menu time eating the tape now that the clock is
// monotonic.
func TestTapeAutoPauseParksUnpolledDeck(t *testing.T) {
	emu, err := newEmulator(roms.Model48K)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 200; i++ {
		runOneFrameHeadless(emu, roms.Model48K)
	}
	tp, err := newTapePlayerFromBytes(longBlockTAP(4000))
	if err != nil {
		t.Fatal(err)
	}
	emu.ula.SetTapePlayer(tp)
	tp.Play()

	for i := 0; i < tapeAutoPauseFrames+25; i++ {
		runOneFrameHeadless(emu, roms.Model48K)
	}
	if tp.IsPlaying() {
		t.Fatal("deck still playing after the auto-pause idle window with no loader polling")
	}
	blockIdx, pulseIdx, _, dataPulses, _, _ := tp.DebugState()
	if blockIdx != 0 || pulseIdx >= dataPulses {
		t.Errorf("auto-pause parked the deck at block %d pulse %d/%d; the block's content should be preserved",
			blockIdx, pulseIdx, dataPulses)
	}
}

// TestTapeTurboEngagesOnHeavyReads: a guest polling $FE at loader rate must
// flip tapeReadActive within a frame and cause tapeTurboFrames to burst; a
// guest that stops polling must idle the signal and auto-pause the deck.
func TestTapeTurboEngagesOnHeavyReads(t *testing.T) {
	emu, err := newEmulator(roms.Model48K)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 200; i++ {
		runOneFrameHeadless(emu, roms.Model48K)
	}
	tp, err := newTapePlayerFromBytes(longBlockTAP(4000))
	if err != nil {
		t.Fatal(err)
	}
	emu.ula.SetTapePlayer(tp)
	tp.Play()

	// loop: IN A,($FE); JR loop — a loader-like $FE poll (~3000 reads/frame).
	emu.mem.Write(0x8000, 0xDB)
	emu.mem.Write(0x8001, 0xFE)
	emu.mem.Write(0x8002, 0x18)
	emu.mem.Write(0x8003, 0xFC)
	emu.cpu.IFF1 = false
	emu.cpu.PC = 0x8000

	runOneFrameHeadless(emu, roms.Model48K)
	if !emu.tapeReadActive {
		t.Fatal("a frame of loader-rate $FE polling did not set tapeReadActive")
	}
	if n := emu.tapeTurboFrames(); n != tapeTurboFramesPerTick {
		t.Errorf("tapeTurboFrames = %d during an active fast-tape load, want %d", n, tapeTurboFramesPerTick)
	}

	// jr $ — no reads at all; the signal must drop and the deck auto-pause.
	emu.mem.Write(0x8004, 0x18)
	emu.mem.Write(0x8005, 0xFE)
	emu.cpu.PC = 0x8004
	for i := 0; i < tapeAutoPauseFrames+5; i++ {
		runOneFrameHeadless(emu, roms.Model48K)
	}
	if emu.tapeReadActive {
		t.Error("tapeReadActive stuck after the guest stopped polling")
	}
	if n := emu.tapeTurboFrames(); n != 1 {
		t.Errorf("tapeTurboFrames = %d with an idle loader, want 1", n)
	}
	if tp.IsPlaying() {
		t.Error("deck not auto-paused after the guest stopped polling")
	}
}

// TestHewsonCustomLoaderRealTime is the end-to-end lock for #192: Exolon and
// Firelord (Hewson custom loaders) must fully load on the browser path —
// 128K machine, loadAndRunTape's Tape Loader macro, LD-BYTES trap for the
// standard blocks, then genuine real-time playback for the custom-loaded
// blocks, accelerated by the fast-tape turbo burst exactly as the wasm
// zxFrame path drives it. Skips when the (copyrighted, uncommitted) game
// files are absent.
func TestHewsonCustomLoaderRealTime(t *testing.T) {
	dir := os.Getenv("HOME") + "/Downloads/Retro/ZX Spectrum/TFW8B/Home/Games/Classic/"
	for _, game := range []string{"Exolon (1987).tap", "Firelord (1986).tap"} {
		t.Run(game, func(t *testing.T) {
			data, err := os.ReadFile(dir + game)
			if err != nil {
				t.Skipf("game not present: %v", err)
			}
			emu, err := newEmulator(roms.Model128K)
			if err != nil {
				t.Fatal(err)
			}
			installTapeTrap(emu)
			if err := emu.loadAndRunTape(data); err != nil {
				t.Fatal(err)
			}
			// Browser-style display ticks: tapeTurboFrames per tick, one
			// render per tick. Real-time would need ~14000 ticks; the turbo
			// must land well under 700.
			const maxTicks = 700
			loaded := false
			for tick := 0; tick < maxTicks && !loaded; tick++ {
				n := emu.tapeTurboFrames()
				for k := 0; k < n; k++ {
					runOneFrameHeadless(emu, roms.Model128K)
					if emu.nexloadMacro != nil && emu.nexloadMacro.tick(emu) {
						emu.nexloadMacro = nil
					}
				}
				emu.renderFrame()
				if tp := emu.ula.GetTapePlayer(); tp != nil && !tp.HasMoreBlocks() {
					loaded = true
				}
			}
			if !loaded {
				t.Fatalf("tape not fully consumed within %d turbo ticks", maxTicks)
			}
			// Let the game come up (Firelord runs a long decrunch + title
			// sequence after the tape ends), then require a real screen
			// (title/menu), not a blank, BASIC or tape-error screen.
			dp := 0
			for i := 0; i < 4000 && dp < 8; i++ {
				runOneFrameHeadless(emu, roms.Model128K)
				if i%100 == 99 {
					dp = distinctPixels(emu.renderFrame().Pix)
				}
			}
			if dp < 8 {
				t.Errorf("screen has only %d distinct colours after loading — game did not come up", dp)
			}
		})
	}
}
