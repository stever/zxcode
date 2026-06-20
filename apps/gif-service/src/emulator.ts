import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { TAPFile } from './tap-file.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FRAME_BUFFER_SIZE = 0x6600;

export interface EmulatorCore {
    memory: WebAssembly.Memory;
    FRAME_BUFFER: number;
    REGISTERS: number;
    TAPE_PULSES: number;
    TAPE_PULSES_LENGTH: number;
    MACHINE_MEMORY: number;
    AUDIO_BUFFER_LEFT: number;
    AUDIO_BUFFER_RIGHT: number;
    runFrame(): number;
    resumeFrame(): number;
    setMachineType(type: number): void;
    reset(): void;
    keyDown(row: number, mask: number): void;
    keyUp(row: number, mask: number): void;
    poke(addr: number, value: number): void;
    setPC(pc: number): void;
    setIFF1(value: number): void;
    setIFF2(value: number): void;
    setIM(value: number): void;
    setHalted(value: number): void;
    writePort(port: number, value: number): void;
    setTStates(tstates: number): void;
    setAudioSamplesPerFrame(samples: number): void;
    getTapePulseBufferTstateCount(): number;
    getTapePulseWriteIndex(): number;
    setTapePulseBufferState(writeIndex: number, tstateCount: number): void;
    setTapeTraps(enabled: number): void;
}

export class Emulator {
    private core: EmulatorCore | null = null;
    private memoryData: Uint8Array | null = null;
    private frameData: Uint8Array | null = null;
    private registerPairs: Uint16Array | null = null;
    private tape: TAPFile | null = null;
    private tapePulses: Uint16Array | null = null;
    private tapeIsPlaying: boolean = false;
    // Audio is generated only when a non-zero samples-per-frame is requested.
    // Each frame's stereo samples are copied out of WASM memory before the next
    // frame overwrites them.
    private audioSamplesPerFrame: number = 0;
    private lastAudioLeft: Float32Array | null = null;
    private lastAudioRight: Float32Array | null = null;
    // Number of tape-load traps that fired during the most recent runFrame.
    // Non-zero only while a LOAD is pulling blocks in, so it marks the loader
    // phase distinctly from the program running afterwards.
    private tapeTrapsLastFrame: number = 0;

    // ZX Spectrum keyboard matrix (character -> [row, bitmask]).
    // Rows/masks match the core's keyDown(row, mask) convention used by the web
    // app's KeyboardHandler. Only unshifted keys are mapped; punctuation and
    // symbols require CAPS/SYMBOL SHIFT combinations that are not modelled here.
    private static readonly KEY_MAP: { [key: string]: [number, number] } = {
        'CAPS SHIFT': [0, 0x01], 'Z': [0, 0x02], 'X': [0, 0x04], 'C': [0, 0x08], 'V': [0, 0x10],
        'A': [1, 0x01], 'S': [1, 0x02], 'D': [1, 0x04], 'F': [1, 0x08], 'G': [1, 0x10],
        'Q': [2, 0x01], 'W': [2, 0x02], 'E': [2, 0x04], 'R': [2, 0x08], 'T': [2, 0x10],
        '1': [3, 0x01], '2': [3, 0x02], '3': [3, 0x04], '4': [3, 0x08], '5': [3, 0x10],
        '0': [4, 0x01], '9': [4, 0x02], '8': [4, 0x04], '7': [4, 0x08], '6': [4, 0x10],
        'P': [5, 0x01], 'O': [5, 0x02], 'I': [5, 0x04], 'U': [5, 0x08], 'Y': [5, 0x10],
        'ENTER': [6, 0x01], 'L': [6, 0x02], 'K': [6, 0x04], 'J': [6, 0x08], 'H': [6, 0x10],
        ' ': [7, 0x01], 'SYMBOL SHIFT': [7, 0x02], 'M': [7, 0x04], 'N': [7, 0x08], 'B': [7, 0x10]
    };

