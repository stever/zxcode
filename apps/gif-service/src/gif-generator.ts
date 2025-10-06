import GIFEncoder from 'gif-encoder-2';
import { Emulator } from './emulator.js';
import { FrameDecoder } from './frame-decoder.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface GIFGeneratorOptions {
    maxDurationMs: number;
    staleFrameThreshold: number;
    ignoreInitialFrames: number;
}

export class GIFGenerator {
    private emulator: Emulator;
    private decoder: FrameDecoder;
    private options: GIFGeneratorOptions;

    constructor(options: Partial<GIFGeneratorOptions> = {}) {
        this.options = {
            maxDurationMs: options.maxDurationMs ?? 180000,
            staleFrameThreshold: options.staleFrameThreshold ?? 500,
            ignoreInitialFrames: options.ignoreInitialFrames ?? 0,
        };
        this.emulator = new Emulator();
        this.decoder = new FrameDecoder();
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

    async generateFromTAP(tapData: Buffer, machineType: number = 128): Promise<Buffer> {
        const width = this.decoder.getWidth();
        const height = this.decoder.getHeight();

        const encoder = new GIFEncoder(width, height, 'neuquant');
        encoder.setDelay(20);
        encoder.setRepeat(0);
        encoder.setQuality(10);
        encoder.start();

        this.emulator.setMachineType(machineType);
        this.emulator.setTapeTraps(true);
        this.emulator.loadTAPFile(tapData);

        const tapeLoaderPath = join(
            __dirname,
            '../../..',
            'apps/web/public/tapeloaders',
            machineType === 128 ? 'tape_128.szx' : 'tape_48.szx'
        );

        const snapshotData = await readFile(tapeLoaderPath);
        const snapshot = await this.parseSZXSnapshot(snapshotData);
        await this.emulator.loadSnapshot(snapshot);

        const startTime = Date.now();
        let frameCount = 0;
        let staleCount = 0;
        let previousFrame: Uint8Array | null = null;
        let hasSeenChange = false;

        const maxFrames = Math.floor(this.options.maxDurationMs / 20);

        while (frameCount < maxFrames) {
            const frameBuffer = this.emulator.runFrame();
            frameCount++;

            const rgbaData = this.decoder.decode(frameBuffer);
            encoder.addFrame(rgbaData);

            if (previousFrame && this.areFramesIdentical(frameBuffer, previousFrame)) {
                if (hasSeenChange) {
                    staleCount++;
                    if (staleCount >= this.options.staleFrameThreshold) {
                        console.log(`Stopping: ${staleCount} stale frames after ${frameCount} total frames`);
                        break;
                    }
                }
            } else {
                if (!hasSeenChange) {
                    console.log(`First frame change detected at frame ${frameCount}`);
                }
                hasSeenChange = true;
                staleCount = 0;
            }

            previousFrame = new Uint8Array(frameBuffer);
        }

        encoder.finish();
        return Buffer.from(encoder.out.getData());
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
