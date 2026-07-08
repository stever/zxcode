import React, {useEffect} from "react";
import PropTypes from "prop-types";
import {ImageButton, SingleWindow} from "../lib/canvasgui";

Keyboard.propTypes = {
    cssWidth: PropTypes.number,
    cssHeight: PropTypes.number,
    keystr: PropTypes.string,
    rounded: PropTypes.bool
}

// The keyboard is drawn once at this internal resolution and then CSS-scaled to
// whatever size the responsive layout asks for. PointerEventHandler maps touches
// back through the internal/CSS scale ratio, so scaling is safe.
const BASE_WIDTH = 640;

export function Keyboard(props) {
    const keystr = props.keystr;

    useEffect(() => {
        return renderKeyboard(BASE_WIDTH, keystr);
    }, [keystr]);

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

// _: [space]        space
// e: [enter]        enter
// c: [caps   shift] shift
// s: [symbol shift] ctrl
//
const keyCodes = {
    '0': 48, '1': 49, '2': 50, '3': 51, '4': 52,
    '5': 53, '6': 54, '7': 55, '8': 56, '9': 57,
    A: 65, B: 66, C: 67, D: 68, E: 69,
    F: 70, G: 71, H: 72, I: 73, J: 74,
    K: 75, L: 76, M: 77, N: 78, O: 79,
    P: 80, Q: 81, R: 82, S: 83, T: 84,
    U: 85, V: 86, W: 87, X: 88, Y: 89,
    Z: 90, e: 13, c: 16, s: 17, _: 32,
};

const imgExceptions = {
    e: 'ENT',
    c: 'CAP',
    s: 'SYM',
    _: 'SPC',
}

// Spectrum keyboard matrix position (row, mask) of each drawable key — must
// match the emulator's SPECCY table (packages/emulator KeyboardHandler.js).
// Used to mirror the machine's real key state onto the on-screen keys.
const matrixByCh = {
    '1': [3, 1], '2': [3, 2], '3': [3, 4], '4': [3, 8], '5': [3, 16],
    '6': [4, 16], '7': [4, 8], '8': [4, 4], '9': [4, 2], '0': [4, 1],
    Q: [2, 1], W: [2, 2], E: [2, 4], R: [2, 8], T: [2, 16],
    Y: [5, 16], U: [5, 8], I: [5, 4], O: [5, 2], P: [5, 1],
    A: [1, 1], S: [1, 2], D: [1, 4], F: [1, 8], G: [1, 16],
    H: [6, 16], J: [6, 8], K: [6, 4], L: [6, 2], e: [6, 1],
    c: [0, 1], Z: [0, 2], X: [0, 4], C: [0, 8], V: [0, 16],
    B: [7, 16], N: [7, 8], M: [7, 4], s: [7, 2], _: [7, 1],
};

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
    constructor(parent, x, y, w, h, suffix, keyCode) {
        super(parent, x, y, w, h, '/keys/key' + suffix + '.png', '/keys/keyNONE.png');
        this.keyCode = keyCode;
        this.face = FACE_OVERRIDES[suffix] || FACE;

        this.on_begin = this.on_enter = function () {
            simulateKey(keyCode, 'down');
        }

        this.on_end = this.on_leave = function () {
            simulateKey(keyCode, 'up');
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

function renderKeyboard(width, keystr) {
    if (!keystr) {
        keystr = '1234567890,QWERTYUIOP,ASDFGHJKLe,cZXCVBNMs_';
        // let keystr = '-W-P,ASDe,123456789M';    // snake
        // let keystr = 'GH-e,OP-Z';    // manic miner
        // let keystr = 'OPeZ'; // manic miner simple

        const url = new URL(window.location.href);
        for (const [key, value] of url.searchParams) {
            if (key === 'k') {
                keystr = value;
            }
        }
    }

    let height = 0;

    const btnrows = [];
    const buttonsByMatrix = {};

    const keyrows = keystr.split(',');
    for (let j = 0; j < keyrows.length; j++) {
        const keyrow = keyrows[j];

        let rowlen = keyrow.length;
        if (rowlen === 0) continue;
        if (rowlen > 10) rowlen = 10;

        const d = width / rowlen;
        const btnrow = {d: d, chs: []};

        for (let i = 0; i < rowlen; i++) {
            let ch = keyrow.charAt(i);

            if (!(ch in keyCodes)) {
                ch = '-';
            }

            btnrow.chs.push(ch);
        }

        btnrows.push(btnrow);
        height += d;
    }

    // console.log(btnrows)

    const win = new SingleWindow('virtkeys');
    win.setTargetSize(width, height);

    let x = 0;
    let y = 0;
    for (let j = 0; j < btnrows.length; j++) {
        const btnrow = btnrows[j];
        const d = btnrow.d;

        x = 0;
        for (let i = 0; i < btnrow.chs.length; i++) {
            const ch = btnrow.chs[i];

            if (ch === '-') {
                new ImageButton(win, x, y, d, d, '/keys/keyNONE.png', '/keys/keyNONE.png');
            } else {
                let suffix = ch;

                if (suffix in imgExceptions) {
                    suffix = imgExceptions[ch];
                }

                let code = keyCodes[ch];
                const btn = new MyImageButton(win, x, y, d, d, suffix, code);
                const [row, mask] = matrixByCh[ch];
                const matrixKey = row * 256 + mask;
                (buttonsByMatrix[matrixKey] = buttonsByMatrix[matrixKey] || []).push(btn);

                // console.log(x, y, d, d, suffix, code);
            }

            x += d;
        }

        y += d;
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
    const reflect = (evt) => {
        const {row, mask, down} = evt.detail;
        const buttons = buttonsByMatrix[row * 256 + mask];
        if (!buttons) return;
        let redraw = false;
        for (const btn of buttons) {
            if (btn.pressed !== down) {
                btn.pressed = down;
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
    };
}
