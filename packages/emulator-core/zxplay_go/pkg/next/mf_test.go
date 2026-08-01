package next

import (
	"testing"

	"github.com/stever/zxplay_go/pkg/next/nextregs"
)

// Port-role mapping per NR$0A mf_type (zxnext.vhd:2612-2616) and the
// MF128 read-back shape (:4319). The state machine itself is pinned by
// pkg/multiface's GHDL golden replay; here the block's personality
// decode and data composition are under test.
func TestMFPortRolesPerPersonality(t *testing.T) {
	d := nextregs.New()
	b := NewMFBlock(d, nil, nil, nil)

	cases := []struct {
		nr0a    byte
		enable  byte
		disable byte
		name    string
	}{
		{0x00, 0x3F, 0xBF, "MF+3 (type 00)"},
		{0x40, 0xBF, 0x3F, "MF128 (type 01)"},
		{0x80, 0x9F, 0x1F, "MF48 (type 10)"},
		{0xC0, 0x9F, 0x1F, "MF48 (type 11)"},
	}
	for _, c := range cases {
		d.Store(0x0A, c.nr0a)
		en, dis := b.portRoles(c.enable)
		if !en || dis {
			t.Errorf("%s: $%02X roles = (en=%v dis=%v), want enable", c.name, c.enable, en, dis)
		}
		en, dis = b.portRoles(c.disable)
		if en || !dis {
			t.Errorf("%s: $%02X roles = (en=%v dis=%v), want disable", c.name, c.disable, en, dis)
		}
		if b.Claims(uint16(0x1200)|uint16(c.enable)&0xFF) != true {
			t.Errorf("%s: enable port not claimed on an arbitrary high byte", c.name)
		}
		// A low byte belonging to NEITHER role is unclaimed.
		if b.Claims(0x12AB) {
			t.Errorf("%s: $AB claimed", c.name)
		}
	}
}
