import GIFEncoder from 'gif-encoder-2';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { Emulator } from './emulator.js';
import { FrameDecoder } from './frame-decoder.js';
import { readFile, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface GIFGeneratorOptions {
    maxDurationMs: number;
    staleFrameThreshold: number;
    ignoreInitialFrames: number;
    scale: number;
}

export class GIFGenerator {
    private emulator: Emulator;
    private decoder: FrameDecoder;
    private options: GIFGeneratorOptions;

    constructor(options: Partial<GIFGeneratorOptions> = {}) {
        this.options = {
            maxDurationMs: options.maxDurationMs ?? 30000,
            staleFrameThreshold: options.staleFrameThreshold ?? 150,
            ignoreInitialFrames: options.ignoreInitialFrames ?? 0,
            scale: options.scale ?? 2,
        };
        this.emulator = new Emulator();
        this.decoder = new FrameDecoder({ scale: this.options.scale });
    }

    async initialize(): Promise<void> {
        await this.emulator.loadCore();
        await this.emulator.loadRoms();
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

    // ZX Spectrum keyboard matrix cells.
    private static readonly KEY = {
        ENTER: [6, 0x01] as [number, number],
        J: [6, 0x08] as [number, number], // produces the LOAD token in 48K K-mode
        P: [5, 0x01] as [number, number],
        SYMBOL_SHIFT: [7, 0x02] as [number, number],
    };

    // Hold a set of matrix cells down for a few frames, then release, leaving a
    // gap so the ROM keyboard scan registers each press distinctly.
    private pressKeys(keys: Array<[number, number]>, downFrames = 4, gapFrames = 4): void {
        for (const [row, mask] of keys) this.emulator.rawKeyDown(row, mask);
        for (let i = 0; i < downFrames; i++) this.emulator.runFrame();
        for (const [row, mask] of keys) this.emulator.rawKeyUp(row, mask);
        for (let i = 0; i < gapFrames; i++) this.emulator.runFrame();
    }

    /**
     * Boot the machine, load the tape, run the program, and return the kept raw
     * frame buffers (50fps, trailing static trimmed). Shared by both encoders.
     */
    private async captureFrames(tapData: Buffer, machineType: number): Promise<Uint8Array[]> {
        this.emulator.setMachineType(machineType);
        this.emulator.setTapeTraps(true); // instant block loading; no pulse playback needed
        this.emulator.loadTAPFile(tapData);
        this.emulator.reset();

        console.log(`Booting ${machineType}K machine with tape traps enabled`);

        if (machineType === 48) {
            // 48K boots straight to the (C) screen with a K cursor and no loader
            // window. Enter LOAD "" using single-key tokens: J = LOAD,
            // SYMBOL SHIFT + P = the " character.
            for (let i = 0; i < 100; i++) this.emulator.runFrame(); // ~2s to settle
            this.pressKeys([GIFGenerator.KEY.J]);
            this.pressKeys([GIFGenerator.KEY.SYMBOL_SHIFT, GIFGenerator.KEY.P]);
            this.pressKeys([GIFGenerator.KEY.SYMBOL_SHIFT, GIFGenerator.KEY.P]);
            this.pressKeys([GIFGenerator.KEY.ENTER]);
        } else {
            // 128K boots to a menu with "Tape Loader" pre-selected; ENTER runs it.
            // Note: leaves the loader's bottom-window UI on screen.
            for (let i = 0; i < 150; i++) this.emulator.runFrame(); // ~3s to menu
            this.pressKeys([GIFGenerator.KEY.ENTER]);
        }

        // Let the trap loader inject every block and the program start.
        for (let i = 0; i < 15; i++) this.emulator.runFrame();

        // Capture the running program. Stop once the screen has been static for
        // `staleFrameThreshold` consecutive frames, then trim trailing static.
        const maxFrames = Math.floor(this.options.maxDurationMs / 20);
        const staleStop = this.options.staleFrameThreshold;
        const tailFrames = 25; // ~0.5s of static tail kept for readability

        const frames: Uint8Array[] = [];
        let previousFrame: Uint8Array | null = null;
        let staleCount = 0;
        let lastChangeIndex = -1;

        for (let f = 0; f < maxFrames; f++) {
            const frameBuffer = new Uint8Array(this.emulator.runFrame());
            frames.push(frameBuffer);

            if (previousFrame && this.areFramesIdentical(frameBuffer, previousFrame)) {
                staleCount++;
                if (staleCount >= staleStop) {
                    console.log(`Program settled after ${f + 1} captured frames`);
                    break;
                }
            } else {
                staleCount = 0;
                lastChangeIndex = f;
            }
            previousFrame = frameBuffer;
        }

        if (lastChangeIndex < 0) {
            // Nothing ever changed; keep a short clip so the output is not empty.
            lastChangeIndex = Math.min(frames.length, tailFrames) - 1;
        }
        const keep = Math.min(frames.length, lastChangeIndex + 1 + tailFrames);
        console.log(`Captured ${frames.length} frames, keeping ${keep}`);
        return frames.slice(0, keep);
    }

    /** Render the program to an animated GIF (25fps to keep size sane). */
    async generateFromTAP(tapData: Buffer, machineType: number = 48): Promise<Buffer> {
        const frames = await this.captureFrames(tapData, machineType);

        // The core runs at 50fps; encode every 2nd frame (25fps) to halve GIF
        // size and encode time with little visible loss.
        const frameStep = 2;
        const encoder = new GIFEncoder(this.decoder.getWidth(), this.decoder.getHeight(), 'neuquant');
        encoder.setDelay(20 * frameStep);
        encoder.setRepeat(0); // loop forever
        encoder.setQuality(10);
        encoder.start();

        for (let i = 0; i < frames.length; i += frameStep) {
            encoder.addFrame(this.decoder.decode(frames[i]));
        }
        encoder.finish();
        return Buffer.from(encoder.out.getData());
    }

    /** Render the program to an H.264 MP4 at the full 50fps. */
    async generateMp4FromTAP(tapData: Buffer, machineType: number = 48): Promise<Buffer> {
        const frames = await this.captureFrames(tapData, machineType);
        return this.encodeMp4(frames, 50);
    }

    /** Pipe decoded RGBA frames through ffmpeg to a temporary MP4 and return it. */
    private async encodeMp4(frames: Uint8Array[], fps: number): Promise<Buffer> {
        const width = this.decoder.getWidth();
        const height = this.decoder.getHeight();
        const outPath = join(tmpdir(), `zxplay-${process.pid}-${Date.now()}.mp4`);

        const args = [
            '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps),
            '-i', 'pipe:0',
            '-an', // no audio
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
            '-movflags', '+faststart',
            '-y', outPath,
        ];
        const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        ff.stderr.on('data', (d) => { stderr += d.toString(); });

        const finished = new Promise<void>((resolve, reject) => {
            ff.on('error', reject);
            ff.on('close', (code) =>
                code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)),
            );
        });

        for (const raw of frames) {
            const rgba = this.decoder.decode(raw);
            if (!ff.stdin.write(rgba)) {
                await new Promise<void>((resolve) => ff.stdin.once('drain', () => resolve()));
            }
        }
        ff.stdin.end();
        await finished;

        const buffer = await readFile(outPath);
        await unlink(outPath).catch(() => undefined);
        console.log(`Encoded MP4: ${frames.length} frames, ${buffer.length} bytes`);
        return buffer;
    }

    private async parseSZXSnapshot(data: Buffer): Promise<any> {
        const file = new DataView(data.buffer, data.byteOffset, data.byteLength);

        if (
            String.fromCharCode(file.getUint8(0)) !== 'Z' ||
            String.fromCharCode(file.getUint8(1)) !== 'X' ||
            String.fromCharCode(file.getUint8(2)) !== 'S' ||
            String.fromCharCode(file.getUint8(3)) !== 'T'
        ) {
            throw new Error('Invalid SZX file');
        }

        const machineId = file.getUint8(6);
        const is48K = (machineId === 1);
        const model = is48K ? 48 : 128;

        const snapshot: any = {
            model,
            registers: {},
            ulaState: {},
            memoryPages: {},
            tstates: 0,
            halted: false,
        };

        let offset = 8;

        while (offset < data.length) {
            const blockId = String.fromCharCode(
                file.getUint8(offset),
                file.getUint8(offset + 1),
                file.getUint8(offset + 2),
                file.getUint8(offset + 3)
            );
            const blockSize = file.getUint32(offset + 4, true);
            offset += 8;

            switch (blockId) {
                case 'Z80R':
                    snapshot.registers = {
                        AF: file.getUint16(offset, true),
                        BC: file.getUint16(offset + 2, true),
                        DE: file.getUint16(offset + 4, true),
                        HL: file.getUint16(offset + 6, true),
                        AF_: file.getUint16(offset + 8, true),
                        BC_: file.getUint16(offset + 10, true),
                        DE_: file.getUint16(offset + 12, true),
                        HL_: file.getUint16(offset + 14, true),
                        IX: file.getUint16(offset + 16, true),
                        IY: file.getUint16(offset + 18, true),
                        SP: file.getUint16(offset + 20, true),
                        PC: file.getUint16(offset + 22, true),
                        IR: (file.getUint8(offset + 24) << 8) | file.getUint8(offset + 25),
                        iff1: !!file.getUint8(offset + 26),
                        iff2: !!file.getUint8(offset + 27),
                        im: file.getUint8(offset + 28),
                    };
                    snapshot.tstates = file.getUint32(offset + 29, true);
                    snapshot.halted = !!file.getUint8(offset + 33);
                    break;
                case 'SPCR':
                    snapshot.ulaState.borderColour = file.getUint8(offset);
                    if (!is48K) {
                        snapshot.ulaState.pagingFlags = file.getUint8(offset + 1);
                    }
                    break;
                case 'RAMP':
                    const flags = file.getUint16(offset, true);
                    const page = file.getUint8(offset + 2);
                    const isCompressed = !!(flags & 0x01);
                    const pageData = new Uint8Array(data.buffer, data.byteOffset + offset + 3, blockSize - 3);

                    if (isCompressed) {
                        const decompressed = new Uint8Array(0x4000);
                        let srcPtr = 0;
                        let dstPtr = 0;
                        while (dstPtr < 0x4000 && srcPtr < pageData.length) {
                            if (
                                srcPtr + 3 < pageData.length &&
                                pageData[srcPtr] === 0xed &&
                                pageData[srcPtr + 1] === 0xed
                            ) {
                                const count = pageData[srcPtr + 2];
                                const value = pageData[srcPtr + 3];
                                for (let i = 0; i < count && dstPtr < 0x4000; i++) {
                                    decompressed[dstPtr++] = value;
                                }
                                srcPtr += 4;
                            } else {
                                decompressed[dstPtr++] = pageData[srcPtr++];
                            }
                        }
                        snapshot.memoryPages[page] = decompressed;
                    } else {
                        snapshot.memoryPages[page] = new Uint8Array(pageData);
                    }
                    break;
            }

            offset += blockSize;
        }

        return snapshot;
    }
}
