package sdcard

import (
	"encoding/binary"
	"fmt"
	"strings"
	"unicode/utf16"
)

// AddFileToFAT32 inserts data as a file named fileName under the directory
// dirPath (e.g. "imported", or "games/imported") into an existing in-memory
// FAT32 image, creating intermediate directories as needed. It returns the
// absolute SD-card path of the written file using its 8.3 short name (e.g.
// "/imported/SONIC.NEX"), which a loader can reference unambiguously.
//
// The image is modified in place; callers persist it (e.g. ImageSource.
// WriteBackTo). The file is written with a unique 8.3 alias within the target
// directory, so re-importing the same name produces a fresh entry rather than
// corrupting the directory.
func AddFileToFAT32(img []byte, dirPath, fileName string, data []byte) (string, error) {
	b, err := openFAT32(img)
	if err != nil {
		return "", err
	}

	dirClus := uint32(2) // root directory
	var sdDir strings.Builder
	for _, part := range strings.Split(strings.Trim(dirPath, "/"), "/") {
		if part == "" {
			continue
		}
		sub := b.findSubdir(dirClus, part)
		if sub == 0 {
			if sub = b.createSubdir(dirClus, part); sub == 0 {
				return "", fmt.Errorf("sdcard: could not create directory %q (disk full?)", part)
			}
		}
		dirClus = sub
		sdDir.WriteString("/")
		sdDir.WriteString(strings.ToUpper(part))
	}

	used := b.collectUsed(dirClus)
	short11, needLFN := shortAlias(fileName, used)

	first, n := b.writeData(data)
	if first == 0 && len(data) > 0 {
		return "", fmt.Errorf("sdcard: not enough free space to write %s", fileName)
	}
	if needLFN {
		b.writeLFN(dirClus, fileName, short11)
	}
	if !b.appendDirent(dirClus, rawDirent(short11, attrArchive, first, uint32(n))) {
		return "", fmt.Errorf("sdcard: directory full adding %s", fileName)
	}
	b.mirrorFAT()

	return sdDir.String() + "/" + name83ToPath(short11), nil
}

// WriteFileToFAT32 writes data as fileName under dirPath, replacing any
// existing file of the same name in that directory (and freeing its old
// clusters) instead of creating a uniquely-aliased duplicate the way
// AddFileToFAT32 does. Use it for fixed-name files that must be updatable in
// place, e.g. nextzxos/autoexec.bas. Names (directories included) that don't
// fit 8.3 are written as VFAT LFN chains with a generated ~N alias, exactly
// like BuildFAT32's host-dir mode — NextZXOS resolves them by long name; the
// match for replacement is the long name, case-insensitively, the way VFAT
// matches. Returns the absolute SD-card path (short names).
func WriteFileToFAT32(img []byte, dirPath, fileName string, data []byte) (string, error) {
	b, err := openFAT32(img)
	if err != nil {
		return "", err
	}

	dirClus := uint32(2) // root directory
	var sdDir strings.Builder
	for _, part := range strings.Split(strings.Trim(dirPath, "/"), "/") {
		if part == "" {
			continue
		}
		sub := b.findSubdir(dirClus, part)
		if sub == 0 {
			if sub = b.createSubdir(dirClus, part); sub == 0 {
				return "", fmt.Errorf("sdcard: could not create directory %q (disk full?)", part)
			}
		}
		dirClus = sub
		sdDir.WriteString("/")
		sdDir.WriteString(strings.ToUpper(part))
	}

	first, n := b.writeData(data)
	if first == 0 && len(data) > 0 {
		return "", fmt.Errorf("sdcard: not enough free space to write %s", fileName)
	}
	// Replace an existing entry in place (freeing its old chain, keeping its
	// LFN chain and alias); otherwise add a fresh entry, with an LFN chain
	// when the name doesn't round-trip as plain 8.3.
	var name11 []byte
	if off := b.findDirent(dirClus, fileName, false); off >= 0 {
		b.repointDirent(off, first, uint32(n))
		name11 = append([]byte(nil), b.img[off:off+11]...)
	} else {
		short11, needLFN := shortAlias(fileName, b.collectUsed(dirClus))
		if needLFN {
			b.writeLFN(dirClus, fileName, short11)
		}
		if !b.appendDirent(dirClus, rawDirent(short11, attrArchive, first, uint32(n))) {
			return "", fmt.Errorf("sdcard: directory full adding %s", fileName)
		}
		name11 = short11
	}
	b.mirrorFAT()

	return sdDir.String() + "/" + name83ToPath(name11), nil
}

// repointDirent frees the cluster chain of the short entry at absolute image
// offset off and repoints it at a freshly written chain (first/size),
// keeping the entry (and any LFN chain ahead of it) in place.
func (b *fat32Builder) repointDirent(off int, first, size uint32) {
	e := b.img[off : off+32]
	old := uint32(binary.LittleEndian.Uint16(e[20:22]))<<16 |
		uint32(binary.LittleEndian.Uint16(e[26:28]))
	b.freeChain(old)
	binary.LittleEndian.PutUint16(e[20:22], uint16(first>>16))
	binary.LittleEndian.PutUint16(e[26:28], uint16(first&0xFFFF))
	binary.LittleEndian.PutUint32(e[28:32], size)
}

