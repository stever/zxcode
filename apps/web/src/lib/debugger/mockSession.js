// Mock debug session — the fallback when the emulator's wasm debug bridge
// is unavailable (older zx.wasm, unit tests). realSession.js is the live
// implementation; both provide the same contract:
//
//   createSession() -> null | {
//       backend                   — 'mock' | 'zxgo'
//       snapshot(reason)          -> {reason, pc, registers, disasm, memory,
//                                     paging, pausedLine}
//                                    memory.bytes is the full 64K address
//                                    space (Uint8Array); paging feeds the
//                                    memory-map pane (null when unknown)
//       step() / stepFrame()      -> snapshot
//       stepOver()                -> snapshot | {running: true}
//       resume()                  — run until a breakpoint hits (onPause fires)
//       pause()                   -> snapshot
//       setBreakpoints({lines, addrs})
//       setSourceMap(map)         — parsed SLD map (lib/debugger/sld.js) or
//                                   null; lets the real session arm line
//                                   breakpoints and report pausedLine. The
//                                   mock's canned program has no source, so
//                                   it ignores this.
//       sendCommand(text)         -> Promise<string>  ("OK ..." / "ERR ...")
//       onPause(cb)               — breakpoint hits while running
//       dispose({resume = true}?) — resume:false skips restarting the
//                                   machine (it is being replaced)
//   }
//
// The mock walks a canned Z80 routine so every panel has real-looking data
// and stepping visibly moves the pc and mutates registers.

const PROGRAM = [
    {addr: 0x8000, bytes: [0xCD, 0x30, 0x80], text: "call $8030", symbol: "start"},
    {addr: 0x8003, bytes: [0xCD, 0x38, 0x80], text: "call $8038"},
    {addr: 0x8006, bytes: [0xCD, 0x10, 0x80], text: "call $8010", symbol: "main_loop"},
    {addr: 0x8009, bytes: [0xCD, 0x1C, 0x80], text: "call $801C"},
    {addr: 0x800C, bytes: [0x18, 0xF8], text: "jr $8006"},
    {addr: 0x8010, bytes: [0x3A, 0x40, 0x80], text: "ld a,($8040)", symbol: "move_player"},
    {addr: 0x8013, bytes: [0xFE, 0x20], text: "cp $20"},
    {addr: 0x8015, bytes: [0x28, 0x04], text: "jr z,$801B"},
    {addr: 0x8017, bytes: [0x3C], text: "inc a"},
    {addr: 0x8018, bytes: [0x32, 0x40, 0x80], text: "ld ($8040),a"},
    {addr: 0x801B, bytes: [0xC9], text: "ret", symbol: ".clamp"},
    {addr: 0x801C, bytes: [0x21, 0x00, 0x40], text: "ld hl,$4000", symbol: "draw_frame"},
    {addr: 0x801F, bytes: [0x06, 0x20], text: "ld b,$20"},
    {addr: 0x8021, bytes: [0x7E], text: "ld a,(hl)"},
    {addr: 0x8022, bytes: [0xEE, 0xFF], text: "xor $FF"},
    {addr: 0x8024, bytes: [0x77], text: "ld (hl),a"},
    {addr: 0x8025, bytes: [0x23], text: "inc hl"},
    {addr: 0x8026, bytes: [0x10, 0xF9], text: "djnz $8021"},
    {addr: 0x8028, bytes: [0xC9], text: "ret"},
    {addr: 0x8030, bytes: [0x3E, 0x07], text: "ld a,$07", symbol: "init_screen"},
    {addr: 0x8032, bytes: [0xD3, 0xFE], text: "out ($FE),a"},
    {addr: 0x8034, bytes: [0xC9], text: "ret"},
    {addr: 0x8038, bytes: [0x21, 0x40, 0x80], text: "ld hl,$8040", symbol: "init_player"},
    {addr: 0x803B, bytes: [0x36, 0x1F], text: "ld (hl),$1F"},
    {addr: 0x803D, bytes: [0xC9], text: "ret"},
];

const HELP =
    "OK pause continue step step-over step-line get-registers get-stack backtrace " +
    "history hexdump read-memory write-memory set-breakpoint clear-breakpoint " +
    "list-breakpoints disassemble get-mmu get-divmmc nr-panel sprite-list " +
    "palette-dump watch-mem watch-read watch-port tp tt-on tt-rewind ... " +
    "(the full zxplay_go command set arrives with the emulator bridge)";

const hex16 = (v) => v.toString(16).toUpperCase().padStart(4, "0");

