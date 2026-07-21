// Headless emulation for rendering — the zx_go core (Go → WebAssembly, the
// same engine the sites run) hosted under Node. Drives every machine: the
// 48K/128K classics (embedded ROMs, tape auto-run with the LD-BYTES trap)
// and the Spectrum Next (real NextZXOS boot, programs delivered the way the
// sites deliver them).
//
// Runtime assets:
// - zx.wasm + wasm_exec.js: packages/emulator-core/dist in the repo, or
//   ./engine/zxgo/ in the Docker image (compiled by a golang build stage),
//   or $ZXGO_DIST.
// - NextZXOS ROMs + SD image (licensed, never committed): ./next-assets/,
//   or apps/play/public/next in the repo, or $NEXT_ASSETS_DIR.

import { readFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tapToNext } from './tap-to-next.mjs';
import { CompileError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SAMPLES_PER_FRAME = 882; // 44100 / 50, mono

// The Next's frame size is video-mode-dependent (320x240 boot timing,
// 320x256 Layer 2, 640-wide text modes). Composite every mode into one fixed
// box so encoders get constant dimensions; filler rows take the frame's own
// border colour. 320x256 at 1x, scaled 2x on output = 640x512, matching the
// sites' display box.
const BOX_W = 320;
const BOX_H = 256;

function firstExistingDir(candidates: string[]): string {
    for (const c of candidates) {
        if (c && existsSync(c)) return c;
    }
    throw new Error(`none of these directories exist: ${candidates.filter(Boolean).join(', ')}`);
}

// Browser-global shims for the Fyne package inits compiled into zx.wasm
// (they read navigator/document at init; none of the GUI ever runs).
function installBrowserShims(): void {
    const g = globalThis as any;
    try {
        Object.defineProperty(globalThis, 'navigator', {
            value: { userAgent: 'node', platform: 'linux', language: 'en' },
            configurable: true,
        });
    } catch {
        /* already overridable or defined */
    }
    if (!g.document) {
        g.document = {
            body: { style: { setProperty: () => undefined, removeProperty: () => undefined } },
            createElement: () => ({ style: {}, getContext: () => null, addEventListener: () => undefined }),
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            getElementById: () => null,
        };
    }
}

// One Go runtime per process (the zx_go exports are globals).
let runtimePromise: Promise<void> | null = null;

function loadRuntime(): Promise<void> {
    if (runtimePromise) return runtimePromise;
    runtimePromise = (async () => {
        installBrowserShims();
        const dist = firstExistingDir([
            process.env.ZXGO_DIST ?? '',
            join(__dirname, '../../..', 'packages/emulator-core/dist'),
            join(__dirname, '../engine/zxgo'),
        ]);
        // wasm_exec.js is a classic script defining globalThis.Go.
        (0, eval)(readFileSync(join(dist, 'wasm_exec.js'), 'utf8'));
        const go = new (globalThis as any).Go();
        // Surface ZX_GO_* diagnostics (NEXTREG_WATCH, FORCE_SPEED, ...) to
        // the core; wasm_exec's default env is empty under Node.
        go.env = process.env;
        const wasm = await WebAssembly.instantiate(readFileSync(join(dist, 'zx.wasm')), go.importObject);
        go.run(wasm.instance); // runs forever; exports appear asynchronously
        await new Promise<void>((resolve, reject) => {
            const t0 = Date.now();
            const t = setInterval(() => {
                if ((globalThis as any).zxReady) { clearInterval(t); resolve(); }
                else if (Date.now() - t0 > 30000) { clearInterval(t); reject(new Error('zx_go core did not become ready')); }
            }, 10);
        });
    })();
    return runtimePromise;
}

export interface ZxGoFrame {
    rgba: Uint8Array; // BOX_W x BOX_H fixed-size composite
    audio: Float32Array; // mono, SAMPLES_PER_FRAME
}

export class ZxGoEmulator {
    private buf: Uint8Array = new Uint8Array(0);
    private w = 0;
    private h = 0;
    private audioPull = new Uint8Array(SAMPLES_PER_FRAME * 4);

    static readonly BOX_W = BOX_W;
    static readonly BOX_H = BOX_H;

    /** Load the core and boot NextZXOS off the staged SD image. */
    async boot(): Promise<void> {
        await loadRuntime();
        const g = globalThis as any;
        const assets = firstExistingDir([
            process.env.NEXT_ASSETS_DIR ?? '',
            join(__dirname, '../next-assets'),
            join(__dirname, '../../..', 'apps/play/public/next'),
        ]);
        g.zxRegisterROM('enNextZX.rom', new Uint8Array(readFileSync(join(assets, 'enNextZX.rom'))));
        g.zxRegisterROM('enNxtmmc.rom', new Uint8Array(readFileSync(join(assets, 'enNxtmmc.rom'))));
        const sdPath = join(assets, 'tbblue.mmc');
        if (g.zxSdIngestBegin) {
            // Stream the image into the core's SPARSE card in disk-sized
            // chunks — the browser's ingest path minus the zip. The staged
            // card is distro-capacity (1 GB since the trim-distro-card.sh
            // rebuild) with only a few MB of real content; a flat
            // readFileSync + zxBootNext(bytes) holds the WHOLE image in the
            // Node heap and again in the wasm heap, which breaks the
            // container's 2 GB cap. Sparse ingest keeps residency at the
            // card's real content.
            const size = statSync(sdPath).size;
            const beginErr = g.zxSdIngestBegin(size);
            if (beginErr) throw new Error(`zxSdIngestBegin: ${beginErr}`);
            const fd = openSync(sdPath, 'r');
            try {
                const buf = new Uint8Array(4 * 1024 * 1024);
                for (;;) {
                    const n = readSync(fd, buf, 0, buf.length, null);
                    if (n <= 0) break;
                    const chunkErr = g.zxSdIngestChunk(n === buf.length ? buf : buf.subarray(0, n));
                    if (chunkErr) throw new Error(`zxSdIngestChunk: ${chunkErr}`);
                }
            } finally {
                closeSync(fd);
            }
            const bootErr = g.zxBootNext();
            if (bootErr) throw new Error(`zxBootNext: ${bootErr}`);
        } else {
            // Old core without the sparse exports: flat mount.
            g.zxBootNext(new Uint8Array(readFileSync(sdPath)));
        }
        await new Promise<void>((resolve, reject) => {
            const t0 = Date.now();
            const t = setInterval(() => {
                if ((g.zxModel() || '').includes('Next')) { clearInterval(t); resolve(); }
                else if (Date.now() - t0 > 30000) { clearInterval(t); reject(new Error('Next machine did not come up')); }
            }, 25);
        });
    }

    /** Boot a classic machine (48 or 128) from the embedded ROMs. */
    async bootClassic(model: 48 | 128): Promise<void> {
        await loadRuntime();
        const g = globalThis as any;
        const err = g.zxBoot(String(model));
        if (err) throw new Error(`zxBoot: ${err}`);
        const frag = model === 48 ? '48K' : '128K';
        await new Promise<void>((resolve, reject) => {
            const t0 = Date.now();
            const t = setInterval(() => {
                if ((g.zxModel() || '').includes(frag)) { clearInterval(t); resolve(); }
                else if (Date.now() - t0 > 30000) { clearInterval(t); reject(new Error(`${model}K machine did not come up`)); }
            }, 25);
        });
    }

    /**
     * Classic tape auto-run: reboot, drive LOAD"" (48K) / the 128 Tape
     * Loader via the core's keystroke macro, fast-loaded by the LD-BYTES
     * trap. zxMacroActive covers the boot-and-typing phase.
     */
    runTAPClassic(tapData: Buffer): void {
        const g = globalThis as any;
        g.zxTapeTraps(true);
        const err = g.zxLoadTap(new Uint8Array(tapData));
        if (err) throw new Error(`tape auto-run failed: ${err}`);
    }

    /** Current tape block index — advances as the trap pulls blocks in, so
     *  it marks the loader phase distinctly from the program running after. */
    tapeBlock(): number {
        const st = (globalThis as any).zxTapeStatus?.();
        return st && st.inserted ? st.block : -1;
    }

    /**
     * Deliver a compiled TAP the way the sites do: BASIC programs become a
     * PLUS3DOS file LOADed at the NextZXOS command line; machine code becomes
     * a generated .nex run via .nexload. Throws for untranslatable tapes.
     */
    runTAP(tapData: Buffer): void {
        const g = globalThis as any;
        // A tape the translator can't express as a NextZXOS program is the
        // project's shape, not a service fault: surface it as a CompileError
        // so the routes answer 422 (web shows the cartridge fallback).
        let next: ReturnType<typeof tapToNext>;
        try {
            next = tapToNext(new Uint8Array(tapData));
        } catch (err) {
            throw new CompileError(err instanceof Error ? err.message : String(err));
        }
        const err = next.kind === 'bas'
            ? g.zxRunBas(next.name, next.data)
            : g.zxRunNex(next.name, next.data);
        if (err) throw new Error(`Next ${next.kind} delivery failed: ${err}`);
    }

    /** True while the boot/typing macro still drives the machine. */
    macroActive(): boolean {
        return !!(globalThis as any).zxMacroActive?.();
    }

    /** Run one frame; returns the fixed-size RGBA composite + mono audio. */
    runFrame(): ZxGoFrame {
        const g = globalThis as any;
        let d = g.zxFrame(this.buf.length ? this.buf : undefined);
        if (d.w * d.h * 4 !== this.buf.length) {
            this.buf = new Uint8Array(d.w * d.h * 4);
            d = g.zxFrame(this.buf);
        }
        this.w = d.w; this.h = d.h;

        const rgba = this.composite();

        const n: number = g.zxPullAudio(this.audioPull);
        const audio = new Float32Array(SAMPLES_PER_FRAME);
        const s16 = new Int16Array(this.audioPull.buffer, 0, Math.min(n, SAMPLES_PER_FRAME));
        for (let i = 0; i < s16.length; i++) audio[i] = s16[i] / 32768;

        return { rgba, audio };
    }

    // Composite the (mode-dependent) raw frame into the fixed BOX, centred,
    // filler in the frame's border colour. Frames >=600px wide are the Next's
    // half-width-pixel modes: sample every second pixel.
    private composite(): Uint8Array {
        const out = new Uint8Array(BOX_W * BOX_H * 4);
        const src = this.buf;
        const w = this.w, h = this.h;
        const xStep = w >= 600 ? 2 : 1;
        const visW = Math.floor(w / xStep);
        const copyW = Math.min(visW, BOX_W);
        const copyH = Math.min(h, BOX_H);
        const dx = (BOX_W - copyW) >> 1;
        const dy = (BOX_H - copyH) >> 1;
        // Border colour from the frame's corner pixel.
        const r = src[0], g = src[1], b = src[2];
        for (let i = 0; i < out.length; i += 4) {
            out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
        }
        const sy0 = h > BOX_H ? (h - BOX_H) >> 1 : 0;
        const sx0 = visW > BOX_W ? (visW - BOX_W) >> 1 : 0;
        for (let y = 0; y < copyH; y++) {
            let di = ((dy + y) * BOX_W + dx) * 4;
            let si = ((sy0 + y) * w + sx0 * xStep) * 4;
            for (let x = 0; x < copyW; x++) {
                out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = 255;
                di += 4; si += 4 * xStep;
            }
        }
        return out;
    }
}
