import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CompileError } from './errors.js';

// Run the worker under tsx (the service itself runs via tsx, so it's installed).
const WORKER_PATH = fileURLToPath(new URL('./compile-worker.ts', import.meta.url));
const COMPILE_TIMEOUT_MS = parseInt(process.env.COMPILE_TIMEOUT_MS ?? '20000', 10);

/**
 * Compile in a forked child and SIGKILL it if it overruns. This is the only way
 * to bound an in-process WASM compiler: a synchronous hang blocks the event
 * loop, so a main-thread timer can't interrupt it, but killing a separate
 * process always works. The service is single-client and sequential, so one
 * child per request is fine.
 */
export function compileProjectIsolated(lang: string, code: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = fork(WORKER_PATH, { execArgv: ['--import', 'tsx'] });
        let settled = false;

        const finish = (action: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill('SIGKILL');
            action();
        };

        const timer = setTimeout(
            () => finish(() => reject(new CompileError(`Compilation timed out after ${COMPILE_TIMEOUT_MS}ms`))),
            COMPILE_TIMEOUT_MS,
        );

        child.on('message', (m: any) =>
            finish(() => {
                if (m?.ok) {
                    resolve(Buffer.from(m.tapB64, 'base64'));
                } else {
                    reject(m?.compile ? new CompileError(m.error) : new Error(m?.error ?? 'compile failed'));
                }
            }),
        );
        child.on('error', (err) => finish(() => reject(err)));
        child.on('exit', (codeNum) =>
            finish(() => reject(new Error(`compile worker exited unexpectedly (code ${codeNum})`))),
        );

        child.send({ lang, code });
    });
}
