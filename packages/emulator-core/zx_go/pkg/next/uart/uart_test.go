package uart

import (
	"strings"
	"testing"
)

// send pushes a command string byte-by-byte into the TX port.
func send(u *UART, s string) {
	for _, b := range []byte(s) {
		u.PortWrite(RegTx, b)
	}
}

// drain pops the RX FIFO until the status reports empty.
func drain(u *UART) string {
	var buf []byte
	for u.PortRead(RegTx)&StatusRxAvail != 0 {
		buf = append(buf, u.PortRead(RegRx))
	}
	return string(buf)
}

func TestStartEmpty(t *testing.T) {
	u := New()
	if got := u.PortRead(RegTx); got != StatusTxEmpty {
		t.Errorf("status on fresh UART = %#x, want %#x (TX-empty only)", got, StatusTxEmpty)
	}
	if u.PortRead(RegRx) != 0 {
		t.Errorf("RX read on empty UART should return 0 (uart.vhd:352)")
	}
}

func TestATReturnsOK(t *testing.T) {
	u := New()
	send(u, "AT\r")
	if u.PortRead(RegTx)&StatusRxAvail == 0 {
		t.Errorf("status after AT\\r should have RX-avail bit set")
	}
	if got := drain(u); got != "OK\r\n" {
		t.Errorf("response = %q, want OK\\r\\n", got)
	}
	if u.PortRead(RegTx)&StatusRxAvail != 0 {
		t.Errorf("status after reading response should clear RX-avail")
	}
}

func TestNonATCommandsReturnError(t *testing.T) {
	u := New()
	send(u, "HELLO\r")
	if got := drain(u); got != "ERROR\r\n" {
		t.Errorf("got %q, want ERROR\\r\\n", got)
	}
}

func TestATPlusCommandReturnsOK(t *testing.T) {
	u := New()
	send(u, "AT+CWMODE=1\r")
	if got := drain(u); got != "OK\r\n" {
		t.Errorf("AT+CWMODE response = %q, want OK\\r\\n", got)
	}
}

func TestATGMRReturnsIdentity(t *testing.T) {
	u := New()
	send(u, "AT+GMR\r")
	s := drain(u)
	if !strings.Contains(s, "zx_go") || !strings.Contains(s, "OK") {
		t.Errorf("AT+GMR response = %q, want identity + OK", s)
	}
}

func TestATCIPSENDReturnsPrompt(t *testing.T) {
	u := New()
	send(u, "AT+CIPSEND=4\r")
	if got := drain(u); got != ">\r\n" {
		t.Errorf("AT+CIPSEND response = %q, want >\\r\\n", got)
	}
}

func TestATCaseInsensitive(t *testing.T) {
	u := New()
	send(u, "at\r")
	if u.PortRead(RegTx)&StatusRxAvail == 0 {
		t.Errorf("lowercase at\\r should also queue OK")
	}
}

// TestStatusTXAlwaysEmpty documents the stub's instant-transmit
// invariant — TX never reports full.
func TestStatusTXAlwaysEmpty(t *testing.T) {
	u := New()
	for i := 0; i < 100; i++ {
		u.PortWrite(RegTx, byte(i))
	}
	if u.PortRead(RegTx)&StatusTxEmpty == 0 {
		t.Error("after 100 writes: TX-empty cleared (stub transmits instantly)")
	}
}

func TestATGMRUsesSetVersion(t *testing.T) {
	u := New()
	u.SetVersion("my-build-1.0")
	send(u, "AT+GMR\r")
	if s := drain(u); !strings.Contains(s, "my-build-1.0") {
		t.Errorf("AT+GMR response %q doesn't contain custom version", s)
	}
}

func TestBareCRIsNoOp(t *testing.T) {
	u := New()
	u.PortWrite(RegTx, '\r')
	if u.PortRead(RegTx)&StatusRxAvail != 0 {
		t.Error("bare CR queued a response — should be no-op")
	}
}

func TestATPlusGenericPrefix(t *testing.T) {
	u := New()
	send(u, "AT+CWJAP=\"net\",\"pw\"\r")
	if s := drain(u); !strings.Contains(s, "OK") {
		t.Errorf("AT+CWJAP response = %q, want OK", s)
	}
}

func TestMultipleCommandsInSequence(t *testing.T) {
	u := New()
	send(u, "AT\r")
	drain(u)
	send(u, "BAD\r")
	if s := drain(u); !strings.Contains(s, "ERROR") {
		t.Errorf("second command response = %q, want ERROR (TX-buffer state leaked?)", s)
	}
}

// TestSelectRegister pins the $153B semantics (uart.vhd:279-287 write,
// :355/:371 read): bit 6 selects the UART and reads back at bit 6;
// bit 4 gates a prescaler-MSB write whose 3 bits read back at 2:0,
// held per-UART.
func TestSelectRegister(t *testing.T) {
	u := New()
	if got := u.PortRead(RegSelect); got != 0x00 {
		t.Errorf("default $153B read = %#x, want 0 (uart0, MSB 0)", got)
	}
	// Write MSB=5 to uart0 (bit 4 set, bit 6 clear).
	u.PortWrite(RegSelect, 0x15)
	if got := u.PortRead(RegSelect); got != 0x05 {
		t.Errorf("$153B after MSB write = %#x, want $05", got)
	}
	// Select uart1 without bit 4: MSB write gated off.
	u.PortWrite(RegSelect, 0x47)
	if got := u.PortRead(RegSelect); got != 0x40 {
		t.Errorf("$153B on uart1 = %#x, want $40 (uart1 bit + its own zero MSB)", got)
	}
	// Back to uart0: its MSB survived.
	u.PortWrite(RegSelect, 0x00)
	if got := u.PortRead(RegSelect); got != 0x05 {
		t.Errorf("$153B back on uart0 = %#x, want $05 (per-UART MSB)", got)
	}
}

// TestFrameRegister pins the $163B framing register: reset $18
// (uart.vhd:298-299), full-byte store per UART.
func TestFrameRegister(t *testing.T) {
	u := New()
	if got := u.PortRead(RegFrame); got != 0x18 {
		t.Errorf("default $163B read = %#x, want $18", got)
	}
	u.PortWrite(RegFrame, 0xA5)
	if got := u.PortRead(RegFrame); got != 0xA5 {
		t.Errorf("$163B after write = %#x, want $A5", got)
	}
	// uart1's framing register is independent.
	u.PortWrite(RegSelect, 0x40)
	if got := u.PortRead(RegFrame); got != 0x18 {
		t.Errorf("uart1 $163B = %#x, want its own $18 default", got)
	}
}

// TestUART1RxIdle: with the Pi UART selected, TX bytes are dropped
// and RX stays empty — the AT responder serves the ESP only.
func TestUART1RxIdle(t *testing.T) {
	u := New()
	u.PortWrite(RegSelect, 0x40)
	send(u, "AT\r")
	if got := u.PortRead(RegTx); got != StatusTxEmpty {
		t.Errorf("uart1 status after AT = %#x, want %#x (no RX)", got, StatusTxEmpty)
	}
	// The ESP side must not have seen the bytes either.
	u.PortWrite(RegSelect, 0x00)
	if u.PortRead(RegTx)&StatusRxAvail != 0 {
		t.Error("uart0 RX has bytes after uart1-directed AT — select leaked")
	}
}
