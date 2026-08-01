package next

// UART interrupt sources into the im2 daisy chain (#158 Axis 5).
// FPGA truth (zxnext.vhd:1941-1949): the chain's request vector
// carries uart0_rx (source/vector 1: near-full OR rx-avail when the
// near-full-only enable is clear), uart1_rx (2), uart0_tx_empty (12)
// and uart1_tx_empty (13) as LEVELS, enabled by NR$C6 — bits 1|0
// (uart0 rx), 5|4 (uart1 rx), 2 (uart0 tx), 6 (uart1 tx). NR$CA reads
// the sticky source states ('0' & st13 & st2 & st2 & '0' & st12 & st1
// & st1, :6254) with write-1-to-clear (:1953-1956).

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/next/nextregs"
	"github.com/stever/zxplay_go/pkg/next/uart"
	"github.com/stever/zxplay_go/pkg/z80"
)

func uartIntRig(t *testing.T) (*z80.CPU, *nextregs.Dispatcher, *IM2Block, *uart.UART) {
	t.Helper()
	mem := &slideMem{}
	cpu := z80.New(mem, minimalULA{})
	disp := nextregs.New()
	WireCPUSpeed(disp, cpu)
	WireInterruptControl(disp, cpu)
	ctcBlk := WireCTC(disp, cpu)
	blk := WireIM2(disp, cpu, ctcBlk)
	u := uart.New()
	blk.SetUARTSource(u.RxAvail)
	disp.WriteReg(0xC0, 0x41) // hw-IM2 mode, vector base 010
	cpu.IM = 2
	return cpu, disp, blk, u
}

// chainAsserts polls IntLine a few times — the daisy chain pipelines a
// latched request to the INT line over a couple of ticks, exactly like
// the FPGA's per-clock FSM (real callers poll per instruction).
func chainAsserts(blk *IM2Block) bool {
	for i := 0; i < 8; i++ {
		if blk.IntLine(0) {
			return true
		}
	}
	return false
}

// TestWireUARTRxInterrupt: with NR$C6 bit 0 set, a byte landing in the
// ESP RX FIFO asserts the chain and the acknowledge supplies vector 1.
func TestWireUARTRxInterrupt(t *testing.T) {
	cpu, disp, blk, u := uartIntRig(t)
	disp.WriteReg(0xC6, 0x01) // uart0 rx-avail enable

	if chainAsserts(blk) {
		t.Fatalf("INT asserted with an empty RX FIFO")
	}
	for _, b := range []byte("AT\r") {
		u.PortWrite(uart.RegTx, b) // queues "OK\r\n" into RX
	}
	if !chainAsserts(blk) {
		t.Fatalf("RX-avail level did not assert the chain (vhd:1941/1949)")
	}
	vec, ok := cpu.IntAckFunc()
	if !ok || vec != 0x40|1<<1 {
		t.Errorf("acknowledge vector = $%02X ok=%v, want $%02X (base 010 | vector 1 | 0)", vec, ok, 0x40|1<<1)
	}
	// Sticky status at NR$CA: uart0 rx mirrors into bits 1:0 (:6254).
	if got := disp.ReadReg(0xCA) & 0x03; got != 0x03 {
		t.Errorf("NR$CA uart0-rx status = $%02X, want $03", got)
	}
}

// TestWireUARTTxEmptyInterrupt: TX-empty is a constant-true level (we
// transmit instantly), so enabling NR$C6 bit 2 asserts immediately —
// exactly what an idle real UART does.
func TestWireUARTTxEmptyInterrupt(t *testing.T) {
	cpu, disp, blk, _ := uartIntRig(t)
	if chainAsserts(blk) {
		t.Fatalf("INT asserted with all UART enables off")
	}
	disp.WriteReg(0xC6, 0x04) // uart0 tx-empty enable
	if !chainAsserts(blk) {
		t.Fatalf("TX-empty level did not assert the chain")
	}
	vec, ok := cpu.IntAckFunc()
	if !ok || vec != 0x40|12<<1 {
		t.Errorf("acknowledge vector = $%02X ok=%v, want $%02X (vector 12)", vec, ok, 0x40|12<<1)
	}
	if got := disp.ReadReg(0xCA) & 0x04; got != 0x04 {
		t.Errorf("NR$CA uart0-tx status clear, want set")
	}
}

// TestWireUARTNearFullOnlyBitGatesRxAvail: with NR$C6 bit 1 set (the
// near-full-only enable), plain rx-avail no longer requests — the
// request term is near_full OR (rx_avail AND NOT bit1) (vhd:1943) and
// our FIFO never reports near-full.
func TestWireUARTNearFullOnlyBitGatesRxAvail(t *testing.T) {
	_, disp, blk, u := uartIntRig(t)
	disp.WriteReg(0xC6, 0x02) // near-full-only enable, avail-enable clear
	for _, b := range []byte("AT\r") {
		u.PortWrite(uart.RegTx, b)
	}
	if chainAsserts(blk) {
		t.Errorf("rx-avail asserted despite the near-full-only gate (vhd:1943)")
	}
}
