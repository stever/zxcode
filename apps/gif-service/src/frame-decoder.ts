const PALETTE = new Uint32Array([
    /* RGBA dark - stored as ABGR in little-endian */
    0xff000000, // black
    0xffdd0000, // blue
    0xff0000dd, // red
    0xffdd00dd, // magenta
    0xff00dd00, // green
    0xffdddd00, // cyan
    0xff00dddd, // yellow
    0xffdddddd, // white
    /* RGBA bright */
    0xff000000, // black
    0xffff0000, // bright blue
    0xff0000ff, // bright red
    0xffff00ff, // bright magenta
    0xff00ff00, // bright green
    0xffffff00, // bright cyan
    0xff00ffff, // bright yellow
    0xffffffff, // bright white
]);

export interface FrameDecoderOptions {
    // Integer upscale factor applied with nearest-neighbour (keeps pixels crisp).
    scale?: number;
}

export class FrameDecoder {
    private baseWidth: number = 320;
    private baseHeight: number = 240;
    private scale: number;
    private flashPhase: number = 0;

    constructor(options: FrameDecoderOptions = {}) {
        this.scale = Math.max(1, Math.floor(options.scale ?? 1));
    }

    getWidth(): number {
        return this.baseWidth * this.scale;
    }

    getHeight(): number {
        return this.baseHeight * this.scale;
    }

    decode(frameBuffer: Uint8Array): Uint8Array {
        const bw = this.baseWidth;
        const bh = this.baseHeight;
        const pixels = new Uint32Array(bw * bh);
        let pixelPtr = 0;
        let bufferPtr = 0;

        /* top border: 24 rows × 160 pixels, each pixel doubled horizontally */
        for (let y = 0; y < 24; y++) {
            for (let x = 0; x < 160; x++) {
                const border = PALETTE[frameBuffer[bufferPtr++]];
                pixels[pixelPtr++] = border;
                pixels[pixelPtr++] = border;
            }
        }

        /* main screen: 192 rows */
        for (let y = 0; y < 192; y++) {
            /* left border: 16 pixels, doubled */
            for (let x = 0; x < 16; x++) {
                const border = PALETTE[frameBuffer[bufferPtr++]];
                pixels[pixelPtr++] = border;
                pixels[pixelPtr++] = border;
            }

            /* screen data: 32 bytes of (bitmap, attribute) pairs */
            for (let x = 0; x < 32; x++) {
                let bitmap = frameBuffer[bufferPtr++];
                const attr = frameBuffer[bufferPtr++];

                let ink: number, paper: number;
                if ((attr & 0x80) && (this.flashPhase & 0x10)) {
                    paper = PALETTE[((attr & 0x40) >> 3) | (attr & 0x07)];
                    ink = PALETTE[(attr & 0x78) >> 3];
                } else {
                    ink = PALETTE[((attr & 0x40) >> 3) | (attr & 0x07)];
                    paper = PALETTE[(attr & 0x78) >> 3];
                }

                for (let i = 0; i < 8; i++) {
                    pixels[pixelPtr++] = (bitmap & 0x80) ? ink : paper;
                    bitmap <<= 1;
                }
            }

            /* right border: 16 pixels, doubled */
            for (let x = 0; x < 16; x++) {
                const border = PALETTE[frameBuffer[bufferPtr++]];
                pixels[pixelPtr++] = border;
                pixels[pixelPtr++] = border;
            }
        }

        /* bottom border: 24 rows × 160 pixels, each pixel doubled */
        for (let y = 0; y < 24; y++) {
            for (let x = 0; x < 160; x++) {
                const border = PALETTE[frameBuffer[bufferPtr++]];
                pixels[pixelPtr++] = border;
                pixels[pixelPtr++] = border;
            }
        }

        this.flashPhase = (this.flashPhase + 1) & 0x1f;

        if (this.scale === 1) {
            return new Uint8Array(pixels.buffer);
        }
        return this.upscale(pixels, bw, bh, this.scale);
    }

    /* Nearest-neighbour integer upscale of an ABGR pixel buffer. */
    private upscale(src: Uint32Array, w: number, h: number, s: number): Uint8Array {
        const dw = w * s;
        const out = new Uint32Array(dw * h * s);
        for (let y = 0; y < h; y++) {
            const srcRow = y * w;
            for (let sy = 0; sy < s; sy++) {
                let o = (y * s + sy) * dw;
                for (let x = 0; x < w; x++) {
                    const p = src[srcRow + x];
                    for (let sx = 0; sx < s; sx++) {
                        out[o++] = p;
                    }
                }
            }
        }
        return new Uint8Array(out.buffer);
    }
}
