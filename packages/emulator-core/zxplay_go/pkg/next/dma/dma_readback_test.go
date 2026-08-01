package dma

import "testing"

// After a transfer, setting the read mask to the byte-counter registers and
// reading port 0x6B returns the live counter low then high byte.
func TestReadbackByteCounter(t *testing.T) {
	d := New(memMap{})
	feed(d, transferCmd(0x4000, 0x6000, 0x0140, addrIncrement, addrIncrement, true))
	// Read mask: bits 1,2 = byte counter low + high (0x06).
	feed(d, []byte{0xBB, 0x06})
	if lo := d.ReadCommand(); lo != 0x40 {
		t.Errorf("counter low = $%02X, want $40", lo)
	}
	if hi := d.ReadCommand(); hi != 0x01 {
		t.Errorf("counter high = $%02X, want $01", hi)
	}
	// Sequence wraps back to the first masked register.
	if lo := d.ReadCommand(); lo != 0x40 {
		t.Errorf("after wrap, counter low = $%02X, want $40", lo)
	}
}

// The read mask can select the port A / port B address registers, returning
// the live internal pointers.
func TestReadbackPortAddresses(t *testing.T) {
	d := New(memMap{})
	feed(d, transferCmd(0x4000, 0x6000, 4, addrIncrement, addrIncrement, true))
	// Mask bits 3,4 = port A addr low/high; 5,6 = port B addr low/high (0x78).
	feed(d, []byte{0xBB, 0x78})
	got := []byte{d.ReadCommand(), d.ReadCommand(), d.ReadCommand(), d.ReadCommand()}
	// After a 4-byte incrementing transfer: curA=$4004, curB=$6004.
	want := []byte{0x04, 0x40, 0x04, 0x60}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("readback[%d] = $%02X, want $%02X", i, got[i], want[i])
		}
	}
}

// $A7 (initiate read sequence) resets the read cursor to the first masked
// register.
func TestInitiateReadSequenceResetsCursor(t *testing.T) {
	d := New(memMap{})
	feed(d, transferCmd(0x4000, 0x6000, 0x0102, addrIncrement, addrIncrement, true))
	feed(d, []byte{0xBB, 0x06}) // counter low, high
	_ = d.ReadCommand()         // consume low
	d.WriteCommand(0xA7)        // re-initiate read sequence
	if lo := d.ReadCommand(); lo != 0x02 {
		t.Errorf("after $A7, first read = $%02X, want counter low $02", lo)
	}
}

// $BF (Read Status Byte) aims the read state at STATUS: the next port read
// returns the status byte regardless of where the sequence stood
// (dma.vhd:687-688), and reading resumes the masked sequence after it.
func TestReadStatusByteCommand(t *testing.T) {
	d := New(memMap{})
	feed(d, transferCmd(0x4000, 0x6000, 4, addrIncrement, addrIncrement, true))
	feed(d, []byte{0xBB, 0x0A}) // mask: counter lo (bit1) + port A lo (bit3)
	if got := d.ReadCommand(); got != 0x04 {
		t.Fatalf("first masked read = $%02X, want counter lo $04", got)
	}
	d.WriteCommand(0xBF)
	// Status after a completed one-shot block: endofblock_n=0, atleastone=0
	// → "00"&0&"1101"&0 = $1A (dma.vhd:902).
	if got := d.ReadCommand(); got != 0x1A {
		t.Errorf("read after $BF = $%02X, want status $1A", got)
	}
	// The state advances from STATUS to the next masked register (counter lo).
	if got := d.ReadCommand(); got != 0x04 {
		t.Errorf("read after status = $%02X, want counter lo $04", got)
	}
}

