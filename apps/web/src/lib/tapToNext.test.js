import {parseTAP, tapToNext} from "../../../../packages/emulator/src/zxgo/tapToNext";

// TAP building blocks (little-endian length prefix + flag + payload + checksum).
function tapBlock(flag, payload) {
    const block = new Uint8Array(2 + 1 + payload.length + 1);
    const len = payload.length + 2;
    block[0] = len & 0xFF;
    block[1] = len >> 8;
    block[2] = flag;
    block.set(payload, 3);
    let sum = flag;
    for (const b of payload) sum ^= b;
    block[block.length - 1] = sum;
    return block;
}

function header(type, name, dataLen, param1, param2) {
    const h = new Uint8Array(17);
    h[0] = type;
    for (let i = 0; i < 10; i++) h[1 + i] = i < name.length ? name.charCodeAt(i) : 0x20;
    h[11] = dataLen & 0xFF; h[12] = dataLen >> 8;
    h[13] = param1 & 0xFF; h[14] = param1 >> 8;
    h[15] = param2 & 0xFF; h[16] = param2 >> 8;
    return h;
}

function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

// The sjasmplus SAVETAP shape, as produced by 1.23.1 for DEVICE
// ZXSPECTRUM48 + ORG $8000: BASIC bootstrap, a 52-byte second-stage tape
// loader at $5E00 whose tail is the (entry, org, length) parameter table,
// then the program as a HEADERLESS dump of $8000-$FFFE.
function sjasmplusTap(program, org, entry) {
    const dump = new Uint8Array(0x7FFF);
    dump.set(program, 0); // program at org; rest zero-fill
    const loader = new Uint8Array(52);
    loader[0] = 0x3E; // enough opcodes to look like code; the tail matters
    const w = (off, v) => { loader[off] = v & 0xFF; loader[off + 1] = v >> 8; };
    w(52 - 6, entry);
    w(52 - 4, org);
    w(52 - 2, dump.length);
    const basic = new Uint8Array([0, 10, 4, 0, 0xF9, 0xC0, 0xB0, 0x22]); // RANDOMIZE USR VAL "
    return concat([
        tapBlock(0x00, header(0, 'LOADER', basic.length, 10, basic.length)),
        tapBlock(0xFF, basic),
        tapBlock(0x00, header(3, 'loader', loader.length, 0x5E00, 0)),
        tapBlock(0xFF, loader),
        tapBlock(0xFF, dump),
    ]);
}

describe("tapToNext sjasmplus SAVETAP translation", () => {
    test("ships the headerless program, not the tape loader", () => {
        const program = new Uint8Array([0x3E, 0x02, 0xCD, 0x01, 0x16, 0x18, 0xFE]);
        const tap = sjasmplusTap(program, 0x8000, 0x8000);
        const next = tapToNext(tap);
        expect(next.kind).toBe('nex');
        // NEX layout: 512-byte header, then banks in canonical order — the
        // $8000 org lands at the start of bank 2, the first bank here.
        expect(next.data[14] | (next.data[15] << 8)).toBe(0x8000); // PC
        expect(Array.from(next.data.subarray(512, 512 + program.length)))
            .toEqual(Array.from(program));
    });

    test("entry from the loader table wins (USR elsewhere in the dump)", () => {
        const program = new Uint8Array(0x30);
        program[0x20] = 0xC9; // entry point deeper in
        const tap = sjasmplusTap(program, 0x8000, 0x8020);
        const next = tapToNext(tap);
        expect(next.data[14] | (next.data[15] << 8)).toBe(0x8020);
    });

    test("parseTAP surfaces headerless blocks as type -1", () => {
        const tap = sjasmplusTap(new Uint8Array(4), 0x8000, 0x8000);
        const entries = parseTAP(tap);
        expect(entries.map((e) => e.type)).toEqual([0, 3, -1]);
        expect(entries[2].data.length).toBe(0x7FFF);
    });

    test("pasmo-style tape (headered CODE at org) keeps the generic path", () => {
        const code = new Uint8Array([0x00, 0x18, 0xFE]);
        const basic = new Uint8Array([0, 10, 8, 0, 0xF9, 0xC0, 0x33, 0x32, 0x37, 0x36, 0x38, 0x0D]); // USR 32768
        const tap = concat([
            tapBlock(0x00, header(0, 'loader', basic.length, 10, basic.length)),
            tapBlock(0xFF, basic),
            tapBlock(0x00, header(3, 'output.tap', code.length, 0x8000, 0x8000)),
            tapBlock(0xFF, code),
        ]);
        const next = tapToNext(tap);
        expect(next.kind).toBe('nex');
        // Small high-org code enters through the USR-environment stub in
        // bank 0 at $C000 (pre-existing behaviour, unchanged by the
        // sjasmplus path).
        expect(next.data[14] | (next.data[15] << 8)).toBe(0xC000);
        expect(Array.from(next.data.subarray(512, 512 + code.length)))
            .toEqual(Array.from(code));
    });
});
