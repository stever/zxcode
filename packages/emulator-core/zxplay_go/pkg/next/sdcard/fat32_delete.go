package sdcard

import (
	"encoding/binary"
	"strings"
)

// DeleteFileFromImage removes the file fileName from the directory dirPath
// (e.g. "nextzxos") of an existing FAT32 image (flat or sparse): the data
// cluster chain returns to the FAT and the directory entry — together with
// any VFAT LFN chain ahead of it — gets the 0xE5 free marker, exactly the
// tombstone a real FAT driver leaves. Name matching is findDirent's: long
// name case-insensitively, or the 8.3 short form. Returns false (with no
// error) when the directory or file does not exist, so callers can treat
// deletion as idempotent.
func DeleteFileFromImage(dev Image, dirPath, fileName string) (bool, error) {
	b, err := openFAT32(dev)
	if err != nil {
		return false, err
	}
	dirClus, ok := b.walkDirPath(dirPath)
	if !ok {
		return false, nil
	}
	if !b.deleteDirent(dirClus, fileName) {
		return false, nil
	}
	b.mirrorFAT()
	return true, nil
}

// FileExistsInImage reports whether dirPath/fileName exists as a file in the
// FAT32 image, matching names the way DeleteFileFromImage does.
func FileExistsInImage(dev Image, dirPath, fileName string) (bool, error) {
	b, err := openFAT32(dev)
	if err != nil {
		return false, err
	}
	dirClus, ok := b.walkDirPath(dirPath)
	if !ok {
		return false, nil
	}
	return b.findDirent(dirClus, fileName, false) >= 0, nil
}

// walkDirPath resolves a "a/b/c" directory path from the root without
// creating anything. ok is false when any segment is missing.
func (b *fat32Builder) walkDirPath(dirPath string) (uint32, bool) {
	dirClus := uint32(2)
	for _, part := range strings.Split(strings.Trim(dirPath, "/"), "/") {
		if part == "" {
			continue
		}
		if dirClus = b.findSubdir(dirClus, part); dirClus == 0 {
			return 0, false
		}
	}
	return dirClus, true
}

// deleteDirent tombstones the live file entry named name in the directory
// chain at dirClus and frees its data chain. The walk mirrors forEachDirent
// but additionally tracks the physical offsets of the LFN entries directly
// ahead of each short entry (forEachDirent decodes names without exposing
// them), so the whole chain is freed even when it spans a cluster boundary.
func (b *fat32Builder) deleteDirent(dirClus uint32, name string) bool {
	target := b.findDirent(dirClus, name, false)
	if target < 0 {
		return false
	}
	var lfnOffs []int
	for c := dirClus; c >= 2 && c < 0x0FFFFFF8; c = b.getFAT(c) {
		base := b.clusterOffset(c)
		for i := 0; i+32 <= b.spc*512; i += 32 {
			off := base + i
			e := b.rd(off, 32)
			switch {
			case e[0] == 0x00:
				return false // end of directory before the target
			case e[0] == 0xE5:
				lfnOffs = lfnOffs[:0]
			case e[11] == 0x0F:
				lfnOffs = append(lfnOffs, off)
			default:
				if off == target {
					first := uint32(binary.LittleEndian.Uint16(e[20:22]))<<16 |
						uint32(binary.LittleEndian.Uint16(e[26:28]))
					b.freeChain(first)
					for _, o := range append(lfnOffs, off) {
						ent := b.rd(o, 32)
						ent[0] = 0xE5
						b.wr(o, ent)
					}
					return true
				}
				lfnOffs = lfnOffs[:0]
			}
		}
	}
	return false
}
