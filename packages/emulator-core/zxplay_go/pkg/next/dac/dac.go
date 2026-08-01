// Package dac implements the Spectrum Next's four 8-bit DACs.
// Each channel is a single byte register whose value is the
// current speaker level; the mixer samples this at the audio
// sample rate and adds it to the AY / beeper / DAC sum.
//
// Port mapping (soundrive-1 / soundrive-2 columns of the ports.txt DAC
// channel table):
//
//	Channel A: 0x1F or 0xF1
//	Channel B: 0x0F or 0xF3
//	Channel C: 0x4F or 0xF9
//	Channel D: 0xFB
//
// Each channel has two alias ports — both are decoded; writing
// to either updates that channel. The DAC ports are decoded on
// the low byte only, matching real hardware.
package dac

// Channel identifies one of the four DACs.
type Channel int

const (
	ChannelA Channel = 0
	ChannelB Channel = 1
	ChannelC Channel = 2
	ChannelD Channel = 3
)

// Bank is the four-channel DAC bank.
type Bank struct {
	levels [4]byte
	// Event-timed reconstruction: each port write records the resulting mixed
	// level with its T-state offset within the frame, so the audio frame can be
	// reconstructed sample-accurately (box-filter) instead of snapshotting one
	// level per audio pull. Carries the last level across frames.
	events     []dacEvent
	startLevel byte

	// portEnabled reports the internal-port-enable gates (NR$82-$85
	// AND NR$86-$89 under expbus, zxnext.vhd:2392-2443) for the seven
	// DAC decode personalities — bit numbering matches
	// internal_port_enable: 17 soundrive-1 $1F/$0F/$4F/$5F, 18
	// soundrive-2 $F1/$F3/$F9/$FB, 19 profi-covox stereo $3F/$5F, 20
	// covox stereo $0F/$4F, 21 pentagon/atm mono $FB, 22 gs-covox
	// mono $B3, 23 specdrum mono $DF. nil = all enabled (power-on).
	portEnabled func(bit uint) bool
	// dacEnabled is the NR$08 bit-3 master DAC gate (dac_hw_en,
	// zxnext.vhd:2461). nil = enabled.
	dacEnabled func() bool
}

// Internal-port-enable bit positions for the DAC personalities.
const (
	enSD1    uint = 17
	enSD2    uint = 18
	enStAD   uint = 19
	enStBC   uint = 20
	enMonoFB uint = 21
	enMonoB3 uint = 22
	enMonoDF uint = 23
)

// SetDecodeGates installs the port-enable and NR$08 DAC-enable sources
// (see the field docs). Passing nils keeps the power-on all-enabled
// decode.
func (b *Bank) SetDecodeGates(portEnabled func(bit uint) bool, dacEnabled func() bool) {
	b.portEnabled = portEnabled
	b.dacEnabled = dacEnabled
}

func (b *Bank) en(bit uint) bool { return b.portEnabled == nil || b.portEnabled(bit) }

type dacEvent struct {
	tstateOffset int
	level        byte
}

// New returns a Bank with all channels at level 0 (silent).
func New() *Bank { return &Bank{} }

// Record appends a timed event capturing the current mixed level at the given
// T-state offset within the frame. The ULA calls this after each DAC port write
// so GenerateFrame can reconstruct the waveform sample-accurately.
func (b *Bank) Record(tstateOffset int) {
	b.events = append(b.events, dacEvent{tstateOffset: tstateOffset, level: b.MixedLevel()})
}

// GenerateFrame reconstructs one frame of mixed-range DAC samples from the
// recorded writes (box-filter integration, like the beeper), then clears the
// events and carries the final level into the next frame. The level→amplitude
// mapping matches MixInto so the timed path is the same loudness as the legacy
// per-pull snapshot, only sample-accurate.
func (b *Bank) GenerateFrame(samplesPerFrame, tstatesPerFrame int) []int16 {
	out := make([]int16, samplesPerFrame)
	level := b.startLevel
	idx := 0
	for i := 0; i < samplesPerFrame; i++ {
		sampleStart := i * tstatesPerFrame / samplesPerFrame
		sampleEnd := (i + 1) * tstatesPerFrame / samplesPerFrame
		sampleLen := sampleEnd - sampleStart
		var acc int64
		cur := sampleStart
		for idx < len(b.events) && b.events[idx].tstateOffset < sampleEnd {
			next := b.events[idx].tstateOffset
			if next < cur {
				next = cur
			}
			acc += int64(level) * int64(next-cur)
			level = b.events[idx].level
			cur = next
			idx++
		}
		acc += int64(level) * int64(sampleEnd-cur)
		avg := level
		if sampleLen > 0 {
			avg = byte(acc / int64(sampleLen))
		}
		out[i] = (int16(avg) - 128) * dacMixAmplitude
	}
	// Any event at or after the frame's final sample boundary didn't land in
	// a [sampleStart, sampleEnd) window above and so never updated level —
	// without this it would be silently discarded below instead of carrying
	// into the next frame.
	if idx < len(b.events) {
		level = b.events[len(b.events)-1].level
	}
	b.startLevel = level
	b.events = b.events[:0]
	return out
}

// Level returns the current 8-bit level for the given channel.
// Channels outside ChannelA..ChannelD return 0.
func (b *Bank) Level(c Channel) byte {
	if c < ChannelA || c > ChannelD {
		return 0
	}
	return b.levels[c]
}

