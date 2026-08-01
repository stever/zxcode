package sdcard

import "testing"

// nacIdlesAfterR1 sends a block-read command and counts the idle $FF
// bytes between the R1 response and the $FE data token — the model's
// Nac. Returns the count, failing the test if the token never shows.
func nacIdlesAfterR1(t *testing.T, c *Card, cmd byte, arg uint32) int {
	t.Helper()
	if r1 := sendCommand(c, cmd, arg); r1 != 0x00 {
		t.Fatalf("CMD%d R1 = %#02x, want 0x00", cmd, r1)
	}
	idles := 0
	for i := 0; i < 200; i++ {
		b := c.ReadData()
		if b == 0xFE {
			return idles
		}
		if b != 0xFF {
			t.Fatalf("CMD%d: unexpected byte %#02x before data token", cmd, b)
		}
		idles++
	}
	t.Fatalf("CMD%d: no data token within 200 bytes", cmd)
	return 0
}

// drainBlock reads the 512 data + 2 CRC bytes of the current block.
func drainBlock(c *Card) {
	for i := 0; i < 514; i++ {
		c.ReadData()
	}
}

// TestCard_NacModel_Deterministic pins the two-state data-token
// access-time model (#187): random-access first blocks pay a FIXED
// small Nac; reads continuing the card's sequential read-ahead
// position (a re-opened CMD18 at the previous stream's next LBA, the
// classic single-sector re-open pattern of Atic Atac's stream
// interpreter) get the minimal gap; writes invalidate the read-ahead.
// Deterministic — repeated runs must produce identical byte streams,
// because token-poll loop lengths are mainline PHASE to NMI-lattice-
// locked loaders even though the values are functionally invisible.
func TestCard_NacModel_Deterministic(t *testing.T) {
	img := make([]byte, 16*512)
	src, _ := NewImageSource(img, false)
	c := NewCard(src)
	c.SetSDHC(true) // arg = LBA directly

	// Cold random access: fixed nacRandom.
	if got := nacIdlesAfterR1(t, c, 17, 4); got != nacRandom {
		t.Errorf("random-access CMD17 Nac = %d, want %d", got, nacRandom)
	}
	drainBlock(c)

	// Sequential continuation via CMD17: LBA 5 == read-ahead position.
	if got := nacIdlesAfterR1(t, c, 17, 5); got != nacSequential {
		t.Errorf("sequential CMD17 Nac = %d, want %d", got, nacSequential)
	}
	drainBlock(c)

	// Non-sequential jump: back to nacRandom.
	if got := nacIdlesAfterR1(t, c, 17, 12); got != nacRandom {
		t.Errorf("non-sequential CMD17 Nac = %d, want %d", got, nacRandom)
	}
	drainBlock(c)

	// CMD18 stream: open at 0 (random), read two blocks (the second
	// auto-streamed), stop, then re-open at the stream's next LBA —
	// the re-open is a read-ahead hit and must get the minimal Nac.
	if got := nacIdlesAfterR1(t, c, 18, 0); got != nacRandom {
		t.Errorf("CMD18 open Nac = %d, want %d", got, nacRandom)
	}
	drainBlock(c)
	// Auto-streamed block 1: poll to its token, drain it.
	tok := byte(0xFF)
	for i := 0; i < 20 && tok == 0xFF; i++ {
		tok = c.ReadData()
	}
	if tok != 0xFE {
		t.Fatalf("CMD18 auto-stream token = %#02x, want 0xFE", tok)
	}
	drainBlock(c)
	if r1 := sendCommand(c, 12, 0); r1 != 0x00 {
		t.Fatalf("CMD12 R1 = %#02x", r1)
	}
	// Blocks 0 and 1 were delivered; the card's read-ahead sits at 2.
	if got := nacIdlesAfterR1(t, c, 18, 2); got != nacSequential {
		t.Errorf("CMD18 re-open at stream continuation Nac = %d, want %d", got, nacSequential)
	}
	drainBlock(c)
	if r1 := sendCommand(c, 12, 0); r1 != 0x00 {
		t.Fatalf("CMD12 R1 = %#02x", r1)
	}

	// A write invalidates the read-ahead: the very LBA that would
	// have been sequential now pays the random-access fetch.
	if r1 := sendCommand(c, 24, 9); r1 != 0x00 {
		t.Fatalf("CMD24 R1 = %#02x", r1)
	}
	c.WriteData(0xFE)
	for i := 0; i < 514; i++ {
		c.WriteData(0x00)
	}
	// Drain the data-accepted token + not-busy byte.
	c.ReadData()
	c.ReadData()
	if got := nacIdlesAfterR1(t, c, 17, 3); got != nacRandom {
		t.Errorf("post-write CMD17 Nac = %d, want %d (read-ahead invalidated)", got, nacRandom)
	}
	drainBlock(c)
}
