export class PulseGenerator {
    private segments: any[] = [];
    private tapeIsFinished: boolean = false;
    private pendingCycles: number = 0;
    private getSegmentsCallback: ((generator: PulseGenerator) => boolean) | null = null;

    constructor(getSegmentsCallback: (generator: PulseGenerator) => boolean) {
        this.getSegmentsCallback = getSegmentsCallback;
    }

    addSegment(segment: any): void {
        this.segments.push(segment);
    }

    emitPulses(tapePulses: Uint16Array, writeIndex: number, maxTstates: number): [number, number, boolean] {
        let tstatesGenerated = 0;
        let isFinished = false;

        while (tstatesGenerated < maxTstates) {
            if (this.segments.length === 0) {
                if (this.tapeIsFinished) {
                    // mark end of tape
                    isFinished = true;
                    break;
                } else {
                    // get more segments
                    if (this.getSegmentsCallback) {
                        this.tapeIsFinished = !this.getSegmentsCallback(this);
                    }
                    if (this.segments.length === 0) {
                        if (this.tapeIsFinished) {
                            isFinished = true;
                            break;
                        } else {
                            // add silence if no segments available
                            this.addSegment(new ToneSegment(1000, 100));
                        }
                    }
                }
            }

            const currentSegment = this.segments[0];
            const pulsesGenerated = currentSegment.emitPulses(tapePulses, writeIndex, maxTstates - tstatesGenerated);
            writeIndex += pulsesGenerated;
            tstatesGenerated += currentSegment.getTstatesGenerated();

            if (currentSegment.isFinished()) {
                this.segments.shift();
            }
        }

        return [writeIndex, tstatesGenerated, isFinished];
    }
}

export class ToneSegment {
    private pulseLength: number;
    private pulseCount: number;
    private currentPulse: number = 0;
    private tstatesGenerated: number = 0;

    constructor(pulseLength: number, pulseCount: number) {
        this.pulseLength = pulseLength;
        this.pulseCount = pulseCount;
    }

    emitPulses(tapePulses: Uint16Array, writeIndex: number, maxPulses: number): number {
        let pulsesGenerated = 0;
        while (this.currentPulse < this.pulseCount && pulsesGenerated < maxPulses) {
            tapePulses[writeIndex++] = this.pulseLength;
            this.currentPulse++;
            pulsesGenerated++;
        }
        this.tstatesGenerated += pulsesGenerated * this.pulseLength * 2;
        return pulsesGenerated;
    }

    getTstatesGenerated(): number {
        return this.tstatesGenerated;
    }

    isFinished(): boolean {
        return this.currentPulse >= this.pulseCount;
    }
}

export class PulseSequenceSegment {
    private pulses: number[];
    private currentPulse: number = 0;
    private tstatesGenerated: number = 0;

    constructor(pulses: number[]) {
        this.pulses = pulses;
    }

    emitPulses(tapePulses: Uint16Array, writeIndex: number, maxPulses: number): number {
        let pulsesGenerated = 0;
        while (this.currentPulse < this.pulses.length && pulsesGenerated < maxPulses) {
            tapePulses[writeIndex++] = this.pulses[this.currentPulse++];
            pulsesGenerated++;
        }
        this.tstatesGenerated += this.pulses.slice(0, pulsesGenerated).reduce((sum, pulse) => sum + pulse, 0);
        return pulsesGenerated;
    }

    getTstatesGenerated(): number {
        return this.tstatesGenerated;
    }

    isFinished(): boolean {
        return this.currentPulse >= this.pulses.length;
    }
}

export class DataSegment {
    private data: Uint8Array;
    private pilotPulseLength: number;
    private sync1Length: number;
    private sync2Length: number;
    private bit0Length: number;
    private bit1Length: number;
    private currentBit: number = 0;
    private currentPulseInBit: number = 0;
    private tstatesGenerated: number = 0;

    constructor(data: Uint8Array, bit0Length: number, bit1Length: number, pilotPulseLength: number) {
        this.data = data;
        this.bit0Length = bit0Length;
        this.bit1Length = bit1Length;
        this.pilotPulseLength = pilotPulseLength;
        this.sync1Length = pilotPulseLength; // sync pulse 1
        this.sync2Length = pilotPulseLength * 2; // sync pulse 2
    }

