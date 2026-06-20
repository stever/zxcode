export class PulseSequenceSegment {
    constructor(pulses) {
        this.pulses = pulses;
        this.index = 0;
    }
    isFinished() {
        return this.index == this.pulses.length;
    }
    getNextPulseLength() {
        return this.pulses[this.index++];
    }
}