    async loadCore(): Promise<void> {
        const wasmPath = join(__dirname, '../../..', 'apps/web/public/dist/jsspeccy-core.wasm');
        const wasmBuffer = await readFile(wasmPath);
        const results: any = await WebAssembly.instantiate(wasmBuffer, {});
        this.core = results.instance.exports as unknown as EmulatorCore;
        this.memoryData = new Uint8Array(this.core.memory.buffer);
        this.frameData = this.memoryData.subarray(this.core.FRAME_BUFFER, this.core.FRAME_BUFFER + FRAME_BUFFER_SIZE);
        this.registerPairs = new Uint16Array(this.core.memory.buffer, this.core.REGISTERS, 12);
        this.tapePulses = new Uint16Array(this.core.memory.buffer, this.core.TAPE_PULSES, this.core.TAPE_PULSES_LENGTH);
    }

    async loadRom(romPath: string, page: number): Promise<void> {
        if (!this.core || !this.memoryData) {
            throw new Error('Core not loaded');
        }
        const romData = await readFile(romPath);
        this.memoryData.set(romData, this.core.MACHINE_MEMORY + page * 0x4000);
    }

    async loadRoms(): Promise<void> {
        const romsPath = join(__dirname, '../../..', 'apps/web/public/roms');
        await this.loadRom(join(romsPath, '128-0.rom'), 8);
        await this.loadRom(join(romsPath, '128-1.rom'), 9);
        await this.loadRom(join(romsPath, '48.rom'), 10);
        await this.loadRom(join(romsPath, 'pentagon-0.rom'), 12);
        await this.loadRom(join(romsPath, 'trdos.rom'), 13);
    }

    setMachineType(type: number): void {
        if (!this.core) {
            throw new Error('Core not loaded');
        }
        this.core.setMachineType(type);
    }

    reset(): void {
        if (!this.core) {
            throw new Error('Core not loaded');
        }
        this.core.reset();
    }

    setTapeTraps(enabled: boolean): void {
        if (!this.core) {
            throw new Error('Core not loaded');
        }
        this.core.setTapeTraps(enabled ? 1 : 0);
    }

    loadTAPFile(tapData: Buffer): void {
        this.tape = new TAPFile(tapData);
        this.tapeIsPlaying = false;
    }

    playTape(): void {
        if (this.tape && !this.tapeIsPlaying) {
            this.tapeIsPlaying = true;
            console.log('Tape playing started');
            console.log(`Tape state: tape=${!!this.tape}, tapePulses=${!!this.tapePulses}, playing=${this.tapeIsPlaying}`);
        } else {
            console.log(`Cannot play tape: tape=${!!this.tape}, playing=${this.tapeIsPlaying}`);
        }
    }

    stopTape(): void {
        if (this.tape && this.tapeIsPlaying) {
            this.tapeIsPlaying = false;
            console.log('Tape playing stopped');
        }
    }

    isTapePlaying(): boolean {
        return this.tapeIsPlaying;
    }

    // How many tape-load traps fired during the most recent runFrame. Used to
    // tell the loader phase apart from the program running afterwards.
    getTapeTrapsLastFrame(): number {
        return this.tapeTrapsLastFrame;
    }

    // Ask the core to render `samplesPerFrame` stereo audio samples each frame
    // (0 disables audio generation entirely, the default).
    enableAudio(samplesPerFrame: number): void {
        this.audioSamplesPerFrame = samplesPerFrame;
    }

    // The stereo samples produced by the most recent runFrame, or null if audio
    // is disabled. The arrays are copies, safe to retain past the next frame.
    getLastAudio(): { left: Float32Array; right: Float32Array } | null {
        if (!this.lastAudioLeft || !this.lastAudioRight) return null;
        return { left: this.lastAudioLeft, right: this.lastAudioRight };
    }

