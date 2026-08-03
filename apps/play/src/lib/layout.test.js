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
    // pixel of height there, so it cannot use the width the keyboard frees: the
    // column shrinks to the compact nav that still lives in it, and what neither
    // wants is left as margin for the shell to centre the pair in.
    it("keeps the full height in landscape and only drops the keyboard", () => {
        const withKeys = computeLayout({width: 800, height: 400, navHeight: 48,
            kbAspect: KB_ASPECT});
        const without = computeLayout({width: 800, height: 400, navHeight: 48, ...hidden});
        expect(without.mode).toBe('side');
        expect(without.screenH).toBe(400);
        expect(without.screenW).toBe(withKeys.screenW);
        expect(without.colW).toBeLessThan(withKeys.colW);
        expect(without.colW).toBe(176); // the nav's own width, and no more
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

// Pixel perfect draws the screen only at a whole scale of the display, so no
// Spectrum pixel is wider than its neighbour. It may only ever give space back:
// rounding UP would overflow the box the fit had already settled.
describe("computeLayout with pixel perfect", () => {
    const perfect = (box) => computeLayout({...box, pixelPerfect: true});
    const fitted = (box) => computeLayout({...box, pixelPerfect: false});

    // Every viewport the layout is checked at elsewhere, in both modes and with
    // and without a keyboard: the screen is always a whole number of steps.
    it.each([
        [1920, 1080], [1440, 900], [1366, 768], [1280, 800],
        [900, 400], [844, 390], [390, 844], [1024, 768],
    ])("lands on a whole scale at %ix%i", (width, height) => {
        for (const hidden of [false, true]) {
            const {screenW} = perfect({
                width, height, navHeight: 48, kbAspect: KB_ASPECT, hidden,
            });
            if (screenW >= 320) expect(screenW % 320).toBe(0);
            expect(screenW % 1).toBe(0);
        }
    });

    it("never asks for more room than fitting would have", () => {
        for (const [width, height] of [[1920, 1080], [1366, 768], [900, 400], [390, 844]]) {
            for (const hidden of [false, true]) {
                const box = {width, height, navHeight: 48, kbAspect: KB_ASPECT, hidden};
                expect(perfect(box).screenW).toBeLessThanOrEqual(fitted(box).screenW);
                expect(perfect(box).screenH).toBeLessThanOrEqual(fitted(box).screenH);
            }
        }
    });

    // 1250 wide (3.906 steps) was the reported case: some pixels 4 across and
    // some 3. It comes back as a flat 3x.
    it("takes the stacked screen with no keyboard down to a whole 3x", () => {
        const box = {width: 1920, height: 1080, navHeight: 48, kbAspect: KB_ASPECT, hidden: true};
        expect(fitted(box).screenW).toBeGreaterThan(960);
        expect(perfect(box).screenW).toBe(960);
        expect(perfect(box).screenH).toBe(768);
    });

    // Below one whole step there is nothing to drop to, and a screen shrunk to
    // nothing would be worse than uneven pixels - so the fit is kept.
    it("keeps the fitted size when even 1x will not fit", () => {
        const box = {width: 260, height: 500, navHeight: 48, kbAspect: KB_ASPECT};
        expect(perfect(box).screenW).toBe(fitted(box).screenW);
        expect(perfect(box).screenW).toBeLessThan(320);
    });

    // Side by side the width the screen gives up is NOT poured into the column:
    // the screen is bounded by the height, so neither of them wants it, and it
    // is left over for the shell to centre the pair in. Pouring it in gave a
    // 614px keyboard beside a 640px screen, and with no keyboard drawn a void
    // where the column should be.
    it("leaves the width it gives up as margin, not column", () => {
        const box = {width: 900, height: 400, navHeight: 48, kbAspect: KB_ASPECT};
        expect(computeMode(box)).toBe('side');
        expect(perfect(box).screenW + perfect(box).colW).toBeLessThan(900);
        expect(perfect(box).colW).toBeLessThanOrEqual(perfect(box).screenW);
    });

    // One machine: a keyboard wider than its own display reads as a fault. The
    // column used to take every pixel the screen did not, which on a wide window
    // grew it far past the screen.
    it("never draws the keyboard wider than the screen", () => {
        for (const [width, height] of [[2560, 760], [1920, 700], [1254, 760], [900, 400]]) {
            const box = {width, height, navHeight: 48, kbAspect: KB_ASPECT};
            for (const l of [fitted(box), perfect(box)]) {
                expect(l.kbW).toBeLessThanOrEqual(l.screenW);
            }
        }
    });

    // With a keyboard the two are one column, so it follows the screen's width.
    it("keeps the keyboard the screen's width", () => {
        const box = {width: 390, height: 844, navHeight: 48, kbAspect: KB_ASPECT};
        const {screenW, kbW} = perfect(box);
        expect(screenW).toBe(320);
        expect(kbW).toBe(320);
    });

    it("changes nothing when it is off", () => {
        for (const [width, height] of [[1920, 1080], [900, 400], [390, 844]]) {
            const box = {width, height, navHeight: 48, kbAspect: KB_ASPECT, hidden: true};
            expect(computeLayout(box)).toEqual(fitted(box));
        }
    });
});
