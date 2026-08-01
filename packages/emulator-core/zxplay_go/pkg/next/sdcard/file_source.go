package sdcard

import (
	"fmt"
	"io"
	"os"
)

// FileSource is a BlockSource backed by a host file opened
// read-only, with guest writes captured in an in-memory overlay.
// It exists for card images too large to slurp into a byte slice
// (e.g. a dd of a real multi-GB SD card): reads hit the file
// directly via ReadAt, writes never touch the file, and the
// overlay wins on subsequent reads so the guest sees its own
// writes coherently.
type FileSource struct {
	f       *os.File
	blocks  uint32
	overlay map[uint32][]byte
}

// NewFileSource opens path read-only as a block source. The file
// length must be a multiple of 512.
func NewFileSource(path string) (*FileSource, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if st.Size()%512 != 0 {
		f.Close()
		return nil, fmt.Errorf("sdcard: image length %d is not a multiple of 512", st.Size())
	}
	return &FileSource{
		f:       f,
		blocks:  uint32(st.Size() / 512),
		overlay: make(map[uint32][]byte),
	}, nil
}

// ReadBlock returns the overlay copy when the guest has written
// the block, else reads the backing file. Reads beyond the image
// return zeros, matching ImageSource.
func (s *FileSource) ReadBlock(lba uint32, dst []byte) error {
	if b, ok := s.overlay[lba]; ok {
		copy(dst, b)
		return nil
	}
	if lba >= s.blocks {
		for i := range dst {
			dst[i] = 0
		}
		return nil
	}
	if _, err := s.f.ReadAt(dst, int64(lba)*512); err != nil && err != io.EOF {
		return fmt.Errorf("sdcard: read LBA %d: %w", lba, err)
	}
	return nil
}

// WriteBlock stores the block in the overlay; the backing file is
// never modified.
func (s *FileSource) WriteBlock(lba uint32, src []byte) error {
	if lba >= s.blocks {
		return fmt.Errorf("sdcard: write LBA %d beyond image", lba)
	}
	b := make([]byte, 512)
	copy(b, src)
	s.overlay[lba] = b
	return nil
}

// Capacity returns the number of 512-byte blocks in the image.
func (s *FileSource) Capacity() uint32 { return s.blocks }

// Close releases the backing file handle.
func (s *FileSource) Close() error { return s.f.Close() }
