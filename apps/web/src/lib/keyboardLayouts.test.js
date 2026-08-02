// The machine keyboard tables are shared data (packages/ui/keyboard) with no
// canvas involved, so the things that would go wrong silently — a key whose
// rectangle overlaps its neighbour or falls off the keyboard, a legend or an
// action no layout entry resolves to, a matrix position that does not match the
// engine, or a single press lighting several keys — are checked here.

import {
    KEY_ACTIONS, KEYBOARD_CHOICES, LAYOUTS, baseKeyId, heldKeys, keyRects, layoutAspect,
    layoutForChoice, layoutForMachine, layoutFromKeystr, legendsFor, matrixKey,
} from "@zxplay/ui/keyboard";
import {DEFAULT_KEYSTR, keyboardAspect, resolveKeyboard} from "./layout";

// The two 58-key machines. The 48K's rubber keyboard is a different beast and
// is checked on its own below.
const machines = [['plus', LAYOUTS.plus], ['next', LAYOUTS.next]];
const layouts = Object.entries(LAYOUTS);

// The 40 keys of the Spectrum matrix.
const MATRIX_KEYS = [
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
    'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P',
    'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'ENTER',
    'CAPS', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'SYMBOL', 'SPACE',
];

// The dedicated keys the Spectrum+ / Next membrane folds onto shift
// combinations, plus the second CAPS and SYMBOL SHIFT.
const DEDICATED = [
    'BREAK', 'DELETE', 'EDIT', 'GRAPH', 'EXTEND', 'CAPSLOCK', 'TRUEVIDEO', 'INVVIDEO',
    'LEFT', 'RIGHT', 'UP', 'DOWN', 'SEMI', 'QUOTE', 'COMMA', 'PERIOD',
];

const overlaps = (a, b) => (
    a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6
    && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6
);

describe.each(machines)('%s layout', (name, layout) => {
    const cells = layout.keys.flatMap((key) => keyRects(key).map((r) => ({...r, id: key.id})));

    it('carries all 58 keys of the machine', () => {
        expect(layout.keys).toHaveLength(MATRIX_KEYS.length + DEDICATED.length + 2);
    });

    it('places every matrix key exactly once', () => {
        const ids = layout.keys.map((key) => key.id);
        for (const id of MATRIX_KEYS) {
            expect(ids.filter((k) => k === id)).toEqual([id]);
        }
    });

    it('places every dedicated key, and a second CAPS and SYMBOL SHIFT', () => {
        const ids = layout.keys.map((key) => key.id);
        for (const id of [...DEDICATED, 'CAPS2', 'SYMBOL2']) {
            expect(ids).toContain(id);
        }
    });

    it('resolves every key to an action and a legend', () => {
        const legends = legendsFor(name);
        for (const key of layout.keys) {
            expect(KEY_ACTIONS[baseKeyId(key.id)]).toBeDefined();
            expect(legends[baseKeyId(key.id)]).toBeDefined();
        }
    });

    it('lays every key on a quarter of a key width', () => {
        // Both machines measure that way, and it is what lets one grid serve
        // both — so a key off the quarter is a transcription slip.
        for (const key of layout.keys) {
            for (const r of keyRects(key)) {
                expect((r.x * layout.units * 4) % 1).toBeCloseTo(0, 6);
                expect((r.w * layout.units * 4) % 1).toBeCloseTo(0, 6);
            }
        }
    });

    it('gives ENTER the two rectangles of its L', () => {
        const enter = layout.keys.find((key) => key.id === 'ENTER');
        expect(enter.rects).toHaveLength(2);
        // The narrow piece sits beside P, the wide one a row below beside L.
        const [top, bottom] = enter.rects;
        expect(bottom.y).toBeGreaterThan(top.y);
        expect(bottom.w).toBeGreaterThan(top.w);
        // They meet: the renderer keys off that to travel the L as one piece
        // and to leave a gap only where the lower rectangle is really exposed.
        expect(top.y + top.h).toBeCloseTo(bottom.y, 6);
        expect(bottom.x).toBeLessThan(top.x);
        expect(bottom.x + bottom.w).toBeCloseTo(top.x + top.w, 6);
    });

    it('does not overlap keys', () => {
        for (let i = 0; i < cells.length; i++) {
            for (let j = i + 1; j < cells.length; j++) {
                if (cells[i].id === cells[j].id) continue;
                expect(`${cells[i].id}/${cells[j].id}: ${overlaps(cells[i], cells[j])}`)
                    .toBe(`${cells[i].id}/${cells[j].id}: false`);
            }
        }
    });

    it('keeps every key inside the keyboard', () => {
        for (const cell of cells) {
            expect(cell.x).toBeGreaterThanOrEqual(0);
            expect(cell.y).toBeGreaterThanOrEqual(0);
            expect(cell.x + cell.w).toBeLessThanOrEqual(1.0001);
            expect(cell.y + cell.h).toBeLessThanOrEqual(1.0001);
        }
    });

    it('covers the whole keyboard', () => {
        // Every part of it is a key: a gap would be a dead spot the user can
        // see but not press. Each row must fill the width, too.
        const right = Math.max(...cells.map((c) => c.x + c.w));
        const bottom = Math.max(...cells.map((c) => c.y + c.h));
        expect(right).toBeCloseTo(1, 6);
        expect(bottom).toBeCloseTo(1, 6);
        for (let row = 0; row < layout.rows; row++) {
            const width = cells.filter((c) => Math.abs(c.y - row / layout.rows) < 1e-6)
                .reduce((total, c) => total + c.w, 0);
            expect(width).toBeCloseTo(1, 6);
        }
    });

    it('draws at the shape the app lays out for', () => {
        expect(layoutAspect(name)).toBe(layout.aspect);
        expect(layout.aspect).toBeGreaterThan(0.3);
        expect(layout.aspect).toBeLessThan(0.5);
    });
});

