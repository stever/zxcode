package sdcard

import (
	"fmt"
	"sort"
	"strings"
)

// ListDir returns the display names of a directory's entries in the
// order the NextZXOS Browser presents them: files and directories
// mixed, sorted case-insensitively by display name (the VFAT long
// name when present, the 8.3 name otherwise). The "." and ".."
// entries of subdirectories are NOT included — the Browser shows
// them as the first two rows ahead of the sorted entries, and the
// root has none. dirPath "" or "/" lists the root.
//
// Used to compute Browser cursor positions for the .nex launch macro:
// the Browser opens with its cursor on the first row, so an entry's
// row index is exactly the number of cursor-DOWN presses to reach it.
func ListDir(dev Image, dirPath string) ([]string, error) {
	b, err := openFAT32(dev)
	if err != nil {
		return nil, err
	}
	dirClus := uint32(2)
	for _, part := range strings.Split(strings.Trim(dirPath, "/"), "/") {
		if part == "" {
			continue
		}
		dirClus = b.findSubdir(dirClus, part)
		if dirClus == 0 {
			return nil, fmt.Errorf("sdcard: directory %q not found", part)
		}
	}
	var names []string
	b.forEachDirent(dirClus, func(off int, long string) bool {
		e := b.rd(off, 32)
		if e[11]&attrVolume != 0 {
			return false
		}
		name := long
		if name == "" {
			name = name83ToPath(e[0:11])
			// 8.3 lowercase-display flags (dirent offset 12: bit 3 =
			// lowercase base, bit 4 = lowercase extension) only affect
			// case, which the sort ignores.
		}
		if name == "." || name == ".." {
			return false
		}
		names = append(names, name)
		return false
	})
	sort.SliceStable(names, func(i, j int) bool {
		return strings.ToLower(names[i]) < strings.ToLower(names[j])
	})
	return names, nil
}
