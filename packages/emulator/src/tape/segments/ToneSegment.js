export class ToneSegment {
    constructor(pulseLength, pulseCount) {
        this.pulseLength = pulseLength;
        this.pulseCount = pulseCount;
        this.pulsesGenerated = 0;
    }
    isFinished() {
        return this.pulsesGenerated == this.pulseCount;
    }
    getNextPulseLength() {
        this.pulsesGenerated++;
        return this.pulseLength;
    }
}
