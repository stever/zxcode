import {JOY, padVector, GamepadPoller} from "../../../../packages/emulator/src/zxgo/gamepad";

// fakePad builds a Gamepad-shaped snapshot. axes default to centred and
// buttons to released, so each test only states what it cares about.
function fakePad({mapping = 'standard', axes = [0, 0], pressed = [], buttons = 16} = {}) {
    return {
        id: 'test pad',
        index: 0,
        connected: true,
        mapping,
        axes,
        buttons: Array.from({length: buttons}, (_, i) => ({pressed: pressed.includes(i)})),
    };
}

describe('padVector — standard mapping', () => {
    it('maps the dpad buttons to direction bits', () => {
        expect(padVector(fakePad({pressed: [12]}))).toBe(JOY.U);
        expect(padVector(fakePad({pressed: [13]}))).toBe(JOY.D);
        expect(padVector(fakePad({pressed: [14]}))).toBe(JOY.L);
        expect(padVector(fakePad({pressed: [15]}))).toBe(JOY.R);
    });

    it('maps the face buttons onto the Megadrive six', () => {
        expect(padVector(fakePad({pressed: [0]}))).toBe(JOY.B);
        expect(padVector(fakePad({pressed: [1]}))).toBe(JOY.C);
        expect(padVector(fakePad({pressed: [2]}))).toBe(JOY.A);
        expect(padVector(fakePad({pressed: [3]}))).toBe(JOY.Y);
        expect(padVector(fakePad({pressed: [4]}))).toBe(JOY.X);
        expect(padVector(fakePad({pressed: [5]}))).toBe(JOY.Z);
        expect(padVector(fakePad({pressed: [8]}))).toBe(JOY.MODE);
        expect(padVector(fakePad({pressed: [9]}))).toBe(JOY.START);
    });

    // The primary fire button must be the one under the player's thumb.
    // Getting this wrong makes every Kempston game feel broken even though
    // the plumbing works.
    it('puts fire on the bottom face button', () => {
        expect(padVector(fakePad({pressed: [0]} )) & JOY.B).toBeTruthy();
    });

    // Every physical button must do something. A 10-button pad in the
    // standard layout uses 0-9, so leaving the triggers (6/7) unmapped
    // silently kills two buttons the user can see and press.
    it('maps the triggers, doubling them onto the shoulders', () => {
        expect(padVector(fakePad({pressed: [6]}))).toBe(JOY.X);
        expect(padVector(fakePad({pressed: [7]}))).toBe(JOY.Z);
    });

    it('leaves no standard index below 10 unmapped', () => {
        for (let i = 0; i < 10; i++) {
            expect(padVector(fakePad({pressed: [i]}))).not.toBe(0);
        }
    });

    // Chrome reports the DragonRise pad (0079:0011) as standard with the
    // dpad synthesised into buttons 12-15 and NO axes at all. Reading a
    // missing axis must not throw or invent a direction.
    it('handles a standard pad that reports no axes', () => {
        const pad = fakePad({axes: [], pressed: [14]});
        expect(padVector(pad)).toBe(JOY.L);
        expect(padVector(fakePad({axes: []}))).toBe(0);
    });

    it('reads the left stick, with the API Y convention (-1 is up)', () => {
        expect(padVector(fakePad({axes: [0, -1]}))).toBe(JOY.U);
        expect(padVector(fakePad({axes: [0, 1]}))).toBe(JOY.D);
        expect(padVector(fakePad({axes: [-1, 0]}))).toBe(JOY.L);
        expect(padVector(fakePad({axes: [1, 0]}))).toBe(JOY.R);
        expect(padVector(fakePad({axes: [1, 1]}))).toBe(JOY.R | JOY.D);
    });

    // A resting analogue stick never sits at exactly zero. Without a
    // deadzone its drift reads as a permanently held direction, which in a
    // game looks exactly like the emulator ignoring the player.
    it('ignores stick drift below the deadzone', () => {
        expect(padVector(fakePad({axes: [0.3, -0.4]}))).toBe(0);
        expect(padVector(fakePad({axes: [0.49, 0]}))).toBe(0);
        expect(padVector(fakePad({axes: [0.51, 0]}))).toBe(JOY.R);
    });

    it('combines directions and buttons', () => {
        expect(padVector(fakePad({pressed: [0, 15]}))).toBe(JOY.B | JOY.R);
    });
});