describe('key actions', () => {
    it('gives every dedicated key a shift plus a key', () => {
        for (const id of DEDICATED) {
            const action = KEY_ACTIONS[id];
            expect(action.codes).toHaveLength(2);
            expect(action.matrix).toHaveLength(2);
            // CAPS SHIFT (row 0, bit 0) or SYMBOL SHIFT (row 7, bit 1) leads.
            expect([16, 17]).toContain(action.codes[0]);
        }
    });

    it('gives every matrix key one code and one position', () => {
        for (const id of MATRIX_KEYS) {
            expect(KEY_ACTIONS[id].codes).toHaveLength(1);
            expect(KEY_ACTIONS[id].matrix).toHaveLength(1);
        }
    });

    it('holds each matrix position at most once per key', () => {
        for (const action of Object.values(KEY_ACTIONS)) {
            const keys = action.matrix.map(([row, mask]) => matrixKey(row, mask));
            expect(new Set(keys).size).toBe(keys.length);
        }
    });

    it('uses matrix positions that exist', () => {
        for (const action of Object.values(KEY_ACTIONS)) {
            for (const [row, mask] of action.matrix) {
                expect(row).toBeGreaterThanOrEqual(0);
                expect(row).toBeLessThanOrEqual(7);
                expect([0x01, 0x02, 0x04, 0x08, 0x10]).toContain(mask);
            }
        }
    });

    it('presses the same positions for a dedicated key as its parts do', () => {
        // EDIT is CAPS SHIFT + 1, DELETE is CAPS SHIFT + 0, ';' is SYMBOL
        // SHIFT + O — the combinations the membrane folds into the matrix.
        expect(KEY_ACTIONS.EDIT.matrix).toEqual([
            ...KEY_ACTIONS.CAPS.matrix, ...KEY_ACTIONS['1'].matrix]);
        expect(KEY_ACTIONS.DELETE.matrix).toEqual([
            ...KEY_ACTIONS.CAPS.matrix, ...KEY_ACTIONS['0'].matrix]);
        expect(KEY_ACTIONS.BREAK.matrix).toEqual([
            ...KEY_ACTIONS.CAPS.matrix, ...KEY_ACTIONS.SPACE.matrix]);
        expect(KEY_ACTIONS.EXTEND.matrix).toEqual([
            ...KEY_ACTIONS.CAPS.matrix, ...KEY_ACTIONS.SYMBOL.matrix]);
        expect(KEY_ACTIONS.SEMI.matrix).toEqual([
            ...KEY_ACTIONS.SYMBOL.matrix, ...KEY_ACTIONS.O.matrix]);
        expect(KEY_ACTIONS.PERIOD.matrix).toEqual([
            ...KEY_ACTIONS.SYMBOL.matrix, ...KEY_ACTIONS.M.matrix]);
    });
});

