export class TAPFile {
    private blocks: Uint8Array[] = [];
    private nextBlockIndex: number = 0;

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
