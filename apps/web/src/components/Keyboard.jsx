import React, {useEffect} from "react";
import PropTypes from "prop-types";
import {ImageButton, Control, SingleWindow} from "../lib/canvasgui";
import {useSelector} from "react-redux";
import {
    KEY_ACTIONS, LAYOUTS, PALETTE, baseKeyId, buildKeyboard, drawKeyboard, drawKeyPressed,
    heldKeys, keyRects, matrixKey,
} from "@zxplay/ui/keyboard";
import {resolveKeyboard} from "../lib/layout";

Keyboard.propTypes = {
    width: PropTypes.number
}

// The machine keyboards are drawn at twice the nominal width: the printed
// legends are small, and the extra resolution is what keeps them sharp once the
// canvas is scaled down to the width the layout asked for.
const KEYBOARD_SCALE = 2;

export function Keyboard(props) {
    const width = props.width || 960;
    const isMobile = useSelector(state => state?.window.isMobile);
    // The keyboard follows the machine: the 128K gets the Spectrum+ /
    // toastrack layout, the Next its own, and the 48K its rubber keys.
    const machine = useSelector(state => state?.app.machine);
    const layout = resolveKeyboard(machine).layout;

    // Redraw at the current (responsive) width so a viewport/orientation change
    // keeps every key on-screen.
    useEffect(() => {
        return renderKeyboard(layout ? width * KEYBOARD_SCALE : width, layout);
    }, [width, layout]);

    let style = {
        imageRendering: 'auto',
        display: 'block',
        width: `${width}px`
    };

    if (!isMobile) {
        style.borderRadius = '0 0 5px 5px';
    }

    return (
        // preventDefault on mousedown keeps a click on the virtual keys from
        // blurring the emulator canvas (focus-scoped keyboard capture).
        <div id="guiparent" onMouseDown={(e) => e.preventDefault()} style={{
            width: `${width}px`,
            margin: 0,
            backgroundColor: "#444",
            padding: 0,
        }}>
            <canvas
                id="virtkeys"
                width={width}
                style={style}
            />
        </div>
    )
}

// _: [space]        space
// e: [enter]        enter
// c: [caps   shift] shift
// s: [symbol shift] ctrl
//
// The characters a "k" key string may name, mapped to the ids of KEY_ACTIONS.
const keystrKeys = {
    '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
    '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
    A: 'A', B: 'B', C: 'C', D: 'D', E: 'E',
    F: 'F', G: 'G', H: 'H', I: 'I', J: 'J',
    K: 'K', L: 'L', M: 'M', N: 'N', O: 'O',
    P: 'P', Q: 'Q', R: 'R', S: 'S', T: 'T',
    U: 'U', V: 'V', W: 'W', X: 'X', Y: 'Y',
    Z: 'Z', e: 'ENTER', c: 'CAPS', s: 'SYMBOL', _: 'SPACE',
};