    emitPulses(tapePulses: Uint16Array, writeIndex: number, maxPulses: number): number {
        let pulsesGenerated = 0;

        // Add pilot tone (longer for header, shorter for data)
        const isHeader = (this.data[0] & 0x80) === 0;
        const pilotPulseCount = isHeader ? 8063 : 3223;
        
        for (let i = 0; i < pilotPulseCount && pulsesGenerated < maxPulses; i++) {
            tapePulses[writeIndex++] = this.pilotPulseLength;
            pulsesGenerated++;
        }

        // Add sync pulses
        if (pulsesGenerated + 2 <= maxPulses) {
            tapePulses[writeIndex++] = this.sync1Length;
            tapePulses[writeIndex++] = this.sync2Length;
            pulsesGenerated += 2;
        }

        // Add data bits
        while (this.currentBit < this.data.length * 8 && pulsesGenerated < maxPulses) {
            const byteIndex = Math.floor(this.currentBit / 8);
            const bitIndex = this.currentBit % 8;
            const bit = (this.data[byteIndex] >> bitIndex) & 1;
            
            const pulseLength = bit ? this.bit1Length : this.bit0Length;
            tapePulses[writeIndex++] = pulseLength;
            pulsesGenerated++;
            
            this.currentPulseInBit++;
            if (this.currentPulseInBit >= 2) { // each bit is 2 pulses
                this.currentBit++;
                this.currentPulseInBit = 0;
            }
        }

        this.tstatesGenerated += pulsesGenerated * 1000; // rough estimate
        return pulsesGenerated;
    }

    getTstatesGenerated(): number {
        return this.tstatesGenerated;
    }

    isFinished(): boolean {
        return this.currentBit >= this.data.length * 8;
    }
}

export class PauseSegment {
    private duration: number;
    private tstatesGenerated: number = 0;

    constructor(duration: number) {
        this.duration = duration;
    }

    emitPulses(tapePulses: Uint16Array, writeIndex: number, maxPulses: number): number {
        // Pause segments don't generate pulses, just consume time
        this.tstatesGenerated = this.duration;
        return 0;
    }

    getTstatesGenerated(): number {
        return this.tstatesGenerated;
    }

    isFinished(): boolean {
        return true;
    }
}

export class TAPFile {
    private blocks: Uint8Array[] = [];
    private nextBlockIndex: number = 0;
    public pulseGenerator: PulseGenerator;

    constructor(data: Buffer) {
        let i = 0;
        const tap = new DataView(data.buffer, data.byteOffset, data.byteLength);

        while ((i + 1) < data.byteLength) {
            const blockLength = tap.getUint16(i, true);
            i += 2;
            this.blocks.push(new Uint8Array(data.buffer, data.byteOffset + i, blockLength));
            i += blockLength;
        }
        console.log(`TAP file parsed: ${this.blocks.length} blocks, sizes: ${this.blocks.map(b => b.length).join(', ')}`);

        this.pulseGenerator = new PulseGenerator((generator) => {
            if (this.blocks.length === 0) return false;
            const block = this.blocks[this.nextBlockIndex];
            this.nextBlockIndex = (this.nextBlockIndex + 1) % this.blocks.length;

            if (block[0] & 0x80) {
                // add short leader tone for data block
                generator.addSegment(new ToneSegment(2168, 3223));
            } else {
                // add long leader tone for header block
                generator.addSegment(new ToneSegment(2168, 8063));
            }
            generator.addSegment(new PulseSequenceSegment([667, 735]));
            generator.addSegment(new DataSegment(block, 855, 1710, 8));
            generator.addSegment(new PauseSegment(1000));

            // return false if tape has ended
            return this.nextBlockIndex != 0;
        });
    }

    getNextLoadableBlock(): Uint8Array | null {
        if (this.blocks.length === 0) return null;
        const block = this.blocks[this.nextBlockIndex];
        console.log(`getNextLoadableBlock: returning block ${this.nextBlockIndex} of ${this.blocks.length}, size ${block.length}`);
        this.nextBlockIndex = (this.nextBlockIndex + 1) % this.blocks.length;
        return block;
    }

    static isValid(data: Buffer): boolean {
        let pos = 0;
        const tap = new DataView(data.buffer, data.byteOffset, data.byteLength);

        while (pos < data.byteLength) {
            if (pos + 1 >= data.byteLength) return false;
            const blockLength = tap.getUint16(pos, true);
            pos += blockLength + 2;
        }

        return pos === data.byteLength;
    }
}
