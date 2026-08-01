package sdcard

import (
	"bytes"
	"testing"
)

func TestSparseSourceBlocksAndSparsity(t *testing.T) {
	s, err := NewSparseSource(512 * 1024 * 1024) // 512 MB virtual
	if err != nil {
		t.Fatal(err)
	}
	if s.Capacity() != 1024*1024 {
		t.Fatalf("Capacity = %d blocks, want 1Mi", s.Capacity())
	}
	if s.ResidentBytes() != 0 {
		t.Fatalf("fresh source resident = %d, want 0", s.ResidentBytes())
	}

	blk := make([]byte, 512)
	if err := s.ReadBlock(999999, blk); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(blk, make([]byte, 512)) {
		t.Fatal("absent block not zero-filled")
	}

	// Zero writes to absent pages allocate nothing.
	if err := s.WriteBlock(5000, make([]byte, 512)); err != nil {
		t.Fatal(err)
	}
	if s.ResidentBytes() != 0 {
		t.Fatalf("all-zero write allocated %d bytes", s.ResidentBytes())
	}

	// Real data round-trips, including across a page boundary.
	data := bytes.Repeat([]byte{0xC3, 0x5A}, 3*sparsePageBytes/2)
	off := int64(7*sparsePageBytes - 100)
	if _, err := s.WriteAt(data, off); err != nil {
		t.Fatal(err)
	}
	back := make([]byte, len(data))
	s.ReadAt(back, off)
	if !bytes.Equal(back, data) {
		t.Fatal("cross-page round-trip mismatch")
	}
	if !s.Dirty() {
		t.Fatal("Dirty not set after write")
	}

	// Writes past the virtual end are rejected at block level.
	if err := s.WriteBlock(s.Capacity(), blk); err == nil {
		t.Fatal("expected error writing past capacity")
	}
}

// TestSparseSourceHostsAFATFilesystem builds real FAT structures on a
// sparse image via the shared builder path (WriteFileToImage) and reads
// the file back through both the Image and BlockSource faces.
func TestSparseSourceHostsAFATFilesystem(t *testing.T) {
	// Format: build a small flat FAT32 image, ingest it sparsely (the
	// wasm boot path), then write through the FAT machinery.
	flat, err := BuildFAT32(t.TempDir(), FAT32Opts{SizeMB: 64})
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewSparseSource(int64(len(flat)))
	if err != nil {
		t.Fatal(err)
	}
	const chunk = 64 * 1024
	for off := 0; off < len(flat); off += chunk {
		end := off + chunk
		if end > len(flat) {
			end = len(flat)
		}
		s.WriteAt(flat[off:end], int64(off))
	}
	// The 64 MB image is mostly zeros: sparsity must hold.
	if s.ResidentBytes() > 8*1024*1024 {
		t.Fatalf("ingested 64MB image resident = %d bytes, want well under 8MB", s.ResidentBytes())
	}

	want := bytes.Repeat([]byte{0x77}, 40000)
	sdPath, err := WriteFileToImage(s, "games", "test.nex", want)
	if err != nil {
		t.Fatalf("WriteFileToImage(sparse): %v", err)
	}
	if sdPath != "/GAMES/TEST.NEX" {
		t.Errorf("sdPath = %q", sdPath)
	}

	// Read back through the FAT reader on a flattened copy — proving
	// the sparse writes produced a coherent filesystem.
	out := make([]byte, len(flat))
	s.ReadAt(out, 0)
	got := readPath(t, out, "games", "TEST.NEX")
	if !bytes.Equal(got, want) {
		t.Fatalf("sparse FAT round-trip mismatch: got %d bytes", len(got))
	}
}