// forEachDirent walks the live short entries of the directory chain at
// dirClus, giving fn each entry's absolute image offset together with the
// long name decoded from the VFAT LFN chain immediately ahead of it (""
// when the entry has none, or the chain is broken). fn returns true to
// stop the walk.
func (b *fat32Builder) forEachDirent(dirClus uint32, fn func(off int, long string) bool) {
	var parts [][]uint16 // LFN pieces indexed by seq-1 (seq 1 = first 13 chars)
	var sum byte
	haveLFN := false
	reset := func() { parts, haveLFN = nil, false }
	for c := dirClus; c >= 2 && c < 0x0FFFFFF8; c = b.getFAT(c) {
		base := b.clusterOffset(c)
		for i := 0; i+32 <= b.spc*512; i += 32 {
			e := b.img[base+i : base+i+32]
			switch {
			case e[0] == 0x00:
				return // end of directory
			case e[0] == 0xE5:
				reset()
			case e[11] == 0x0F: // LFN entry (chain stored last-part-first)
				seq := int(e[0] & 0x3F)
				if e[0]&0x40 != 0 {
					parts, sum, haveLFN = make([][]uint16, seq), e[13], true
				}
				if !haveLFN || seq < 1 || seq > len(parts) || e[13] != sum {
					reset()
					continue
				}
				parts[seq-1] = lfnUnits(e)
			default:
				long := ""
				if haveLFN && lfnChecksum(e[0:11]) == sum {
					long = joinLFN(parts)
				}
				reset()
				if fn(base+i, long) {
					return
				}
			}
		}
	}
}

// lfnUnits extracts the 13 UTF-16 units carried by one LFN entry.
func lfnUnits(e []byte) []uint16 {
	out := make([]uint16, 0, 13)
	for _, sp := range [][2]int{{1, 5}, {14, 6}, {28, 2}} { // offset, count(u16)
		for k := 0; k < sp[1]; k++ {
			out = append(out, binary.LittleEndian.Uint16(e[sp[0]+k*2:sp[0]+k*2+2]))
		}
	}
	return out
}

// joinLFN reassembles the long name from its collected pieces; "" when any
// piece of the chain is missing.
func joinLFN(parts [][]uint16) string {
	var units []uint16
	for _, p := range parts {
		if p == nil {
			return ""
		}
		units = append(units, p...)
	}
	for i, u := range units {
		if u == 0x0000 {
			units = units[:i]
			break
		}
	}
	return string(utf16.Decode(units))
}

// findDirent locates a live entry named `name` in the directory chain at
// dirClus, matching the way VFAT does: against the entry's long name
// (case-insensitive) or, when name itself round-trips as 8.3, against the
// short name. wantDir selects directories vs files. Returns the short
// entry's absolute image offset, or -1.
func (b *fat32Builder) findDirent(dirClus uint32, name string, wantDir bool) int {
	short := ""
	if base, ext, fits83, _ := basis(name); fits83 {
		short = string(padName83(base, ext))
	}
	found := -1
	b.forEachDirent(dirClus, func(off int, long string) bool {
		e := b.img[off : off+32]
		if e[11]&attrVolume != 0 || (e[11]&attrDir != 0) != wantDir {
			return false
		}
		if (long != "" && strings.EqualFold(long, name)) ||
			(short != "" && string(e[0:11]) == short) {
			found = off
			return true
		}
		return false
	})
	return found
}

// freeChain releases a cluster chain back to the FAT (marks each cluster free).
func (b *fat32Builder) freeChain(first uint32) {
	for c := first; c >= 2 && c < 0x0FFFFFF8; {
		next := b.getFAT(c)
		b.setFAT(c, 0)
		c = next
	}
}

