package sdcard

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestFileSourceReadsWritesAndOverlay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "card.img")
	img := make([]byte, 4*512)
	for i := range img {
		img[i] = byte(i / 512)
	}
	if err := os.WriteFile(path, img, 0o644); err != nil {
		t.Fatal(err)
	}

	src, err := NewFileSource(path)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if got := src.Capacity(); got != 4 {
		t.Fatalf("Capacity = %d, want 4", got)
	}

	blk := make([]byte, 512)
	if err := src.ReadBlock(2, blk); err != nil {
		t.Fatal(err)
	}
	if blk[0] != 2 || blk[511] != 2 {
		t.Fatalf("block 2 read wrong: %02x %02x", blk[0], blk[511])
	}

	// Reads beyond the image return zeros, matching ImageSource.
	if err := src.ReadBlock(9, blk); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(blk, make([]byte, 512)) {
		t.Fatal("past-EOF read not zeroed")
	}

	// A guest write lands in the overlay and wins on read-back...
	wr := bytes.Repeat([]byte{0xAB}, 512)
	if err := src.WriteBlock(1, wr); err != nil {
		t.Fatal(err)
	}
	if err := src.ReadBlock(1, blk); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(blk, wr) {
		t.Fatal("overlay read-back mismatch")
	}
	// ...while the backing file stays untouched.
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(onDisk, img) {
		t.Fatal("backing file was modified")
	}

	// Writes beyond the image are rejected.
	if err := src.WriteBlock(4, wr); err == nil {
		t.Fatal("expected error writing past capacity")
	}
}