describe('which keys light up', () => {
    // Stand-ins for the drawn keys: heldKeys only cares about their positions.
    const key = (id) => ({id, positions: KEY_ACTIONS[baseKeyId(id)].matrix});
    const down = (...ids) => new Set(
        ids.flatMap((id) => KEY_ACTIONS[id].matrix.map(([r, m]) => matrixKey(r, m))));
    const lit = (keys, held, pointer) =>
        [...heldKeys(keys, held, pointer)].map((k) => k.id).sort();

    const board = ['EDIT', 'CAPS', 'CAPS2', '1', 'DELETE', '0', 'SYMBOL', 'O', 'SEMI'].map(key);

    it('lights one key for one press', () => {
        expect(lit(board, down('1'))).toEqual(['1']);
    });

    it('lights EDIT alone, not EDIT and CAPS SHIFT and 1', () => {
        expect(lit(board, down('EDIT'))).toEqual(['EDIT']);
    });

    it('lights DELETE alone, not DELETE and CAPS SHIFT and 0', () => {
        expect(lit(board, down('DELETE'))).toEqual(['DELETE']);
    });

    it("lights ';' alone, not ';' and SYMBOL SHIFT and O", () => {
        expect(lit(board, down('SEMI'))).toEqual(['SEMI']);
    });

    it('lights CAPS SHIFT on its own when only CAPS SHIFT is down', () => {
        // Both CAPS SHIFT keys are the same position, so both light when the
        // press came from the host keyboard: the matrix cannot say which.
        expect(lit(board, down('CAPS'))).toEqual(['CAPS', 'CAPS2']);
    });

    it('lights only the CAPS SHIFT the pointer is on', () => {
        const right = board.find((k) => k.id === 'CAPS2');
        expect(lit(board, down('CAPS'), right)).toEqual(['CAPS2']);
    });

    it('still lights the parts when the board has no key for the pair', () => {
        // The 48K's rubber keyboard draws no DELETE, so Backspace has to show
        // as CAPS SHIFT and 0 — which is what the machine sees.
        const rubber = ['CAPS', '0', '1'].map(key);
        expect(lit(rubber, down('DELETE'))).toEqual(['0', 'CAPS']);
    });

    it('lights nothing when nothing is down', () => {
        expect(lit(board, down())).toEqual([]);
    });
});

describe.each(layouts)('%s layout, whatever the machine', (name, layout) => {
    const cells = layout.keys.flatMap((key) => keyRects(key).map((r) => ({...r, id: key.id})));

    it('resolves every key to an action and a legend', () => {
        const legends = legendsFor(name);
        for (const key of layout.keys) {
            expect(KEY_ACTIONS[baseKeyId(key.id)]).toBeDefined();
            expect(legends[baseKeyId(key.id)]).toBeDefined();
        }
    });

    it('does not overlap keys, and covers the whole keyboard', () => {
        for (let i = 0; i < cells.length; i++) {
            for (let j = i + 1; j < cells.length; j++) {
                if (cells[i].id === cells[j].id) continue;
                expect(`${cells[i].id}/${cells[j].id}: ${overlaps(cells[i], cells[j])}`)
                    .toBe(`${cells[i].id}/${cells[j].id}: false`);
            }
        }
        expect(Math.max(...cells.map((c) => c.x + c.w))).toBeCloseTo(1, 6);
        expect(Math.max(...cells.map((c) => c.y + c.h))).toBeCloseTo(1, 6);
    });
});