    private trapTapeLoad(): void {
        if (!this.tape || !this.core || !this.registerPairs) {
            console.log('trapTapeLoad: missing tape, core, or registers');
            return;
        }

        const block = this.tape.getNextLoadableBlock();
        if (!block) {
            console.log('trapTapeLoad: no block available');
            return;
        }
        console.log(`trapTapeLoad: loading block of ${block.length} bytes`);

        const af_ = this.registerPairs[4];
        const expectedBlockType = af_ >> 8;
        const shouldLoad = af_ & 0x0001;
        let addr = this.registerPairs[8];
        const requestedLength = this.registerPairs[2];
        const actualBlockType = block[0];

        console.log(`Tape trap details: expected type=${expectedBlockType}, actual type=${actualBlockType}, shouldLoad=${shouldLoad}, addr=0x${addr.toString(16)}, length=${requestedLength}`);

        let success = true;
        if (expectedBlockType !== actualBlockType) {
            success = false;
        } else {
            if (shouldLoad) {
                let offset = 1;
                let loadedBytes = 0;
                let checksum = actualBlockType;
                while (loadedBytes < requestedLength) {
                    if (offset >= block.length) {
                        success = false;
                        break;
                    }
                    const byte = block[offset++];
                    loadedBytes++;
                    this.core.poke(addr, byte);
                    addr = (addr + 1) & 0xffff;
                    checksum ^= byte;
                }

                success = success && (offset < block.length);
                if (success) {
                    const expectedChecksum = block[offset];
                    success = (checksum === expectedChecksum);
                }
            } else {
                success = true;
            }
        }

        if (success) {
            this.registerPairs[0] |= 0x0001;
            console.log(`Trap successful, AF=${this.registerPairs[0].toString(16)}, setting PC to 0x05e2`);
        } else {
            this.registerPairs[0] &= 0xfffe;
            console.log(`Trap failed, AF=${this.registerPairs[0].toString(16)}, setting PC to 0x05e2`);
        }
        this.core.setPC(0x05e2);
    }

    runFrame(): Uint8Array {
        if (!this.core || !this.frameData) {
            throw new Error('Core not loaded');
        }
        this.core.setAudioSamplesPerFrame(this.audioSamplesPerFrame);

        // Handle tape pulse generation if tape is playing
        if (this.tape && this.tapeIsPlaying && this.tapePulses) {
            const tapePulseBufferTstateCount = this.core.getTapePulseBufferTstateCount();
            const tapePulseWriteIndex = this.core.getTapePulseWriteIndex();
            const [newTapePulseWriteIndex, tstatesGenerated, tapeFinished] = this.tape.pulseGenerator.emitPulses(
                this.tapePulses, tapePulseWriteIndex, 80000 - tapePulseBufferTstateCount
            );
            this.core.setTapePulseBufferState(newTapePulseWriteIndex, tapePulseBufferTstateCount + tstatesGenerated);
            if (tapeFinished) {
                this.tapeIsPlaying = false;
                console.log('Tape finished playing');
            }
        }

        let status = this.core.runFrame();
        let trapCount = 0;
        while (status) {
            trapCount++;
            // Bound the trap loop: a normal tape load fires a few hundred traps,
            // so a runaway here is a malformed/hostile program, not real work.
            if (trapCount > 20000) {
                throw new Error('Too many tape traps in one frame');
            }
            switch (status) {
                case 1:
                    throw new Error('Unrecognized opcode');
                case 2:
                    console.log(`Tape trap #${trapCount} triggered!`);
                    this.trapTapeLoad();
                    break;
                default:
                    throw new Error(`runFrame returned unexpected result: ${status}`);
            }
            status = this.core.resumeFrame();
        }
        this.tapeTrapsLastFrame = trapCount;

        if (this.audioSamplesPerFrame > 0) {
            // Copy out of WASM memory: the views alias the heap, which the next
            // frame overwrites, so slice() to detach a standalone buffer.
            const n = this.audioSamplesPerFrame;
            this.lastAudioLeft = new Float32Array(this.core.memory.buffer, this.core.AUDIO_BUFFER_LEFT, n).slice();
            this.lastAudioRight = new Float32Array(this.core.memory.buffer, this.core.AUDIO_BUFFER_RIGHT, n).slice();
        }

        return new Uint8Array(this.frameData);
    }

