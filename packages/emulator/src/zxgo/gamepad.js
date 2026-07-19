// Host gamepad -> zx_go joystick vector.
//
// The Gamepad API is poll-only by design: navigator.getGamepads() hands
// back a snapshot and there are no button events, so this is read once
// per displayed frame from GoEmulator's rAF loop. That suits the core,
// whose zxJoystickState export is state-based and diffs snapshots
// itself — nothing here has to synthesise press/release edges.
//
// Everything is expressed as the FPGA's 12-bit i_JOY vector
// (zxnext.vhd:90), active high, so one bit order runs the whole length
// of the path: pad -> wasm boundary -> ULA -> NR $B2.

export const JOY = {
    R: 0x001, L: 0x002, D: 0x004, U: 0x008,
    B: 0x010, C: 0x020, A: 0x040, START: 0x080,
    Y: 0x100, Z: 0x200, X: 0x400, MODE: 0x800,
};

// Axis travel past which a stick counts as pushed. Deliberately high:
// the cheap dpad-only pads report their dpad AS an axis pinned to the
// extremes, and a low threshold turns a resting analogue stick's drift
// into a permanently held direction.
const DEADZONE = 0.5;

// Standard-mapping pads (Xbox / PlayStation / 8BitDo and anything else
// the browser recognises) expose a fixed layout, so buttons can be
// mapped by meaning rather than by index. The face buttons are laid
// onto the Megadrive's six in physical position order: bottom-row A B C
// on the pad's bottom/right/left face buttons, top-row X Y Z on the
// remaining face button and the two shoulders.
// The Megadrive has six face buttons; a standard pad has four plus two
// shoulders and two triggers. The triggers double up on the shoulders'
// assignments rather than going unmapped: a physical button that does
// nothing reads as broken hardware, and there is no seventh MD button
// to give them. (Pads without triggers simply never report 6/7.)
const STANDARD_BUTTONS = [
    [0, JOY.B],      // bottom face (A / cross)  -> MD B, the primary fire
    [1, JOY.C],      // right face  (B / circle) -> MD C
    [2, JOY.A],      // left face   (X / square) -> MD A
    [3, JOY.Y],      // top face    (Y / triangle)
    [4, JOY.X],      // left shoulder
    [5, JOY.Z],      // right shoulder
    [6, JOY.X],      // left trigger  -> same as left shoulder
    [7, JOY.Z],      // right trigger -> same as right shoulder
    [8, JOY.MODE],   // back / select
    [9, JOY.START],  // start
    [12, JOY.U], [13, JOY.D], [14, JOY.L], [15, JOY.R], // dpad
];

// Non-standard pads report an arbitrary, device-specific button order,
// so index-to-meaning is guesswork. Two rules keep it usable anyway:
// directions come from the axes (near-universal on such pads), and
// *every* unmapped button fires — so whatever the user presses, the
// game reacts. The positional guesses below only add the Megadrive
// extras on top of that.
const FALLBACK_BUTTONS = [
    [0, JOY.B], [1, JOY.C], [2, JOY.A],
    [3, JOY.Y], [4, JOY.X], [5, JOY.Z],
    [8, JOY.MODE], [9, JOY.START],
];

// Buttons that must NOT also count as fire in the fallback path: a pad
// where START doubled as fire would start and shoot at once.
const FALLBACK_NON_FIRE = new Set([8, 9]);

const pressed = (pad, i) => !!(pad.buttons[i] && pad.buttons[i].pressed);

// axisBits reads a stick/dpad pair as direction bits. Y is inverted in
// the API's convention (-1 is up).
function axisBits(pad, xi, yi) {
    let bits = 0;
    const x = pad.axes[xi] || 0;
    const y = pad.axes[yi] || 0;
    if (x <= -DEADZONE) bits |= JOY.L;
    if (x >= DEADZONE) bits |= JOY.R;
    if (y <= -DEADZONE) bits |= JOY.U;
    if (y >= DEADZONE) bits |= JOY.D;
    return bits;
}