// WritePort accepts a port write and updates the appropriate
// channel's level if the port matches one of the documented DAC
// ports. Returns true if the port was a DAC port (and was
// handled), false otherwise — the caller (ULA's port dispatcher)
// uses this as a fall-through signal.
//
// The decode follows zxnext.vhd's port_dac_A/B/C/D terms (:2658-2664)
// with the power-on internal port enables: the mono ports drive TWO
// channels at once — $DF (SpecDrum) writes A and D, $B3 (GS Covox)
// writes B and C. $FB stays D-only because the soundrive-2 decode has
// precedence over the Pentagon/ATM mono-AD mapping when both port
// enables are on (port_dac_mono_AD_fb_io_en <= enable and NOT sd2).
// Atic Atac's sample engine leans on the mono ports: music is streamed
// stereo through $0F/$4F while the jingle voice (death/reincarnation)
// goes to $DF — dropping $DF silences exactly those jingles (#207).
func (b *Bank) WritePort(port uint16, val byte) bool {
	if b.dacEnabled != nil && !b.dacEnabled() {
		return false
	}
	// Per-alias channel sets are the FPGA's port_dac_A/B/C/D terms
	// (zxnext.vhd:2657-2664), each alias contributing only under its
	// personality's port enable. $FB's mono-AD contribution rides
	// port_dac_mono_AD_fb_io_en = enable(21) AND NOT sd2 (:2440) — the
	// soundrive-2 decode has precedence, which is why $FB is D-only at
	// power-on.
	var chans byte
	switch port & 0xFF {
	case 0x1F:
		if b.en(enSD1) {
			chans = 1 << ChannelA
		}
	case 0xF1:
		if b.en(enSD2) {
			chans = 1 << ChannelA
		}
	case 0x3F:
		if b.en(enStAD) {
			chans = 1 << ChannelA
		}
	case 0x0F:
		if b.en(enSD1) || b.en(enStBC) {
			chans = 1 << ChannelB
		}
	case 0xF3:
		if b.en(enSD2) {
			chans = 1 << ChannelB
		}
	case 0x4F:
		if b.en(enSD1) || b.en(enStBC) {
			chans = 1 << ChannelC
		}
	case 0xF9:
		if b.en(enSD2) {
			chans = 1 << ChannelC
		}
	case 0x5F:
		if b.en(enSD1) || b.en(enStAD) {
			chans = 1 << ChannelD
		}
	case 0xFB:
		if b.en(enSD2) {
			chans = 1 << ChannelD
		} else if b.en(enMonoFB) {
			chans = 1<<ChannelA | 1<<ChannelD
		}
	case 0xDF:
		if b.en(enMonoDF) {
			chans = 1<<ChannelA | 1<<ChannelD
		}
	case 0xB3:
		if b.en(enMonoB3) {
			chans = 1<<ChannelB | 1<<ChannelC
		}
	default:
		return false
	}
	if chans == 0 {
		return false
	}
	for c := ChannelA; c <= ChannelD; c++ {
		if chans&(1<<c) != 0 {
			b.levels[c] = val
		}
	}
	return true
}

// Reset clears all four DAC levels to 0 and the event-timing state.
func (b *Bank) Reset() {
	for i := range b.levels {
		b.levels[i] = 0
	}
	b.events = b.events[:0]
	b.startLevel = 0
}

// MixedLevel returns the mean of the four channel levels as an
// 8-bit unsigned value. The mixer in pkg/ula uses this to fold
// DAC output into the global audio sum. Channels at 0 contribute
// silence; the divide-by-four prevents the sum from saturating
// when all four channels are at max.
func (b *Bank) MixedLevel() byte {
	sum := uint16(b.levels[0]) + uint16(b.levels[1]) + uint16(b.levels[2]) + uint16(b.levels[3])
	return byte(sum / 4)
}

// dacMixAmplitude scales the centred 8-bit DAC value (range -128..127
// after subtracting 128) up to a usable int16 amplitude. 64 puts the
// peak-to-peak DAC range at ±8128 — enough to be clearly audible
// alongside the beeper (peaks at ±20000) and the AY (similar
// magnitude) without saturating their combined sum at int16 limits.
const dacMixAmplitude int16 = 64

// MixInto adds the current DAC output to every sample in buf as a flat per-call
// snapshot. The ULA no longer uses this for the Next DAC — it now drives the
// event-timed GenerateFrame (sample-accurate, like the beeper). MixInto is
// retained for the generic audio.DACSource interface / tests.
//
// The contribution is centred: a DAC value of 0x80 produces zero
// offset; 0x00 and 0xFF produce maximal negative and positive
// contributions. This matches the convention real DACs use when
// driving a speaker (output should sit at 0V mean to avoid
// loudspeaker offset).
func (b *Bank) MixInto(buf []int16) {
	level := int16(b.MixedLevel()) - 128
	contrib := int32(level) * int32(dacMixAmplitude)
	if contrib == 0 {
		return
	}
	for i := range buf {
		// Saturating add: the sum of beeper (±20000) + AY (similar)
		// + DAC (±8128) can exceed int16 range. Without saturation
		// the wrap-around produces audible pops at extrema.
		sum := int32(buf[i]) + contrib
		switch {
		case sum > 32767:
			buf[i] = 32767
		case sum < -32768:
			buf[i] = -32768
		default:
			buf[i] = int16(sum)
		}
	}
}
