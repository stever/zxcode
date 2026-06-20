export class PulseGenerator {
    constructor(getSegments) {
        this.segments = [];
        this.getSegments = getSegments;
        this.level = 0x0000;
        this.tapeIsFinished = false;  // if true, don't call getSegments again
        this.pendingCycles = 0;
    }
    addSegment(segment) {
        this.segments.push(segment);
    }
    emitPulses(buffer, startIndex, cycleCount) {
        let cyclesEmitted = 0;
        let index = startIndex;
        let isFinished = false;
        while (cyclesEmitted < cycleCount) {
            if (this.pendingCycles > 0) {
                if (this.pendingCycles >= 0x8000) {
                    // emit a pulse of length 0x7fff
                    buffer[index++] = this.level | 0x7fff;
                    cyclesEmitted += 0x7fff;
                    this.pendingCycles -= 0x7fff;
                } else {
                    // emit a the remainder of this pulse in full
                    buffer[index++] = this.level | this.pendingCycles;
                    cyclesEmitted += this.pendingCycles;
                    this.pendingCycles = 0;
                }
            } else if (this.segments.length === 0) {
                if (this.tapeIsFinished) {
                    // mark end of tape
                    isFinished = true;
                    break;
                } else {
                    // get more segments
                    this.tapeIsFinished = !this.getSegments(this);
                }
            } else if (this.segments[0].isFinished()) {
                // discard finished segment
                this.segments.shift();
            } else {
                // new pulse
                this.pendingCycles = this.segments[0].getNextPulseLength();
                this.level ^= 0x8000;
            }
        }
        return [index, cyclesEmitted, isFinished];
    }
}
