import { CompileError } from './errors.js';
import { compileViaAction } from './hasura.js';

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

/**
 * Compile a project's source to a self-loading TAP, dispatching on language.
 *
 * In-process WASM: basic (zmakebas), bas2tap, asm (pasmo --tapbas loader).
 * Via Hasura actions: zxbasic (Boriel), c (z88dk).
 * Not yet supported: zmac / sdcc (multi-step WASM toolchains that today live
 * only in the web worker — see work item #44).
 */
export async function compileProject(lang: string, code: string): Promise<Buffer> {
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
        case 'asm':
            return inProcess(async () => {
                const { default: getPasmoTap } = await import('pasmo');
                return getPasmoTap(code);
            });
        case 'zxbasic':
            return Buffer.from(await compileViaAction('compile', code));
        case 'c':
            return Buffer.from(await compileViaAction('compileC', code));
        case 'zmac':
            return inProcess(async () => {
                const { runTool } = await import('./wasm-tools.js');
                const { files, errors } = runTool({
                    module: 'zmac',
                    inputs: { 'in.asm': code },
                    args: ['-z', '-c', '--oo', 'lst,cim', 'in.asm'],
                    outputs: ['zout/in.cim'],
                });
                const cim = files['zout/in.cim'];
                if (!cim || cim.length === 0) {
                    throw errors.length ? errors : new Error('zmac produced no output');
                }
                // Wrap the raw code image (ORG 0x8000) into a self-loading TAP.
                const { bin2tap } = await import('pasmo');
                return bin2tap(Buffer.from(cim));
            });
        case 'sdcc':
            throw new CompileError(`Language "${lang}" can't be rendered yet`);
        default:
            throw new CompileError(`Unknown language "${lang}"`);
    }
}
