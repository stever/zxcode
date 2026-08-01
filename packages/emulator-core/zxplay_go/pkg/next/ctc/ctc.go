// Package ctc implements the Z80 CTC (counter/timer circuit) channel as found
// on the ZX Spectrum Next, modelled cycle-accurately on the FPGA core's
// device/ctc_chan.vhd. The Next instantiates four such channels behind a port
// select/route/read-mux (device/ctc.vhd); all of the per-channel behaviour
// (control-word decode, the 16/256 prescaler, timer vs counter mode, the
// down-counter with time-constant reload, and the zero-count ZC/TO pulse) lives
// in the channel, which is what this package reproduces.
//
// Reference: Zilog Z80 CTC (ps0181). The IM2 vector/interrupt itself is not
// handled here — exactly as in the FPGA core, the channel exposes the ZC/TO
// pulse and the interrupt-enable bit so the instantiating module wires IM2.
//
// Every behaviour and its timing is captured by the FPGA golden replay in
// fpga_golden_test.go (tooling: _tools/ctc-vhdl-test/).
package ctc

// state mirrors ctc_chan.vhd's state_t (ctc_chan.vhd:98). The channel only
// actually counts in S_RUN / S_RUN_TC; in every other state reset_soft holds
// the prescaler and the down-counter at their reload values.
type state int

const (
	sReset   state = iota // S_RESET    — hard-reset / awaiting a control word (D2=1)
	sResetTC              // S_RESET_TC — control word seen, awaiting the time constant
	sTrigger              // S_TRIGGER  — loaded; (timer) awaiting auto/ext-trigger start
	sRun                  // S_RUN      — counting
	sRunTC                // S_RUN_TC   — running, control word re-written, awaiting new TC
)

// Channel is one Z80 CTC counter/timer channel. The zero value is NOT ready —
// construct with New (which applies the hard reset, as i_reset does in HW).
type Channel struct {
	// registers (ctc_chan.vhd)
	state      state
	controlReg uint8 // 5 bits: control_reg = i_cpu_d(7 downto 3) (ctc_chan.vhd:269)
	timeConst  uint8 // time_constant_reg (ctc_chan.vhd:284)
	pCount     uint8 // prescaler p_count (ctc_chan.vhd:138)
	tCount     uint8 // down-counter t_count (ctc_chan.vhd:163)
	zcToD      bool  // registered ZC/TO output o_zc_to (ctc_chan.vhd:178/183)
	clkTrgD    bool  // previous synchronized trigger level clk_trg_d (ctc_chan.vhd:124)
	iowrD      bool  // previous i_iowr for edge detect (ctc_chan.vhd:251)

	// live (combinational) inputs sampled at the next Tick
	clkTrg bool // i_clk_trg current level
}

// New returns a hard-reset channel (equivalent to holding i_reset).
func New() *Channel {
	c := &Channel{}
	c.HardReset()
	return c
}

// HardReset applies i_reset = '1' for a cycle: every reset_hard-guarded register
// returns to its power-on value (ctc_chan.vhd:175,190,266,281).
func (c *Channel) HardReset() {
	c.state = sReset
	c.controlReg = 0
	c.timeConst = 0
	c.zcToD = false
	c.clkTrgD = false
	c.iowrD = false
	c.clkTrg = false
	// p_count / t_count have no hard-reset; reset_soft holds them while not running.
	c.pCount = 0
	c.tCount = 0
}

// control-word bit accessors (control_reg holds i_cpu_d bits 7..3).
//
//	controlReg bit4 = D7 interrupt enable      (control_reg(7-3))
//	controlReg bit3 = D6 mode 0=timer 1=counter(control_reg(6-3))
//	controlReg bit2 = D5 prescaler 0=16 1=256  (control_reg(5-3))
//	controlReg bit1 = D4 edge 0=falling 1=rising(control_reg(4-3))
//	controlReg bit0 = D3 timer trigger 0=auto 1=wait(control_reg(3-3))
func (c *Channel) cwCounter() bool   { return c.controlReg&0x08 != 0 }
func (c *Channel) cwPre256() bool    { return c.controlReg&0x04 != 0 }
func (c *Channel) cwRisingTrg() bool { return c.controlReg&0x02 != 0 }
func (c *Channel) cwWaitTrg() bool   { return c.controlReg&0x01 != 0 }

// SetTrigger sets the external clock/trigger input level (i_clk_trg). In HW this
// must be synchronized to i_CLK; it is sampled on the next Tick.
func (c *Channel) SetTrigger(level bool) { c.clkTrg = level }

// Count returns the live down-counter (o_cpu_d, ctc_chan.vhd:168).
func (c *Channel) Count() uint8 { return c.tCount }

// ZCTO returns the registered zero-count/timeout output (o_zc_to), asserted for
// one i_CLK cycle when the counter reaches zero (ctc_chan.vhd:183).
func (c *Channel) ZCTO() bool { return c.zcToD }

