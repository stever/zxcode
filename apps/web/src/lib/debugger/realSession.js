// Real debug session, backed by the zx_go wasm debug bridge through the
// JSSpeccy handle's `debug` API (packages/emulator). Implements the same
// contract as mockSession.js — see there for the shape.
//
// Threading model: the CPU only runs inside zxFrame on the JS thread, so
// every read here observes a fully stopped machine. Breakpoint hits and
// step-over landings arrive via the engine's 'debugpause' event (the frame
// loop sees zxFrame report paused and stops itself).

import {locToAddr} from "./sld";

const DISASM_ROWS = 32;
const MEM_BYTES = 0x10000;

// PPC system variable: the BASIC line number the NextZXOS/48K interpreter
// is executing. How a `kind: "basic"` map resolves the paused line — the
// Z80 pc is inside interpreter ROM and means nothing to a BASIC source.
const PPC_ADDR = 0x5C45;

const hex = (v) => "$" + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, "0");

export function createRealSession(handle) {
    const dbg = handle.debug;
    let disasmStart = null;
    let pauseCallback = null;
    let armedAddrs = [];
    // BASIC line numbers armed via `set-basic-bp` (nextbas projects — the
    // sourceMap carries kind: "basic" and its "addresses" are BASIC lines).
    let armedBasicLines = [];
    // Parsed SLD map (lib/debugger/sld.js) for the loaded program, pushed by
    // the saga — already filtered to fresh (never stale). Null means source
    // lines cannot arm and the pc maps to no line.
    let sourceMap = null;
    // Label addresses pushed into the engine's symbol table (`sym`), so a
    // map change can retract them before pushing the replacement set.
    let pushedLabelAddrs = [];

    // The whole 64K address space as the CPU sees it (MMU paging and the
    // divMMC overlay resolved). One 64K copy per snapshot is nothing next
    // to the frame work the emulator already does per tick.
    const readMemory = () => ({
        bytes: dbg.mem(0, MEM_BYTES),
    });

    const registersFrom = (s) => ({
        pc: s.pc,
        sp: s.sp,
        a: (s.af >> 8) & 0xFF,
        f: s.af & 0xFF,
        bc: s.bc,
        de: s.de,
        hl: s.hl,
        ix: s.ix,
        iy: s.iy,
        afAlt: s.afAlt,
        bcAlt: s.bcAlt,
        deAlt: s.deAlt,
        hlAlt: s.hlAlt,
        im: s.im,
        iff1: s.iff1,
    });

    // Keep the disassembly window stable while the pc moves inside it, so
    // stepping reads as a moving arrow rather than rewriting every row;
    // restart at pc when execution leaves the window.
    const disasmWindow = (pc) => {
        if (disasmStart !== null) {
            const rows = dbg.disasm(disasmStart, DISASM_ROWS);
            if (rows.some((r) => r.addr === pc)) return rows;
        }
        disasmStart = pc;
        return dbg.disasm(pc, DISASM_ROWS);
    };

    const snapshot = (reason) => {
        const s = dbg.state();
        if (!s) return null;
        const memory = readMemory();
        // Null when the paused position is outside the program — the editor
        // then shows no paused line and the disassembly pane carries the
        // position. pausedFile names the project file the line lives in
        // (null = the main source). A basic map keys on the interpreter's
        // current BASIC line (PPC), not the Z80 pc: the pc is in ROM for
        // every BASIC line, and PPC holds interpreter states (e.g. $FFFE
        // for a direct command) outside program execution — those miss the
        // map and report no line, exactly as an out-of-program pc does.
        let loc = null;
        if (sourceMap) {
            const key = sourceMap.kind === "basic"
                ? memory.bytes[PPC_ADDR] | (memory.bytes[PPC_ADDR + 1] << 8)
                : s.pc;
            loc = sourceMap.addrToLoc.get(key) ?? null;
        }
        return {
            reason,
            pc: s.pc,
            registers: registersFrom(s),
            disasm: disasmWindow(s.pc),
            memory,
            paging: dbg.paging ? dbg.paging() : null,
            pausedLine: loc ? loc.line : null,
            pausedFile: loc ? loc.file : null,
        };
    };

    const onEnginePause = ({ pc }) => {
        dbg.render();
        if (pauseCallback) pauseCallback(snapshot("breakpoint"));
    };

    if (!dbg.attach()) {
        return null;
    }
    // Stop the frame loop before asking the command layer to pause, so the
    // pause never surfaces as a spurious 'debugpause' event.
    handle.pause();
    dbg.cmd("pause");
    dbg.onPause(onEnginePause);

    return {
        backend: "zxgo",
        snapshot,

        step() {
            dbg.cmd("step");
            dbg.render();
            return snapshot("step");
        },

        stepOver() {
            // On a BASIC project the useful "next" unit is the next BASIC
            // line, not the next ROM instruction: arm the engine's one-shot
            // line-transition halt and run until it fires (delivered via
            // onEnginePause, like a step-over landing).
            if (sourceMap && sourceMap.kind === "basic") {
                dbg.cmd("basic-step");
                dbg.resume();
                return { running: true };
            }
            const response = dbg.cmd("step-over");
            if (response.startsWith("OK step-over running")) {
                // Call-like instruction: the one-shot is armed; run frames
                // until it fires (delivered via onEnginePause).
                dbg.resume();
                return { running: true };
            }
            dbg.render();
            return snapshot("step");
        },

        stepFrame() {
            dbg.stepFrame();
            dbg.render();
            return snapshot("step");
        },

        resume() {
            dbg.cmd("continue");
            dbg.resume();
        },

        pause() {
            handle.pause();
            dbg.cmd("pause");
            dbg.render();
            return snapshot("pause");
        },

        // Address breakpoints arm directly; source locations ({file, line},
        // file null = main source) arm through the source map (locations
        // the map cannot place — or all of them, without a map — stay
        // stored in the store but set nothing here). The two can resolve to
        // the same address; the Set collapses that to one arm and it
        // survives until both are gone.
        setBreakpoints({ lines = [], addrs = [] }) {
            const wanted = new Set(addrs);
            // With a basic map, source locations resolve to BASIC line
            // numbers and arm via the engine's PPC watch instead of
            // address breakpoints; a map going away (stale, cleared)
            // disarms them the same way it disarms address-resolved ones.
            const isBasic = Boolean(sourceMap && sourceMap.kind === "basic");
            const wantedBasic = new Set();
            if (sourceMap) {
                for (const loc of lines) {
                    const addr = locToAddr(sourceMap, loc.file, loc.line);
                    if (addr === undefined) continue;
                    if (isBasic) wantedBasic.add(addr);
                    else wanted.add(addr);
                }
            }
            for (const l of armedBasicLines) {
                if (!wantedBasic.has(l)) dbg.cmd(`clear-basic-bp ${l}`);
            }
            for (const l of wantedBasic) {
                if (!armedBasicLines.includes(l)) dbg.cmd(`set-basic-bp ${l}`);
            }
            armedBasicLines = [...wantedBasic];
            for (const a of armedAddrs) {
                if (!wanted.has(a)) dbg.cmd(`clear-breakpoint ${hex(a)}`);
            }
            for (const a of wanted) {
                // any-bank: the engine otherwise defaults the bank filter
                // to the ROM bank paged when the command runs — the OS
                // menu's bank, not the one the program executes under, so
                // on the 128K/Next the breakpoint would silently never
                // match (48K worked only because both are bank 0). IDE
                // breakpoints target the user's RAM program; bank-filtered
                // ones remain available from the console.
                if (!armedAddrs.includes(a)) dbg.cmd(`set-breakpoint ${hex(a)} any-bank`);
            }
            armedAddrs = [...wanted];
        },

        // The saga pushes the map on session start and whenever it changes
        // (loaded, cleared, or gone stale — stale arrives as null). The
        // caller re-syncs breakpoints afterwards; nothing re-arms here.
        // Labels feed the engine's symbol table so the disassembly rows,
        // backtrace, and history annotate addresses with source names.
        setSourceMap(map) {
            sourceMap = map;
            for (const a of pushedLabelAddrs) dbg.cmd(`sym clear ${hex(a)}`);
            pushedLabelAddrs = [];
            if (map) {
                for (const [name, addr] of map.labels) {
                    dbg.cmd(`sym ${hex(addr)} ${name}`);
                    pushedLabelAddrs.push(addr);
                }
            }
        },

        async sendCommand(text) {
            return dbg.cmd(text);
        },

        onPause(cb) {
            pauseCallback = cb;
        },

        // resume:false tears down the JS side only — the machine this
        // session was attached to is being replaced (machine change/reset),
        // so continue/detach/start would land on its successor instead.
        // Labels come out either way: the symbol table is engine-global,
        // not per-machine, and the successor session re-pushes its own.
        dispose({resume = true} = {}) {
            for (const a of pushedLabelAddrs) dbg.cmd(`sym clear ${hex(a)}`);
            pushedLabelAddrs = [];
            dbg.offPause(onEnginePause);
            pauseCallback = null;
            if (resume) {
                // Disarm the engine's BASIC-line watch before detaching:
                // the PPC hook outlives attach/detach (it's a memory hook,
                // not the attach-gated M1 check), so armed lines left
                // behind would keep firing against the orphaned debugger
                // core — log noise on every entry to the line — until the
                // machine is rebuilt. No-ops when nothing was armed.
                dbg.cmd("clear-basic-bp");
                dbg.cmd("basic-step off");
                armedBasicLines = [];
                dbg.cmd("continue");
                dbg.detach();
                handle.start();
            }
        },
    };
}
