// The machine keyboard tables are shared data (packages/ui/keyboard) with no
// canvas involved, so the things that would go wrong silently — a key whose
// rectangle overlaps its neighbour or falls outside the photograph, an action
// no layout entry resolves to, a matrix position that does not match the
// engine, or a single press lighting several keys — are checked here.

import {
    KEY_ACTIONS, LAYOUTS, baseKeyId, heldKeys, keyRects, layoutAspect, layoutForMachine, matrixKey,
} from "@zxplay/ui/keyboard";

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

describe.each(layouts)('%s layout', (name, layout) => {
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

    it('resolves every key to an action', () => {
        for (const key of layout.keys) {
            expect(KEY_ACTIONS[baseKeyId(key.id)]).toBeDefined();
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

    it('keeps every key inside the photograph', () => {
        for (const cell of cells) {
            expect(cell.x).toBeGreaterThanOrEqual(0);
            expect(cell.y).toBeGreaterThanOrEqual(0);
            expect(cell.x + cell.w).toBeLessThanOrEqual(1.0001);
            expect(cell.y + cell.h).toBeLessThanOrEqual(1.0001);
        }
    });

    it('covers the whole photograph', () => {
        // Every part of the picture is a key: a gap would be a dead spot the
        // user can see but not press.
        const right = Math.max(...cells.map((c) => c.x + c.w));
        const bottom = Math.max(...cells.map((c) => c.y + c.h));
        expect(right).toBeCloseTo(1, 3);
        expect(bottom).toBeCloseTo(1, 3);
    });

    it('names the photograph and the shape it draws at', () => {
        expect(layout.image).toMatch(/^\/keys\/.*\.webp$/);
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

describe('layoutForMachine', () => {
    it('gives the 128K the Spectrum+ / toastrack keyboard', () => {
        expect(layoutForMachine(128)).toBe('plus');
        expect(layoutForMachine('128')).toBe('plus');
    });

    it('gives the Next its own', () => {
        expect(layoutForMachine('next')).toBe('next');
    });

    it('leaves the 48K on its rubber keys', () => {
        expect(layoutForMachine(48)).toBeNull();
        expect(layoutForMachine(undefined)).toBeNull();
    });
});
