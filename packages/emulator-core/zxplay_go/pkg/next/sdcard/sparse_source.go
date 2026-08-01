package sdcard

import "fmt"

// sparsePageBytes is the allocation granule of a SparseSource. 16 KiB
// (32 blocks) balances map overhead against over-allocation around
// small writes.
const sparsePageBytes = 16 * 1024

// SparseSource is a BlockSource (and Image) whose backing store keeps
// only the pages that have ever held non-zero data: a virtual card of
// any geometry at the RAM cost of its actual content. This is what
// lets the browser present a large-cluster, many-gigabyte card while
// holding only the NextZXOS distro plus whatever game is staged —
// the flat ImageSource made card size equal RAM cost, which capped
// the shipped image at 64 MB and its FAT32 clusters at 512 bytes.
//
// Reads of absent pages return zeros. Writes that are entirely zero
// into absent pages allocate nothing — so streaming a mostly-empty
// image in (see the wasm zxSdIngest* exports) stays sparse.
type SparseSource struct {
	pages map[int64][]byte
	size  int64
	dirty bool
}

// NewSparseSource creates an empty sparse image of the given virtual
// size (a multiple of 512).
func NewSparseSource(size int64) (*SparseSource, error) {
	if size <= 0 || size%512 != 0 {
		return nil, fmt.Errorf("sdcard: sparse image size %d is not a positive multiple of 512", size)
	}
	return &SparseSource{pages: make(map[int64][]byte), size: size}, nil
}

// ReadBlock copies 512 bytes for the given LBA into dst (BlockSource).
func (s *SparseSource) ReadBlock(lba uint32, dst []byte) error {
	s.ReadAt(dst[:512], int64(lba)*512)
	return nil
}

// WriteBlock writes 512 bytes at the LBA (BlockSource).
func (s *SparseSource) WriteBlock(lba uint32, src []byte) error {
	if int64(lba)*512+512 > s.size {
		return fmt.Errorf("sdcard: write LBA %d beyond image", lba)
	}
	s.WriteAt(src[:512], int64(lba)*512)
	return nil
}

// Capacity returns the number of 512-byte blocks in the virtual image.
func (s *SparseSource) Capacity() uint32 { return uint32(s.size / 512) }

// Size returns the virtual image size in bytes (Image).
func (s *SparseSource) Size() int64 { return s.size }

// Dirty reports whether any write has landed since creation.
func (s *SparseSource) Dirty() bool { return s.dirty }

// ResidentBytes returns the RAM held by allocated pages (diagnostics).
func (s *SparseSource) ResidentBytes() int64 {
	return int64(len(s.pages)) * sparsePageBytes
}

// ReadAt fills p from the virtual image at off; absent pages read as
// zeros. Reads past the virtual end are zero-filled too (matching
// ImageSource's tolerant past-end behaviour) and report io.EOF via a
// short count only when off itself is past the end — callers in this
// package treat the buffer contents as authoritative.
func (s *SparseSource) ReadAt(p []byte, off int64) (int, error) {
	for done := 0; done < len(p); {
		pageIdx := (off + int64(done)) / sparsePageBytes
		pageOff := int((off + int64(done)) % sparsePageBytes)
		n := sparsePageBytes - pageOff
		if n > len(p)-done {
			n = len(p) - done
		}
		if page, ok := s.pages[pageIdx]; ok {
			copy(p[done:done+n], page[pageOff:pageOff+n])
		} else {
			for i := done; i < done+n; i++ {
				p[i] = 0
			}
		}
		done += n
	}
	return len(p), nil
}

// WriteAt stores p at off, allocating pages as needed. All-zero spans
// aimed at absent pages allocate nothing.
func (s *SparseSource) WriteAt(p []byte, off int64) (int, error) {
	s.dirty = true
	for done := 0; done < len(p); {
		pageIdx := (off + int64(done)) / sparsePageBytes
		pageOff := int((off + int64(done)) % sparsePageBytes)
		n := sparsePageBytes - pageOff
		if n > len(p)-done {
			n = len(p) - done
		}
		chunk := p[done : done+n]
		page, ok := s.pages[pageIdx]
		if !ok {
			if allZero(chunk) {
				done += n
				continue
			}
			page = make([]byte, sparsePageBytes)
			s.pages[pageIdx] = page
		}
		copy(page[pageOff:], chunk)
		done += n
	}
	return len(p), nil
}

func allZero(p []byte) bool {
	for _, b := range p {
		if b != 0 {
			return false
		}
	}
	return true
}
