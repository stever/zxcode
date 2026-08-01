package next

import (
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/dma"
	"github.com/conorarmstrong/zx_go/pkg/next/nextregs"
	"github.com/conorarmstrong/zx_go/pkg/z80"
)

// NR$CC-$CE DMA-interrupt enables (zxnext.vhd:1957-1958 im2_dma_int_en,
// :2005-2008 im2_dma_delay): a chain device outside idle whose enable
// bit is set — or an outstanding NMI with NR$CC bit 7 — pauses an
// ongoing zxnDMA transfer until the ISR's RETI releases the device (the
// per-device condition is im2_device.vhd:151 o_dma_int = state /= S_0
// and i_dma_int_en). In pulse mode the chain is held reset
// (im2_peripheral.vhd:105), so only the NMI arm applies there.

// dmaIntRig builds a CPU + dispatcher + CTC + IM2 block + DMA with the
// production pause wiring (WireDMAPause), on the im2TestRig memory
// image (vector table at $5E00, EI/RETI handler at $8001).
func dmaIntRig(t *testing.T) (*z80.CPU, *nextregs.Dispatcher, *IM2Block, *dma.DMA, *slideMem, *bool) {
	t.Helper()
	mem := &slideMem{}
	cpu := z80.New(mem, minimalULA{})
	disp := nextregs.New()
	WireCPUSpeed(disp, cpu)
	WireInterruptControl(disp, cpu)
	WirePeripheralMasks(disp) // NR$CC-$CE storage
	ctcBlk := WireCTC(disp, cpu)
	blk := WireIM2(disp, cpu, ctcBlk)

	assertT, pulseT := FrameIntTiming(0x03, false)
	cpu.IntAssertTstate = uint64(assertT)
	cpu.IntPulseTstates = uint64(pulseT)

	for a := 0x5E00; a < 0x6000; a += 2 {
		mem.m[a] = 0x01
		mem.m[a+1] = 0x80
	}
	mem.m[0x8001] = 0xFB // EI
	mem.m[0x8002] = 0xED // RETI (exact ED 4D)
	mem.m[0x8003] = 0x4D
	mem.m[0x8004] = 0xC9 // RET back to the main loop

	d := dma.New(memBus{mem})
	d.SetClock(cpu.RefTstates)
	d.SetCycleSink(func(n uint64) { cpu.SetTstates(cpu.Tstates() + n) })
	nmi := false
	WireDMAPause(d, blk, disp, func() bool { return nmi })
	cpu.AddPreFetchHook("zxndma-step", func(uint16) { d.Step(cpu.RefTstates()) })
	return cpu, disp, blk, d, mem, &nmi
}

// memBus adapts slideMem to the DMA's MemoryBus.
type memBus struct{ m *slideMem }

func (b memBus) Read(a uint16) byte     { return b.m.Read(a) }
func (b memBus) Write(a uint16, v byte) { b.m.Write(a, v) }

// dmaXferCmd mirrors the dma package's test stream builder: an A->B
// memory continuous transfer.
func dmaXferCmd(src, dst, length uint16) []byte {
	return []byte{
		0xC3,
		0x7D, byte(src), byte(src >> 8), byte(length), byte(length >> 8),
		0x14,                            // WR1: port A memory, increment
		0x10,                            // WR2: port B memory, increment
		0x8D, byte(dst), byte(dst >> 8), // WR4 continuous + dst
		0xCF, 0x87,
	}
}