// Before any transfer the status byte reads $3A (endofblock_n=1,
// atleastone=0) — the value the upstream base/DMA test prints as its
// second hex byte after a full init + $BF.
func TestStatusBeforeAnyTransfer(t *testing.T) {
	d := New(memMap{})
	feed(d, []byte{0xC3, 0xBF})
	if got := d.ReadCommand(); got != 0x3A {
		t.Errorf("status before any transfer = $%02X, want $3A", got)
	}
}

// An empty read mask parks the sequence on STATUS: every read returns the
// status byte (each dma.vhd RD_* else-branch lands on RD_STATUS).
func TestEmptyReadMaskReadsStatus(t *testing.T) {
	d := New(memMap{})
	feed(d, []byte{0xC3, 0xBB, 0x00})
	for i := 0; i < 2; i++ {
		if got := d.ReadCommand(); got != 0x3A {
			t.Errorf("read %d with empty mask = $%02X, want status $3A", i, got)
		}
	}
}

// An auto-restart burst (WR5 D5) reloads and repeats without a new ENABLE —
// FINISH_DMA goes straight back to START_DMA (dma.vhd:469-489) — until
// DISABLE ($83) idles the FSM. While in flight, status bit 0
// (status_atleastone) reads 1; $83 clears it (IDLE, dma.vhd:265).
func TestAutoRestartBurstRepeatsUntilDisable(t *testing.T) {
	mem := memMap{0x4000: 0x55}
	var now uint64
	d := New(mem)
	d.SetClock(func() uint64 { return now })
	feed(d, []byte{
		0xC3,
		0x7D, 0x00, 0x40, 0x02, 0x00, // WR0 A->B, addr $4000, len 2
		0x24,       // WR1 port A fixed, mem
		0x50, 0x22, // WR2 port B increment, mem, timing byte w/ prescaler
		10,               // prescaler 10 → 5 T-states per byte at turbo 0
		0xCD, 0x00, 0x60, // WR4 burst + port B addr $6000
		0xAA,       // WR5 auto-restart (D5) + ce/wait bits
		0xCF, 0x87, // LOAD, ENABLE
	})
	// Run long enough for 3+ blocks of 2 bytes (5 T each).
	for now = 0; now < 100; now += 5 {
		d.Step(now)
	}
	if got := d.statusByte(); got&0x01 != 0x01 {
		t.Errorf("in-flight auto-restart status = $%02X, want atleastone bit set", got)
	}
	if mem[0x6000] != 0x55 || mem[0x6001] != 0x55 {
		t.Fatalf("auto-restart did not refill: $6000/$6001 = $%02X/$%02X", mem[0x6000], mem[0x6001])
	}
	// Repaint proof: dirty the destination, step further, it repaints.
	mem[0x6000] = 0x00
	for ; now < 200; now += 5 {
		d.Step(now)
	}
	if mem[0x6000] != 0x55 {
		t.Errorf("auto-restart stopped repainting: $6000 = $%02X, want $55", mem[0x6000])
	}
	d.WriteCommand(0x83) // DISABLE — dma_seq := IDLE
	mem[0x6000] = 0x00
	for ; now < 300; now += 5 {
		d.Step(now)
	}
	if mem[0x6000] != 0x00 {
		t.Errorf("$83 did not stop the auto-restart burst: $6000 = $%02X", mem[0x6000])
	}
	if got := d.statusByte(); got&0x01 != 0 {
		t.Errorf("status after $83 = $%02X, want atleastone clear", got)
	}
}

// The power-up read mask is 0x7F (all seven registers in the read sequence).
func TestDefaultReadMaskAllRegisters(t *testing.T) {
	d := New(memMap{})
	feed(d, transferCmd(0x4000, 0x6000, 4, addrIncrement, addrIncrement, true))
	// No explicit read mask set → default 0x7F. Seven distinct reads then wrap.
	first := make([]byte, 7)
	for i := range first {
		first[i] = d.ReadCommand()
	}
	if d.ReadCommand() != first[0] {
		t.Error("read sequence did not wrap after 7 registers (default mask 0x7F)")
	}
}
