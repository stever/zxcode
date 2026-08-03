// The emulator's size and the height split beneath it are pure arithmetic over
// a MEASURED box (usePageMetrics.js supplies the box; guessing the chrome is
// what used to scroll the page), so what is checked here is the arithmetic:
// that a panel never asks for more height than it was given, that the common
// desktop case is unchanged, and that the debugger leaves both halves usable.

import {
    computeMode,
    dockSplit,
    editorHeight,
    emulatorSize,
    fitEmulatorWidth,
    panelHeight,
    splitEmulator,
    tabEmulator,
} from "./layout";

const KB_ASPECT = 0.4; // all three keyboards; layoutAspect covers that invariant
const PAGE_BOTTOM = 4;

// Realistic measured boxes: viewport, and where the emulator was found to start
// (nav + tab strip, or nav + title slot).
const BOXES = [
    {width: 1920, height: 1080, top: 99},
    {width: 1440, height: 900, top: 99},
    {width: 1366, height: 768, top: 127},
    {width: 1345, height: 650, top: 127},
    {width: 1280, height: 800, top: 116},
    {width: 1200, height: 620, top: 116},
    {width: 992, height: 600, top: 116},
    {width: 900, height: 700, top: 116},
    {width: 390, height: 844, top: 116},
];

describe("the height a panel is given", () => {
    it("runs from where the panel starts to the bottom of the page", () => {
        expect(panelHeight({viewportH: 768, top: 127})).toBe(768 - 127 - PAGE_BOTTOM);
    });

    it("gives up what is reserved under it", () => {
        expect(panelHeight({viewportH: 768, top: 127, reserveBelow: 92}))
            .toBe(768 - 127 - 92 - PAGE_BOTTOM);
    });

    it("never goes negative when the chrome exceeds the viewport", () => {
        expect(panelHeight({viewportH: 200, top: 400})).toBe(0);
    });
});

describe("the emulator in tab mode", () => {
    it("keeps the 2x cap while a keyboard is drawn", () => {
        expect(tabEmulator({width: 1920, availH: 900, kbAspect: KB_ASPECT}).emuW).toBe(640);
    });

    // Without the keyboard under it the screen has the whole box, so the same
    // height holds a wider one - and the cap is what would stop it using it.
    it("grows into the freed height when the keyboard goes", () => {
        const capped = tabEmulator({width: 1920, availH: 900, kbAspect: 0}).emuW;
        const lifted = tabEmulator({width: 1920, availH: 900, kbAspect: 0, hidden: true}).emuW;
        expect(capped).toBe(640);
        expect(lifted).toBe(Math.floor(900 / 0.8));
    });

    // The screen is 5:4 as drawn (a 640x512 canvas), so the height a given width
    // needs is 0.8 of it, not the bare screen's 0.75 - which sized the emulator
    // taller than its box.
    it("sizes the screen to the shape it is actually drawn at", () => {
        const {emuW, emuH} = tabEmulator({width: 900, availH: 500, kbAspect: KB_ASPECT});
        expect(emuH).toBe(Math.round(emuW * 1.2));
        expect(emuH).toBeLessThanOrEqual(500);
    });

    it("is still bounded by the width in portrait", () => {
        expect(tabEmulator({width: 390, availH: 700, kbAspect: 0, hidden: true}).emuW)
            .toBe(390);
    });

    it("never returns a negative width when the chrome exceeds the height", () => {
        expect(tabEmulator({width: 320, availH: 0, kbAspect: 0, hidden: true}).emuW).toBe(0);
    });

    it("passes the cap through to fitEmulatorWidth", () => {
        expect(fitEmulatorWidth({availW: 2000, availH: 2000, kbAspect: 0})).toBe(640);
        expect(fitEmulatorWidth({availW: 2000, availH: 2000, kbAspect: 0, maxW: Infinity}))
            .toBe(2000);
    });

    // Rounding must go DOWN: half a pixel over a bound is the scrollbar the
    // whole calculation exists to avoid.
    it("rounds down rather than to nearest", () => {
        expect(fitEmulatorWidth({availW: 640.9, availH: 9999, kbAspect: 0, maxW: Infinity}))
            .toBe(640);
    });
});

