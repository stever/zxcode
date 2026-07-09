import {parseSld, snapLine} from "./sld";

// Verbatim sjasmplus 1.23.1 output for the HELLO sample (DEVICE ZXSPECTRUM48,
// ORG $8000): line 4 is `ld a,2`, line 15 the `jr done` loop, lines 16-17
// data, line 18 an EQU.
const SLD = `|SLD.data.version|1
program.asm|1||0|-1|-1|Z|pages.size:16384,pages.count:4,slots.count:4,slots.adr:0,16384,32768,49152
program.asm|3||0|2|32768|F|start
program.asm|3||0|2|32768|L|,start,
program.asm|4||0|2|32768|T|
program.asm|5||0|2|32770|T|
program.asm|6||0|2|32773|T|
program.asm|7||0|2|32776|F|print
program.asm|7||0|2|32776|L|,print,,+used
program.asm|8||0|2|32776|T|
program.asm|9||0|2|32777|T|
program.asm|10||0|2|32778|T|
program.asm|11||0|2|32780|T|
program.asm|12||0|2|32781|T|
program.asm|13||0|2|32782|T|
program.asm|14||0|2|32784|F|done
program.asm|14||0|2|32784|L|,done,,+used
program.asm|15||0|2|32784|T|
program.asm|16||0|2|32786|F|msg
program.asm|16||0|2|32786|L|,msg,,+used
program.asm|18||0|-1|5|D|count
program.asm|18||0|-1|5|L|,count,,+equ
`;

describe("parseSld", () => {
    test("maps instruction lines to addresses both ways", () => {
        const map = parseSld(SLD);
        expect(map.lineToAddr.get(4)).toBe(0x8000);
        expect(map.lineToAddr.get(15)).toBe(0x8010);
        expect(map.addrToLine.get(0x8000)).toBe(4);
        expect(map.addrToLine.get(0x8010)).toBe(15);
    });

    test("lines without code are unmapped", () => {
        const map = parseSld(SLD);
        expect(map.lineToAddr.has(2)).toBe(false);   // ORG directive
        expect(map.lineToAddr.has(16)).toBe(false);  // msg: DB data
        expect(map.lineToAddr.has(17)).toBe(false);
    });

    test("collects address labels but not EQUs", () => {
        const map = parseSld(SLD);
        expect(map.labels.get("start")).toBe(0x8000);
        expect(map.labels.get("print")).toBe(0x8008);
        expect(map.labels.get("done")).toBe(0x8010);
        expect(map.labels.get("msg")).toBe(0x8012);
        expect(map.labels.has("count")).toBe(false);
    });

    test("first record wins when a line assembles more than once", () => {
        const dup = SLD + "program.asm|4||0|2|40000|T|\n";
        const map = parseSld(dup);
        expect(map.lineToAddr.get(4)).toBe(0x8000);
    });

    test("records from other files are ignored", () => {
        const foreign = SLD + "include.asm|1||0|2|50000|T|\n";
        const map = parseSld(foreign);
        expect(map.addrToLine.has(50000)).toBe(false);
    });

    test("returns null for empty or code-free input", () => {
        expect(parseSld("")).toBeNull();
        expect(parseSld(null)).toBeNull();
        expect(parseSld("|SLD.data.version|1\n")).toBeNull();
        expect(parseSld("garbage that is not sld at all")).toBeNull();
    });
});

describe("snapLine", () => {
    test("keeps a line that has code", () => {
        expect(snapLine(parseSld(SLD), 4)).toBe(4);
    });

    test("snaps a directive/label line forward to the next instruction", () => {
        expect(snapLine(parseSld(SLD), 1)).toBe(4);   // DEVICE line
        expect(snapLine(parseSld(SLD), 14)).toBe(15); // done: label line
    });

    test("returns null past the last instruction", () => {
        expect(snapLine(parseSld(SLD), 16)).toBeNull();
    });
});
