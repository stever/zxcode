package main

import "github.com/stever/zxplay_go/pkg/roms"

// Host joystick input arrives as a whole state vector rather than as
// press/release events, because that is the shape every host API
// actually offers: the browser Gamepad API and GLFW are both poll-only
// (navigator.getGamepads() / glfw.GetJoystickButtons return a snapshot,
// never a stream). Diffing the snapshot here — instead of asking each
// frontend to synthesise edges — also removes the stuck-direction
// failure mode: a lost release event cannot leave a bit held, because
// the next poll's vector simply doesn't have it set.
//
// The vector is the FPGA's 12-bit i_JOY layout (zxnext.vhd:90), active
// high, bits 11..0 = MODE X Z Y START A C B U D L R. That keeps one bit
// order across the whole path — host mapping, wasm boundary, ULA state,
// NR $B2 read-back — so there is no per-layer re-shuffling to get wrong.

// joyVecDirection maps the five low i_JOY bits to the direction indices
// dispatchJoystick speaks (0=up, 1=down, 2=left, 3=right, 4=fire).
var joyVecDirection = [5]struct {
	bit uint16
	dir int
}{
	{0x001, 3}, // R
	{0x002, 2}, // L
	{0x004, 1}, // D
	{0x008, 0}, // U
	{0x010, 4}, // B -> fire
}

// SetJoystickState applies a host joystick snapshot as the current
// state of the (single, left) modelled pad.
//
// Directions and fire go through dispatchJoystick, so they honour the
// selected interface — Kempston sets port bits, Sinclair/Cursor inject
// the matching keyboard-matrix keys. The Megadrive-only buttons go
// straight to the ULA regardless of that selection, mirroring the
// hardware: NR $B2 taps the pad's own lines, and NR$05 routing decides
// only which port the directions appear on, not whether the pad exists.
//
// Only changed bits are dispatched, so holding a direction does not
// re-inject a keypress every frame on the Sinclair/Cursor schemes.
func (e *emulator) SetJoystickState(vec uint16) {
	vec &= 0x0FFF
	changed := vec ^ e.joyState
	e.joyState = vec
	// Accumulate for diagnostics. The live state is useless for
	// answering "did the pad ever reach the machine?", because nobody
	// can hold a direction and inspect the emulator at the same moment —
	// by the time you look, everything has been released.
	e.joyBitsSeen |= vec
	if vec != 0 {
		e.joyNonZeroCount++
	}
	if changed == 0 {
		return
	}
	for _, m := range joyVecDirection {
		if changed&m.bit != 0 {
			e.dispatchJoystick(m.dir, vec&m.bit != 0)
		}
	}
	if e.ula != nil {
		e.ula.SetMDExtraButtons(vec)
	}
}

// setJoystickType switches the active joystick interface, releasing
// whatever the old one was holding first. Without the release a
// direction held across the switch stays latched forever: the release
// would be dispatched to the NEW interface, which never set it.
//
// The release is unconditional rather than a SetJoystickState(0) diff,
// because not every input path goes through the vector — the desktop's
// arrow-key interception calls dispatchJoystick directly, so joyState
// can read idle while a direction is genuinely held.
func (e *emulator) setJoystickType(t JoystickType) {
	for dir := 0; dir < 5; dir++ {
		e.dispatchJoystick(dir, false)
	}
	e.joyState = 0
	e.joystickType = t
	// KempstonEnabled is deliberately NOT touched here. The interface is
	// fitted at construction and stays fitted for the machine's life:
	// un-fitting it mid-run would change what port $1F reads underneath a
	// game that has already probed it, and on real hardware choosing to
	// play with Sinclair keys does not unplug the Kempston card.
	e.applyNextJoystickMode()
}

// nextJoyModeFor maps a frontend joystick selection to the NR$05
// 3-bit mode the Next routes the LEFT pad by (nextreg.txt NR$05).
// Kempston maps to MD 1 rather than plain Kempston 1: port bits 5:0
// are identical in both modes and MD 1 additionally exposes START/A
// in bits 7:6 plus NR$B2 — the superset the boot seed ships, so
// re-selecting Kempston never narrows what a pad-aware game can see.
// None means "leave the machine's own configuration alone".
func nextJoyModeFor(t JoystickType) (byte, bool) {
	switch t {
	case JoystickKempston:
		return 0b101, true
	case JoystickSinclair1:
		return 0b011, true
	case JoystickSinclair2:
		return 0b000, true
	case JoystickCursor:
		return 0b010, true
	}
	return 0, false
}

// applyNextJoystickMode expresses the frontend joystick selection as
// the machine's own NR$05 joystick-1 mode when running a Next — the
// emulator equivalent of setting the joystick type in the NextZXOS
// config. The FPGA model then does all routing itself: ports $1F/$37
// (pkg/ula nextJoyPortByte) and the membrane keyrow injection
// (joymembrane.go). Read-modify-write on the read-back layout
// ([7:6]=joy0[1:0], [3]=joy0[2] — WireJoystickMode) so the 50/60 Hz
// and scandoubler bits, and joystick 2's routing, are untouched.
// Boots rebuild the machine and reseed NR$05, so frontends re-apply
// the selection after every boot (GoEmulator.applyJoystickType).
func (e *emulator) applyNextJoystickMode() {
	if e.nextRegs == nil || e.mem == nil || e.mem.GetCurrentModel() != roms.ModelNext {
		return
	}
	mode, ok := nextJoyModeFor(e.joystickType)
	if !ok {
		return
	}
	v := e.nextRegs.ReadReg(0x05)
	v = v&^0xC8 | (mode&0x03)<<6 | (mode>>2)<<3
	e.nextRegs.WriteReg(0x05, v)
}

// joystickTypeFromName parses the frontend-facing joystick names. The
// spellings match pkg/config's persisted strings so the desktop config
// file and the browser's setting speak one vocabulary.
func joystickTypeFromName(name string) (JoystickType, bool) {
	switch name {
	case "None", "none", "":
		return JoystickNone, true
	case "Kempston", "kempston":
		return JoystickKempston, true
	case "Sinclair1", "sinclair1":
		return JoystickSinclair1, true
	case "Sinclair2", "sinclair2":
		return JoystickSinclair2, true
	case "Cursor", "cursor":
		return JoystickCursor, true
	}
	return JoystickNone, false
}

// clearJoystickState drops every held joystick bit, host-side cache
// included, so a later poll of the same vector re-dispatches it. Called
// from releaseAllInput on focus loss and reboot.
func (e *emulator) clearJoystickState() {
	e.joyState = 0
	if e.ula != nil {
		e.ula.KempstonState = 0
		e.ula.SetMDExtraButtons(0)
	}
}
