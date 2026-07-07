import GIFEncoder from 'gif-encoder-2';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { ZxGoEmulator } from './emulator-zxgo.js';
import { readFile, unlink, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SAMPLE_RATE = 44100;
const SAMPLES_PER_FRAME = SAMPLE_RATE / 50; // 882 stereo samples per 50fps frame
const AUDIO_SILENCE_EPS = 0.001; // a channel whose peak-to-peak is below this is flat (silent)

interface AudioFrame {
    left: Float32Array;
    right: Float32Array;
}

export type MachineType = number | 'next';

export interface GIFGeneratorOptions {
    maxDurationMs: number;
    staleFrameThreshold: number;
    ignoreInitialFrames: number;
    scale: number;
}

export class GIFGenerator {
    private options: GIFGeneratorOptions;

    constructor(options: Partial<GIFGeneratorOptions> = {}) {
        this.options = {
            maxDurationMs: options.maxDurationMs ?? 30000,
            staleFrameThreshold: options.staleFrameThreshold ?? 150,
            ignoreInitialFrames: options.ignoreInitialFrames ?? 0,
            scale: options.scale ?? 2,
        };
    }

    async initialize(): Promise<void> {
        // The zx_go runtime loads lazily on first capture; kept for API
        // compatibility with the routes.
    }

    // Hand control back to the event loop mid-render. The capture loops are
    // synchronous (emu.runFrame() never awaits), so without this a render
    // monopolises the single thread for tens of seconds and /health can't
    // answer — a health-based restart (autoheal/Swarm) then SIGTERMs the
    // container mid-render. Safe under MAX_CONCURRENT_RENDERS=1: the render
    // slot is held, so no second render starts; only /health and queued
    // waiters run during the yield.
    private yieldToLoop(): Promise<void> {
        return new Promise((resolve) => setImmediate(resolve));
    }

    private areFramesIdentical(frame1: Uint8Array, frame2: Uint8Array): boolean {
        if (frame1.length !== frame2.length) {
            return false;
        }
        for (let i = 0; i < frame1.length; i++) {
            if (frame1[i] !== frame2[i]) {
                return false;
            }
        }
        return true;
    }

    // Count "ink" pixels: how many pixels differ from the frame's dominant
    // colour (sampled). On a cleared screen the paper dominates and the count
    // is ~0; text and graphics read higher. The RGBA equivalent of the old
    // core's bitmap-byte count, used by findProgramStart.
    private screenInk(rgba: Uint8Array): number {
        const counts = new Map<number, number>();
        for (let i = 0; i < rgba.length; i += 32) { // every 8th pixel
            const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        let dominant = 0, best = -1;
        for (const [k, n] of counts) if (n > best) { best = n; dominant = k; }
        const dr = (dominant >> 16) & 0xff, dg = (dominant >> 8) & 0xff, db = dominant & 0xff;
        let ink = 0;
        for (let i = 0; i < rgba.length; i += 16) { // every 4th pixel
            if (rgba[i] !== dr || rgba[i + 1] !== dg || rgba[i + 2] !== db) ink++;
        }
        return ink;
    }

    // Pick the frame the clip should open on: the program's first own frame,
    // with the ROM loader skipped entirely. Tape-load traps fire only while LOAD
    // pulls blocks in, so `lastLoadFrame` is where the loader hands control to
    // the program. From there the program typically clears the loader screen
    // (CLS), which is the one event that reliably wipes the ROM's "Program:" /
    // "Bytes:" text. Open on the first frame that draws content after that clear,
    // so no opening-animation frame is lost and no loader text is ever shown.
    private findProgramStart(
        frames: Uint8Array[],
        lastLoadFrame: number,
        lastChangeIndex: number,
    ): number {
        if (lastLoadFrame < 0) return 0; // no tape load seen; nothing to skip
        const CLEAR_INK = 2; // at/below this the screen is effectively blank
        const afterLoad = Math.min(lastLoadFrame + 1, lastChangeIndex);

        // Find the program's first screen clear after the loader handoff.
        let clearedAt = -1;
        for (let i = afterLoad; i <= lastChangeIndex; i++) {
            if (this.screenInk(frames[i]) <= CLEAR_INK) {
                clearedAt = i;
                break;
            }
        }
        // No clear (e.g. a program that loads a screen and draws straight over
        // it): best effort is the loader handoff frame.
        if (clearedAt < 0) return afterLoad;

        // Open on the first frame that draws anything after the clear. Catching
        // the very first drawn pixel (not a content threshold) means a slow
        // opening animation keeps all its frames. If the program never draws
        // (blank or audio-only), stay on the cleared frame.
        for (let i = clearedAt + 1; i <= lastChangeIndex; i++) {
            if (this.screenInk(frames[i]) > CLEAR_INK) return i;
        }
        return clearedAt;
    }

    /**
     * Classic 48K/128K path on the zx_go core: boot from embedded ROMs, let
     * the core's own keystroke macro drive LOAD"" / the 128 Tape Loader with
     * the LD-BYTES trap loading blocks instantly. Capture runs THROUGH the
     * boot-and-typing phase (stale-stop disarmed until the macro ends) and
     * findProgramStart trims to the program's first own frame using the
     * tape-block progression as the loader marker — the same opening-frame
     * logic the service has always had.
     */
    private async captureFrames(
        tapData: Buffer,
        machineType: number,
        captureAudio: boolean,
    ): Promise<{ frames: Uint8Array[]; audio: AudioFrame[] }> {
        const emu = new ZxGoEmulator();
        console.log(`Booting ${machineType}K machine (zx_go core)`);
        await emu.bootClassic(machineType === 128 ? 128 : 48);
        emu.runTAPClassic(tapData);

        const maxFrames = Math.floor(this.options.maxDurationMs / 20) + 600; // + boot margin
        const staleStop = this.options.staleFrameThreshold;
        const tailFrames = 25;
        const renderDeadline = Date.now() + Math.max(this.options.maxDurationMs * 20, 300_000);

        const frames: Uint8Array[] = [];
        const audio: AudioFrame[] = [];
        let previousFrame: Uint8Array | null = null;
        let staleCount = 0;
        let lastChangeIndex = -1;
        let lastLoadFrame = -1;
        let prevBlock = emu.tapeBlock();

        for (let f = 0; f < maxFrames; f++) {
            if ((f & 31) === 0) await this.yieldToLoop(); // keep /health responsive
            if (Date.now() > renderDeadline) {
                console.warn(`Render wall-clock budget exceeded after ${f} frames; stopping`);
                break;
            }
            const { rgba, audio: mono } = emu.runFrame();
            frames.push(rgba);

            const blk = emu.tapeBlock();
            if (blk !== prevBlock) { lastLoadFrame = f; prevBlock = blk; }

            let audioSilent = true;
            if (captureAudio) {
                audio.push({ left: mono, right: mono });
                audioSilent = this.isAudioSilent(mono, mono);
            }
            const videoStatic =
                previousFrame !== null && this.areFramesIdentical(rgba, previousFrame);
            if (!videoStatic || !audioSilent) {
                staleCount = 0;
                lastChangeIndex = f;
            } else if (emu.macroActive()) {
                staleCount = 0; // boot/typing phase: never stale-stop here
            } else {
                staleCount++;
                if (staleCount >= staleStop) {
                    console.log(`Program settled after ${f + 1} captured frames`);
                    break;
                }
            }
            previousFrame = rgba;
        }

        if (lastChangeIndex < 0) {
            const keepStatic = Math.min(frames.length, tailFrames);
            console.log(`Captured ${frames.length} frames, no changes; keeping ${keepStatic}`);
            return { frames: frames.slice(0, keepStatic), audio: audio.slice(0, keepStatic) };
        }

        const start = this.findProgramStart(frames, lastLoadFrame, lastChangeIndex);
        const keep = Math.min(frames.length, lastChangeIndex + 1 + tailFrames);
        console.log(`Captured ${frames.length} frames, keeping ${start}..${keep}`);
        return { frames: frames.slice(start, keep), audio: audio.slice(start, keep) };
    }

    /**
     * Next path: boot real NextZXOS, deliver the compiled TAP the way the
     * sites do (PLUS3DOS LOAD for BASIC, generated .nex via .nexload for
     * machine code), and capture from the moment the boot-and-typing macro
     * hands over.
     */
    private async captureFramesNext(
        tapData: Buffer,
        captureAudio: boolean,
    ): Promise<{ frames: Uint8Array[]; audio: AudioFrame[] }> {
        const emu = new ZxGoEmulator();
        console.log('Booting Spectrum Next (zx_go core) for render');
        await emu.boot();
        emu.runTAP(tapData);

        const macroDeadline = Date.now() + 300_000;
        let skipped = 0;
        while (emu.macroActive()) {
            if ((skipped & 31) === 0) await this.yieldToLoop(); // keep /health responsive
            emu.runFrame();
            skipped++;
            if (skipped > 15000 || Date.now() > macroDeadline) {
                throw new Error('Next boot macro did not complete');
            }
        }
        console.log(`Next macro complete after ${skipped} skipped frames`);

        const maxFrames = Math.floor(this.options.maxDurationMs / 20);
        const staleStop = this.options.staleFrameThreshold;
        const tailFrames = 25;
        const renderDeadline = Date.now() + Math.max(this.options.maxDurationMs * 20, 300_000);

        const frames: Uint8Array[] = [];
        const audio: AudioFrame[] = [];
        let previousFrame: Uint8Array | null = null;
        let staleCount = 0;
        let lastChangeIndex = -1;

        for (let f = 0; f < maxFrames; f++) {
            if ((f & 31) === 0) await this.yieldToLoop(); // keep /health responsive
            if (Date.now() > renderDeadline) {
                console.warn(`Next render wall-clock budget exceeded after ${f} frames; stopping`);
                break;
            }
            const { rgba, audio: mono } = emu.runFrame();
            frames.push(rgba);

            let audioSilent = true;
            if (captureAudio) {
                audio.push({ left: mono, right: mono });
                audioSilent = this.isAudioSilent(mono, mono);
            }
            const videoStatic =
                previousFrame !== null && this.areFramesIdentical(rgba, previousFrame);
            if (videoStatic && audioSilent) {
                staleCount++;
                if (staleCount >= staleStop) {
                    console.log(`Next program settled after ${f + 1} captured frames`);
                    break;
                }
            } else {
                staleCount = 0;
                lastChangeIndex = f;
            }
            previousFrame = rgba;
        }

        if (lastChangeIndex < 0) {
            const keepStatic = Math.min(frames.length, tailFrames);
            return { frames: frames.slice(0, keepStatic), audio: audio.slice(0, keepStatic) };
        }
        const keep = Math.min(frames.length, lastChangeIndex + 1 + tailFrames);
        console.log(`Next capture: ${frames.length} frames, keeping 0..${keep}`);
        return { frames: frames.slice(0, keep), audio: audio.slice(0, keep) };
    }

    // Frame adapter: every machine renders through the same fixed 320x256
    // composite (matching the sites' display box), integer-upscaled here.
    private frameAdapter(_machineType: MachineType): {
        width: number; height: number; toRGBA: (frame: Uint8Array) => Uint8Array;
    } {
        const scale = this.options.scale;
        const w = ZxGoEmulator.BOX_W, h = ZxGoEmulator.BOX_H;
        return {
            width: w * scale,
            height: h * scale,
            toRGBA: (frame) => this.scaleRGBA(frame, w, h, scale),
        };
    }

    private scaleRGBA(src: Uint8Array, w: number, h: number, scale: number): Uint8Array {
        if (scale === 1) return src;
        const out = new Uint8Array(w * scale * h * scale * 4);
        const outW = w * scale;
        for (let y = 0; y < h * scale; y++) {
            const sy = (y / scale) | 0;
            for (let x = 0; x < outW; x++) {
                const sx = (x / scale) | 0;
                const si = (sy * w + sx) * 4;
                const di = (y * outW + x) * 4;
                out[di] = src[si]; out[di + 1] = src[si + 1];
                out[di + 2] = src[si + 2]; out[di + 3] = 255;
            }
        }
        return out;
    }

    private captureFor(
        tapData: Buffer,
        machineType: MachineType,
        captureAudio: boolean,
    ): Promise<{ frames: Uint8Array[]; audio: AudioFrame[] }> {
        return machineType === 'next'
            ? this.captureFramesNext(tapData, captureAudio)
            : this.captureFrames(tapData, machineType as number, captureAudio);
    }

    private isAudioSilent(left: Float32Array, right: Float32Array): boolean {
        return this.channelFlat(left) && this.channelFlat(right);
    }

    // A channel is "silent" when it is flat: an idle beeper/AY holds a constant
    // (often non-zero) DC level, so detect a lack of oscillation, not zero.
    private channelFlat(samples: Float32Array): boolean {
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < samples.length; i++) {
            const v = samples[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        return max - min < AUDIO_SILENCE_EPS;
    }

    /** Render the program to an animated GIF (25fps to keep size sane). GIF carries no audio. */
    async generateFromTAP(tapData: Buffer, machineType: MachineType = 48): Promise<Buffer> {
        const { frames } = await this.captureFor(tapData, machineType, false);
        const fit = this.frameAdapter(machineType);

        // The core runs at 50fps; encode every 2nd frame (25fps) to halve GIF
        // size and encode time with little visible loss.
        const frameStep = 2;
        const encoder = new GIFEncoder(fit.width, fit.height, 'neuquant');
        encoder.setDelay(20 * frameStep);
        encoder.setRepeat(0); // loop forever
        encoder.setQuality(10);
        encoder.start();

        for (let i = 0; i < frames.length; i += frameStep) {
            encoder.addFrame(fit.toRGBA(frames[i]));
        }
        encoder.finish();
        return Buffer.from(encoder.out.getData());
    }

    /** Render the program to an H.264 MP4 at the full 50fps, with AAC audio. */
    async generateMp4FromTAP(tapData: Buffer, machineType: MachineType = 48): Promise<Buffer> {
        const { frames, audio } = await this.captureFor(tapData, machineType, true);
        return this.encodeMp4(frames, audio, 50, this.options.scale);
    }

    // Concatenate per-frame stereo audio into one interleaved (L,R,L,R) f32 buffer.
    private interleaveAudio(audio: AudioFrame[]): Buffer {
        const total = audio.reduce((sum, a) => sum + a.left.length, 0);
        const interleaved = new Float32Array(total * 2);
        let p = 0;
        for (const { left, right } of audio) {
            for (let i = 0; i < left.length; i++) {
                interleaved[p++] = left[i];
                interleaved[p++] = right[i];
            }
        }
        return Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
    }

    /** Pipe native RGBA frames through ffmpeg to a temporary MP4 and return it.
     *  ffmpeg upscales (nearest-neighbour, so the pixels stay crisp) during
     *  encode — far cheaper than a per-frame JS scale loop, and the pipe carries
     *  scale^2 less data (native 320x256 instead of the upscaled frame). */
    private async encodeMp4(
        frames: Uint8Array[],
        audio: AudioFrame[],
        fps: number,
        scale: number,
    ): Promise<Buffer> {
        const w = ZxGoEmulator.BOX_W;
        const h = ZxGoEmulator.BOX_H;
        const s = Math.max(1, Math.floor(scale));
        const outPath = join(tmpdir(), `zxplay-${process.pid}-${Date.now()}.mp4`);

        // Only attach an audio track when the program actually made a sound;
        // a silent program is encoded video-only (-an), as it was before audio
        // support. Audio (when present) goes via a temp f32le file as a second
        // ffmpeg input; video stays on stdin. Both are frames/50 seconds long.
        const hasAudio = audio.some((a) => !this.isAudioSilent(a.left, a.right));
        const audioPath = outPath.replace(/\.mp4$/, '.f32le');
        if (hasAudio) {
            await writeFile(audioPath, this.interleaveAudio(audio));
        }

        const args = [
            '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(fps),
            '-i', 'pipe:0',
        ];
        if (hasAudio) {
            args.push('-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', audioPath);
        }
        // Upscale in ffmpeg (SIMD C) rather than a JS loop; nearest-neighbour
        // preserves the crisp integer-pixel look the JS scaler produced.
        if (s !== 1) {
            args.push('-vf', `scale=${w * s}:${h * s}:flags=neighbor`);
        }
        args.push(
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
        );
        if (hasAudio) {
            args.push('-c:a', 'aac', '-b:a', '128k', '-shortest');
        } else {
            args.push('-an');
        }
        args.push('-movflags', '+faststart', '-y', outPath);
        const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        ff.stderr.on('data', (d) => { stderr += d.toString(); });
        ff.stdin.on('error', () => undefined); // EPIPE if ffmpeg exits early; close handler reports status

        const finished = new Promise<void>((resolve, reject) => {
            ff.on('error', reject);
            ff.on('close', (code) =>
                code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)),
            );
        });

        for (const raw of frames) {
            if (!ff.stdin.write(raw)) {
                await new Promise<void>((resolve) => ff.stdin.once('drain', () => resolve()));
            }
        }
        ff.stdin.end();
        await finished;

        const buffer = await readFile(outPath);
        await unlink(outPath).catch(() => undefined);
        if (hasAudio) await unlink(audioPath).catch(() => undefined);
        console.log(`Encoded MP4: ${frames.length} frames @ ${w * s}x${h * s}, ${buffer.length} bytes${hasAudio ? ' (with audio)' : ''}`);
        return buffer;
    }

    /** Render a representative still frame to a 4:3 PNG (Spectrum border included). */
    async generatePngFromTAP(tapData: Buffer, machineType: MachineType = 48): Promise<Buffer> {
        const { frames } = await this.captureFor(tapData, machineType, false);
        const frame = frames[frames.length - 1] ?? frames[0];
        if (!frame) throw new Error('No frame captured');
        return this.encodePng(frame, this.frameAdapter(machineType));
    }

    /** ffmpeg-encode one decoded frame to a PNG at its native 4:3 size (border
     *  included). The card fills it with object-fit: cover, so the outer border
     *  is cropped to the square crop, not the screen. */
    private async encodePng(
        frame: Uint8Array,
        fit: { width: number; height: number; toRGBA: (frame: Uint8Array) => Uint8Array },
    ): Promise<Buffer> {
        const width = fit.width;
        const height = fit.height;
        const rgba = fit.toRGBA(frame);
        const outPath = join(tmpdir(), `zxshot-${process.pid}-${Date.now()}.png`);

        const args = [
            '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', 'pipe:0',
            '-frames:v', '1',
            '-y', outPath,
        ];
        const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        ff.stderr.on('data', (d) => { stderr += d.toString(); });
        // If ffmpeg exits early the stdin write EPIPEs; swallow it (the close
        // handler reports the real status) so it can't crash the process.
        ff.stdin.on('error', () => undefined);
        const finished = new Promise<void>((resolve, reject) => {
            ff.on('error', reject);
            ff.on('close', (code) =>
                code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)),
            );
        });
        ff.stdin.write(rgba);
        ff.stdin.end();
        await finished;

        const buffer = await readFile(outPath);
        await unlink(outPath).catch(() => undefined);
        return buffer;
    }

}