describe('rubber layout', () => {
    const layout = LAYOUTS.rubber;

    it('carries the 48K\'s forty keys, ten to a row', () => {
        expect(layout.keys).toHaveLength(40);
        expect(layout.units).toBe(10);
        expect(layout.rows).toBe(4);
        for (const id of MATRIX_KEYS) expect(layout.keys.map((k) => k.id)).toContain(id);
    });

    it('has no dedicated keys — that machine has none', () => {
        const ids = layout.keys.map((key) => key.id);
        for (const id of DEDICATED) expect(ids).not.toContain(id);
    });

    it('gives every key one square cell', () => {
        for (const key of layout.keys) {
            expect(key.rects).toHaveLength(1);
            expect(key.rects[0].w).toBeCloseTo(0.1, 6);
            expect(key.rects[0].h).toBeCloseTo(0.25, 6);
        }
    });
});

describe('layoutFromKeystr', () => {
    it('lays out the keys a game named, and nothing else', () => {
        const layout = layoutFromKeystr('OPeZ');
        expect(layout.keys.map((k) => k.id)).toEqual(['O', 'P', 'ENTER', 'Z']);
        expect(layout.style).toBe('rubber');
        expect(layout.aspect).toBeCloseTo(1 / 4, 6);
    });

    it('gives a row of four keys bigger keys than a row of ten', () => {
        expect(layoutFromKeystr('OPeZ').keys[0].rects[0].w).toBeCloseTo(0.25, 6);
        expect(layoutFromKeystr('1234567890').keys[0].rects[0].w).toBeCloseTo(0.1, 6);
    });

    it('matches the full rubber keyboard when it names those keys', () => {
        const layout = layoutFromKeystr('1234567890,QWERTYUIOP,ASDFGHJKLe,cZXCVBNMs_');
        expect(layout.keys).toHaveLength(40);
        expect(layout.aspect).toBeCloseTo(LAYOUTS.rubber.aspect, 6);
    });

    it('skips a dash, which holds a place without drawing a key', () => {
        expect(layoutFromKeystr('-Q-').keys.map((k) => k.id)).toEqual(['Q']);
    });

    it('gives nothing back for an empty string', () => {
        expect(layoutFromKeystr('')).toBeNull();
    });
});

describe('every keyboard draws at one size', () => {
    it('gives the two layouts the same grid and the same aspect', () => {
        // #212: switching machine must not move anything on the page.
        expect(LAYOUTS.plus.units).toBe(LAYOUTS.next.units);
        expect(LAYOUTS.plus.rows).toBe(LAYOUTS.next.rows);
        expect(layoutAspect('plus')).toBe(layoutAspect('next'));
    });

    it('draws at the same shape as the 48K rubber keyboard', () => {
        // Which is the box all three share, so the 48K's four rows of ten
        // square keys set it.
        expect(layoutAspect('plus')).toBe(keyboardAspect(DEFAULT_KEYSTR));
        expect(layoutAspect('rubber')).toBe(keyboardAspect(DEFAULT_KEYSTR));
    });
});

