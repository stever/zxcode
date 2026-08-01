package sdcard

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// buildDeleteFixture makes a 64MB card holding /nextzxos/autoexec.1st (an
// 8.3 name), /nextzxos/keep.bas, and a long-named file whose dirent needs a
// VFAT LFN chain.
func buildDeleteFixture(t *testing.T) []byte {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "nextzxos"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{
		"nextzxos/autoexec.1st":         bytes.Repeat([]byte{0x11}, 10510),
		"nextzxos/keep.bas":             []byte("10 PRINT \"kept\"\n"),
		"nextzxos/a-very-long-name.cfg": bytes.Repeat([]byte{0x22}, 700),
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	img, err := BuildFAT32(dir, FAT32Opts{SizeMB: 64})
	if err != nil {
		t.Fatalf("BuildFAT32: %v", err)
	}
	return img
}

func TestDeleteFileFromImage_RemovesEntryAndFreesChain(t *testing.T) {
	img := buildDeleteFixture(t)
	dev := byteImage(img)

	if ok, err := FileExistsInImage(dev, "nextzxos", "autoexec.1st"); err != nil || !ok {
		t.Fatalf("fixture: autoexec.1st missing before delete (ok=%v err=%v)", ok, err)
	}
	b, err := openFAT32(dev)
	if err != nil {
		t.Fatal(err)
	}
	freeBefore := countFreeClusters(b)

	deleted, err := DeleteFileFromImage(dev, "nextzxos", "autoexec.1st")
	if err != nil || !deleted {
		t.Fatalf("delete: deleted=%v err=%v", deleted, err)
	}
	if ok, _ := FileExistsInImage(dev, "nextzxos", "autoexec.1st"); ok {
		t.Fatal("autoexec.1st still present after delete")
	}
	// The neighbour file survives intact.
	if got := readPath(t, img, "nextzxos", "KEEP.BAS"); !bytes.Equal(got, []byte("10 PRINT \"kept\"\n")) {
		t.Fatalf("keep.bas corrupted after delete: %q", got)
	}
	// The data chain returned to the FAT.
	b2, err := openFAT32(dev)
	if err != nil {
		t.Fatal(err)
	}
	if freeAfter := countFreeClusters(b2); freeAfter <= freeBefore {
		t.Fatalf("no clusters freed: before=%d after=%d", freeBefore, freeAfter)
	}
}

func TestDeleteFileFromImage_TombstonesLFNChain(t *testing.T) {
	img := buildDeleteFixture(t)
	dev := byteImage(img)

	deleted, err := DeleteFileFromImage(dev, "nextzxos", "a-very-long-name.cfg")
	if err != nil || !deleted {
		t.Fatalf("delete: deleted=%v err=%v", deleted, err)
	}
	if ok, _ := FileExistsInImage(dev, "nextzxos", "a-very-long-name.cfg"); ok {
		t.Fatal("long-named file still present after delete")
	}
	// No orphaned live LFN entries may remain in the directory: every live
	// LFN entry must be followed (possibly after more LFN entries) by a live
	// short entry.
	b, err := openFAT32(dev)
	if err != nil {
		t.Fatal(err)
	}
	dirClus, ok := b.walkDirPath("nextzxos")
	if !ok {
		t.Fatal("nextzxos missing")
	}
	pendingLFN := 0
	for c := dirClus; c >= 2 && c < 0x0FFFFFF8; c = b.getFAT(c) {
		base := b.clusterOffset(c)
		for i := 0; i+32 <= b.spc*512; i += 32 {
			e := b.rd(base+i, 32)
			switch {
			case e[0] == 0x00:
				if pendingLFN != 0 {
					t.Fatalf("%d orphaned LFN entries at end of directory", pendingLFN)
				}
				return
			case e[0] == 0xE5:
				pendingLFN = 0
			case e[11] == 0x0F:
				pendingLFN++
			default:
				pendingLFN = 0
			}
		}
	}
	if pendingLFN != 0 {
		t.Fatalf("%d orphaned LFN entries at end of directory chain", pendingLFN)
	}
}

func TestDeleteFileFromImage_MissingIsIdempotent(t *testing.T) {
	img := buildDeleteFixture(t)
	dev := byteImage(img)

	if deleted, err := DeleteFileFromImage(dev, "nextzxos", "nosuch.bin"); err != nil || deleted {
		t.Fatalf("missing file: deleted=%v err=%v", deleted, err)
	}
	if deleted, err := DeleteFileFromImage(dev, "nosuchdir", "x.bin"); err != nil || deleted {
		t.Fatalf("missing dir: deleted=%v err=%v", deleted, err)
	}
	// Deleting twice: second call reports not-found without error.
	if deleted, err := DeleteFileFromImage(dev, "nextzxos", "autoexec.1st"); err != nil || !deleted {
		t.Fatalf("first delete: deleted=%v err=%v", deleted, err)
	}
	if deleted, err := DeleteFileFromImage(dev, "nextzxos", "autoexec.1st"); err != nil || deleted {
		t.Fatalf("second delete: deleted=%v err=%v", deleted, err)
	}
}

func countFreeClusters(b *fat32Builder) int {
	n := 0
	for c := uint32(2); c < b.clusters+2; c++ {
		if b.getFAT(c) == 0 {
			n++
		}
	}
	return n
}
