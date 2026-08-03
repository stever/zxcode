// The emulator's size is pure viewport maths (no DOM), so the sizes it hands
// the page are checked here: growing into the space a hidden keyboard frees is
// the point of the "no keyboard" choice, and the editor beside it in split mode
// has to survive that.

import {computeMode, fitEmulatorWidth, splitEmulatorWidth, tabEmulatorWidth} from "./layout";

const KB_ASPECT = 0.4; // all three keyboards; layoutAspect covers that invariant

describe("emulator width in tab mode", () => {
    it("keeps the 2x cap while a keyboard is drawn", () => {
        expect(tabEmulatorWidth({width: 1920, height: 1080, kbAspect: KB_ASPECT})).toBe(640);
    });

    // Without the keyboard under it the screen has the whole box, so the same
    // height holds a wider one - and the cap is what would stop it using it.
    it("grows into the freed height when the cap is lifted", () => {
        const box = {width: 1920, height: 1080};
        const capped = tabEmulatorWidth({...box, kbAspect: 0});
        const lifted = tabEmulatorWidth({...box, kbAspect: 0, maxW: Infinity});
        expect(capped).toBe(640);
        expect(lifted).toBeGreaterThan(capped);
        // (1080 - TAB_CHROME) / 0.8, the height's answer rather than the cap's.
        expect(lifted).toBe(1213);
    });

    // The screen is 5:4 as drawn (a 640x512 canvas), so the height a given width
    // needs is 0.8 of it, not the bare screen's 0.75 - which sized the emulator
    // taller than its box.
    it("sizes the screen to the shape it is actually drawn at", () => {
        const emuW = tabEmulatorWidth({width: 900, height: 700, kbAspect: 0.4});
        expect(Math.round(emuW * (0.8 + 0.4))).toBeLessThanOrEqual(700 - 110);
    });

    it("is still bounded by the viewport with no cap", () => {
        // A phone in portrait: width binds, so nothing changes but the keyboard
        // going, and the screen cannot overflow the width it has.
        expect(tabEmulatorWidth({width: 390, height: 844, kbAspect: 0, maxW: Infinity}))
            .toBe(390);
    });

    it("never returns a negative width when the chrome exceeds the height", () => {
        expect(tabEmulatorWidth({width: 320, height: 40, kbAspect: 0, maxW: Infinity})).toBe(0);
    });

    // The pages pass maxW: undefined when a keyboard is drawn, which must mean
    // "the usual cap", not "no cap".
    it("keeps the cap when maxW is not given", () => {
        expect(tabEmulatorWidth({width: 1920, height: 1080, kbAspect: 0, maxW: undefined}))
            .toBe(640);
    });

    it("passes the cap through to fitEmulatorWidth", () => {
        expect(fitEmulatorWidth({availW: 2000, availH: 2000, kbAspect: 0})).toBe(640);
        expect(fitEmulatorWidth({availW: 2000, availH: 2000, kbAspect: 0, maxW: Infinity}))
            .toBe(2000);
    });
});

describe("emulator width in split mode", () => {
    it("is the original 2x column while a keyboard is drawn", () => {
        for (const [width, height] of [[1280, 800], [1920, 1080], [3840, 2160]]) {
            expect(splitEmulatorWidth({width, height})).toBe(640);
            expect(splitEmulatorWidth({width, height, hidden: false})).toBe(640);
        }
    });

    // Using the height the keyboard had means width, and the width comes out of
    // the editor - so the editor keeps half the page.
    it("grows with no keyboard, leaving the editor half the page", () => {
        expect(splitEmulatorWidth({width: 1920, height: 1080, hidden: true})).toBe(960);
        expect(splitEmulatorWidth({width: 3840, height: 2160, hidden: true})).toBe(1920);
    });

    it("is bounded by the height, not only by the editor's half", () => {
        // A wide, short window: half of 2560 is 1280, but 800px of height is not
        // enough to draw a 1280-wide screen in.
        expect(splitEmulatorWidth({width: 2560, height: 800, hidden: true}))
            .toBe(Math.round((800 - 110) / 0.8));
    });

    it("never shrinks below the size it always had", () => {
        // A laptop: half the page is exactly the old column, and a page with a
        // toolbar under it has less height than the screen would want.
        expect(splitEmulatorWidth({width: 1280, height: 800, hidden: true})).toBe(640);
        expect(splitEmulatorWidth({width: 1000, height: 620, hidden: true, extraChrome: 60}))
            .toBe(640);
    });
});

// Unchanged by the keyboard choice: which mode the page is in comes from the
// viewport alone, and split mode is about having room for an editor.
describe("split versus tab", () => {
    it("splits only when there is room for both", () => {
        expect(computeMode(1920, 1080)).toBe("split");
        expect(computeMode(992, 600)).toBe("split");
        expect(computeMode(991, 1080)).toBe("tab");
        expect(computeMode(1920, 599)).toBe("tab");
    });
});
