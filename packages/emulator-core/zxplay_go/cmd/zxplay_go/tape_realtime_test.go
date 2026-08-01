package main

import (
	"encoding/binary"
	"os"
	"testing"

	"github.com/stever/zxplay_go/pkg/roms"
	"github.com/stever/zxplay_go/pkg/z80"
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

// TestTapeTurboEngagesOnHeavyReads: turbo compresses time for the whole
// window the deck is mid-load (playing with blocks left) — including a
// loader's read-free settle stretches — and it is the READ-driven auto-pause
// that ends the window: a guest that stops polling has its deck parked and
// turbo drops to 1x.
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

	// The deck is mid-load: turbo engages regardless of the read rate (the
	// LD-EDGE trap makes read-free settle windows part of a live load).
	if n := emu.tapeTurboFrames(); n != tapeTurboFramesPerTick {
		t.Errorf("tapeTurboFrames = %d with the deck mid-load, want %d", n, tapeTurboFramesPerTick)
	}

	// loop: IN A,($FE); JR loop — loader-rate polling keeps tapeReadActive
	// (the auto-pause's signal) asserted.
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

	// jr $ — no reads at all: the auto-pause parks the deck within its idle
	// window, which is what ends the turbo.
	emu.mem.Write(0x8004, 0x18)
	emu.mem.Write(0x8005, 0xFE)
	emu.cpu.PC = 0x8004
	for i := 0; i < tapeAutoPauseFrames+5; i++ {
		runOneFrameHeadless(emu, roms.Model48K)
	}
	if emu.tapeReadActive {
		t.Error("tapeReadActive stuck after the guest stopped polling")
	}
	if tp.IsPlaying() {
		t.Error("deck not auto-paused after the guest stopped polling")
	}
	if n := emu.tapeTurboFrames(); n != 1 {
		t.Errorf("tapeTurboFrames = %d with the deck parked, want 1", n)
	}
}

// TestLDEdgeTrapByteExact: the LD-EDGE fast trap must be OBSERVABLY
// equivalent to interpreting the ROM's sampling loop — same loaded bytes,
// same success flag, and (near-)identical emulated time — because the B
// count it synthesises IS the loader's bit discrimination. Drives the real
// ROM LD-BYTES routine (no block trap, so the pilot/sync/data path runs for
// real) against the same tape twice: once fully interpreted, once with only
// the LD-EDGE trap installed.
func TestLDEdgeTrapByteExact(t *testing.T) {
	payload := make([]byte, 1500)
	for i := range payload {
		payload[i] = byte(i*7 + 3)
	}
	run := func(withTrap bool) (mem []byte, carry bool, frames int) {
		emu, err := newEmulator(roms.Model48K)
		if err != nil {
			t.Fatal(err)
		}
		if withTrap {
			emu.cpu.TrapCheck = func(pc uint16) bool {
				if pc == 0x05E7 {
					return tapeTrapLDEdge(emu)
				}
				return false
			}
		}
		for i := 0; i < 200; i++ {
			runOneFrameHeadless(emu, roms.Model48K)
		}
		tp, err := newTapePlayerFromBytes(longBlockTAP(len(payload)))
		if err != nil {
			t.Fatal(err)
		}
		// longBlockTAP's payload is bytes 1..n; overwrite with ours by
		// rebuilding the block: flag + payload + checksum.
		blk := make([]byte, len(payload)+2)
		blk[0] = 0xFF
		copy(blk[1:], payload)
		var sum byte
		for _, b := range blk[:len(blk)-1] {
			sum ^= b
		}
		blk[len(blk)-1] = sum
		var tap []byte
		tap = append(tap, byte(len(blk)), byte(len(blk)>>8))
		tap = append(tap, blk...)
		tp, err = newTapePlayerFromBytes(tap)
		if err != nil {
			t.Fatal(err)
		}
		emu.ula.SetTapePlayer(tp)
		tp.Play()

		// Call the REAL ROM LD-BYTES: A = expected flag, carry = LOAD,
		// IX = dest, DE = length, DI, return parked at a jr $ in RAM.
		emu.mem.Write(0x7F00, 0x18) // jr $
		emu.mem.Write(0x7F01, 0xFE)
		emu.cpu.IFF1 = false
		emu.cpu.A = 0xFF
		emu.cpu.F = z80.FLAG_C
		emu.cpu.IX = 0x8000
		emu.cpu.D = byte(len(payload) >> 8)
		emu.cpu.E = byte(len(payload))
		emu.cpu.SP = 0x7E00
		emu.mem.Write(0x7DFE, 0x00) // push return address $7F00
		emu.mem.Write(0x7DFF, 0x7F)
		emu.cpu.SP = 0x7DFE
		emu.cpu.PC = 0x0556

		for frames = 0; frames < 3000 && emu.cpu.PC != 0x7F00; frames++ {
			runOneFrameHeadless(emu, roms.Model48K)
		}
		if emu.cpu.PC != 0x7F00 {
			t.Fatalf("LD-BYTES (withTrap=%v) never returned within 3000 frames; PC=%04X", withTrap, emu.cpu.PC)
		}
		got := make([]byte, len(payload))
		for i := range got {
			got[i] = emu.mem.Read(0x8000 + uint16(i))
		}
		return got, emu.cpu.F&z80.FLAG_C != 0, frames
	}

	memI, carryI, framesI := run(false)
	memT, carryT, framesT := run(true)
	if !carryI || !carryT {
		t.Fatalf("LD-BYTES failed: interpreted carry=%v, trapped carry=%v", carryI, carryT)
	}
	for i := range memI {
		if memI[i] != memT[i] {
			t.Fatalf("byte %d differs: interpreted %02X, trapped %02X", i, memI[i], memT[i])
		}
	}
	// Timeline neutrality: the trap credits the exact T-states the loop
	// would have burned, so both runs complete in (nearly) the same number
	// of frames. Small drift is tolerated for sample-grid phase effects.
	if d := framesI - framesT; d > 5 || d < -5 {
		t.Errorf("frame counts diverge: interpreted %d, trapped %d — trap is not timeline-neutral", framesI, framesT)
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
			const maxTicks = 350
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
			// sequence after the tape ends), then require a real screen —
			// not a blank, BASIC or tape-error screen (those have 2-4
			// colours). Kept deliberately loose: Firelord's menu colour-
			// cycles through phases as low as 7 distinct colours, and the
			// EXACT screens are pinned by the corpus golden hashes.
			dp := 0
			for i := 0; i < 4000 && dp < 6; i++ {
				runOneFrameHeadless(emu, roms.Model128K)
				if i%100 == 99 {
					dp = distinctPixels(emu.renderFrame().Pix)
				}
			}
			if dp < 6 {
				t.Errorf("screen has only %d distinct colours after loading — game did not come up", dp)
			}
		})
	}
}
