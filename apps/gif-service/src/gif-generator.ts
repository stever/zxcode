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
        this.emulator.reset();

        // Start tape playing for pulse-based loading
        this.emulator.playTape();

        // Create a fresh startup state instead of using tape loader snapshot
        console.log(`Starting fresh ${machineType}K machine with tape traps enabled and tape playing`);

        console.log('Starting tape loading process...');
        
        // Phase 1: Let the emulator settle after loading the snapshot
        console.log('Phase 1: Letting emulator settle...');
        for (let i = 0; i < 25; i++) { // 0.5 seconds at 50fps
            const frameBuffer = this.emulator.runFrame();
            const rgbaData = this.decoder.decode(frameBuffer);
            encoder.addFrame(rgbaData);
        }

        // Phase 2: Type the LOAD command
        console.log('Phase 2: Triggering LOAD command...');
        await this.emulator.typeLoadCommand(50); // 50ms delay between keystrokes for more reliable input
        
        // Wait a bit after pressing Enter for the command to be processed
        console.log('Phase 2b: Waiting for LOAD command to be processed...');
        for (let i = 0; i < 50; i++) { // 1 second at 50fps
            const frameBuffer = this.emulator.runFrame();
            const rgbaData = this.decoder.decode(frameBuffer);
            encoder.addFrame(rgbaData);
        }

        // Phase 3: Capture the tape loading process
        console.log('Phase 3: Capturing tape loading...');
        const startTime = Date.now();
        let frameCount = 25; // Account for frames already captured
        let staleCount = 0;
        let previousFrame: Uint8Array | null = null;
        let hasSeenChange = false;
        let loadingStarted = false;
        let loadingCompleted = false;
        let framesSinceLoadingComplete = 0;

        const maxFrames = Math.floor(this.options.maxDurationMs / 20);
        const maxLoadingFrames = 300; // 6 seconds max for loading
        const maxPostLoadingFrames = 150; // 3 seconds after loading completes

        while (frameCount < maxFrames) {
            const frameBuffer = this.emulator.runFrame();
            frameCount++;

            const rgbaData = this.decoder.decode(frameBuffer);
            encoder.addFrame(rgbaData);

            // Log every 50 frames to see what's happening
            if (frameCount % 50 === 0) {
                console.log(`Frame ${frameCount}: loadingStarted=${loadingStarted}, staleCount=${staleCount}`);
            }

            // Detect loading start (border color changes)
            if (!loadingStarted && this.isLoadingBorder(frameBuffer)) {
                console.log(`Loading started at frame ${frameCount}`);
                loadingStarted = true;
            }

            // Detect loading completion (border returns to normal)
            if (loadingStarted && !loadingCompleted && !this.isLoadingBorder(frameBuffer)) {
                console.log(`Loading completed at frame ${frameCount}`);
                loadingCompleted = true;
                framesSinceLoadingComplete = 0;
            }

            // Count frames after loading completes
            if (loadingCompleted) {
                framesSinceLoadingComplete++;
                if (framesSinceLoadingComplete >= maxPostLoadingFrames) {
                    console.log(`Stopping: captured ${framesSinceLoadingComplete} frames after loading completed`);
                    break;
                }
            }

            // Stop if loading takes too long
            if (loadingStarted && !loadingCompleted && (frameCount > maxLoadingFrames)) {
                console.log(`Stopping: loading took too long (${frameCount} frames)`);
                break;
            }

            // General stale frame detection - but be more lenient
            if (previousFrame && this.areFramesIdentical(frameBuffer, previousFrame)) {
                if (hasSeenChange) {
                    staleCount++;
                    // Increase threshold to allow more time for loading to start
                    if (staleCount >= 2000 && !loadingStarted) {
                        console.log(`Stopping: ${staleCount} stale frames before loading started`);
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

    /**
     * Check if the current frame shows loading border colors (red/cyan stripes)
     */
    private isLoadingBorder(frameBuffer: Uint8Array): boolean {
        // Check a few border pixels for loading colors
        // Loading typically shows red/cyan alternating border
        const borderPixels = [
            0,      // Top-left border
            50,     // Top border
            100,    // Top-right border
            6200,   // Bottom-left border
            6250,   // Bottom border
            6300    // Bottom-right border
        ];

        let redCount = 0;
        let cyanCount = 0;
        
        for (const pixel of borderPixels) {
            if (pixel < frameBuffer.length) {
                const color = frameBuffer[pixel];
                // Red (color 2) or Cyan (color 5) indicate loading
                if (color === 2) redCount++;
                else if (color === 5) cyanCount++;
            }
        }

        // Consider it loading if we see both red and cyan (loading stripes)
        return redCount > 0 && cyanCount > 0;
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
