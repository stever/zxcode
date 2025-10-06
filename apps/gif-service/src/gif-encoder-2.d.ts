declare module 'gif-encoder-2' {
    export default class GIFEncoder {
        constructor(width: number, height: number, algorithm?: string);
        setDelay(ms: number): void;
        setRepeat(repeat: number): void;
        setQuality(quality: number): void;
        start(): void;
        addFrame(data: Uint8Array | Uint8ClampedArray): void;
        finish(): void;
        out: { getData(): Uint8Array };
    }
}