describe("the emulator in split mode", () => {
    // The common desktop case must come out exactly as it always has: this is
    // the size the whole layout was built around.
    it("is the original 2x column on a desktop", () => {
        expect(splitEmulator({width: 1920, availH: 900, kbAspect: KB_ASPECT}).emuW).toBe(640);
        expect(splitEmulator({width: 3840, availH: 2000, kbAspect: KB_ASPECT}).emuW).toBe(640);
    });

    // Using the height the keyboard had means width, and the width comes out of
    // the editor - so the editor keeps half the page.
    it("leaves the editor half the page with no keyboard", () => {
        for (const {width, height} of BOXES) {
            const {emuW} = splitEmulator({width, availH: height, kbAspect: 0, hidden: true});
            expect(emuW).toBeLessThanOrEqual(Math.max(320, width / 2));
        }
    });

    it("is bounded by the height, not only by the editor's half", () => {
        // A wide, short window: half of 2560 is 1280, but 690px of height is not
        // enough to draw a 1280-wide screen in.
        expect(splitEmulator({width: 2560, availH: 690, kbAspect: 0, hidden: true}).emuW)
            .toBe(Math.floor(690 / 0.8));
    });

    // The bug this change fixes: the column was a flat 640 (and so 768 tall)
    // whatever the window, which is what scrolled the page on a laptop.
    it("shrinks to fit a short window instead of overflowing it", () => {
        expect(splitEmulator({width: 1366, availH: 500, kbAspect: KB_ASPECT}).emuW)
            .toBeLessThan(640);
        expect(splitEmulator({width: 1366, availH: 900, kbAspect: KB_ASPECT}).emuW)
            .toBe(640);
    });

    it("stops shrinking rather than letting the screen vanish", () => {
        expect(splitEmulator({width: 1000, availH: 100, kbAspect: KB_ASPECT}).emuW).toBe(256);
    });

    // The floor is a safety net, not a target: at the smallest viewport split
    // mode allows, with the toolbar wrapped, the fit still decides.
    it("does not bind at the smallest split viewport", () => {
        const availH = panelHeight({viewportH: 600, top: 116, reserveBelow: 100 + 6});
        expect(splitEmulator({width: 992, availH, kbAspect: KB_ASPECT}).emuW)
            .toBeGreaterThan(256);
    });
});

// The point of the whole change: whatever the viewport, what the layout puts on
// the page fits the page.
describe("nothing the layout returns overflows its box", () => {
    const TOOLBAR = 92; // two wrapped rows, the worst the project page shows

    it.each(BOXES.map(b => [b.width, b.height, b.top]))(
        "fits the emulator at %ix%i", (width, height, top) => {
            for (const hidden of [false, true]) {
                const kbAspect = hidden ? 0 : KB_ASPECT;
                for (const reserveBelow of [0, TOOLBAR]) {
                    const availH = panelHeight({viewportH: height, top, reserveBelow});
                    for (const size of [
                        tabEmulator({width, availH, kbAspect, hidden}),
                        splitEmulator({width, availH, kbAspect, hidden}),
                    ]) {
                        // The floor is the one stated exception: under it we
                        // would rather scroll than draw the screen away.
                        if (size.emuW > 256) {
                            expect(size.emuH).toBeLessThanOrEqual(availH);
                            expect(top + size.emuH + reserveBelow + PAGE_BOTTOM)
                                .toBeLessThanOrEqual(height);
                        }
                    }
                }
            }
        });

    // Asking for no keyboard is asking for a bigger screen, so it must never
    // buy a smaller one - the height bound could otherwise take it back.
    it.each(BOXES.map(b => [b.width, b.height, b.top]))(
        "never draws a smaller screen with no keyboard at %ix%i", (width, height, top) => {
            const availH = panelHeight({viewportH: height, top});
            const withKb = splitEmulator({width, availH, kbAspect: KB_ASPECT});
            const without = splitEmulator({width, availH, kbAspect: 0, hidden: true});
            expect(without.emuW).toBeGreaterThanOrEqual(withKb.emuW);
        });

    it("keeps the emulator's aspect whatever the box", () => {
        for (const kbAspect of [0, KB_ASPECT]) {
            const {emuW, emuH} = emulatorSize({availW: 900, availH: 400, kbAspect});
            expect(emuH).toBe(Math.round(emuW * (0.8 + kbAspect)));
        }
    });
});

