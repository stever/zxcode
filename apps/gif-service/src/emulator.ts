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

    async loadCore(): Promise<void> {
        const wasmPath = join(__dirname, '../../..', 'apps/web/public/dist/jsspeccy-core.wasm');
        const wasmBuffer = await readFile(wasmPath);
        const results: any = await WebAssembly.instantiate(wasmBuffer, {});
        this.core = results.instance.exports as unknown as EmulatorCore;
        this.memoryData = new Uint8Array(this.core.memory.buffer);
        this.frameData = this.memoryData.subarray(this.core.FRAME_BUFFER, this.core.FRAME_BUFFER + FRAME_BUFFER_SIZE);
        this.registerPairs = new Uint16Array(this.core.memory.buffer, this.core.REGISTERS, 12);
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
        this.core.setAudioSamplesPerFrame(0);
        let status = this.core.runFrame();
        let trapCount = 0;
        while (status) {
            trapCount++;
            switch (status) {
                case 1:
                    throw new Error('Unrecognized opcode');
                case 2:
                    console.log(`Tape trap #${trapCount} in this frame`);
                    this.trapTapeLoad();
                    break;
                default:
                    throw new Error(`runFrame returned unexpected result: ${status}`);
            }
            status = this.core.resumeFrame();
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
}