export function createDebugSession() {
    let rowIndex = 0;
    let pauseCallback = null;
    let runTimer = null;
    let breakpointLines = [];
    let breakpointAddrs = [];

    const registers = {
        pc: PROGRAM[0].addr, sp: 0x5BF3,
        a: 0x00, f: 0x44,
        bc: 0x061F, de: 0xA930, hl: 0x2758,
        ix: 0xDBD0, iy: 0x5C3A,
        afAlt: 0x0044, bcAlt: 0x0921, deAlt: 0x5CB9, hlAlt: 0x2758,
        im: 1, iff1: true,
    };

    // 96 bytes of recognisable RAM content at $8040 so the memory panel and
    // the program's player_x variable agree; the rest of the 64K stays zero.
    const memoryBytes = [
        0x1F, 0x60, 0x04, 0x00, 0x3E, 0x02, 0xCF, 0x21,
        0x00, 0x40, 0x11, 0x00, 0x58, 0x01, 0x00, 0x1B,
        0xED, 0xB0, 0xC9, 0xF3, 0x3E, 0x07, 0xD3, 0xFE,
        0x21, 0x3B, 0x5C, 0xCB, 0x6E, 0x28, 0xEA, 0xCB,
        0xAE, 0x3A, 0x08, 0x5C, 0xFE, 0x0E, 0x28, 0x06,
        0xCB, 0x86, 0xFE, 0x10, 0x30, 0x1F, 0xF5, 0xFE,
        0x06, 0x20, 0x4F, 0x06, 0x00, 0x21, 0x6E, 0x5C,
        0x09, 0x7E, 0xFE, 0x18, 0x28, 0x03, 0xC3, 0x90,
        0x0C, 0x3E, 0x00, 0x32, 0x40, 0x80, 0xC9, 0x00,
        0x44, 0x00, 0x09, 0x21, 0xB9, 0x5C, 0x58, 0x27,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];

    // Full 64K image: the canned program bytes at their addresses plus the
    // fake RAM block at $8040, zero elsewhere.
    const memoryImage = () => {
        const bytes = new Uint8Array(0x10000);
        for (const row of PROGRAM) {
            bytes.set(row.bytes, row.addr);
        }
        bytes.set(memoryBytes, 0x8040);
        return {bytes};
    };

    // A plausible 48K layout for the memory-map pane.
    const paging = {
        mode: 'classic',
        slots: [16, 5, 2, 0],
        screenPage: 5,
        is128K: false,
    };

    const snapshot = (reason, pausedLine = null) => ({
        reason,
        pc: registers.pc,
        registers: {...registers},
        disasm: PROGRAM.map((row) => ({...row})),
        memory: memoryImage(),
        paging,
        pausedLine,
    });

    // Advance one canned instruction, nudging registers so the change
    // highlighting in the strip has something to show.
    const executeRow = () => {
        const row = PROGRAM[rowIndex];
        if (row.text.startsWith("ld a,")) registers.a = memoryBytes[0];
        if (row.text.startsWith("inc a")) registers.a = (registers.a + 1) & 0xFF;
        if (row.text.startsWith("ld hl")) registers.hl = 0x4000;
        if (row.text.startsWith("ld ($8040),a")) memoryBytes[0] = registers.a;
        if (row.text.startsWith("call")) registers.sp = (registers.sp - 2) & 0xFFFF;
        if (row.text.startsWith("ret")) registers.sp = (registers.sp + 2) & 0xFFFF;
        rowIndex = (rowIndex + 1) % PROGRAM.length;
        registers.pc = PROGRAM[rowIndex].addr;
    };

    const stopRunTimer = () => {
        if (runTimer) {
            clearTimeout(runTimer);
            runTimer = null;
        }
    };

    return {
        backend: "mock",
        snapshot,

        step() {
            executeRow();
            return snapshot("step");
        },

        stepOver() {
            // The mock has no call depth to track; skip the called routine
            // by advancing past the call row.
            executeRow();
            return snapshot("step");
        },

        stepFrame() {
            for (let i = 0; i < 4; i++) executeRow();
            return snapshot("step");
        },

        resume() {
            stopRunTimer();
            // With breakpoints set, "run" for a moment and report a hit at
            // the first one; otherwise run until pause() is called.
            if (breakpointLines.length > 0 || breakpointAddrs.length > 0) {
                runTimer = setTimeout(() => {
                    runTimer = null;
                    const line = breakpointLines.length > 0 ? breakpointLines[0] : null;
                    const addrHit = PROGRAM.findIndex(
                        (row) => breakpointAddrs.includes(row.addr));
                    rowIndex = addrHit >= 0 ? addrHit : 2; // else main_loop
                    registers.pc = PROGRAM[rowIndex].addr;
                    if (pauseCallback) {
                        pauseCallback(snapshot("breakpoint", line));
                    }
                }, 700);
            }
        },

        pause() {
            stopRunTimer();
            return snapshot("pause");
        },

        setBreakpoints({lines, addrs}) {
            // Locations are {file, line}; the canned program is single-file,
            // so only main-source (file: null) lines take part in the mock.
            breakpointLines = lines
                .filter((loc) => (loc.file ?? null) === null)
                .map((loc) => loc.line)
                .sort((a, b) => a - b);
            breakpointAddrs = [...addrs].sort((a, b) => a - b);
        },

        setSourceMap(_map) {
            // The canned program has no source to map.
        },

        async sendCommand(text) {
            const cmd = text.trim().split(/\s+/)[0].toLowerCase();
            switch (cmd) {
                case "help":
                case "?":
                    return HELP;
                case "get-registers":
                    return `OK PC:${hex16(registers.pc)} SP:${hex16(registers.sp)} ` +
                        `AF:${hex16((registers.a << 8) | registers.f)} ` +
                        `BC:${hex16(registers.bc)} DE:${hex16(registers.de)} ` +
                        `HL:${hex16(registers.hl)} IX:${hex16(registers.ix)} ` +
                        `IY:${hex16(registers.iy)} IM:${registers.im} ` +
                        `IFF1:${registers.iff1}`;
                case "get-mmu":
                    return "OK mmu 255 255 10 11 4 5 0 1";
                case "list-breakpoints":
                    return breakpointLines.length > 0
                        ? `OK ${breakpointLines.map((l) => `line ${l}`).join(", ")}`
                        : "OK no breakpoints";
                default:
                    return `ERR mock session: '${cmd}' arrives with the emulator bridge (see help)`;
            }
        },

        onPause(cb) {
            pauseCallback = cb;
        },

        dispose() {
            stopRunTimer();
            pauseCallback = null;
        },
    };
}
