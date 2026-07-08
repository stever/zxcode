// Real debug session, backed by the zx_go wasm debug bridge through the
// JSSpeccy handle's `debug` API (packages/emulator). Implements the same
// contract as mockSession.js — see there for the shape.
//
// Threading model: the CPU only runs inside zxFrame on the JS thread, so
// every read here observes a fully stopped machine. Breakpoint hits and
// step-over landings arrive via the engine's 'debugpause' event (the frame
// loop sees zxFrame report paused and stops itself).

const DISASM_ROWS = 32;
const MEM_BYTES = 0x10000;

const hex = (v) => "$" + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, "0");

export function createRealSession(handle) {
    const dbg = handle.debug;
    let disasmStart = null;
    let pauseCallback = null;
    let armedAddrs = [];

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
        return {
            reason,
            pc: s.pc,
            registers: registersFrom(s),
            disasm: disasmWindow(s.pc),
            memory: readMemory(),
            paging: dbg.paging ? dbg.paging() : null,
            // Source-line mapping arrives with symbol maps (phase 3).
            pausedLine: null,
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

        // Only address breakpoints arm on the real backend for now; source
        // lines join them when the compilers emit symbol maps.
        setBreakpoints({ addrs }) {
            for (const a of armedAddrs) {
                if (!addrs.includes(a)) dbg.cmd(`clear-breakpoint ${hex(a)}`);
            }
            for (const a of addrs) {
                if (!armedAddrs.includes(a)) dbg.cmd(`set-breakpoint ${hex(a)}`);
            }
            armedAddrs = [...addrs];
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
        dispose({resume = true} = {}) {
            dbg.offPause(onEnginePause);
            pauseCallback = null;
            if (resume) {
                dbg.cmd("continue");
                dbg.detach();
                handle.start();
            }
        },
    };
}