const imgExceptions = {
    ENTER: 'ENT',
    CAPS: 'CAP',
    SYMBOL: 'SYM',
    SPACE: 'SPC',
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

// Geometry of the 132x132 key artwork, as fractions of the image size. The
// art is drawn slightly from below: FACE is the complete rubber cap
// INCLUDING its darker bottom lip (the subtle 3D extrusion), and below
// that lies only the drop shadow, fading into panel at `foot`.
// strip: a texture band used to erase the shadow when the key is pressed
// flat (clean panel for standard keys; for the striped ENTER and BREAK
// SPACE, a band just below the footprint so the stripes continue).
const FACE = {
    x: 19 / 132, y: 32 / 132, w: 93 / 132, h: 65 / 132,
    foot: 104 / 132, strip: {y: 25 / 132, h: 5 / 132},
};
// ENTER and BREAK SPACE have oversized caps.
const FACE_OVERRIDES = {
    ENT: {
        x: 20 / 132, y: 32 / 132, w: 96 / 132, h: 66 / 132,
        foot: 102 / 132, strip: {y: 103 / 132, h: 5 / 132},
    },
    SPC: {
        x: 17 / 132, y: 33 / 132, w: 105 / 132, h: 65 / 132,
        foot: 102 / 132, strip: {y: 103 / 132, h: 5 / 132},
    },
};
// How far the whole cap slides down when pressed — into the space its own
// drop shadow occupied. The cap keeps its exact size and silhouette.
const SINK = 3 / 132;
// A strip of clean panel just above the cap, used to backfill the area the
// face vacates when it sinks (below the printed keyword legends).
const PANEL_STRIP = {y: 25 / 132, h: 5 / 132};

class MyImageButton extends ImageButton {
    constructor(parent, x, y, w, h, suffix, codes) {
        super(parent, x, y, w, h, '/keys/key' + suffix + '.png', '/keys/keyNONE.png');
        this.face = FACE_OVERRIDES[suffix] || FACE;
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

    // Pressed keys flatten against the panel: the complete cap (bottom lip
    // and all) slides down into the space its drop shadow occupied, and the
    // shadow itself is erased — pressed flush, nothing clipped. Stretched
    // panel texture backfills the strip vacated at the top. A whisper of
    // shade keeps the state readable at a glance.
    onDraw(ctx) {
        const img = this.imgup;
        ctx.drawImage(img, this.x, this.y, this.w, this.h);
        if (!this.pressed) return;

        const iw = img.naturalWidth || 132;
        const ih = img.naturalHeight || 132;
        const face = this.face;
        const sx = iw * face.x, sy = ih * face.y;
        const sw = iw * face.w, sh = ih * face.h;
        const dx = this.x + this.w * face.x, dy = this.y + this.h * face.y;
        const dw = this.w * face.w, dh = this.h * face.h;
        const sink = this.h * SINK;

        // Panel revealed above the sinking cap (start a touch higher to
        // cover the original cap edge's anti-aliasing).
        const reveal = this.h * (2 / 132);
        ctx.drawImage(img,
            sx, ih * PANEL_STRIP.y, sw, ih * PANEL_STRIP.h,
            dx, dy - reveal, dw, sink + reveal * 2);

        // Erase the drop shadow below the cap (a little wider than the
        // cap — the shadow bleeds sideways).
        const bandY = dy + dh + sink - this.h * (1 / 132);
        const bandB = this.y + this.h * face.foot;
        const padS = iw * (2 / 132), padD = this.w * (2 / 132);
        if (bandB > bandY) {
            ctx.drawImage(img,
                sx - padS, ih * face.strip.y, sw + padS * 2, ih * face.strip.h,
                dx - padD, bandY, dw + padD * 2, bandB - bandY);
        }

        // The complete cap, slid down into its old shadow, flat on the panel.
        ctx.drawImage(img, sx, sy, sw, sh, dx, dy + sink, dw, dh);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
        ctx.fillRect(dx, dy + sink, dw, dh);
    }
}

// The machine's keyboard, drawn once into an offscreen canvas and blitted
// behind the keys. It never takes a pointer: the keys sit on top of it and do
// that.
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

// One key of a machine keyboard. There is nothing to draw until it is held —
// the drawn keyboard behind it already shows the key — and it hit-tests against
// the key's own rectangles rather than its bounding box, or the notch of the
// L-shaped ENTER would steal the corner of the key beside it.
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
        this.seam = PALETTE.case;
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
 * @param {String} layout a machine keyboard layout ('plus' or 'next'), or null
 *                        for the 48K's rubber keys
 * @returns {Function} cleanup for the host effect
 */
function renderKeyboard(width, layout) {
    const win = new SingleWindow('virtkeys');
    // Every drawable key, with the matrix positions it holds down.
    const keys = [];
    const registerKey = (btn, positions) => {
        btn.positions = positions;
        keys.push(btn);
    };

    if (layout) {
        layoutMachineKeyboard(win, width, LAYOUTS[layout], registerKey);
    } else {
        layoutRubberKeyboard(win, width, registerKey);
    }

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

    return () => {
        document.removeEventListener('zx-matrix-key', reflect);
        win.destroy();
    };
}

// The 48K's rubber keys, or the subset the "k" parameter named: a uniform
// square grid of photographic key art, at most ten to a row.
function layoutRubberKeyboard(win, width, registerKey) {
    let keystr = '1234567890,QWERTYUIOP,ASDFGHJKLe,cZXCVBNMs_';
    // let keystr = '-W-P,ASDe,123456789M';    // snake
    // let keystr = 'GH-e,OP-Z';    // manic miner
    // let keystr = 'OPeZ'; // manic miner simple

    const url = new URL(window.location.href);
    for (const [key, value] of url.searchParams) {
        if (key === 'k') {
            keystr = value;
        }
    }

    const rows = keystr.split(',').filter((row) => row.length > 0);
    const height = rows.reduce((total, row) => total + width / Math.min(row.length, 10), 0);

    win.setTargetSize(width, height);

    let y = 0;
    for (const row of rows) {
        const cols = Math.min(row.length, 10);
        const d = width / cols;

        for (let i = 0; i < cols; i++) {
            const id = keystrKeys[row.charAt(i)];
            const x = i * d;

            if (!id) {
                new ImageButton(win, x, y, d, d, '/keys/keyNONE.png', '/keys/keyNONE.png');
                continue;
            }

            const action = KEY_ACTIONS[id];
            const suffix = imgExceptions[id] || id;
            const btn = new MyImageButton(win, x, y, d, d, suffix, action.codes);
            registerKey(btn, action.matrix);
        }

        y += d;
    }
}

// A machine's own keyboard: the Spectrum+ / 128K toastrack or the Next. The
// keyboard is drawn once into an offscreen canvas and each key is an invisible
// control over the key it can see, so an idle keyboard costs one drawImage.
function layoutMachineKeyboard(win, width, layout, registerKey) {
    const height = Math.round(width * layout.aspect);
    const board = buildKeyboard(layout, width, height, (w, h) => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        return canvas;
    });

    win.bgColor = PALETTE.case;
    win.setTargetSize(width, height);
    new KeyboardImage(win, board, width, height);

    for (const key of layout.keys) {
        const action = KEY_ACTIONS[baseKeyId(key.id)];
        const btn = new MachineKey(win, layout, key, board, width, height, action.codes);
        registerKey(btn, action.matrix);
    }
}
