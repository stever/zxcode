package sdcard

import (
	"os"
	"path/filepath"
	"testing"
)

// ListDir must return entries in the NextZXOS Browser's presentation
// order — files and directories mixed, case-insensitive by display
// name — with no "."/".." rows, because the .nex launch macro converts
// an entry's index directly into cursor-DOWN presses.
func TestListDirBrowserOrder(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "TX-1696"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []struct{ path, data string }{
		{"zeta.txt", "z"},
		{"Alpha.txt", "a"},
		{"2data.bin", "2"},
		{"TX-1696/main.nex", "nex"},
		{"TX-1696/Level Data.bin", "lvl"},
		{"TX-1696/audio.pt3", "ay"},
	} {
		p := filepath.Join(dir, f.path)
		if err := os.WriteFile(p, []byte(f.data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	img, err := BuildFAT32(dir, FAT32Opts{SizeMB: 64})
	if err != nil {
		t.Fatal(err)
	}

	root, err := ListDir(byteImage(img), "")
	if err != nil {
		t.Fatal(err)
	}
	wantRoot := []string{"2data.bin", "Alpha.txt", "TX-1696", "zeta.txt"}
	if len(root) != len(wantRoot) {
		t.Fatalf("root = %v, want %v", root, wantRoot)
	}
	for i := range wantRoot {
		if root[i] != wantRoot[i] {
			t.Fatalf("root = %v, want %v", root, wantRoot)
		}
	}

	sub, err := ListDir(byteImage(img), "TX-1696")
	if err != nil {
		t.Fatal(err)
	}
	wantSub := []string{"audio.pt3", "Level Data.bin", "main.nex"}
	if len(sub) != len(wantSub) {
		t.Fatalf("subdir = %v, want %v", sub, wantSub)
	}
	for i := range wantSub {
		if sub[i] != wantSub[i] {
			t.Fatalf("subdir = %v, want %v", sub, wantSub)
		}
	}

	if _, err := ListDir(byteImage(img), "NOPE"); err == nil {
		t.Fatal("missing directory should error")
	}
}
