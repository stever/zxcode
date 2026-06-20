import {CanvasRenderer} from "./CanvasRenderer";
import {FRAME_BUFFER_SIZE} from './constants.js';

export class DisplayHandler {
    /*
    Handles triple-buffering so that at any given time we can have:
    - one buffer being drawn to the screen by the renderer
    - one buffer just finished being built by the worker process and waiting to be shown
      on the next animation frame
    - one buffer buffer being built by the worker process
    */
    constructor(canvas) {
        this.renderer = new CanvasRenderer(canvas);

        this.frameBuffers = [
            new ArrayBuffer(FRAME_BUFFER_SIZE),
            new ArrayBuffer(FRAME_BUFFER_SIZE),
            new ArrayBuffer(FRAME_BUFFER_SIZE),
        ];
        this.bufferBeingShown = null;
        this.bufferAwaitingShow = null;
        this.lockedBuffer = null;
    }

    frameCompleted(newFrameBuffer) {
        this.frameBuffers[this.lockedBuffer] = newFrameBuffer;
        this.bufferAwaitingShow = this.lockedBuffer;
        this.lockedBuffer = null;
    }

    getNextFrameBufferIndex() {
        for (let i = 0; i < 3; i++) {
            if (i !== this.bufferBeingShown && i !== this.bufferAwaitingShow) {
                return i;
            }
        }
    }
    getNextFrameBuffer() {
        this.lockedBuffer = this.getNextFrameBufferIndex();
        return this.frameBuffers[this.lockedBuffer];
    }

    readyToShow() {
        return this.bufferAwaitingShow !== null;
    }
    show() {
        this.bufferBeingShown = this.bufferAwaitingShow;
        this.bufferAwaitingShow = null;
        this.renderer.showFrame(this.frameBuffers[this.bufferBeingShown]);
        this.bufferBeingShown = null;
    }
}
