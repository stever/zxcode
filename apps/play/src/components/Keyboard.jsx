import React, {useEffect} from "react";
import PropTypes from "prop-types";
import {Control, SingleWindow} from "../lib/canvasgui";
import {
    KEY_ACTIONS, LAYOUTS, PALETTE, RUBBER_PALETTE, baseKeyId, buildKeyboard, drawKeyboard,
    drawKeyPressed, heldKeys, keyRects, layoutFromKeystr, matrixKey,
} from "@zxplay/ui/keyboard";

Keyboard.propTypes = {
    cssWidth: PropTypes.number,
    cssHeight: PropTypes.number,
    keystr: PropTypes.string,
    layout: PropTypes.oneOf(['rubber', 'plus', 'next']),
    rounded: PropTypes.bool
}

// The keyboard is drawn once at this internal resolution and then CSS-scaled to
// whatever size the responsive layout asks for. PointerEventHandler maps touches
// back through the internal/CSS scale ratio, so scaling is safe.
const BASE_WIDTH = 640;

// Keyboards are drawn at twice the nominal width: the printed legends are
// small, and the extra resolution is what keeps them sharp once the canvas is
// scaled down to the width the layout asked for.
const KEYBOARD_SCALE = 2;

export function Keyboard(props) {
    const {keystr, layout} = props;

    useEffect(() => {
        return renderKeyboard(BASE_WIDTH * KEYBOARD_SCALE, keystr, layout);
    }, [keystr, layout]);

    const cssWidth = props.cssWidth || BASE_WIDTH;
    const cssHeight = props.cssHeight;

    let style = {
        imageRendering: 'auto',
        display: 'block',
        width: `${cssWidth}px`
    };

    if (cssHeight) {
        style.height = `${cssHeight}px`;
    }

    if (props.rounded) {
        style.borderRadius = '0 0 5px 5px';
    }

    return (
        // preventDefault on mousedown keeps a click on the virtual keys from
        // blurring the emulator canvas (focus-scoped keyboard capture).
        <div id="guiparent" onMouseDown={(e) => e.preventDefault()} style={{
            width: `${cssWidth}px`,
            ...(cssHeight ? {height: `${cssHeight}px`} : {}),
            margin: 0,
            backgroundColor: "#444",
            padding: 0,
        }}>
            <canvas
                id="virtkeys"
                width={BASE_WIDTH}
                style={style}
            />
        </div>
    )
}

/**
 * Simulate a key event.
 * @param {Number} keyCode The keyCode of the key to simulate
 * @param {String} type (optional) The type of event : down, up or press. The default is down
 */
function simulateKey(keyCode, type) {
    let evtName = (typeof (type) === "string") ? "key" + type : "keydown";

    let event = document.createEvent("HTMLEvents");
    event.initEvent(evtName, true, false);
    event.keyCode = keyCode;

    // The KeyboardHandler listens on the emulator canvas (keyboard capture
    // is focus-scoped); a synthetic dispatch at the canvas reaches it
    // without the canvas needing focus.
    const screen = document.querySelector('#jsspeccy-screen canvas');
    (screen || document).dispatchEvent(event);
}

// Press (and release) every code a key stands for. Single-code keys are the
// letters and digits; the dedicated keys of the Spectrum+ / Next keyboards name
// two, a shift and a key, which is exactly what a physical keyboard sends when
// you hold Shift and press 1 for EDIT. Releasing in reverse order leaves the
// shift down until its partner has lifted, as a real hand would.
function pressKey(codes, down) {
    const order = down ? codes : [...codes].reverse();
    for (const code of order) {
        simulateKey(code, down ? 'down' : 'up');
    }
}

const paletteFor = (layout) => (layout.style === 'rubber' ? RUBBER_PALETTE : PALETTE);

// The keyboard, drawn once into an offscreen canvas and blitted behind the
// keys. It never takes a pointer: the keys sit on top of it and do that.
class KeyboardImage extends Control {
    constructor(parent, board, width, height) {
        super(parent, 0, 0, width, height);
        this.board = board;
    }

    isPointerInside() {
        return false;
    }

    onDraw(ctx) {
        drawKeyboard(ctx, this.board, this.w, this.h);
    }
}

