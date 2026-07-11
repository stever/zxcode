// Debug-build harvest for Pasmo (asm) — see lib/debugger/pasmoMap.js for
// the scheme. The user's compile goes through the pasmo package's normal
// wrapper untouched; this second, best-effort build drives the same wasm
// module directly so it can pass -d (statement echo with addresses on
// stdout) and assemble the label-injected sources. Every failure path
// resolves to null: the map is simply absent, never wrong, and the real
// build is unaffected.
import PasmoModule from "pasmo/dist/pasmo.js";
import {
    injectPasmoDebugLabels,
    buildPasmoDebugMap,
} from "../../lib/debugger/pasmoMap";

// One -d build of the injected sources -> {tap, echo} | null. The module's
// baked-in postRun rejects with the collected output when no TAP came out.
function debugBuild(asmInput, files) {
    const out = [];
    return new Promise((resolve) => {
        PasmoModule({
            arguments: ["-d", "--tapbas", "input.asm", "output.tap"],
            asmInput,
            files,
            out,
            resolve: (tap) => resolve({
                tap,
                echo: out.filter((o) => o.type === "out").map((o) => o.text),
            }),
            reject: () => resolve(null),
            print: (text) => out.push({type: "out", text}),
            printErr: (text) => out.push({type: "err", text}),
        });
    });
}

function bytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// harvestPasmoSourceMap(code, files, tap) -> map | null. `files` is the
// staging map the real compile used ({path: string|Uint8Array}) and `tap`
// its output: labels emit no bytes, so a debug TAP that differs from the
// real one means the injection perturbed the program (a text file INCBINed
// as data, a label collision) and the whole map is discarded.
export async function harvestPasmoSourceMap(code, files, tap) {
    try {
        const injected = injectPasmoDebugLabels(code, files);
        if (!injected) return null;
        const result = await debugBuild(injected.code, injected.files);
        if (!result || !bytesEqual(result.tap, tap)) return null;
        return buildPasmoDebugMap(result.echo, injected.labelToLoc);
    } catch (e) {
        console.warn("[pasmo] source map harvest failed", e);
        return null;
    }
}