    loadMemoryPage(page: number, data: Uint8Array): void {
        if (!this.core || !this.memoryData) {
            throw new Error('Core not loaded');
        }
        this.memoryData.set(data, this.core.MACHINE_MEMORY + page * 0x4000);
    }

    async loadSnapshot(snapshot: any): Promise<void> {
        if (!this.core || !this.registerPairs) {
            throw new Error('Core not loaded');
        }
        this.core.setMachineType(snapshot.model);
        for (const page in snapshot.memoryPages) {
            this.loadMemoryPage(Number(page), snapshot.memoryPages[page]);
        }
        ['AF', 'BC', 'DE', 'HL', 'AF_', 'BC_', 'DE_', 'HL_', 'IX', 'IY', 'SP', 'IR'].forEach(
            (r, i) => {
                if (this.registerPairs) {
                    this.registerPairs[i] = snapshot.registers[r];
                }
            }
        );
        this.core.setPC(snapshot.registers.PC);
        this.core.setIFF1(snapshot.registers.iff1);
        this.core.setIFF2(snapshot.registers.iff2);
        this.core.setIM(snapshot.registers.im);
        this.core.setHalted(snapshot.halted ? 1 : 0);

        this.core.writePort(0x00fe, snapshot.ulaState.borderColour);
        if (snapshot.model !== 48) {
            this.core.writePort(0x7ffd, snapshot.ulaState.pagingFlags);
        }

        this.core.setTStates(snapshot.tstates);
    }

    /**
     * Press a matrix cell directly (row + bitmask), bypassing the character map.
     */
    rawKeyDown(row: number, mask: number): void {
        if (!this.core) {
            throw new Error('Core not loaded');
        }
        this.core.keyDown(row, mask);
    }

    rawKeyUp(row: number, mask: number): void {
        if (!this.core) {
            throw new Error('Core not loaded');
        }
        this.core.keyUp(row, mask);
    }

    /**
     * Press a key down
     */
    pressKey(key: string): void {
        if (!this.core) {
            throw new Error('Core not loaded');
        }

        const upperKey = key.toUpperCase();
        const keyMapping = Emulator.KEY_MAP[upperKey];
        
        if (!keyMapping) {
            console.log(`Unknown key: ${key}`);
            return;
        }

        const [row, mask] = keyMapping;
        console.log(`Pressing key: ${key} (row=${row}, mask=0x${mask.toString(16)})`);
        this.core.keyDown(row, mask);
    }

    /**
     * Release a key
     */
    releaseKey(key: string): void {
        if (!this.core) {
            throw new Error('Core not loaded');
        }

        const upperKey = key.toUpperCase();
        const keyMapping = Emulator.KEY_MAP[upperKey];
        
        if (!keyMapping) {
            console.log(`Unknown key: ${key}`);
            return;
        }

        const [row, mask] = keyMapping;
        console.log(`Releasing key: ${key} (row=${row}, mask=0x${mask.toString(16)})`);
        this.core.keyUp(row, mask);
    }

    /**
     * Type a string by pressing and releasing each key
     */
    async typeString(text: string, delayMs: number = 50): Promise<void> {
        console.log(`Typing: "${text}"`);
        
        for (const char of text) {
            this.pressKey(char);
            await this.sleep(delayMs);
            this.releaseKey(char);
            await this.sleep(delayMs);
        }
    }

    /**
     * Press Enter key
     */
    async pressEnter(delayMs: number = 50): Promise<void> {
        console.log('Pressing Enter');
        this.pressKey('ENTER');
        await this.sleep(delayMs);
        this.releaseKey('ENTER');
        await this.sleep(delayMs);
    }

    /**
     * Type the LOAD "" command for tape loading
     */
    async typeLoadCommand(delayMs: number = 50): Promise<void> {
        console.log('Typing LOAD "" command');
        await this.typeString('LOAD ""', delayMs);
        await this.pressEnter(delayMs);
    }

    /**
     * Helper function to create delays
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
