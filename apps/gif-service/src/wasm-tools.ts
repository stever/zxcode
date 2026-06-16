import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// Runs the web app's Emscripten-built CLI tools (zmac, sdcc, sdasz80, sdldz80)
// under Node. These are old Emscripten builds that, under the NODE environment,
// hard-exit the process when main returns and install their own process
// handlers (unhandledRejection -> process.exit). So this is only safe inside the
// disposable compile child (compile-worker): we intercept the exit and strip the
// handlers it adds.

const require = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = process.env.WASM_TOOLS_DIR ?? join(moduleDir, '..', 'wasm');

type EmscriptenModule = {
    FS: {
        writeFile(path: string, data: Uint8Array | string): void;
        readFile(path: string): Uint8Array;
        mkdir?(path: string): void;
    };
    callMain(args: string[]): void;
};

function loadFactory(name: string): (cfg: unknown) => EmscriptenModule {
    const src = readFileSync(join(WASM_DIR, `${name}.js`), 'utf8');
    // The .js assigns a global `var <name> = function(){...}` rather than
    // exporting it, so run it and return that factory.
    const fn = new Function(
        'require',
        'process',
        '__dirname',
        '__filename',
        'module',
        'exports',
        `${src}\n;return typeof ${name} !== 'undefined' ? ${name} : undefined;`,
    );
    const shim = { exports: {} };
    return fn(require, process, WASM_DIR, join(WASM_DIR, `${name}.js`), shim, shim.exports);
}

export interface ToolRun {
    module: string; // wasm tool name (zmac, sdcc, ...)
    args: string[]; // callMain arguments
    inputs: Record<string, Uint8Array | string>; // files to write into the in-memory FS
    outputs: string[]; // files to read back out of the in-memory FS
}

export interface ToolResult {
    files: Record<string, Uint8Array>;
    errors: string[];
}

export function runTool(run: ToolRun): ToolResult {
    const errors: string[] = [];
    const wasmModule = new WebAssembly.Module(readFileSync(join(WASM_DIR, `${run.module}.wasm`)));
    const factory = loadFactory(run.module);

    const instance = factory({
        noInitialRun: true,
        instantiateWasm: (imports: WebAssembly.Imports, ready: (i: WebAssembly.Instance) => void) => {
            const inst = new WebAssembly.Instance(wasmModule, imports);
            ready(inst);
            return inst.exports;
        },
        print: () => undefined,
        printErr: (s: string) => errors.push(s),
    });

    // The module just installed handlers that would exit the (child) process on
    // any stray rejection — drop them so they can't kill the compile.
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');

    for (const [name, content] of Object.entries(run.inputs)) {
        instance.FS.writeFile(name, content);
    }

    // Emscripten calls process.exit when main returns; intercept it so we can
    // read the output that's still sitting in the in-memory FS.
    const realExit = process.exit;
    (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
        throw new Error(`emscripten-exit:${code ?? 0}`);
    };
    try {
        instance.callMain(run.args);
    } catch {
        /* expected: the intercepted exit */
    } finally {
        (process as unknown as { exit: typeof realExit }).exit = realExit;
    }

    const files: Record<string, Uint8Array> = {};
    for (const out of run.outputs) {
        files[out] = Uint8Array.from(instance.FS.readFile(out));
    }
    return { files, errors };
}