// IntEnabled returns the interrupt-enable bit (o_int_en, ctc_chan.vhd:276).
func (c *Channel) IntEnabled() bool { return c.controlReg&0x10 != 0 }

// resetSoft mirrors ctc_chan.vhd:117 — asserted whenever not in a RUN state.
func (c *Channel) resetSoft() bool { return c.state != sRun && c.state != sRunTC }

// Write performs a single CPU write of a byte to this channel port. It edge-
// detects internally exactly as the FPGA does (i_iowr held one cycle), so a
// call to Write models one full i_iowr pulse: it advances the channel by the
// cycle on which iowr is asserted. The FPGA distinguishes a control word
// (D0=1), a time constant (in S_RESET_TC/S_RUN_TC), and an interrupt vector
// (D0=0); only the control-word / time-constant effects are state-bearing here.
//
// To keep the cycle bookkeeping identical to the golden (which pulses i_iowr for
// one clock then releases it), Write performs the asserted-iowr cycle followed
// by one released cycle, matching the testbench's cpu_write.
func (c *Channel) Write(b uint8) {
	c.tick(true, b, false, false)  // i_iowr = 1 for one cycle
	c.tick(false, b, false, false) // released cycle (lets iowr_d clear)
}

// WriteIntEnable performs the separate interrupt-enable write (the FPGA's
// nr_c5 path, i_int_en_wr). It must not overlap a port write. It updates only
// control_reg bit (7-3) (ctc_chan.vhd:270-271).
func (c *Channel) WriteIntEnable(enable bool) {
	c.tick(false, 0, true, enable)
	c.tick(false, 0, false, false)
}

// Tick advances the channel by exactly one i_CLK rising edge with i_iowr = 0.
func (c *Channel) Tick() { c.tick(false, 0, false, false) }

// runningTimer reports whether the channel is actively counting in
// TIMER mode (prescaler-driven) — the state AdvanceIdle can
// fast-forward analytically.
func (c *Channel) runningTimer() bool {
	return (c.state == sRun || c.state == sRunTC) && !c.cwCounter()
}

// prescale returns the timer prescaler period in i_CLK ticks (16/256).
func (c *Channel) prescale() uint64 {
	if c.cwPre256() {
		return 256
	}
	return 16
}

// tcPeriod returns the down-counter reload in prescaler fires (TC=0
// counts as 256, the 8-bit wrap).
func (c *Channel) tcPeriod() uint64 {
	if c.timeConst == 0 {
		return 256
	}
	return uint64(c.timeConst)
}

// steadyIdle reports whether further idle ticks (no write, no trigger
// change) leave the channel's STATE unchanged: every state except a
// transitioning S_TRIGGER. A pending trigger edge (clkTrg != clkTrgD)
// also disqualifies, since the next tick consumes it.
func (c *Channel) steadyIdle() bool {
	if c.clkTrg != c.clkTrgD {
		return false
	}
	if c.state != sTrigger {
		return true
	}
	// S_TRIGGER holds only for a timer waiting on its trigger
	// (ctc_chan.vhd:223); auto-start timers and counters move to
	// S_RUN on the next tick.
	return !c.cwCounter() && c.cwWaitTrg()
}

