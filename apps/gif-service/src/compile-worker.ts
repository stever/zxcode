import { compileProject } from './compile.js';
import { CompileError } from './errors.js';

// Child process for one compile. The parent (compile-isolated.ts) forks this per
// request and SIGKILLs it on timeout, so a synchronous hang in a WASM compiler
// dies with the child instead of wedging the service's event loop.
interface CompileRequest {
    lang: string;
    code: string;
}

process.on('message', async (msg: CompileRequest) => {
    try {
        const tap = await compileProject(msg.lang, msg.code);
        // Small payloads; base64 over IPC avoids Buffer-serialisation quirks.
        process.send!({ ok: true, tapB64: tap.toString('base64') }, () => process.exit(0));
    } catch (err) {
        process.send!(
            {
                ok: false,
                compile: err instanceof CompileError,
                error: err instanceof Error ? err.message : String(err),
            },
            () => process.exit(0),
        );
    }
});