// TestWireDMAPauseChainSourceHeldThroughISR: in hw-IM2 mode a
// dma-enabled chain request parks a continuous transfer; the pause
// holds through REQ, ACK and the whole in-service window, and the
// transfer resumes only after the handler's RETI releases the device.
func TestWireDMAPauseChainSourceHeldThroughISR(t *testing.T) {
	cpu, disp, blk, d, mem, _ := dmaIntRig(t)

	nrWrite(disp, 0xC0, 0xA1) // hw-IM2, vector base %101
	nrWrite(disp, 0xCD, 0x01) // CTC channel 0 may interrupt DMA
	cpu.FrameIntDisabled = true

	for i := 0; i < 8; i++ {
		mem.m[0x4000+i] = byte(i + 1)
	}

	// Software-generated (NR$20) request on CTC channel 0 — the device
	// leaves S_0 and o_dma_int asserts.
	nrWrite(disp, 0x20, 0x01)
	if paused, _ := blk.DMAPause(cpu.RefTstates()); !paused {
		t.Fatal("dma-enabled request outstanding but DMAPause reports clear")
	}

	for _, b := range dmaXferCmd(0x4000, 0x9000, 8) {
		d.WriteCommand(b)
	}
	if !d.Suspended() {
		t.Fatal("ENABLE under an outstanding dma-enabled request did not park the block")
	}
	if mem.m[0x9000] != 0 {
		t.Fatal("bytes moved while the chain held the DMA off the bus")
	}

	// Run the CPU from a NOP field: it accepts the vectored interrupt,
	// runs EI/RETI at $8001, and the RETI release lets the pre-fetch
	// pump resume the block.
	for a := 0x9100; a < 0x9200; a++ {
		mem.m[a] = 0x00
	}
	mem.m[0x9200] = 0xC3 // JP $9100
	mem.m[0x9201] = 0x00
	mem.m[0x9202] = 0x91
	cpu.PC = 0x9100
	cpu.SP = 0xFF00
	cpu.IM = 2
	cpu.I = 0x5E
	cpu.IFF1, cpu.IFF2 = true, true

	sawISR := false
	resumedAt := -1
	for i := 0; i < 2000; i++ {
		cpu.StepInstructionWithIRQ()
		if cpu.PC >= 0x8001 && cpu.PC <= 0x8004 {
			sawISR = true
			if !d.Suspended() {
				t.Fatal("DMA resumed inside the ISR — the pause must hold through the in-service window")
			}
		}
		if resumedAt < 0 && !d.Suspended() {
			resumedAt = i
		}
	}
	if !sawISR {
		t.Fatal("the vectored interrupt never reached the $8001 handler")
	}
	if resumedAt < 0 {
		t.Fatal("the transfer never resumed after RETI")
	}
	for i := 0; i < 8; i++ {
		if mem.m[0x9000+i] != byte(i+1) {
			t.Fatalf("dst[%d]=%02X, want %02X", i, mem.m[0x9000+i], byte(i+1))
		}
	}
}

// TestWireDMAPauseNMIArm: NR$CC bit 7 gates the NMI arm
// (nmi_activated and nr_cc_dma_int_en_0_7, zxnext.vhd:2007) — an
// outstanding NMI parks the transfer regardless of interrupt mode, and
// with bit 7 clear it does not.
func TestWireDMAPauseNMIArm(t *testing.T) {
	cpu, disp, _, d, mem, nmi := dmaIntRig(t)

	for i := 0; i < 4; i++ {
		mem.m[0x4000+i] = byte(0xA0 + i)
	}
	nrWrite(disp, 0xCC, 0x80)
	*nmi = true
	for _, b := range dmaXferCmd(0x4000, 0x9000, 4) {
		d.WriteCommand(b)
	}
	if !d.Suspended() {
		t.Fatal("outstanding NMI with NR$CC bit 7 set did not park the transfer")
	}
	*nmi = false
	d.Step(cpu.RefTstates())
	if d.Suspended() {
		t.Fatal("transfer did not resume after the NMI window closed")
	}
	if mem.m[0x9000] != 0xA0 || mem.m[0x9003] != 0xA3 {
		t.Fatal("resumed transfer did not complete")
	}

	// Bit 7 clear: the same NMI must NOT pause.
	nrWrite(disp, 0xCC, 0x00)
	*nmi = true
	for i := 0; i < 4; i++ {
		mem.m[0x4000+i] = byte(0xB0 + i)
	}
	for _, b := range dmaXferCmd(0x4000, 0x9100, 4) {
		d.WriteCommand(b)
	}
	if d.Suspended() {
		t.Fatal("NMI paused the transfer with NR$CC bit 7 clear")
	}
	if mem.m[0x9100] != 0xB0 {
		t.Fatal("transfer did not run to completion")
	}
}

// TestWireDMAPausePulseModeChainInert: in pulse mode the chain is held
// reset (im2_reset_n = mode and not reset, im2_peripheral.vhd:105), so
// dma-enabled chain sources cannot pause a transfer — only the NMI arm
// can. NR$20 requests are ignored outside hw mode, and a CTC pulse INT
// runs the legacy path, never the chain.
func TestWireDMAPausePulseModeChainInert(t *testing.T) {
	cpu, disp, blk, d, mem, _ := dmaIntRig(t)
	_ = cpu

	nrWrite(disp, 0xCD, 0xFF) // every CTC channel dma-enabled...
	nrWrite(disp, 0xCC, 0x03)
	nrWrite(disp, 0xCE, 0x77)
	nrWrite(disp, 0x20, 0x0F) // ...but pulse mode: requests don't reach the chain

	if paused, _ := blk.DMAPause(0); paused {
		t.Fatal("pulse mode chain reported a DMA pause — chain is held reset")
	}
	for i := 0; i < 4; i++ {
		mem.m[0x4000+i] = byte(0xC0 + i)
	}
	for _, b := range dmaXferCmd(0x4000, 0x9000, 4) {
		d.WriteCommand(b)
	}
	if d.Suspended() {
		t.Fatal("pulse-mode transfer parked — chain sources must be inert")
	}
	if mem.m[0x9000] != 0xC0 {
		t.Fatal("transfer did not complete")
	}
}