// AdvanceIdle advances the channel by n idle i_CLK edges (no CPU
// write, no trigger change) and returns how many ZC/TO pulses fired
// in that window. Semantically identical to calling Tick() n times;
// the steady states are computed in O(1) so a per-instruction caller
// stays cheap. States held by reset_soft (S_RESET / S_RESET_TC /
// S_TRIGGER waiting on a trigger) don't count (ctc_chan.vhd:117,
// 132-141,155-166); a COUNTER-mode RUN channel advances only its
// free-running prescaler register on idle ticks.
func (c *Channel) AdvanceIdle(n uint64) (zcs uint64) {
	// Walk any state transitions idle ticks perform (S_TRIGGER →
	// S_RUN, pending trigger edges) one tick at a time; these are
	// bounded and cannot themselves ZC... except a counter-mode
	// trigger edge decrementing tCount to zero — count via ZCTO.
	for n > 0 && !c.steadyIdle() {
		c.Tick()
		if c.zcToD {
			zcs++
		}
		n--
	}
	if n == 0 {
		return zcs
	}
	if !c.runningTimer() {
		if c.resetSoft() {
			// Held at reload: idle ticks are no-ops beyond the edge-
			// detect registers.
			c.zcToD = false
			c.clkTrgD = c.clkTrg
			c.iowrD = false
			return zcs
		}
		// COUNTER-mode RUN: no idle counting, but the prescaler
		// register free-runs (ctc_chan.vhd:132-141 — reset_soft is
		// the only hold).
		c.pCount += uint8(n)
		c.zcToD = false
		c.clkTrgD = c.clkTrg
		c.iowrD = false
		return zcs
	}
	presc := c.prescale()
	// The k-th tick (k=1..n) fires the prescaler when its PRE-increment
	// pCount ≡ presc-1 (mod presc) (ctc_chan.vhd:143-150). With current
	// pre-state r0, the first fire is at k1 = presc - r0 (mod presc,
	// where r0 = pCount mod presc), then every presc ticks.
	r0 := uint64(c.pCount) % presc
	k1 := presc - r0
	var fires uint64
	if n >= k1 {
		fires = 1 + (n-k1)/presc
	}
	// ZC when a fire decrements tCount from 1 (reload thereafter,
	// ctc_chan.vhd:152-166). tCount==0 behaves as 256 (byte wrap).
	t0 := uint64(c.tCount)
	if t0 == 0 {
		t0 = 256
	}
	period := c.tcPeriod()
	var lastTickWasZC bool
	if fires >= t0 {
		zcs += 1 + (fires-t0)/period
		// tCount after the last ZC: how many fires since it, counted
		// down from the reload value.
		sinceZC := (fires - t0) % period
		c.tCount = uint8(period - sinceZC) // period==256 wraps to 0 == 256 ✓
		// Was the very last tick (k=n) a ZC fire?
		lastFireK := k1 + (fires-1)*presc
		lastTickWasZC = lastFireK == n && sinceZC == 0
	} else {
		c.tCount = uint8(t0 - fires)
	}
	c.pCount += uint8(n % 256) // +1 per tick, byte wrap (presc divides 256)
	c.zcToD = lastTickWasZC
	c.clkTrgD = c.clkTrg
	c.iowrD = false
	return zcs
}

// TriggerSensitive reports whether pulses on the CLK/TRG input can
// change this channel's observable state: a COUNTER-mode channel
// counts them, and a channel parked in S_TRIGGER starts on one. A
// running TIMER ignores its trigger, so feeding pulses to it is a
// wasted no-op the caller can skip.
func (c *Channel) TriggerSensitive() bool {
	return c.cwCounter() || c.state == sTrigger
}

// PulseTrigger models ONE pulse arriving on the CLK/TRG input — the
// Next's channel-to-channel ZC/TO cascade (zxnext.vhd:4082: ch N's
// i_clk_trg is ch (N-1) mod 4's zc_to, a one-i_CLK-wide pulse). The
// level rises for one tick and falls on the next, so both trigger
// polarities see their edge. Returns the ZC/TO pulses THIS channel
// fired during the two ticks (a counter at 1 reloads and pulses).
// The two ticks advance the channel's own clock by 2 — at the block's
// lazy-advance granularity that drift is negligible and only occurs
// while a cascade is actively fed.
func (c *Channel) PulseTrigger() (zcs uint64) {
	c.SetTrigger(true)
	c.Tick()
	if c.zcToD {
		zcs++
	}
	c.SetTrigger(false)
	c.Tick()
	if c.zcToD {
		zcs++
	}
	return zcs
}

// TicksToNextZC returns how many idle i_CLK edges from now the next
// ZC/TO pulse fires, and whether one is scheduled at all (running
// TIMER mode only — counter-mode and idle channels return false).
func (c *Channel) TicksToNextZC() (uint64, bool) {
	if !c.runningTimer() {
		if c.state == sTrigger && !c.cwCounter() && !c.cwWaitTrg() {
			// Auto-start timer: one tick to enter RUN, then a full
			// first period from the reload values.
			return 1 + c.prescale()*c.tcPeriod(), true
		}
		return 0, false
	}
	presc := c.prescale()
	r0 := uint64(c.pCount) % presc
	k1 := presc - r0
	t0 := uint64(c.tCount)
	if t0 == 0 {
		t0 = 256
	}
	return k1 + (t0-1)*presc, true
}

