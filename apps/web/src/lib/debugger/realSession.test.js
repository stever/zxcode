import {createRealSession} from "./realSession";
import {parseSld} from "./sld";
import {parseBasicMap} from "./basicMap";
import {buildLineCallMap} from "./lineCallMap";

// Code on lines 4 ($8000) and 15 ($8010).
const SLD = `|SLD.data.version|1
program.asm|4||0|2|32768|T|
program.asm|15||0|2|32784|T|
`;

function fakeHandle(pc = 0x8000, ppc = 0, hl = 0) {
    const cmds = [];
    // PPC ($5C45/6): the BASIC line the interpreter is executing, read from
    // the memory snapshot by basic-map paused-line resolution. hl feeds the
    // linecall-map resolution (the per-line call's line-number register).
    const memory = new Uint8Array(0x10000);
    memory[0x5C45] = ppc & 0xFF;
    memory[0x5C46] = (ppc >> 8) & 0xFF;
    const dbg = {
        attach: () => true,
        detach: jest.fn(),
        cmd: (line) => { cmds.push(line); return "OK"; },
        state: () => ({
            pc, sp: 0xFF00, af: 0, bc: 0, de: 0, hl, ix: 0, iy: 0,
            afAlt: 0, bcAlt: 0, deAlt: 0, hlAlt: 0, im: 1, iff1: 1,
        }),
        mem: () => memory,
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

// Editor lines 1-3 carry BASIC lines 10/20/30.
const BASIC_SRC = "10 PRINT 1\n20 GO TO 10\n30 STOP";

describe("realSession NextBASIC breakpoints", () => {
    test("lines arm as basic-bps through a basic map, and diff-clear", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        session.setSourceMap(parseBasicMap(BASIC_SRC));
        cmds.length = 0;
        session.setBreakpoints({lines: [{file: null, line: 1}, {file: null, line: 3}], addrs: []});
        expect(cmds).toEqual(["set-basic-bp 10", "set-basic-bp 30"]);
        cmds.length = 0;
        session.setBreakpoints({lines: [{file: null, line: 3}], addrs: []});
        expect(cmds).toEqual(["clear-basic-bp 10"]);
    });

    test("address breakpoints stay address breakpoints alongside a basic map", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        session.setSourceMap(parseBasicMap(BASIC_SRC));
        cmds.length = 0;
        session.setBreakpoints({lines: [{file: null, line: 2}], addrs: [0x8000]});
        expect(cmds).toEqual(["set-basic-bp 20", "set-breakpoint $8000 any-bank"]);
    });

    test("map withdrawal clears armed basic-bps on the next sync", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        session.setSourceMap(parseBasicMap(BASIC_SRC));
        session.setBreakpoints({lines: [{file: null, line: 1}], addrs: []});
        session.setSourceMap(null);
        cmds.length = 0;
        session.setBreakpoints({lines: [{file: null, line: 1}], addrs: []});
        expect(cmds).toEqual(["clear-basic-bp 10"]);
    });

    test("snapshot resolves the paused line from PPC, not the pc", () => {
        // pc deep in ROM, PPC says BASIC line 20 -> editor line 2.
        const {handle} = fakeHandle(0x3986, 20);
        const session = createRealSession(handle);
        session.setSourceMap(parseBasicMap(BASIC_SRC));
        const snap = session.snapshot("breakpoint");
        expect(snap.pausedLine).toBe(2);
        expect(snap.pausedFile).toBeNull();
    });

    test("interpreter PPC states outside the program report no line", () => {
        // $FFFE = direct command; and a pc that happens to equal a BASIC
        // line number must not leak through the basic map.
        const {handle} = fakeHandle(10, 0xFFFE);
        const session = createRealSession(handle);
        session.setSourceMap(parseBasicMap(BASIC_SRC));
        expect(session.snapshot("pause").pausedLine).toBeNull();
    });

    test("stepOver on a basic map arms a one-shot line step and runs", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        session.setSourceMap(parseBasicMap(BASIC_SRC));
        cmds.length = 0;
        expect(session.stepOver()).toEqual({running: true});
        expect(cmds).toEqual(["basic-step"]);
    });

    test("dispose disarms the engine's line watch before detaching", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        session.setSourceMap(parseBasicMap(BASIC_SRC));
        session.setBreakpoints({lines: [{file: null, line: 1}], addrs: []});
        cmds.length = 0;
        session.dispose();
        expect(cmds).toEqual([
            "clear-basic-bp", "basic-step off",
            "clear-linecall-bp", "linecall-anchor off",
            "continue",
        ]);
    });
});

// Boriel (compiled) projects: the map carries the per-line runtime call's
// address (anchor) and the file lines that received a check.
const LINECALL_DEBUG = {kind: "zxbasic", anchor: 0x9333, lines: [2, 3, 5]};

describe("realSession Boriel linecall breakpoints", () => {
    test("map push anchors the engine; withdrawal disarms it", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        cmds.length = 0;
        session.setSourceMap(buildLineCallMap(LINECALL_DEBUG));
        expect(cmds).toEqual(["linecall-anchor $9333"]);
        cmds.length = 0;
        session.setSourceMap(null);
        expect(cmds).toEqual(["linecall-anchor off"]);
    });

    test("a session with no linecall map disarms a leftover engine anchor", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        cmds.length = 0;
        session.setSourceMap(null);
        expect(cmds).toEqual(["linecall-anchor off"]);
    });

    test("lines arm as linecall-bps and diff-clear", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        session.setSourceMap(buildLineCallMap(LINECALL_DEBUG));
        cmds.length = 0;
        session.setBreakpoints({lines: [{file: null, line: 2}, {file: null, line: 5}], addrs: []});
        expect(cmds).toEqual(["set-linecall-bp 2", "set-linecall-bp 5"]);
        cmds.length = 0;
        session.setBreakpoints({lines: [{file: null, line: 5}], addrs: []});
        expect(cmds).toEqual(["clear-linecall-bp 2"]);
    });

    test("paused line resolves from HL at the anchor only", () => {
        const atAnchor = fakeHandle(0x9333, 0, 3);
        const s1 = createRealSession(atAnchor.handle);
        s1.setSourceMap(buildLineCallMap(LINECALL_DEBUG));
        expect(s1.snapshot("breakpoint").pausedLine).toBe(3);

        // Away from the anchor HL is arbitrary program state, not a line.
        const elsewhere = fakeHandle(0x8000, 0, 3);
        const s2 = createRealSession(elsewhere.handle);
        s2.setSourceMap(buildLineCallMap(LINECALL_DEBUG));
        expect(s2.snapshot("pause").pausedLine).toBeNull();
    });

    test("stepOver arms a one-shot line step and runs", () => {
        const {handle, cmds} = fakeHandle();
        const session = createRealSession(handle);
        session.setSourceMap(buildLineCallMap(LINECALL_DEBUG));
        cmds.length = 0;
        expect(session.stepOver()).toEqual({running: true});
        expect(cmds).toEqual(["linecall-step"]);
    });
});
