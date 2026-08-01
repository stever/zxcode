package sdcard

import "testing"

// Regression: on an SDSC card (advertiseSDHC = false — the wasm default,
// which never calls SetSDHC) the command argument is a BYTE address, not an
// LBA. The read handlers already divided it by 512; the write handlers did
// not, so the guest's byte address was treated as an LBA and WriteBlock's
// *512 sent every write past end-of-card, silently dropping it. That was the
// in-game "save to SD does nothing" bug (LoneWolf's F_WRITE). These tests lock
// the write/erase paths to the same byte->LBA conversion as reads.

// writeOneBlockSDSC drives a CMD24 single-block write at byte address
// lba*512 and returns the data-accepted token.
func writeCMD24(c *Card, byteAddr uint32, fill byte) byte {
	sendCommand(c, 24, byteAddr)
	c.WriteData(0xFE) // data token
	for i := 0; i < 512; i++ {
		c.WriteData(byte(i) ^ fill)
	}
	c.WriteData(0xFF) // CRC hi
	c.WriteData(0xFF) // CRC lo
	var tok byte = 0xFF
	for i := 0; i < 16 && tok == 0xFF; i++ {
		tok = c.ReadData()
	}
	return tok
}

func TestCard_SDSC_CMD24_ByteAddressLandsAtLBA(t *testing.T) {
	img := make([]byte, 8192) // 16 blocks
	src, _ := NewImageSource(img, false)
	c := NewCard(src) // SDSC by default: arg is a byte address

	// Write to byte address 3*512 — must land in LBA 3, not 3*512.
	if tok := writeCMD24(c, 3*512, 0xA5); tok != 0x05 {
		t.Fatalf("CMD24 data-accepted token = %02X, want 0x05", tok)
	}
	for i := 0; i < 512; i++ {
		if got, want := img[3*512+i], byte(i)^0xA5; got != want {
			t.Fatalf("LBA3 byte %d = %02X, want %02X", i, got, want)
		}
	}
	// A stray *512 of the byte address would be far past the 8 KB image,
	// so a non-converting write would leave LBA 3 untouched (zero) — the
	// failure this test guards against.
}

func TestCard_SDSC_CMD25_ByteAddressLandsAtLBA(t *testing.T) {
	img := make([]byte, 8192)
	src, _ := NewImageSource(img, false)
	c := NewCard(src) // SDSC

	// CMD25 start at byte address 2*512 → LBA 2, then LBA 3.
	if r1 := sendCommand(c, 25, 2*512); r1 != 0x00 {
		t.Fatalf("CMD25 R1=%02X, want 0x00", r1)
	}
	writeOneMultiBlock(c, 0xA5)
	if tok := drainAccepted(c); tok != 0x05 {
		t.Fatalf("block 0 token=%02X, want 0x05", tok)
	}
	writeOneMultiBlock(c, 0x3C)
	if tok := drainAccepted(c); tok != 0x05 {
		t.Fatalf("block 1 token=%02X, want 0x05", tok)
	}
	c.WriteData(0xFD) // stop-tran
	c.ReadData()

	for i := 0; i < 512; i++ {
		if got, want := img[2*512+i], byte(i)^0xA5; got != want {
			t.Fatalf("LBA2 byte %d = %02X, want %02X", i, got, want)
		}
		if got, want := img[3*512+i], byte(i)^0x3C; got != want {
			t.Fatalf("LBA3 byte %d = %02X, want %02X", i, got, want)
		}
	}
}

func TestCard_SDSC_Erase_ByteAddressRange(t *testing.T) {
	img := make([]byte, 8192)
	for i := range img {
		img[i] = 0xBB
	}
	src, _ := NewImageSource(img, false)
	c := NewCard(src) // SDSC

	// Erase byte-address range covering LBA 1..3.
	sendCommand(c, 32, 1*512)
	sendCommand(c, 33, 3*512)
	if r := sendCommand(c, 38, 0); r != 0x00 {
		t.Fatalf("CMD38 R1=%02X, want 0x00", r)
	}
	for b := 1; b <= 3; b++ {
		if img[b*512] != 0x00 {
			t.Fatalf("LBA %d not erased (=%02X)", b, img[b*512])
		}
	}
	if img[0] != 0xBB || img[4*512] != 0xBB {
		t.Errorf("erase overran the LBA 1..3 range")
	}
}
