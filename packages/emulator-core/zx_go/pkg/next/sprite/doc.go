// Package sprite implements the Spectrum Next's hardware-sprite engine:
// 128 sprite slots, 16x16 patterns in 4bpp or 8bpp, mirror/rotate/scale
// 1-8x, anchor groups (composite + unified), the NR$34/port-$303B dual
// sprite indexes with the NR$09 lockstep tie, collision detection and
// the per-line render budget (both status bits in port 0x303B).
package sprite
