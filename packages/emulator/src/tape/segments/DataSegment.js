export class DataSegment {
    constructor(data, zeroPulseLength, onePulseLength, lastByteBits) {
        this.data = data;
        this.zeroPulseLength = zeroPulseLength;
        this.onePulseLength = onePulseLength;
        this.bitCount = (this.data.length - 1) * 8 + lastByteBits;
        this.pulsesOutput = 0;
        this.lastPulseLength = null;
    }
    isFinished() {
        return this.pulsesOutput == this.bitCount * 2;
    }
    getNextPulseLength() {
        if (this.pulsesOutput & 0x01) {
            this.pulsesOutput++;
            return this.lastPulseLength;
        } else {
            const bitIndex = this.pulsesOutput >> 1;
            const byteIndex = bitIndex >> 3;
            const bitMask = 1 << (7 - (bitIndex & 0x07));
            this.lastPulseLength = (this.data[byteIndex] & bitMask) ? this.onePulseLength : this.zeroPulseLength;
            this.pulsesOutput++;
            return this.lastPulseLength;
        }
    }
}