// padVector reduces one Gamepad snapshot to the 12-bit vector.
export function padVector(pad) {
    if (!pad) return 0;
    let bits = axisBits(pad, 0, 1);

    if (pad.mapping === 'standard') {
        for (const [i, bit] of STANDARD_BUTTONS) {
            if (pressed(pad, i)) bits |= bit;
        }
        return bits;
    }

    // Unrecognised device. Some still report a dpad as buttons 12-15
    // even without a standard mapping, so honour those too — they cost
    // nothing when absent.
    for (const [i, bit] of [[12, JOY.U], [13, JOY.D], [14, JOY.L], [15, JOY.R]]) {
        if (pressed(pad, i)) bits |= bit;
    }
    for (const [i, bit] of FALLBACK_BUTTONS) {
        if (pressed(pad, i)) bits |= bit;
    }
    for (let i = 0; i < pad.buttons.length; i++) {
        if (!FALLBACK_NON_FIRE.has(i) && pressed(pad, i)) bits |= JOY.B;
    }
    return bits;
}

export class GamepadPoller {
    constructor() {
        this.lastVector = 0;
        this.hadPad = false;
        this.loggedId = null;
        // Cumulative, for diagnostics: the OR of every vector produced
        // and how many non-idle ones there were. Live state is useless
        // once the user lets go of the pad to go and look at it.
        this.bitsSeen = 0;
        this.nonZeroCount = 0;
    }

    // firstPad returns the lowest-indexed connected pad, or null. Pads
    // stay invisible to the page until the user presses something on
    // them (a browser fingerprinting defence), so an attached-but-
    // untouched controller legitimately reads as absent here.
    firstPad() {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (const p of pads) {
            if (p && p.connected) return p;
        }
        return null;
    }

    // poll returns the current vector, or null when nothing needs
    // sending. Null is not the same as 0: it means "no pad, don't touch
    // the core's joystick state", which keeps a keyboard-driven session
    // from having its input zeroed 50 times a second by a poller with
    // no pad to read.
    poll() {
        const pad = this.firstPad();
        if (!pad) {
            if (!this.hadPad) return null;
            // Pad just vanished (unplugged mid-press): release everything
            // once, then go quiet.
            this.hadPad = false;
            this.lastVector = 0;
            return 0;
        }
        this.hadPad = true;
        if (this.loggedId !== pad.id) {
            this.loggedId = pad.id;
            console.info(`[zxplay] gamepad: ${pad.id}`
                + ` (mapping: ${pad.mapping || 'none'},`
                + ` ${pad.buttons.length} buttons, ${pad.axes.length} axes)`);
        }
        const bits = padVector(pad);
        this.bitsSeen |= bits;
        if (bits !== 0) this.nonZeroCount++;
        if (bits === this.lastVector) return null;
        this.lastVector = bits;
        return bits;
    }

    // describe dumps every visible pad's raw state. Mapping a pad the
    // browser doesn't recognise is otherwise pure guesswork — this is
    // what turns "button 7 does nothing" into a fixable observation.
    //
    // When nothing is visible it returns a REASON rather than an empty
    // array: "no pads" has several very different causes (API absent,
    // document unfocused, pad not yet woken by a button press) that all
    // look identical from an empty result, and the most common one —
    // the browser withholding pads until a button is pressed while the
    // PAGE has focus — is easy to hit by calling this from devtools,
    // which can hold that focus itself.
    describe() {
        if (!navigator.getGamepads) {
            return {
                pads: [],
                reason: 'navigator.getGamepads is unavailable'
                    + (window.isSecureContext ? '' : ' (page is not a secure context)'),
            };
        }
        const pads = navigator.getGamepads();
        const out = [];
        for (const p of pads) {
            if (!p) continue;
            out.push({
                index: p.index,
                id: p.id,
                mapping: p.mapping || '(none)',
                axes: Array.from(p.axes, (a) => Math.round(a * 100) / 100),
                buttons: Array.from(p.buttons, (b) => (b.pressed ? 1 : 0)),
                pressedIndices: Array.from(p.buttons, (b, i) => (b.pressed ? i : -1))
                    .filter((i) => i >= 0),
                vector: '0x' + padVector(p).toString(16).padStart(3, '0'),
            });
        }
        if (out.length) return out;
        return {
            pads: [],
            slots: pads.length,
            documentHasFocus: document.hasFocus(),
            reason: document.hasFocus()
                ? 'No pad visible yet. Browsers withhold gamepads until a'
                    + ' button is pressed on one — press a button on the pad'
                    + ' with this page focused, and watch for the'
                    + ' "gamepad connected" console line.'
                : 'This document does NOT have focus (devtools or another'
                    + ' window has it), and browsers only expose gamepads to'
                    + ' the focused document. Click the page, press a pad'
                    + ' button, then check again.',
        };
    }
}
