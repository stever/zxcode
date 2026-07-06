// ZX audio feeder — AudioWorkletProcessor for the zxgo engine. Served as a
// real static file (copied to /dist by the package build) rather than a
// blob:/data: module because the site's CSP is script-src 'self'.
//
// The page posts Int16 mono 44.1kHz chunks (transferred ArrayBuffers) drained
// from the emulator core each displayed frame. This processor owns all
// buffering policy on the audio render thread: a ~40ms startup/re-buffer
// cushion, hold-and-decay on underrun (mirroring the core's own ring policy),
// drop-oldest at a 200ms cap so latency can never creep, underrun reports
// back to the page (which widens its production cushion), and a linear-
// interpolating resampler for contexts that refuse a 44.1kHz rate.
class ZXFeeder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 8820;                       // ring: 200ms hard cap on queued audio
    this.buf = new Float32Array(this.cap);
    this.head = 0; this.tail = 0; this.size = 0;
    this.prev = 0; this.last = 0;          // adjacent samples for interpolation
    this.started = false;                  // building the cushion
    this.step = 44100 / sampleRate;        // 1.0 when the context honours 44.1kHz
    this.phase = 0;
    this.port.onmessage = (e) => {
      const s = new Int16Array(e.data);
      for (let i = 0; i < s.length; i++) {
        if (this.size === this.cap) {      // full: drop oldest, bound the latency
          this.tail = (this.tail + 1) % this.cap; this.size--;
        }
        this.buf[this.head] = s[i] / 32768;
        this.head = (this.head + 1) % this.cap;
        this.size++;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.started) {                   // cushion not built yet: fade out, wait
      if (this.size < 1764) {              // ~40ms — absorbs rAF + GC jitter
        for (let i = 0; i < out.length; i++) {
          this.prev = this.last = this.last * 0.996;
          out[i] = this.last;
        }
        return true;
      }
      this.started = true;
    }
    let underran = false;
    for (let i = 0; i < out.length; i++) {
      this.phase += this.step;
      while (this.phase >= 1 && this.size > 0) {
        this.phase -= 1;
        this.prev = this.last;
        this.last = this.buf[this.tail];
        this.tail = (this.tail + 1) % this.cap; this.size--;
      }
      if (this.phase >= 1) {               // ring starved mid-step
        underran = true;
        this.phase = 1;                    // hold position; resume when data arrives
        this.prev = this.last = this.last * 0.996;  // fade, don't click
        out[i] = this.last;
      } else {
        // Linear interpolation — identity when step is exactly 1 (phase lands
        // on 0), real resampling when the browser refused a 44.1kHz context.
        out[i] = this.prev + (this.last - this.prev) * this.phase;
      }
    }
    if (underran) {
      this.started = false;                // rebuild the cushion before resuming
      this.port.postMessage(1);            // tell the page so it can widen the cushion
    }
    return true;
  }
}
registerProcessor('zx-feeder', ZXFeeder);