// One key. There is nothing to draw until it is held — the drawn keyboard
// behind it already shows the key — and it hit-tests against the key's own
// rectangles rather than its bounding box, or the notch of the L-shaped ENTER
// would steal the corner of the key beside it.
class MachineKey extends Control {
    constructor(parent, layout, key, board, width, height, codes) {
        const rects = keyRects(key);
        const left = Math.min(...rects.map((r) => r.x)) * width;
        const top = Math.min(...rects.map((r) => r.y)) * height;
        const right = Math.max(...rects.map((r) => r.x + r.w)) * width;
        const bottom = Math.max(...rects.map((r) => r.y + r.h)) * height;
        super(parent, left, top, right - left, bottom - top);

        this.rects = rects;
        this.board = board;
        this.boardW = width;
        this.boardH = height;
        this.seam = paletteFor(layout).case;
        const win = parent.win;

        this.on_begin = this.on_enter = () => {
            win.pointerKey = this;
            pressKey(codes, true);
        }

        this.on_end = this.on_leave = () => {
            if (win.pointerKey === this) win.pointerKey = null;
            pressKey(codes, false);
        }
    }

    isPointerInside(x, y) {
        return this.rects.some((r) => (
            x >= r.x * this.boardW && x <= (r.x + r.w) * this.boardW
            && y >= r.y * this.boardH && y <= (r.y + r.h) * this.boardH
        ));
    }

    onDraw(ctx) {
        if (!this.pressed) return;
        drawKeyPressed(ctx, this.board, {
            rects: this.rects,
            width: this.boardW,
            height: this.boardH,
            seam: this.seam,
        });
    }
}

/**
 * Draw the on-screen keyboard and wire it to the emulator.
 *
 * @param {Number} width canvas width, in pixels
 * @param {String} keystr the keys to draw, when a game names its own
 * @param {String} layout the machine's keyboard, when it does not
 * @returns {Function} cleanup for the host effect
 */
function renderKeyboard(width, keystr, layout) {
    const win = new SingleWindow('virtkeys');
    // Every drawable key, with the matrix positions it holds down.
    const keys = [];

    layoutKeyboard(win, width, keystr, layout, (btn, positions) => {
        btn.positions = positions;
        keys.push(btn);
    });

    win._onload();

    // Mirror the machine's keyboard matrix onto the on-screen keys: the
    // emulator broadcasts every matrix transition it feeds the core
    // (zx-matrix-key from GoEmulator.setMatrixKey), already translated from
    // the PC keyboard — so Backspace lights CAPS SHIFT + 0 and '.' lights
    // SYMBOL SHIFT + M, exactly the keys the machine sees. Events only flow
    // while the emulator is trapping keys (or from the virtual keys), and
    // the emulator releases everything on focus loss, so no key can stick.
    // Render-only: the key callbacks never fire from here.
    //
    // heldKeys decides which of the drawn keys that accounts for: pressing
    // EDIT lights EDIT alone, not EDIT and CAPS SHIFT and 1.
    const down = new Set();
    const reflect = (evt) => {
        const {row, mask, down: isDown} = evt.detail;
        const key = matrixKey(row, mask);
        if (isDown) down.add(key); else down.delete(key);

        const held = heldKeys(keys, down, win.pointerKey);
        let redraw = false;
        for (const btn of keys) {
            const lit = held.has(btn);
            if (btn.pressed !== lit) {
                btn.pressed = lit;
                redraw = true;
            }
        }
        if (redraw) {
            win.requestRedraw();
            win.redrawIfRequested();
        }
    };
    document.addEventListener('zx-matrix-key', reflect);

    // Cleanup for the host effect: the reflection listener is document-
    // level and must not outlive this keyboard instance.
    return () => {
        document.removeEventListener('zx-matrix-key', reflect);
        win.destroy();
    };
}

// Lay out whichever keyboard is wanted: the machine's own, or the keys a game
// named with the "k" parameter — the 48K's rubber keys in whatever rows it
// asked for. The keyboard is drawn once into an offscreen canvas and each key
// is an invisible control over the key it can see, so an idle keyboard costs
// one drawImage.
function layoutKeyboard(win, width, keystr, layoutName, registerKey) {
    const layout = (keystr && layoutFromKeystr(keystr)) || LAYOUTS[layoutName || 'rubber'];
    const height = Math.round(width * layout.aspect);
    const board = buildKeyboard(layout, width, height, (w, h) => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        return canvas;
    });

    win.bgColor = paletteFor(layout).case;
    win.setTargetSize(width, height);
    new KeyboardImage(win, board, width, height);

    for (const key of layout.keys) {
        const action = KEY_ACTIONS[baseKeyId(key.id)];
        const btn = new MachineKey(win, layout, key, board, width, height, action.codes);
        registerKey(btn, action.matrix);
    }
}
