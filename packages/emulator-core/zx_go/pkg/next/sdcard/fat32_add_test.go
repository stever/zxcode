package sdcard

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// path83To11 builds the 11-byte 8.3 form of an already-8.3 "NAME.EXT".
func path83To11(name string) []byte {
	base, ext, _, _ := basis(name)
	return padName83(base, ext)
}

func (b *fat32Builder) readChain(first uint32, size int) []byte {
	out := make([]byte, 0, size)
	for c := first; c >= 2 && c < 0x0FFFFFF8 && len(out) < size; c = b.getFAT(c) {
		off := b.clusterOffset(c)
		n := b.spc * 512
		if size-len(out) < n {
			n = size - len(out)
		}
		out = append(out, b.img[off:off+n]...)
	}
	return out
}

func (b *fat32Builder) readFileBytes(dirClus uint32, name83 string) ([]byte, bool) {
	want := string(path83To11(name83))
	for c := dirClus; c >= 2 && c < 0x0FFFFFF8; c = b.getFAT(c) {
		off := b.clusterOffset(c)
		cluster := b.img[off : off+b.spc*512]
		for i := 0; i+32 <= len(cluster); i += 32 {
			e := cluster[i : i+32]
			if e[0] == 0 {
				return nil, false
			}
			if e[0] == 0xE5 || e[11] == 0x0F || e[11]&attrDir != 0 {
				continue
			}
			if string(e[0:11]) == want {
				size := int(binary.LittleEndian.Uint32(e[28:32]))
				first := uint32(binary.LittleEndian.Uint16(e[20:22]))<<16 |
					uint32(binary.LittleEndian.Uint16(e[26:28]))
				return b.readChain(first, size), true
			}
		}
	}
	return nil, false
}

// readPath reads /dir/.../NAME.EXT from a FAT32 image for test verification.
func readPath(t *testing.T, img []byte, dirPath, file83 string) []byte {
	t.Helper()
	b, err := openFAT32(img)
	if err != nil {
		t.Fatalf("openFAT32: %v", err)
	}
	dirClus := uint32(2)
	for _, part := range splitNonEmpty(dirPath) {
		dirClus = b.findSubdir(dirClus, part)
		if dirClus == 0 {
			t.Fatalf("dir %q not found", part)
		}
	}
	data, ok := b.readFileBytes(dirClus, file83)
	if !ok {
		t.Fatalf("file %q not found in %q", file83, dirPath)
	}
	return data
}

func splitNonEmpty(p string) []string {
	var out []string
	for _, s := range bytes.Split([]byte(p), []byte("/")) {
		if len(s) > 0 {
			out = append(out, string(s))
		}
	}
	return out
}

func TestAddFileToFAT32_RoundTrips(t *testing.T) {
	// Build a starter image from a temp tree with one existing file.
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "games"), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := bytes.Repeat([]byte{0xA5}, 5000)
	if err := os.WriteFile(filepath.Join(dir, "games", "orig.bin"), orig, 0o644); err != nil {
		t.Fatal(err)
	}
	img, err := BuildFAT32(dir, FAT32Opts{SizeMB: 64})
	if err != nil {
		t.Fatalf("BuildFAT32: %v", err)
	}

	// Insert a multi-cluster file into a new /imported directory.
	want := make([]byte, 40000)
	for i := range want {
		want[i] = byte(i*7 + 3)
	}
	sdPath, err := AddFileToFAT32(img, "imported", "sonic.nex", want)
	if err != nil {
		t.Fatalf("AddFileToFAT32: %v", err)
	}
	if sdPath != "/IMPORTED/SONIC.NEX" {
		t.Errorf("sdPath = %q, want /IMPORTED/SONIC.NEX", sdPath)
	}

	// The inserted file reads back byte-for-byte.
	got := readPath(t, img, "imported", "SONIC.NEX")
	if !bytes.Equal(got, want) {
		t.Errorf("inserted file mismatch: got %d bytes, want %d (equal=%v)", len(got), len(want), bytes.Equal(got, want))
	}

	// The pre-existing file is untouched.
	gotOrig := readPath(t, img, "games", "ORIG.BIN")
	if !bytes.Equal(gotOrig, orig) {
		t.Errorf("pre-existing file corrupted by the insert")
	}
}

// readLongPath resolves /dir/.../name by long name (the way NextZXOS would)
// and returns the file bytes.
func readLongPath(t *testing.T, img []byte, dirPath, name string) []byte {
	t.Helper()
	b, err := openFAT32(img)
	if err != nil {
		t.Fatalf("openFAT32: %v", err)
	}
	dirClus := uint32(2)
	for _, part := range splitNonEmpty(dirPath) {
		dirClus = b.findSubdir(dirClus, part)
		if dirClus == 0 {
			t.Fatalf("dir %q not found", part)
		}
	}
	off := b.findDirent(dirClus, name, false)
	if off < 0 {
		t.Fatalf("file %q not found in %q", name, dirPath)
	}
	e := b.img[off : off+32]
	size := int(binary.LittleEndian.Uint32(e[28:32]))
	first := uint32(binary.LittleEndian.Uint16(e[20:22]))<<16 |
		uint32(binary.LittleEndian.Uint16(e[26:28]))
	return b.readChain(first, size)
}

