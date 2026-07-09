import {createRealSession} from "./realSession";
import {parseSld} from "./sld";

// Code on lines 4 ($8000) and 15 ($8010).
const SLD = `|SLD.data.version|1
program.asm|4||0|2|32768|T|
program.asm|15||0|2|32784|T|
`;

function fakeHandle(pc = 0x8000) {
    const cmds = [];
    const dbg = {
        attach: () => true,
        detach: jest.fn(),
        cmd: (line) => { cmds.push(line); return "OK"; },
        state: () => ({
            pc, sp: 0xFF00, af: 0, bc: 0, de: 0, hl: 0, ix: 0, iy: 0,
            afAlt: 0, bcAlt: 0, deAlt: 0, hlAlt: 0, im: 1, iff1: 1,
        }),
        mem: () => new Uint8Array(0x10000),
        disasm: () => [{addr: pc, bytes: [0], text: "nop"}],
        paging: () => null,
        render: () => {},
        resume: () => {},
        onPause: () => {},
        offPause: () => {},
    };
    return {handle: {debug: dbg, pause: () => {}, start: () => {}}, cmds};
}

describe("realSession source-line breakpoints", () => {
    test("lines arm as address breakpoints through the map", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        session.setSourceMap(parseSld(SLD));
        cmds.length = 0;
        session.setBreakpoints({lines: [{file: null, line: 4}, {file: null, line: 15}], addrs: []});
        expect(cmds).toEqual(["set-breakpoint $8000 any-bank", "set-breakpoint $8010 any-bank"]);
    });

    test("without a map, lines set nothing and addrs still arm", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        cmds.length = 0;
        session.setBreakpoints({lines: [{file: null, line: 4}], addrs: [0x9000]});
        expect(cmds).toEqual(["set-breakpoint $9000 any-bank"]);
    });

    test("a line and an addr on the same address arm once, clear once", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        session.setSourceMap(parseSld(SLD));
        cmds.length = 0;
        session.setBreakpoints({lines: [{file: null, line: 4}], addrs: [0x8000]});
        expect(cmds).toEqual(["set-breakpoint $8000 any-bank"]);
        cmds.length = 0;
        session.setBreakpoints({lines: [], addrs: [0x8000]});
        expect(cmds).toEqual([]);
        cmds.length = 0;
        session.setBreakpoints({lines: [], addrs: []});
        expect(cmds).toEqual(["clear-breakpoint $8000"]);
    });

    test("map withdrawal clears line-derived arms on the next sync", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        session.setSourceMap(parseSld(SLD));
        session.setBreakpoints({lines: [{file: null, line: 4}], addrs: []});
        session.setSourceMap(null);
        cmds.length = 0;
        session.setBreakpoints({lines: [{file: null, line: 4}], addrs: []});
        expect(cmds).toEqual(["clear-breakpoint $8000"]);
    });

    test("snapshot reports pausedLine from the pc, null outside the map", () => {
        const atStart = fakeHandle(0x8000);
        const s1 = createRealSession(atStart.handle);
        s1.setSourceMap(parseSld(SLD));
        expect(s1.snapshot("entry").pausedLine).toBe(4);

        const inRom = fakeHandle(0x0038);
        const s2 = createRealSession(inRom.handle);
        s2.setSourceMap(parseSld(SLD));
        expect(s2.snapshot("entry").pausedLine).toBeNull();

        const noMap = fakeHandle(0x8000);
        const s3 = createRealSession(noMap.handle);
        expect(s3.snapshot("entry").pausedLine).toBeNull();
    });
});

// Records for an included file interleave with the main source's, keyed by
// the staged file's name.
const MULTI_SLD = `|SLD.data.version|1
program.asm|4||0|2|32768|T|
part.asm|2||0|2|32770|T|
program.asm|6||0|2|32773|T|
`;

describe("realSession multi-file breakpoints", () => {
    test("included-file lines arm through the map", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        session.setSourceMap(parseSld(MULTI_SLD));
        cmds.length = 0;
        session.setBreakpoints({
            lines: [{file: null, line: 4}, {file: "part.asm", line: 2}],
            addrs: [],
        });
        expect(cmds).toEqual(["set-breakpoint $8000 any-bank", "set-breakpoint $8002 any-bank"]);
    });

    test("a pause inside the included file reports its file and line", () => {
        const {handle} = fakeHandle(0x8002);
        const session = createRealSession(handle);
        session.setSourceMap(parseSld(MULTI_SLD));
        const snap = session.snapshot("breakpoint");
        expect(snap.pausedLine).toBe(2);
        expect(snap.pausedFile).toBe("part.asm");
    });

    test("a pause in the main source reports a null file", () => {
        const {handle} = fakeHandle(0x8000);
        const session = createRealSession(handle);
        session.setSourceMap(parseSld(MULTI_SLD));
        const snap = session.snapshot("breakpoint");
        expect(snap.pausedLine).toBe(4);
        expect(snap.pausedFile).toBeNull();
    });
});