// tick computes every combinational signal from the CURRENT (pre-edge) state —
// just as the VHDL processes read the registers' current values — then applies
// all the clocked register updates atomically, modelling one rising_edge(i_CLK).
func (c *Channel) tick(iowr bool, cpuD uint8, intEnWr, intEn bool) {
	// --- combinational decode (reads current registers) ---

	// iowr edge detect (ctc_chan.vhd:255): iowr = i_iowr and not iowr_d.
	iowrPulse := iowr && !c.iowrD

	// write classification (ctc_chan.vhd:257-259).
	inTCWait := c.state == sResetTC || c.state == sRunTC
	iowrTC := iowrPulse && inTCWait
	iowrCW := iowrPulse && !inTCWait && (cpuD&0x01 != 0)

	// clk_edge_change (ctc_chan.vhd:289): a CW that changes the edge bit counts
	// as a clock edge. control_reg(4-3) is bit1 of controlReg = old edge.
	oldEdge := c.controlReg&0x02 != 0
	newEdge := cpuD&0x10 != 0 // i_cpu_d(4)
	clkEdgeChange := iowrCW && (newEdge != oldEdge)

	// clk_trg_edge (ctc_chan.vhd:128): falling- or rising-edge of the trigger,
	// OR a clk_edge_change. Uses the CURRENT edge-select bit (control_reg(4-3)).
	var trgEdge bool
	if !c.cwRisingTrg() { // falling edge selected
		trgEdge = (c.clkTrgD && !c.clkTrg) || clkEdgeChange
	} else { // rising edge selected
		trgEdge = (c.clkTrg && !c.clkTrgD) || clkEdgeChange
	}

	// prescaler clock (ctc_chan.vhd:143-146).
	pCountLo := c.pCount&0x0F == 0x0F
	pCountHi := c.pCount&0xF0 == 0xF0
	var prescalerClk bool
	if !c.cwPre256() {
		prescalerClk = pCountLo
	} else {
		prescalerClk = pCountLo && pCountHi
	}

	// counter enable (ctc_chan.vhd:150): timer uses the prescaler, counter uses
	// the external trigger edge.
	var tCountEn bool
	if !c.cwCounter() {
		tCountEn = prescalerClk
	} else {
		tCountEn = trgEdge
	}

	// t_count_next / zero (ctc_chan.vhd:152-153).
	tCountNext := c.tCount - 1
	tCountNextZero := tCountNext == 0

	// zc_to (ctc_chan.vhd:170): next would be zero, counting, in a RUN state.
	inRun := c.state == sRun || c.state == sRunTC
	zcTo := tCountNextZero && tCountEn && inRun

	resetSoft := c.resetSoft()

	// next state (ctc_chan.vhd:198-244).
	stateNext := c.nextState(iowrCW, iowrPulse, cpuD, trgEdge)

	// --- register updates (all atomic on the edge) ---

	// clk_trg_d <= i_clk_trg (ctc_chan.vhd:121-126).
	newClkTrgD := c.clkTrg

	// prescaler (ctc_chan.vhd:132-141).
	var newPCount uint8
	if resetSoft {
		newPCount = 0
	} else {
		newPCount = c.pCount + 1
	}

	// down-counter (ctc_chan.vhd:155-166).
	newTCount := c.tCount
	switch {
	case resetSoft:
		newTCount = c.timeConst
	case zcTo:
		newTCount = c.timeConst
	case tCountEn:
		newTCount = tCountNext
	}

	// zc_to_d (ctc_chan.vhd:172-181) — hard reset clears it; we have no hard
	// reset inside tick (HardReset handles that), so it just registers zcTo.
	newZCToD := zcTo

	// control_reg (ctc_chan.vhd:263-274).
	newControl := c.controlReg
	switch {
	case iowrCW:
		newControl = (cpuD >> 3) & 0x1F
	case intEnWr:
		if intEn {
			newControl |= 0x10
		} else {
			newControl &^= 0x10
		}
	}

	// time_constant_reg (ctc_chan.vhd:278-287).
	newTimeConst := c.timeConst
	if iowrTC {
		newTimeConst = cpuD
	}

	// iowr_d <= i_iowr (ctc_chan.vhd:248-253).
	newIowrD := iowr

	// commit
	c.clkTrgD = newClkTrgD
	c.pCount = newPCount
	c.tCount = newTCount
	c.zcToD = newZCToD
	c.controlReg = newControl
	c.timeConst = newTimeConst
	c.iowrD = newIowrD
	c.state = stateNext
}

// nextState reproduces the state-machine process (ctc_chan.vhd:198-244).
func (c *Channel) nextState(iowrCW, iowr bool, cpuD uint8, trgEdge bool) state {
	d1 := cpuD&0x02 != 0 // i_cpu_d(1) soft reset
	d2 := cpuD&0x04 != 0 // i_cpu_d(2) time constant follows

	// A control word with D1=1 (soft reset) takes priority (ctc_chan.vhd:200-205).
	if iowrCW && d1 {
		if !d2 {
			return sReset
		}
		return sResetTC
	}

	switch c.state {
	case sReset:
		if iowrCW && d2 {
			return sResetTC
		}
		return sReset
	case sResetTC:
		if iowr {
			return sTrigger
		}
		return sResetTC
	case sTrigger:
		switch {
		case iowrCW && d2:
			return sResetTC
		case !c.cwCounter() && c.cwWaitTrg() && !trgEdge:
			// timer mode, waiting for a trigger, no edge yet (ctc_chan.vhd:223).
			return sTrigger
		default:
			return sRun
		}
	case sRun:
		if iowrCW && d2 {
			return sRunTC
		}
		return sRun
	case sRunTC:
		if iowr {
			return sRun
		}
		return sRunTC
	default:
		return sReset
	}
}