func TestWriteFileToFAT32_LongNames(t *testing.T) {
	img, err := BuildFAT32(t.TempDir(), FAT32Opts{SizeMB: 64})
	if err != nil {
		t.Fatal(err)
	}

	// A long-named file in a long-named directory round-trips by long name.
	want := bytes.Repeat([]byte{0x5A}, 20000)
	if _, err := WriteFileToFAT32(img, "spr/really long dir", "sprites_enemigos_a0.spr", want); err != nil {
		t.Fatalf("WriteFileToFAT32: %v", err)
	}
	got := readLongPath(t, img, "spr/really long dir", "sprites_enemigos_a0.spr")
	if !bytes.Equal(got, want) {
		t.Errorf("long-named file mismatch: got %d bytes, want %d", len(got), len(want))
	}
	// The alias carries the standard numeric tail.
	if data := readPath(t, img, "spr/really long dir", "SPRITE~1.SPR"); !bytes.Equal(data, want) {
		t.Errorf("8.3 alias SPRITE~1.SPR mismatch")
	}

	// Overwriting by the same long name (any case) replaces in place, not
	// duplicates — VFAT matches long names case-insensitively.
	want2 := []byte("replacement")
	if _, err := WriteFileToFAT32(img, "spr/really long dir", "Sprites_Enemigos_A0.SPR", want2); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	if got := readLongPath(t, img, "spr/really long dir", "sprites_enemigos_a0.spr"); !bytes.Equal(got, want2) {
		t.Errorf("overwrite readback = %q, want %q", got, want2)
	}
	b, _ := openFAT32(img)
	dirClus := b.findSubdir(2, "spr")
	dirClus = b.findSubdir(dirClus, "really long dir")
	count := 0
	b.forEachDirent(dirClus, func(off int, long string) bool {
		if strings.EqualFold(long, "sprites_enemigos_a0.spr") {
			count++
		}
		return false
	})
	if count != 1 {
		t.Errorf("after overwrite, %d entries named sprites_enemigos_a0.spr; want 1", count)
	}

	// A second distinct long name in the same directory gets its own alias.
	if _, err := WriteFileToFAT32(img, "spr/really long dir", "sprites_enemigos_b0.spr", []byte("b")); err != nil {
		t.Fatal(err)
	}
	if got := readLongPath(t, img, "spr/really long dir", "sprites_enemigos_b0.spr"); string(got) != "b" {
		t.Errorf("second long name = %q, want b", got)
	}
	if data := readPath(t, img, "spr/really long dir", "SPRITE~2.SPR"); string(data) != "b" {
		t.Errorf("8.3 alias SPRITE~2.SPR mismatch")
	}
}

func TestWriteFileToFAT32_ShortNameStillReplaces(t *testing.T) {
	img, err := BuildFAT32(t.TempDir(), FAT32Opts{SizeMB: 64})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := WriteFileToFAT32(img, "nextzxos", "autoexec.bas", []byte("one")); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteFileToFAT32(img, "nextzxos", "autoexec.bas", []byte("two!")); err != nil {
		t.Fatal(err)
	}
	if got := readPath(t, img, "nextzxos", "AUTOEXEC.BAS"); string(got) != "two!" {
		t.Errorf("overwrite = %q, want two!", got)
	}
}

func TestAddFileToFAT32_LongNameReadableByLongName(t *testing.T) {
	img, err := BuildFAT32(t.TempDir(), FAT32Opts{SizeMB: 64})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AddFileToFAT32(img, "imported", "RevivalSurvival.nex", []byte("payload")); err != nil {
		t.Fatal(err)
	}
	if got := readLongPath(t, img, "imported", "RevivalSurvival.nex"); string(got) != "payload" {
		t.Errorf("long-name lookup = %q, want payload", got)
	}
}

func TestAddFileToFAT32_LongNameGetsUniqueAlias(t *testing.T) {
	dir := t.TempDir()
	img, err := BuildFAT32(dir, FAT32Opts{SizeMB: 64})
	if err != nil {
		t.Fatal(err)
	}
	p1, err := AddFileToFAT32(img, "imported", "RevivalSurvival.nex", []byte("one"))
	if err != nil {
		t.Fatal(err)
	}
	p2, err := AddFileToFAT32(img, "imported", "RevivalSurvival.nex", []byte("two"))
	if err != nil {
		t.Fatal(err)
	}
	if p1 == p2 {
		t.Errorf("re-import produced the same path %q (would corrupt the directory)", p1)
	}
	// Both must read back to their own contents (no clobber).
	if got := readPath(t, img, "imported", filepath.Base(p1)); string(got) != "one" {
		t.Errorf("first import = %q, want one", got)
	}
	if got := readPath(t, img, "imported", filepath.Base(p2)); string(got) != "two" {
		t.Errorf("second import = %q, want two", got)
	}
}
