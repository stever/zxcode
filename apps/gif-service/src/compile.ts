import { CompileError } from './errors.js';
import { compileViaAction, ProjectFileRecord } from './api.js';

interface ToolMessage {
    type: string;
    text: string;
}

// zmakebas, pasmo and bas2tap reject with an array of { type, text } messages.
// Pull out the error lines for a readable detail string.
function detailFromMessages(messages: unknown): string {
    if (Array.isArray(messages)) {
        const text = (messages as ToolMessage[])
            .filter((m) => m.type === 'err')
            .map((m) => m.text)
            .join('\n');
        return text || 'unknown error';
    }
    return messages instanceof Error ? messages.message : String(messages);
}

// Run an in-process WASM compiler, mapping any failure (including a module that
// fails to load) to a CompileError so one bad language can't take down the
// service. The compiler is imported lazily inside `run` for the same reason.
async function inProcess(run: () => Promise<Uint8Array>): Promise<Buffer> {
    try {
        return Buffer.from(await run());
    } catch (messages) {
        throw new CompileError(detailFromMessages(messages));
    }
}

// Additional project files as inputs for the in-process WASM tools: text
// content as-is, binary assets decoded from base64.
function toToolInputs(files: ProjectFileRecord[]): Record<string, Uint8Array | string> {
    const inputs: Record<string, Uint8Array | string> = {};
    for (const f of files) {
        inputs[f.name] = f.is_binary ? Uint8Array.from(Buffer.from(f.content, 'base64')) : f.content;
    }
    return inputs;
}

/**
 * Compile a project's source to a self-loading TAP, dispatching on language.
 *
 * In-process WASM: basic (zmakebas), bas2tap, asm (pasmo --tapbas loader).
 * In-process JS: nextbas (txt2bas — the consolidated Sinclair/NextBASIC).
 * Via the api compile mutations: zxbasic (Boriel), c (z88dk), sjasmplus, pascal, forth (zenv).
 *
 * `machine` ('48' | '128' | 'next') is only consulted by languages whose
 * codegen depends on the target — currently pascal (Pasta80). `files` are the
 * project's additional files (includes, INCBIN assets); the action-backed
 * languages forward them and the zmac/sdcc pipelines stage them locally.
 */
export async function compileProject(
    lang: string,
    code: string,
    machine?: string,
    files: ProjectFileRecord[] = [],
): Promise<Buffer> {
    switch (lang) {
        case 'basic':
            return inProcess(async () => {
                const { default: zmakebas } = await import('zmakebas');
                return zmakebas(code);
            });
        case 'bas2tap':
            return inProcess(async () => {
                const { default: getBas2Tap } = await import('bas2tap');
                return getBas2Tap(code);
            });
        case 'nextbas':
            // Consolidated Sinclair/NextBASIC: txt2bas tokenises for every
            // machine. Always emit the TAP format — a Next render translates
            // it into NextZXOS's native delivery exactly as the sites do
            // (tap-to-next.mjs), and a classic render tape-loads it. The
            // autostart line rides in the TAP header (injected from the
            // first line when the source doesn't set one, mirroring the
            // web app's lib/nextbas.js).
            return inProcess(async () => {
                const { file2bas } = await import('txt2bas');
                const firstLine = code.match(/^\s*(\d+)\b/m);
                const src = /^\s*#autostart\b/m.test(code) || !firstLine
                    ? code
                    : `#autostart ${firstLine[1]}\n${code}`;
                return file2bas(src, { filename: 'PROGRAM', format: 'tap' });
            });
        case 'asm':
            return inProcess(async () => {
                const { default: getPasmoTap } = await import('pasmo');
                return getPasmoTap(code);
            });
        case 'zxbasic':
            return Buffer.from(await compileViaAction('compile', code, undefined, files));
        case 'c':
            return Buffer.from(await compileViaAction('compileC', code, undefined, files));
        case 'sjasmplus':
            // May return a TAP or (SAVENEX source) a NEX image; the emulator
            // sniffs the 'Next' signature at load and routes accordingly.
            return Buffer.from(await compileViaAction('compileSjasmplus', code, undefined, files));
        case 'pascal':
            // Pasta80 Turbo Pascal; compiled for the machine the render will
            // boot so the linked runtime matches.
            return Buffer.from(await compileViaAction('compilePascal', code, machine ?? '48', files));
        case 'forth':
            // zenv Forth: the program embedded into the zenv image; no
            // machine or files (the image is a 48K program, and zenv has
            // no file words).
            return Buffer.from(await compileViaAction('compileForth', code));
        case 'zmac':
            return inProcess(async () => {
                const { runTool } = await import('./wasm-tools.js');
                const { files: outFiles, errors } = runTool({
                    module: 'zmac',
                    inputs: { ...toToolInputs(files), 'in.asm': code },
                    args: ['-z', '-c', '--oo', 'lst,cim', 'in.asm'],
                    outputs: ['zout/in.cim'],
                });
                const cim = outFiles['zout/in.cim'];
                if (!cim || cim.length === 0) {
                    // errors are raw stderr strings; join them so the reason
                    // surfaces (logged + returned) rather than "unknown error".
                    throw new Error(errors.join('\n').slice(0, 500) || 'zmac produced no output');
                }
                // Wrap the raw code image (ORG 0x8000) into a self-loading TAP.
                const { bin2tap } = await import('pasmo');
                return bin2tap(Buffer.from(cim));
            });
        case 'sdcc':
            return inProcess(async () => {
                const { compileSdcc } = await import('./tools-sdcc.js');
                return compileSdcc(code, files);
            });
        default:
            throw new CompileError(`Unknown language "${lang}"`);
    }
}
