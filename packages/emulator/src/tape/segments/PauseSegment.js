export class PauseSegment {
    constructor(duration) {
        this.duration = duration;
        this.emitted = false;
    }
    isFinished() {
        return this.emitted;
    }
    getNextPulseLength() {
        // TODO: take level back down to 0 after 1ms if it's currently high
        this.emitted = true;
        return this.duration * 3500;
    }
}
