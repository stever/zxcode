import {tapDownloadFile} from "./tapDownload";

// Minimal TAP builder: a 19-byte header block paired with its data block,
// matching what parseTAP (packages/emulator tapToNext.js) expects. Checksums
// are not validated by the parser, so they are written as 0.
function tapBlock(bytes) {
    return [bytes.length & 0xFF, bytes.length >> 8, ...bytes];
}

function tapEntry(type, name, data, param1, param2) {
    const header = [0x00, type];
    for (let i = 0; i < 10; i++) {
        header.push(i < name.length ? name.charCodeAt(i) : 0x20);
    }
    header.push(data.length & 0xFF, data.length >> 8);
    header.push(param1 & 0xFF, (param1 >> 8) & 0xFF);
    header.push(param2 & 0xFF, (param2 >> 8) & 0xFF);
    header.push(0);
    return [...tapBlock(header), ...tapBlock([0xFF, ...data, 0])];
}

const makeTap = (...entries) => new Uint8Array(entries.flat());

const NEX_MAGIC = [0x4E, 0x65, 0x78, 0x74]; // "Next"
const PLUS3DOS_MAGIC = Array.from("PLUS3DOS", (c) => c.charCodeAt(0));

describe("tapDownloadFile", () => {
    test("keeps a TAP as .tap on classic machines", () => {
        const tap = makeTap(tapEntry(3, "code", [0xC9], 0x8000, 0x8000));
        const {bytes, ext} = tapDownloadFile(tap, 128);
        expect(ext).toBe("tap");
        expect(bytes).toBe(tap);
    });

    test("converts a machine-code TAP to a .nex on the Next", () => {
        const tap = makeTap(tapEntry(3, "code", [0xC9], 0x8000, 0x8000));
        const {bytes, ext} = tapDownloadFile(tap, "next");
        expect(ext).toBe("nex");
        expect(Array.from(bytes.slice(0, 4))).toEqual(NEX_MAGIC);
    });

    test("converts a BASIC-only TAP to a PLUS3DOS .bas on the Next", () => {
        const prog = [0x00, 0x0A, 0x02, 0x00, 0xF5, 0x0D]; // 10 PRINT
        const tap = makeTap(tapEntry(0, "prog", prog, 10, prog.length));
        const {bytes, ext} = tapDownloadFile(tap, "next");
        expect(ext).toBe("bas");
        expect(Array.from(bytes.slice(0, 8))).toEqual(PLUS3DOS_MAGIC);
    });

    test("passes a NEX payload through unchanged (sjasmplus SAVENEX)", () => {
        const nex = new Uint8Array([...NEX_MAGIC, 0x56, 0x31, 0x2E, 0x32]);
        expect(tapDownloadFile(nex, 128)).toEqual({bytes: nex, ext: "nex"});
        expect(tapDownloadFile(nex, "next")).toEqual({bytes: nex, ext: "nex"});
    });

    test("passes a PLUS3DOS payload through unchanged (NextBASIC)", () => {
        const bas = new Uint8Array([...PLUS3DOS_MAGIC, 0x1A, 0x01, 0x00]);
        expect(tapDownloadFile(bas, "next")).toEqual({bytes: bas, ext: "bas"});
    });

    test("throws the translator's message for an unconvertible TAP on the Next", () => {
        const tap = makeTap(tapEntry(3, "low", [0xC9], 0x4000, 0x4000));
        expect(() => tapDownloadFile(tap, "next")).toThrow(/48K\/128K/);
    });
});
