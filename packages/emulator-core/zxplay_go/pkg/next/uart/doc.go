// Package uart models the Spectrum Next's ESP32 UART at its real I/O
// ports $133B (Tx/status), $143B (Rx/prescaler), $153B (select) and
// $163B (frame) — decode zxnext.vhd:2639, register select uart.vhd:44 —
// wired into the ULA's Next port dispatch via ULA.SetNextUART. The
// feasible scope is implemented: TX/RX FIFOs and an AT-command
// responder (AT / AT+GMR / AT+CIPSEND / generic OK) so software that
// probes for an ESP and runs its handshake gets sensible replies and
// never hangs. NextReg $A8/$A9 are NOT this UART: they are the ESP
// GPIO registers (pkg/next.WireESPGPIO).
//
// Real ESP Wi-Fi networking — opening TCP/IP sockets to actual servers
// via AT+CIPSTART etc. — is deliberately OUT OF SCOPE: a live network
// stack is beyond a reference emulator and carries obvious safety
// concerns. AT connection commands are accepted (OK) but do not connect.
package uart
