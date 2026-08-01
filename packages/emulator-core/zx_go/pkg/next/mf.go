package next

import (
	"github.com/conorarmstrong/zx_go/pkg/memory"
	"github.com/conorarmstrong/zx_go/pkg/multiface"
	"github.com/conorarmstrong/zx_go/pkg/next/nextregs"
	"github.com/conorarmstrong/zx_go/pkg/z80"
)

// MFBlock integrates the FPGA-faithful Multiface state machine
// (pkg/multiface.Core — the GHDL-golden-tested port of
// device/multiface.vhd) into the Next's port dispatch: the
// enable/disable port pair selected by the NR$0A mf_type
// (zxnext.vhd:2612-2616, full LOW-BYTE decode — any high byte):
//
//	type 00 (MF +3):  enable $3F, disable $BF
//	type 01 (MF 128): enable $BF, disable $3F
//	type 1x (MF 48):  enable $9F, disable $1F
//
// and the enable-port read-back data (zxnext.vhd:4305-4320: the +3
// personality returns the paging registers selected by a(15:12); the
// 128 personality returns 7FFD bit 3 in bit 7 over ones).
//
// The Core is clocked at EVENT granularity rather than 28 MHz: each
// port access, button/NR$02 NMI, and RETN feeds one strobe edge
// followed by an idle edge (the idle edge settles the port_io_dly
// edge detector exactly as the intervening non-port cycles do on
// hardware). After every event the Core's mf_enabled_o drives the
// memory's Multiface overlay (mem.SetMultifaceActive) — the same
// paging state the NMI path uses.
type MFBlock struct {
	core   *multiface.Core
	disp   *nextregs.Dispatcher
	mem    *memory.Memory
	cpu    *z80.CPU
	border func() byte // port FE border bits for the +3 read-back default arm
}

// NewMFBlock builds the block around a fresh Core (power-on:
// invisible, not paged, no NMI held).
func NewMFBlock(d *nextregs.Dispatcher, mem *memory.Memory, cpu *z80.CPU, border func() byte) *MFBlock {
	b := &MFBlock{core: multiface.NewCore(), disp: d, mem: mem, cpu: cpu, border: border}
	b.core.SetEnable(true) // port_multiface_io_en — the ULA gates the decode
	return b
}

// Core exposes the underlying state machine (tests).
func (b *MFBlock) Core() *multiface.Core { return b.core }

// mfType returns NR$0A bits 7:6 (mf_mode_i).
func (b *MFBlock) mfType() byte { return b.disp.Raw(0x0A) >> 6 & 0x03 }

// portRoles maps a low byte onto the (enable, disable) strobes for the
// current personality (zxnext.vhd:2612-2616).
func (b *MFBlock) portRoles(lb byte) (isEnable, isDisable bool) {
	var en, dis byte
	switch {
	case b.mfType()&0x02 != 0: // MF 48
		en, dis = 0x9F, 0x1F
	case b.mfType()&0x01 != 0: // MF 128
		en, dis = 0xBF, 0x3F
	default: // MF +3
		en, dis = 0x3F, 0xBF
	}
	return lb == en, lb == dis
}

// Claims reports whether the port pair decodes addr (low byte only).
func (b *MFBlock) Claims(addr uint16) bool {
	en, dis := b.portRoles(byte(addr))
	return en || dis
}

// strobe clocks one port event through the Core (strobe edge + idle
// edge for the port_io_dly detector) and pushes the paging output.
func (b *MFBlock) strobe(in multiface.Inputs) {
	in.M1n, in.MReqn = true, true
	b.core.Clock(in)
	b.core.Clock(multiface.Inputs{M1n: true, MReqn: true})
	b.pushPaging()
}

func (b *MFBlock) pushPaging() {
	b.mem.SetMultifaceActive(b.core.MFEnabled())
}

