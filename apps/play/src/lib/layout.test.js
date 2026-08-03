// The player's whole responsive layout is pure viewport maths (no DOM), so the
// sizes it hands the page are checked here. What "no keyboard" changes is the
// mode (side-by-side has nothing to put beside the screen) and the bound on the
// screen (the height the keyboard had, instead of the 2x cap).

import {computeLayout, computeMode, parseKeyConfig, resolveKeyboard} from "./layout";

const KB_ASPECT = 0.4; // all three machine keyboards draw in the same box
const NO_KEYS = {keystr: '', rowCount: 0, maxCols: 0, aspect: 0, override: false};

describe("resolveKeyboard", () => {
    it("follows the machine, and the player's choice over it", () => {
        expect(resolveKeyboard(NO_KEYS, 48).layout).toBe('rubber');
        expect(resolveKeyboard(NO_KEYS, 128).layout).toBe('plus');
        expect(resolveKeyboard(NO_KEYS, 'next').layout).toBe('next');
        expect(resolveKeyboard(NO_KEYS, 48, 'plus').layout).toBe('plus');
        expect(resolveKeyboard(NO_KEYS, 48, 'plus').hidden).toBe(false);
    });

    // The shape is still reported while the keyboard is hidden: it is what keeps
    // the page's layout the same, so hiding one only frees the room it had.
    it("reports no keyboard as hidden, keeping the shape it would have drawn", () => {
        for (const machine of [48, 128, 'next']) {
            const resolved = resolveKeyboard(NO_KEYS, machine, 'none');
            expect(resolved.hidden).toBe(true);
            expect(resolved.aspect).toBe(resolveKeyboard(NO_KEYS, machine).aspect);
        }
    });

    // A game's named keys can be a phone's only controls, so they outrank the
    // saved choice — including a saved "none".
    it("keeps a game's named keys whatever the player chose", () => {
        const keyConfig = {...parseKeyConfig('OPeZ'), override: true};
        const resolved = resolveKeyboard(keyConfig, 48, 'none');
        expect(resolved.hidden).toBe(false);
        expect(resolved.keystr).toBe('OPeZ');
        expect(resolved.aspect).toBe(keyConfig.aspect);
    });
});

describe("layout mode", () => {
    it("stacks in portrait and goes side-by-side when the stack will not fit", () => {
        expect(computeMode({width: 390, height: 844, kbAspect: KB_ASPECT})).toBe('stacked');
        expect(computeMode({width: 800, height: 400, kbAspect: KB_ASPECT})).toBe('side');
        expect(computeMode({width: 1920, height: 1080, kbAspect: KB_ASPECT})).toBe('stacked');
    });

    // Hiding the keyboard must not rearrange the page: a laptop window under
    // ~800px tall is side by side, and flipping it to a stack would cost the
    // screen the nav's height — more than the keyboard freed.
    it("does not change when the keyboard is hidden", () => {
        for (const [width, height] of [[1920, 1080], [1366, 768], [800, 400], [390, 844]]) {
            const shown = resolveKeyboard(NO_KEYS, 48);
            const none = resolveKeyboard(NO_KEYS, 48, 'none');
            expect(computeMode({width, height, kbAspect: none.aspect}))
                .toBe(computeMode({width, height, kbAspect: shown.aspect}));
        }
    });
});

// The whole point of the option: whatever the viewport, asking for no keyboard
// gives the screen at least the room it had, never less.
describe("no keyboard never costs the screen room", () => {
    it.each([[1920, 1080], [1366, 768], [1280, 720], [1024, 300], [800, 400], [600, 400],
             [390, 844], [844, 390]])("%ix%i", (width, height) => {
        const navHeight = 56;
        const shown = resolveKeyboard(NO_KEYS, 48);
        const none = resolveKeyboard(NO_KEYS, 48, 'none');
        const withKeys = computeLayout({width, height, navHeight, kbAspect: shown.aspect});
        const without = computeLayout({width, height, navHeight, kbAspect: none.aspect,
            hidden: true});
        expect(without.screenW).toBeGreaterThanOrEqual(withKeys.screenW);
        expect(without.kbW).toBe(0);
        expect(without.kbH).toBe(0);
    });
});

describe("computeLayout with a keyboard", () => {
    it("caps the stacked screen at 2x and gives the keyboard the same width", () => {
        const layout = computeLayout({width: 1920, height: 1080, navHeight: 48,
            kbAspect: KB_ASPECT});
        expect(layout.mode).toBe('stacked');
        expect(layout.screenW).toBe(640);
        expect(layout.screenH).toBe(512);
        expect(layout.kbW).toBe(640);
        expect(layout.kbH).toBe(256);
    });

    it("fills the height side-by-side, keeping a usable keyboard column", () => {
        const layout = computeLayout({width: 800, height: 400, navHeight: 40,
            kbAspect: KB_ASPECT});
        expect(layout.mode).toBe('side');
        expect(layout.screenH).toBe(400);
        expect(layout.screenW).toBe(500);
        expect(layout.colW).toBe(300);
        expect(layout.kbW).toBeGreaterThan(0);
    });
});

describe("computeLayout with no keyboard", () => {
    // The keyboard's shape is still what decides the mode; "hidden" is what
    // frees its room.
    const hidden = {kbAspect: KB_ASPECT, hidden: true};

    it("gives the screen the height the keyboard and the cap were holding", () => {
        const layout = computeLayout({width: 1920, height: 1080, navHeight: 48, ...hidden});
        expect(layout.mode).toBe('stacked');
        // (1080 - 48 nav - 24 chrome) / 0.8: the height's answer, not the cap's.
        expect(layout.screenW).toBe(1260);
        expect(layout.screenH).toBe(1008);
        expect(layout.kbW).toBe(0);
        expect(layout.kbH).toBe(0);
    });

    // Landscape stays side-by-side, so the screen keeps the full height rather
    // than losing the nav's worth of it to a stack. The screen already has every
    // pixel of height there, so the keyboard simply goes and the column - which
    // the compact nav still needs - keeps its width.
    it("keeps the full height in landscape and only drops the keyboard", () => {
        const withKeys = computeLayout({width: 800, height: 400, navHeight: 48,
            kbAspect: KB_ASPECT});
        const without = computeLayout({width: 800, height: 400, navHeight: 48, ...hidden});
        expect(without.mode).toBe('side');
        expect(without.screenH).toBe(400);
        expect(without.screenW).toBe(withKeys.screenW);
        expect(without.colW).toBe(withKeys.colW);
        // Nothing may be left for a keyboard that is not there.
        expect(without.kbW).toBe(0);
        expect(without.kbH).toBe(0);
    });

    it("is still bounded by the width in portrait", () => {
        const layout = computeLayout({width: 390, height: 844, navHeight: 48, ...hidden});
        expect(layout.screenW).toBe(390);
        expect(layout.kbH).toBe(0);
    });

    // A nav that has wrapped to more rows than the viewport is tall: nothing to
    // draw the screen in, and asking for a negative one would throw the layout.
    it("never asks for a negative screen when the nav takes the height", () => {
        const layout = computeLayout({width: 320, height: 400, navHeight: 500, ...hidden});
        expect(layout.mode).toBe('stacked');
        expect(layout.screenW).toBe(0);
        expect(layout.screenH).toBe(0);
    });
});