describe('padVector — non-standard pads', () => {
    // The DragonRise-style pads (VID 0079:0011 and friends) report no
    // mapping, two axes carrying the dpad, and an arbitrary button order.
    const dragonRise = (opts) => fakePad({mapping: '', buttons: 10, ...opts});

    it('reads directions from the axes', () => {
        expect(padVector(dragonRise({axes: [-1, 0]}))).toBe(JOY.L);
        expect(padVector(dragonRise({axes: [0, -1]}))).toBe(JOY.U);
    });

    // The whole point of the fallback: the button order is unknowable, so
    // whatever the player presses must at least fire. A pad where three of
    // the ten buttons do nothing reads as broken hardware.
    it('fires on any unmapped button', () => {
        for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) {
            expect(padVector(dragonRise({pressed: [i]})) & JOY.B).toBeTruthy();
        }
    });

    it('does not let START or MODE double as fire', () => {
        expect(padVector(dragonRise({pressed: [8]})) & JOY.B).toBeFalsy();
        expect(padVector(dragonRise({pressed: [9]})) & JOY.B).toBeFalsy();
        expect(padVector(dragonRise({pressed: [9]})) & JOY.START).toBeTruthy();
    });

    it('still honours a dpad reported as buttons 12-15', () => {
        const pad = fakePad({mapping: '', buttons: 16, pressed: [14]});
        expect(padVector(pad) & JOY.L).toBeTruthy();
    });
});

describe('GamepadPoller', () => {
    const withPads = (pads) => {
        navigator.getGamepads = () => pads;
    };

    afterEach(() => {
        delete navigator.getGamepads;
    });

    // Null means "say nothing to the core". If an absent pad reported 0
    // instead, the poller would zero the joystick state every frame and
    // stamp on any other input path.
    it('reports null when no pad is visible', () => {
        withPads([null, null]);
        expect(new GamepadPoller().poll()).toBeNull();
    });

    it('reports a vector once, then null while it is unchanged', () => {
        const pad = fakePad({pressed: [0]});
        withPads([pad]);
        const poller = new GamepadPoller();
        expect(poller.poll()).toBe(JOY.B);
        expect(poller.poll()).toBeNull();
        expect(poller.poll()).toBeNull();
    });

    it('reports each change', () => {
        const pad = fakePad({pressed: [0]});
        withPads([pad]);
        const poller = new GamepadPoller();
        expect(poller.poll()).toBe(JOY.B);
        pad.buttons[0].pressed = false;
        pad.buttons[15].pressed = true;
        expect(poller.poll()).toBe(JOY.R);
    });

    // Unplugging mid-press must release, or the game keeps running into a
    // wall with no pad left to let go of.
    it('releases once when the pad disappears', () => {
        const pad = fakePad({pressed: [15]});
        withPads([pad]);
        const poller = new GamepadPoller();
        expect(poller.poll()).toBe(JOY.R);

        withPads([]);
        expect(poller.poll()).toBe(0);
        expect(poller.poll()).toBeNull();
    });

    it('skips disconnected slots', () => {
        withPads([null, {...fakePad({pressed: [0]}), connected: false}]);
        expect(new GamepadPoller().poll()).toBeNull();
    });
});

// An empty result has several very different causes, and reporting them
// all as [] sends whoever is debugging off to look for a bug in the
// mapping when the real answer is "press a button first".
describe('GamepadPoller.describe — diagnostics', () => {
    let hasFocus;

    beforeEach(() => {
        hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(true);
    });

    afterEach(() => {
        hasFocus.mockRestore();
        delete navigator.getGamepads;
    });

    it('describes each visible pad', () => {
        navigator.getGamepads = () => [fakePad({pressed: [0, 15]})];
        const [pad] = new GamepadPoller().describe();
        expect(pad.mapping).toBe('standard');
        expect(pad.pressedIndices).toEqual([0, 15]);
        expect(pad.vector).toBe('0x011'); // B | R
    });

    it('explains an unavailable API rather than returning []', () => {
        const out = new GamepadPoller().describe();
        expect(out.pads).toEqual([]);
        expect(out.reason).toMatch(/unavailable/);
    });

    it('points at the button-press gate when the page has focus', () => {
        navigator.getGamepads = () => [null, null];
        const out = new GamepadPoller().describe();
        expect(out.documentHasFocus).toBe(true);
        expect(out.reason).toMatch(/press a button/i);
    });

    // The trap: calling this from devtools, which holds the focus the
    // browser is waiting on.
    it('points at focus when the document does not have it', () => {
        hasFocus.mockReturnValue(false);
        navigator.getGamepads = () => [];
        const out = new GamepadPoller().describe();
        expect(out.documentHasFocus).toBe(false);
        expect(out.reason).toMatch(/does NOT have focus/);
    });
});