// PortRead handles an IN from the pair: the enable-port read pages the
// MF in when visible (mf_enable <= not invisible_eff) and returns the
// paging shadow data when mf_port_en; the disable-port read pages it
// out (and on the +3 personality releases the NMI hold). Reads always
// claim the bus (port_internal_response); without a data source they
// return the port mux's idle $00.
func (b *MFBlock) PortRead(addr uint16) (byte, bool) {
	en, dis := b.portRoles(byte(addr))
	if !en && !dis {
		return 0, false
	}
	b.core.SetMode(b.mfType())
	// Clock the strobe edge and sample mf_port_en while the strobe is
	// live (the FPGA's combinational term holds through the whole read
	// cycle; the idle edge afterwards settles port_io_dly).
	b.core.Clock(multiface.Inputs{PortEnableRd: en, PortDisableRd: dis, M1n: true, MReqn: true})
	serveData := en && b.core.MFPortEn()
	b.core.Clock(multiface.Inputs{M1n: true, MReqn: true})
	b.pushPaging()
	if !serveData {
		return 0x00, true
	}
	return b.portData(addr), true
}

// PortWrite handles an OUT to the pair: writes release the NMI hold
// and, per personality, set the invisible latch (multiface.vhd:144/:159).
// The data byte is ignored (the FPGA consumes none of it).
func (b *MFBlock) PortWrite(addr uint16, _ byte) bool {
	en, dis := b.portRoles(byte(addr))
	if !en && !dis {
		return false
	}
	b.core.SetMode(b.mfType())
	b.strobe(multiface.Inputs{PortEnableWr: en, PortDisableWr: dis})
	return true
}

// portData composes the enable-port read-back (zxnext.vhd:4305-4320).
func (b *MFBlock) portData(addr uint16) byte {
	p7, p1, _ := b.mem.GetPortState()
	if b.mfType() != 0 {
		// MF 128: 7FFD bit 3 (shadow screen) over ones (:4319).
		return (p7&0x08)<<4 | 0x7F
	}
	switch addr >> 12 & 0x0F {
	case 0x1:
		// "0000" & motor & 1FFD(2:0) — the live 1FFD low nibble.
		return p1 & 0x0F
	case 0x7:
		return p7
	case 0xD:
		// '0' & dffd(6)? & '0' & dffd — our DFFD mirror stores bits 3:0.
		return b.mem.DFFDValue() & 0x5F
	case 0xE:
		bit2, bit3 := b.mem.EFF7Bits()
		var v byte
		if bit3 {
			v |= 0x08
		}
		if bit2 {
			v |= 0x04
		}
		return v
	default:
		if b.border != nil {
			return b.border() & 0x07
		}
		return 0
	}
}

// ButtonNMI feeds the button/software-NMI activation (button_pulse:
// sets nmi_active, clears invisible) plus the $0066 vector fetch that
// pages the MF in (fetch_66 — the memory overlay is already switched
// by the NMI path; this keeps the Core's latch in step).
func (b *MFBlock) ButtonNMI() {
	b.core.SetMode(b.mfType())
	b.core.Clock(multiface.Inputs{Button: true, M1n: true, MReqn: true})
	b.core.Clock(multiface.Inputs{A0066: true, M1n: false, MReqn: false})
	b.core.Clock(multiface.Inputs{M1n: true, MReqn: true})
	b.pushPaging()
}

// Retn feeds the RETN-seen pulse (releases the NMI hold and pages the
// MF out — multiface.vhd:144/:178).
func (b *MFBlock) Retn() {
	b.core.Clock(multiface.Inputs{RetnSeen: true, M1n: true, MReqn: true})
	b.core.Clock(multiface.Inputs{M1n: true, MReqn: true})
	b.pushPaging()
}

// WireMF connects the block: the NR$02 bit-3 MF-NMI arm (chained after
// WireReset's handler — fires the Core's button path whenever the NMI
// actually latched) and returns the block for the ULA/RETN wiring.
func WireMF(d *nextregs.Dispatcher, mem *memory.Memory, cpu *z80.CPU, border func() byte) *MFBlock {
	blk := NewMFBlock(d, mem, cpu, border)
	if prev := d.OnWriteFn(0x02); prev != nil {
		d.SetOnWrite(0x02, func(disp *nextregs.Dispatcher, v byte) {
			wasActive := mem.MultifaceActive()
			prev(disp, v)
			if v&0x08 != 0 && !wasActive && mem.MultifaceActive() {
				// The MF NMI latched (all hardware gates passed) —
				// mirror it into the Core's button/fetch-66 path.
				blk.ButtonNMI()
			}
		})
	}
	return blk
}