describe("the editor's share of its column", () => {
    it("takes whatever the column's own chrome leaves", () => {
        expect(editorHeight({columnH: 800, chrome: 57})).toBe(743);
    });

    // The chrome is measured, so it already counts the dock, the tab strip and
    // the home page's Run button; the floor is what stops a very short window
    // collapsing the editor to nothing.
    it("never collapses below a usable editor", () => {
        expect(editorHeight({columnH: 200, chrome: 190})).toBe(150);
    });
});

describe("the debugger's share of its column", () => {
    it("keeps the panes at their usual height when there is room", () => {
        expect(dockSplit(900)).toEqual({dockH: 102 + 252, paneH: 252});
    });

    // The panes scroll internally, so they are what gives up height first.
    it("shrinks the panes before the editor", () => {
        const {paneH} = dockSplit(500);
        expect(paneH).toBe(500 - 150 - 8 - 102);
        expect(paneH).toBeLessThan(252);
    });

    it("stops shrinking where a pane stops showing anything", () => {
        expect(dockSplit(200).paneH).toBe(96);
        expect(dockSplit(0).paneH).toBe(96);
    });

    it("leaves both halves usable across the viewports", () => {
        for (const {height, top} of BOXES) {
            const columnH = panelHeight({viewportH: height, top});
            const {dockH, paneH} = dockSplit(columnH);
            expect(paneH).toBeGreaterThanOrEqual(96);
            expect(paneH).toBeLessThanOrEqual(252);
            expect(dockH).toBe(102 + paneH);
        }
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

// Pixel perfect draws the screen only at a whole scale of the display, so no
// Spectrum pixel is wider than its neighbour. It may only give space back:
// rounding UP would overflow the box the fit had already settled.
describe("pixel perfect", () => {
    it.each(BOXES.map(b => [b.width, b.height, b.top]))(
        "lands on a whole scale at %ix%i", (width, height, top) => {
            const availH = panelHeight({viewportH: height, top});
            for (const hidden of [false, true]) {
                const kbAspect = hidden ? 0 : KB_ASPECT;
                for (const size of [
                    tabEmulator({width, availH, kbAspect, hidden, pixelPerfect: true}),
                    splitEmulator({width, availH, kbAspect, hidden, pixelPerfect: true}),
                ]) {
                    // 256 is the split floor, which outranks it: below one whole
                    // step there is nothing to drop to anyway.
                    if (size.emuW >= 320) expect(size.emuW % 320).toBe(0);
                }
            }
        });

    it("never asks for more room than fitting would have", () => {
        for (const {width, height, top} of BOXES) {
            const availH = panelHeight({viewportH: height, top});
            for (const hidden of [false, true]) {
                const kbAspect = hidden ? 0 : KB_ASPECT;
                const box = {width, availH, kbAspect, hidden};
                expect(tabEmulator({...box, pixelPerfect: true}).emuW)
                    .toBeLessThanOrEqual(tabEmulator(box).emuW);
                expect(splitEmulator({...box, pixelPerfect: true}).emuH)
                    .toBeLessThanOrEqual(splitEmulator(box).emuH);
            }
        }
    });

    // The 2x column the desktop already draws is a whole scale, so the common
    // case is untouched by turning this on.
    it("leaves the 2x desktop column exactly where it was", () => {
        const box = {width: 1920, availH: 900, kbAspect: KB_ASPECT};
        expect(splitEmulator({...box, pixelPerfect: true}).emuW).toBe(640);
        expect(splitEmulator(box).emuW).toBe(640);
    });

    it("keeps the fitted size when even 1x will not fit", () => {
        const box = {width: 300, availH: 200, kbAspect: KB_ASPECT};
        expect(tabEmulator({...box, pixelPerfect: true}).emuW).toBe(tabEmulator(box).emuW);
    });

    it("changes nothing when it is off", () => {
        const box = {width: 1440, availH: 700, kbAspect: 0, hidden: true};
        expect(tabEmulator({...box, pixelPerfect: false})).toEqual(tabEmulator(box));
    });
});