describe('legends', () => {
    const plus = legendsFor('plus');
    const next = legendsFor('next');

    // O, P, N and M are the four whose SYMBOL SHIFT characters got keys of
    // their own on these machines, so they are not printed on the letter.
    const DEDICATED_SYMBOL = ['O', 'P', 'N', 'M'];

    it('prints a keyword, a symbol and the letter on every letter key', () => {
        for (const id of MATRIX_KEYS.filter((k) => /^[A-Z]$/.test(k))) {
            expect(plus[id].main).toBe(id);
            expect(plus[id].keyword).toBeTruthy();
            expect(plus[id].ext).toBeTruthy();
            expect(plus[id].extSym).toBeTruthy();
            if (!DEDICATED_SYMBOL.includes(id)) expect(plus[id].sym).toBeTruthy();
        }
    });

    it("does not print ; \" , . on the letters that have keys for them", () => {
        // The machines leave them off O, P, N and M because SEMI, QUOTE,
        // COMMA and PERIOD are keys in their own right. Only the printing
        // changes: SYMBOL SHIFT with the letter still types the character.
        for (const id of DEDICATED_SYMBOL) {
            expect(plus[id].sym).toBeUndefined();
            expect(next[id].sym).toBeUndefined();
        }
        for (const [letter, key] of [['O', 'SEMI'], ['P', 'QUOTE'], ['N', 'COMMA'], ['M', 'PERIOD']]) {
            expect(KEY_ACTIONS[key].matrix).toEqual([
                ...KEY_ACTIONS.SYMBOL.matrix, ...KEY_ACTIONS[letter].matrix]);
        }
    });

    it('prints a block graphic on keys 1-8 and none on 9 or 0', () => {
        for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8']) {
            expect(plus[digit].graphic).toBe(Number(digit));
        }
        expect(plus['9'].graphic).toBeUndefined();
        expect(plus['0'].graphic).toBeUndefined();
    });

    it('names every dedicated key', () => {
        for (const id of DEDICATED) {
            expect(plus[id].label || plus[id].main).toBeTruthy();
        }
    });

    it('gives the Next the wording it actually prints', () => {
        // The Next had room for words the Spectrum+ abbreviated.
        expect(plus['3'].ext).toBe('MGNTA');
        expect(next['3'].ext).toBe('MAGENTA');
        expect(plus.M.extSym).toBe('INVERS');
        expect(next.M.extSym).toBe('INVERSE');
    });

    it('leaves the rest of the table shared', () => {
        expect(next.Q).toEqual(plus.Q);
        expect(next.SPACE).toEqual(plus.SPACE);
    });
});

describe('layoutForMachine', () => {
    it('gives the 128K the Spectrum+ / toastrack keyboard', () => {
        expect(layoutForMachine(128)).toBe('plus');
        expect(layoutForMachine('128')).toBe('plus');
    });

    it('gives the Next its own', () => {
        expect(layoutForMachine('next')).toBe('next');
    });

    it('gives the 48K its rubber keys', () => {
        expect(layoutForMachine(48)).toBe('rubber');
        expect(layoutForMachine(undefined)).toBe('rubber');
    });
});
// #214: the keyboard follows the machine, but a machine can be running
// something its own keyboard does not suit, so the user can name one.
describe('choosing a keyboard', () => {
    it('offers every layout, plus following the machine', () => {
        expect(KEYBOARD_CHOICES[0]).toBe('auto');
        expect([...KEYBOARD_CHOICES].slice(1).sort()).toEqual(Object.keys(LAYOUTS).sort());
    });

    it('follows the machine when nothing is chosen', () => {
        for (const [machine, layout] of [[48, 'rubber'], [128, 'plus'], ['next', 'next']]) {
            expect(layoutForChoice('auto', machine)).toBe(layout);
            expect(layoutForChoice(undefined, machine)).toBe(layout);
        }
    });

    it('keeps the chosen keyboard whatever machine is selected', () => {
        for (const choice of ['rubber', 'plus', 'next']) {
            for (const machine of [48, 128, 'next']) {
                expect(layoutForChoice(choice, machine)).toBe(choice);
            }
        }
    });

    // A saved preference outlives the code that wrote it; a name no layout
    // answers to must not leave the app with no keyboard at all.
    it('falls back to the machine when the choice is not a keyboard', () => {
        for (const bad of ['toastrack', '', null, 'RUBBER']) {
            expect(layoutForChoice(bad, 128)).toBe('plus');
        }
    });

    it('is what the app asks resolveKeyboard for', () => {
        expect(resolveKeyboard(48).layout).toBe('rubber');
        expect(resolveKeyboard(48, 'auto').layout).toBe('rubber');
        expect(resolveKeyboard(48, 'next').layout).toBe('next');
        expect(resolveKeyboard('next', 'rubber').layout).toBe('rubber');
        // Every keyboard draws in the same box, so choosing one moves nothing.
        expect(resolveKeyboard(48, 'next').aspect).toBe(resolveKeyboard(48).aspect);
    });
});
