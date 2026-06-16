import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// Runs the web app's Emscripten/asm.js CLI tools (zmac, sdcc, sdasz80, sdldz80,
// mcpp) under Node. These are old builds that hard-exit the process when main
// returns and install their own process handlers — so this is only safe inside
// the disposable compile child (compile-worker): we intercept the exit and strip
// the handlers they add.

const require = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));
// Base dir holding wasm/, asmjs/, fs/, zx/ (the Dockerfile copies them next to src/).
const TOOLS_BASE = process.env.TOOLS_BASE ?? join(moduleDir, '..');
const WASM_DIR = join(TOOLS_BASE, 'wasm');
const ASMJS_DIR = join(TOOLS_BASE, 'asmjs');
const FS_DIR = join(TOOLS_BASE, 'fs');
const ZX_DIR = join(TOOLS_BASE, 'zx');

interface EmscriptenFS {
    // Emscripten defaults to utf8; binary data MUST pass { encoding: 'binary' }
    // or it gets run through charCodeAt as a string.
    writeFile(path: string, data: Uint8Array | string, opts?: { encoding?: 'binary' | 'utf8' }): void;
    readFile(path: string): Uint8Array;
    mkdir(path: string): void;
    init(input: () => number | null, output?: unknown, error?: unknown): void;
}
interface EmscriptenModule {
    FS: EmscriptenFS;
    callMain(args: string[]): void;
}

function loadFactory(jsPath: string, name: string): (cfg: unknown) => EmscriptenModule {
    const src = readFileSync(jsPath, 'utf8');
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
    return fn(require, process, dirname(jsPath), jsPath, shim, shim.exports);
}

export interface LoadedTool {
    instance: EmscriptenModule;
    errors: string[];
    run(args: string[]): void;
}

/** Load a tool module (WASM by default, asm.js for mcpp) ready to callMain. */
export function loadTool(
    name: string,
    opts: { asmjs?: boolean; config?: Record<string, unknown> } = {},
): LoadedTool {
    const errors: string[] = [];
    const jsPath = join(opts.asmjs ? ASMJS_DIR : WASM_DIR, `${name}.js`);
    const factory = loadFactory(jsPath, name);

    const config: Record<string, unknown> = {
        noInitialRun: true,
        print: () => undefined,
        printErr: (s: string) => errors.push(s),
        ...(opts.config ?? {}),
    };
    if (!opts.asmjs) {
        const wasmModule = new WebAssembly.Module(readFileSync(join(WASM_DIR, `${name}.wasm`)));
        config.instantiateWasm = (
            imports: WebAssembly.Imports,
            ready: (i: WebAssembly.Instance) => void,
        ) => {
            const inst = new WebAssembly.Instance(wasmModule, imports);
            ready(inst);
            return inst.exports;
        };
    }

    const instance = factory(config);
    // Drop the exit-on-stray-rejection handlers the module just installed.
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');

    const run = (args: string[]) => {
        const realExit = process.exit;
        (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
            throw new Error(`emscripten-exit:${code ?? 0}`);
        };
        try {
            instance.callMain(args);
        } catch {
            /* expected: intercepted exit */
        } finally {
            (process as unknown as { exit: typeof realExit }).exit = realExit;
        }
    };

    return { instance, errors, run };
}

function mkdirp(FS: EmscriptenFS, path: string): void {
    let cur = '';
    for (const part of path.split('/').filter(Boolean)) {
        cur += `/${part}`;
        try {
            FS.mkdir(cur);
        } catch {
            /* already exists */
        }
    }
}

/**
 * Mount the bundled sdcc filesystem (crt0, z80 stdlib, C headers) at /share.
 * The web uses Emscripten WORKERFS (browser-only); under Node we slice the
 * packed .data per the metadata and write each file into the in-memory FS.
 */
export function mountShare(instance: EmscriptenModule): void {
    const meta = JSON.parse(readFileSync(join(FS_DIR, 'fssdcc.js.metadata'), 'utf8')) as {
        files: Array<{ start: number; end: number; filename: string }>;
    };
    const data = readFileSync(join(FS_DIR, 'fssdcc.data'));
    const FS = instance.FS;
    mkdirp(FS, '/share');
    for (const f of meta.files) {
        const full = `/share${f.filename}`;
        mkdirp(FS, full.slice(0, full.lastIndexOf('/')));
        FS.writeFile(full, data.subarray(f.start, f.end), { encoding: 'binary' });
    }
}

/** The bundled ZX crt0 object the linker needs. */
export function readCrt0(): Uint8Array {
    return readFileSync(join(ZX_DIR, 'crt0.rel'));
}

export interface ToolRun {
    module: string;
    args: string[];
    inputs?: Record<string, Uint8Array | string>;
    outputs: string[];
}
export interface ToolResult {
    files: Record<string, Uint8Array>;
    errors: string[];
}

/** Convenience single-shot runner (used by the zmac path). */
export function runTool(run: ToolRun): ToolResult {
    const tool = loadTool(run.module);
    for (const [name, content] of Object.entries(run.inputs ?? {})) {
        tool.instance.FS.writeFile(name, content);
    }
    tool.run(run.args);
    const files: Record<string, Uint8Array> = {};
    for (const out of run.outputs) {
        files[out] = Uint8Array.from(tool.instance.FS.readFile(out));
    }
    return { files, errors: tool.errors };
}
