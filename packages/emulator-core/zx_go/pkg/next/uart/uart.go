// The AT-responder ESP UART stub, served at the real UART ports
// $133B/$143B/$153B/$163B (decode zxnext.vhd:2639; register select =
// address bits 9:8 per uart.vhd:44 — "00" Rx, "01" select, "10" frame,
// "11" Tx/status). See doc.go for the package story.
//
// UART 1 (the Pi accelerator, $153B bit 6) accepts traffic and reads
// an empty RX — there is no Pi.
package uart

import "strings"

// Port-select values, matching uart.vhd:44's i_uart_reg encoding
// (address bits 9:8 of the four UART ports).
const (
	RegRx     = 0 // $143B: read = RX FIFO pop, write = prescaler
	RegSelect = 1 // $153B: bit 6 = UART select, bit-4-gated prescaler MSB
	RegFrame  = 2 // $163B: framing configuration (reset $18 = 8N1)
	RegTx     = 3 // $133B: write = TX byte, read = status
)

// $133B status-read bits (ports.txt:392-401 / uart.vhd:359-360).
const (
	StatusTxEmpty = 0x10 // 1 = TX buffer empty (always: we transmit instantly)
	StatusRxAvail = 0x01 // 1 = RX buffer contains bytes
)

// UART models the ESP UART surface plus the readable latches of the
// second (Pi) UART the same ports multiplex.
type UART struct {
	rxBuf   []byte // bytes the guest will see on subsequent reads
	txBuf   []byte // accumulated outgoing line; flushed on \r
	version string // AT+GMR identity payload

	sel1         bool    // $153B bit 6: 0 = ESP (uart0), 1 = Pi (uart1)
	prescalerMSB [2]byte // 3-bit MSB regs ($153B bit-4-gated write, uart.vhd:283)
	framing      [2]byte // $163B framing regs (reset $18, uart.vhd:298-299)
}

// DefaultVersion is what AT+GMR returns when SetVersion has not
// been called. Callers (e.g. the emulator binary) override this
// with their build identity.
const DefaultVersion = "zx_go-uart"

// New returns an empty UART. Initial state: TX empty, RX empty,
// UART 0 (ESP) selected, framing $18 (8N1), AT+GMR returns
// DefaultVersion.
func New() *UART {
	return &UART{version: DefaultVersion, framing: [2]byte{0x18, 0x18}}
}

// SetVersion replaces the AT+GMR identity string. Useful for
// keeping the stub's reported version in sync with the host
// build without hard-coding it in this package.
func (u *UART) SetVersion(v string) { u.version = v }

// RxAvail reports whether the ESP (uart0) RX FIFO holds bytes — the
// FPGA's uart0_rx_avail level, an interrupt source into the im2 daisy
// chain (vector 1, zxnext.vhd:1941-1944).
func (u *UART) RxAvail() bool { return len(u.rxBuf) > 0 }

// PortRead serves a CPU read of one of the four UART ports. reg is
// the RegRx/RegSelect/RegFrame/RegTx constant (address bits 9:8).
func (u *UART) PortRead(reg byte) byte {
	sel := u.selIdx()
	switch reg & 0x03 {
	case RegRx:
		// uart.vhd:348-353: RX pop, $00 when empty. The Pi UART's
		// RX is always empty (no Pi).
		if sel == 1 || len(u.rxBuf) == 0 {
			return 0
		}
		b := u.rxBuf[0]
		u.rxBuf = u.rxBuf[1:]
		return b
	case RegSelect:
		// uart.vhd:355/371: select bit at 6, prescaler MSB at 2:0.
		v := u.prescalerMSB[sel] & 0x07
		if sel == 1 {
			v |= 0x40
		}
		return v
	case RegFrame:
		return u.framing[sel]
	default: // RegTx = status read
		v := byte(StatusTxEmpty) // we transmit instantly; TX never fills
		if sel == 0 && len(u.rxBuf) > 0 {
			v |= StatusRxAvail
		}
		return v
	}
}

// PortWrite serves a CPU write to one of the four UART ports.
func (u *UART) PortWrite(reg, val byte) {
	sel := u.selIdx()
	switch reg & 0x03 {
	case RegRx:
		// $143B write = 14-bit prescaler halves by bit 7
		// (ports.txt:408-413). Baud timing is not modelled; the
		// write is accepted and dropped.
	case RegSelect:
		// uart.vhd:279-287: bit 6 selects the UART; bit 4 gates a
		// write of prescaler MSB bits 2:0 to the SELECTED uart.
		u.sel1 = val&0x40 != 0
		if val&0x10 != 0 {
			u.prescalerMSB[u.selIdx()] = val & 0x07
		}
	case RegFrame:
		u.framing[sel] = val
	default: // RegTx
		if sel == 0 {
			u.writeTx(val)
		}
		// UART 1 TX bytes go to the (absent) Pi: dropped.
	}
}

func (u *UART) selIdx() int {
	if u.sel1 {
		return 1
	}
	return 0
}

// writeTx appends a byte to the ESP's outgoing TX buffer. When a CR
// (0x0D) lands the accumulated line is parsed and a canned
// response is queued into the RX FIFO:
//
//   - "AT"             -> "OK\r\n"   (probe / liveness)
//   - any "AT+..."     -> "OK\r\n"   (config commands accepted
//     silently — no real Wi-Fi state is modelled)
//   - "AT+GMR"         -> identity + "OK\r\n"
//   - "AT+CIPSEND"     -> ">\r\n"    (prompt for the bytes payload)
//   - anything else    -> "ERROR\r\n"
//
// This is enough for software that probes whether an ESP UART is
// present to get past its handshake. Real Wi-Fi is out of scope.
func (u *UART) writeTx(b byte) {
	if b == '\r' {
		cmd := strings.TrimSpace(strings.ToUpper(string(u.txBuf)))
		u.txBuf = u.txBuf[:0]
		u.respondTo(cmd)
		return
	}
	u.txBuf = append(u.txBuf, b)
}

func (u *UART) respondTo(cmd string) {
	switch {
	case cmd == "":
		// Bare CR is no-op.
	case cmd == "AT":
		u.rxBuf = append(u.rxBuf, []byte("OK\r\n")...)
	case cmd == "AT+GMR":
		u.rxBuf = append(u.rxBuf, []byte(u.version+"\r\nOK\r\n")...)
	case strings.HasPrefix(cmd, "AT+CIPSEND"):
		u.rxBuf = append(u.rxBuf, []byte(">\r\n")...)
	case strings.HasPrefix(cmd, "AT+") || strings.HasPrefix(cmd, "AT"):
		u.rxBuf = append(u.rxBuf, []byte("OK\r\n")...)
	default:
		u.rxBuf = append(u.rxBuf, []byte("ERROR\r\n")...)
	}
}