// openFAT32 reconstructs a builder over an existing FAT32 image so files can be
// appended: it reads the BPB at the partition start, derives the FAT and data
// offsets, and locates the first free cluster by scanning the FAT.
func openFAT32(img []byte) (*fat32Builder, error) {
	if len(img) < 512 || img[510] != 0x55 || img[511] != 0xAA {
		return nil, fmt.Errorf("sdcard: no MBR signature")
	}
	// The first partition's start LBA — don't assume the 1 MB-aligned
	// value BuildFAT32 uses; real cards vary.
	partLBA := int(binary.LittleEndian.Uint32(img[454:458]))
	if partLBA == 0 {
		partLBA = fat32PartLBA
	}
	if len(img) < (partLBA+1)*512 {
		return nil, fmt.Errorf("sdcard: image too small for its FAT32 partition")
	}
	bpb := img[partLBA*512:]
	if bpb[510] != 0x55 || bpb[511] != 0xAA {
		return nil, fmt.Errorf("sdcard: no boot signature at the FAT32 partition start (LBA %d)", partLBA)
	}
	if bytesPerSector := binary.LittleEndian.Uint16(bpb[11:13]); bytesPerSector != 512 {
		return nil, fmt.Errorf("sdcard: unsupported bytes/sector %d", bytesPerSector)
	}
	spc := int(bpb[13])
	reserved := int(binary.LittleEndian.Uint16(bpb[14:16]))
	numFATs := int(bpb[16])
	fatsz := int(binary.LittleEndian.Uint32(bpb[36:40]))
	partSectors := int(binary.LittleEndian.Uint32(bpb[32:36]))
	rootClus := binary.LittleEndian.Uint32(bpb[44:48])
	if spc == 0 || fatsz == 0 || numFATs < 1 || rootClus != 2 {
		return nil, fmt.Errorf("sdcard: unsupported FAT32 BPB (spc=%d fatsz=%d fats=%d root=%d)", spc, fatsz, numFATs, rootClus)
	}
	clusters := uint32((partSectors - reserved - numFATs*fatsz) / spc)
	b := &fat32Builder{
		img:          img,
		spc:          spc,
		fatsz:        fatsz,
		totalSectors: len(img) / 512,
		clusters:     clusters,
		fatOffset:    (partLBA + reserved) * 512,
		dataOffset:   (partLBA + reserved + numFATs*fatsz) * 512,
		nextFree:     2,
		scanAlloc:    true,
	}
	for c := uint32(2); c < clusters+2; c++ {
		b.nextFree = c
		if b.getFAT(c) == 0 {
			return b, nil
		}
	}
	b.nextFree = clusters + 2 // full
	return b, nil
}

// findSubdir scans the directory chain at dirClus for a subdirectory named
// `name` — by long name (case-insensitive) or 8.3 short name. Returns its
// first cluster, or 0 if not found.
func (b *fat32Builder) findSubdir(dirClus uint32, name string) uint32 {
	off := b.findDirent(dirClus, name, true)
	if off < 0 {
		return 0
	}
	e := b.img[off : off+32]
	return uint32(binary.LittleEndian.Uint16(e[20:22]))<<16 |
		uint32(binary.LittleEndian.Uint16(e[26:28]))
}

// createSubdir allocates and initialises a new subdirectory `name` inside
// dirClus and links it in, with a VFAT LFN chain when the name doesn't fit
// 8.3. Returns the new directory's first cluster, or 0 on disk-full.
func (b *fat32Builder) createSubdir(dirClus uint32, name string) uint32 {
	sub := b.allocCluster()
	if sub == 0 {
		return 0
	}
	b.zeroCluster(sub)
	dot := rawDirent([]byte(padFAT(".", 11)), attrDir, sub, 0)
	dotdot := rawDirent([]byte(padFAT("..", 11)), attrDir, parentForDotDot(dirClus), 0)
	copy(b.img[b.clusterOffset(sub):], append(dot, dotdot...))
	short11, needLFN := shortAlias(name, b.collectUsed(dirClus))
	if needLFN {
		b.writeLFN(dirClus, name, short11)
	}
	if !b.appendDirent(dirClus, rawDirent(short11, attrDir, sub, 0)) {
		return 0
	}
	return sub
}

// writeData streams data into a fresh cluster chain (clusters are zeroed first,
// so trailing bytes of the final cluster are clean). Returns the first cluster
// and the byte count.
func (b *fat32Builder) writeData(data []byte) (uint32, int) {
	if len(data) == 0 {
		return 0, 0
	}
	var first, prev uint32
	rem := data
	for len(rem) > 0 {
		c := b.allocCluster()
		if c == 0 {
			return 0, 0
		}
		if first == 0 {
			first = c
		} else {
			b.linkCluster(prev, c)
		}
		prev = c
		b.zeroCluster(c)
		chunk := b.spc * 512
		if len(rem) < chunk {
			chunk = len(rem)
		}
		copy(b.img[b.clusterOffset(c):], rem[:chunk])
		rem = rem[chunk:]
	}
	return first, len(data)
}

// collectUsed gathers the 8.3 aliases already present in dirClus, so a new
// file's alias can be made unique within the directory.
func (b *fat32Builder) collectUsed(dirClus uint32) map[string]bool {
	used := map[string]bool{}
	for c := dirClus; c >= 2 && c < 0x0FFFFFF8; c = b.getFAT(c) {
		off := b.clusterOffset(c)
		cluster := b.img[off : off+b.spc*512]
		for i := 0; i+32 <= len(cluster); i += 32 {
			e := cluster[i : i+32]
			if e[0] == 0x00 {
				return used
			}
			if e[0] == 0xE5 || e[11] == 0x0F {
				continue
			}
			used[string(e[0:11])] = true
		}
	}
	return used
}

func (b *fat32Builder) zeroCluster(c uint32) {
	off := b.clusterOffset(c)
	for i := 0; i < b.spc*512; i++ {
		b.img[off+i] = 0
	}
}

// name83ToPath turns an 11-byte 8.3 dirent name into a "NAME.EXT" path segment.
func name83ToPath(name11 []byte) string {
	base := strings.TrimRight(string(name11[0:8]), " ")
	ext := strings.TrimRight(string(name11[8:11]), " ")
	if ext == "" {
		return base
	}
	return base + "." + ext
}
