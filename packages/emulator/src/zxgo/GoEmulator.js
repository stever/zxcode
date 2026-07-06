// GoEmulator — drop-in replacement for Emulator.js backed by the zx_go core
// (packages/emulator-core, Go compiled to WebAssembly) instead of the
// JSSpeccy3 AssemblyScript worker. Same constructor signature, methods and
// events, so JSSpeccy.js and the app sagas cannot tell the difference.
//
// Differences under the hood:
// - The core runs on the MAIN thread (Go wasm + its scheduler); there is no
//   worker. KeyboardHandler still gets a worker-SHAPED object whose
//   postMessage routes keyDown/keyUp to the core's matrix.
// - Sound: the core mixes beeper/AY into one mono 44.1kHz stream which we
//   drain per displayed frame (zxPullAudio) and post to an AudioWorklet that
//   owns buffering on the audio render thread (40ms cushion, hold-and-decay
//   underruns, self-widening on jitter). Ported from zxnext-inbrowser-poc.
// - Pacing: the machine is clocked off the AUDIO clock (currentTime) when the
//   context runs — producer and consumer share one crystal so they cannot
//   drift — with a wall-clock accumulator fallback while audio is suspended.
// - ROMs are embedded in zx.wasm; there is no loadRoms step. Machines: 48/128
//   (Pentagon is intentionally not supported; requests for it map to 128).
//
// Assets: /dist/zx.wasm and /dist/wasm_exec.js, served the same way as the
// jsspeccy worker bundle (copied from @zxplay/emulator-core's dist by the
// package build).

import EventEmitter from 'events';
import JSZip from 'jszip';

import { StandardKeyboardHandler, RecreatedZXSpectrumHandler } from '../KeyboardHandler.js';

const scriptUrl = document.currentScript.src;

// ---- Go wasm runtime singleton --------------------------------------------
// wasm_exec.js's Go class runs one program per instantiation and the zx_go
// exports are globals, so the runtime is page-level state shared by every
// GoEmulator instance (in practice there is one per page; a remounted
// component reuses the already-running core and just boots its machine).
let goRuntimePromise = null;

function loadGoRuntime() {
    if (goRuntimePromise) return goRuntimePromise;
    goRuntimePromise = (async () => {
        if (typeof globalThis.Go !== 'function') {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = new URL(`/dist/wasm_exec.js?ver=${window.zxplay_ver}`, scriptUrl);
                s.onload = resolve;
                s.onerror = () => reject(new Error('failed to load wasm_exec.js'));
                document.head.appendChild(s);
            });
        }
        const go = new globalThis.Go();
        const resp = await fetch(new URL(`/dist/zx.wasm?ver=${window.zxplay_ver}`, scriptUrl));
        if (!resp.ok) throw new Error(`zx.wasm: HTTP ${resp.status}`);
        const result = await WebAssembly.instantiateStreaming
            ? await WebAssembly.instantiateStreaming(resp, go.importObject)
            : await WebAssembly.instantiate(await resp.arrayBuffer(), go.importObject);
        go.run(result.instance); // resolves exports asynchronously; do not await
        await new Promise((resolve) => {
            const t = setInterval(() => {
                if (globalThis.zxReady) { clearInterval(t); resolve(); }
            }, 10);
        });
    })();
    return goRuntimePromise;
}

// ---- AudioWorklet ----------------------------------------------------------
// The worklet owns all buffering policy on the audio render thread: a ~40ms
// startup/re-buffer cushion, hold-and-decay on underrun, drop-oldest at a
// 200ms cap, and a linear-interpolating resampler for contexts that refuse
// 44.1kHz. It reports underruns so the page can widen its production cushion.
const ZX_WORKLET = `
class ZXFeeder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 8820;
    this.buf = new Float32Array(this.cap);
    this.head = 0; this.tail = 0; this.size = 0;
    this.prev = 0; this.last = 0;
    this.started = false;
    this.step = 44100 / sampleRate;
    this.phase = 0;
    this.port.onmessage = (e) => {
      const s = new Int16Array(e.data);
      for (let i = 0; i < s.length; i++) {
        if (this.size === this.cap) {
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
    if (!this.started) {
      if (this.size < 1764) {
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
      if (this.phase >= 1) {
        underran = true;
        this.phase = 1;
        this.prev = this.last = this.last * 0.996;
        out[i] = this.last;
      } else {
        out[i] = this.prev + (this.last - this.prev) * this.phase;
      }
    }
    if (underran) {
      this.started = false;
      this.port.postMessage(1);
    }
    return true;
  }
}
registerProcessor('zx-feeder', ZXFeeder);
`;

const SAMPLES_PER_FRAME = 882; // 44100 / 50: one emulated frame of mono audio

export class GoEmulator extends EventEmitter {
    constructor(canvas, opts) {
        super();
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Worker-shaped shim: KeyboardHandler (incl. the virtual keyboard)
        // posts {message:'keyDown'|'keyUp', row, mask}; route it straight to
        // the core's matrix. Everything else it might post is meaningless
        // here and ignored.
        this.worker = {
            postMessage: (msg) => {
                if (!msg) return;
                if (msg.message === 'keyDown' || msg.message === 'keyUp') {
                    this.resumeAudio(); // key gestures unlock the AudioContext
                    if (globalThis.zxMatrixKey) {
                        globalThis.zxMatrixKey(msg.row, msg.mask, msg.message === 'keyDown');
                    }
                }
            },
            terminate: () => {},
        };

        this.keyboardEnabled = ('keyboardEnabled' in opts) ? opts.keyboardEnabled : true;
        if (this.keyboardEnabled) {
            this.keyboardHandler = (opts.keyboardMap == 'recreated')
                ? new RecreatedZXSpectrumHandler(this.worker, opts.keyboardEventRoot || document)
                : new StandardKeyboardHandler(this.worker, opts.keyboardEventRoot || document);
        }

        this.isRunning = false;
        this.isInitiallyPaused = (!opts.autoStart);
        this.autoLoadTapes = opts.autoLoadTapes || false;
        this.tapeIsPlaying = false;
        this.tapeTrapsEnabled = ('tapeTrapsEnabled' in opts) ? opts.tapeTrapsEnabled : true;
        this.machineType = null;
        this.isReady = false;
        this.onReadyHandlers = [];

        // Frame buffer (sized on the first frame the core reports).
        this.frameW = 0; this.frameH = 0;
        this.frameBuf = null; this.imageData = null;

        // Pacing state (see loop()).
        this.acc = 0; this.lastTick = 0;
        this.audioBase = null; this.audioProduced = 0;
        this.audioCushion = 2646; // 60ms; widened on worklet underrun reports
        this.rafId = null;

        this.audioNode = null;
        this.audioPullU8 = new Uint8Array(8192); // ≤4096 samples per drain

        this.initAudio(); // fire and forget; pump no-ops until it lands

        console.info('[zxplay] emulator engine: zxgo (zx_go wasm core)');
        loadGoRuntime().then(() => {
            console.info('[zxplay] zx_go core ready');
            this.setMachine(opts.machine || 128);
            this.setTapeTraps(this.tapeTrapsEnabled);
            const afterOpen = () => {
                if (opts.autoStart) this.start();
                this.isReady = true;
                for (let i = 0; i < this.onReadyHandlers.length; i++) {
                    this.onReadyHandlers[i]();
                }
            };
            if (opts.openUrl) {
                this.openUrlList(opts.openUrl).catch(err => { alert(err); }).then(afterOpen);
            } else {
                afterOpen();
            }
        }).catch(err => {
            console.error('zxgo: core load failed:', err);
            alert('Emulator core failed to load: ' + err.message);
        });
    }

    async initAudio() {
        try {
            const actx = new AudioContext({ sampleRate: 44100 });
            const url = URL.createObjectURL(new Blob([ZX_WORKLET], { type: 'application/javascript' }));
            await actx.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            const node = new AudioWorkletNode(actx, 'zx-feeder',
                { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
            node.connect(actx.destination);
            node.port.onmessage = () => { // underrun: widen the cushion (max 120ms)
                this.audioCushion = Math.min(this.audioCushion + 882, 5292);
                this.audioUnderruns = (this.audioUnderruns || 0) + 1;
                console.debug('[zxplay] audio underrun #' + this.audioUnderruns
                    + ' - cushion now ' + Math.round(this.audioCushion / 44.1) + 'ms');
            };
            this.audioNode = node;
            // Diagnostic hook: run window.__zxgoAudio() in the console.
            window.__zxgoAudio = () => {
                const actx = this.audioNode && this.audioNode.context;
                const now = performance.now();
                const dt = (now - (this.diagT0 || now)) / 1000;
                const rate = dt > 0 ? Math.round((this.diagPulled || 0) / dt) : 0;
                this.diagT0 = now; this.diagPulled = 0;
                return {
                    machine: this.machineType,
                    contextState: actx ? actx.state : 'none',
                    contextRate: actx ? actx.sampleRate : 0,
                    cushionMs: Math.round(this.audioCushion / 44.1),
                    bufferedMs: (actx && this.audioBase !== null)
                        ? Math.round((this.audioProduced - (actx.currentTime - this.audioBase) * 44100) / 44.1)
                        : -1,
                    underruns: this.audioUnderruns || 0,
                    pulledPerSec: rate, // since the previous __zxgoAudio() call
                    lastChunkMin: this.diagMin, lastChunkMax: this.diagMax,
                };
            };
        } catch (e) {
            console.warn('zxgo: AudioWorklet init failed - no sound:', e);
        }
    }

    resumeAudio() {
        const actx = this.audioNode && this.audioNode.context;
        if (actx && actx.state !== 'running') actx.resume().catch(() => {});
    }

    pumpAudio() {
        if (!this.audioNode || !globalThis.zxPullAudio) return;
        const n = globalThis.zxPullAudio(this.audioPullU8);
        if (!n) return;
        const chunk = this.audioPullU8.slice(0, n * 2);
        // Diagnostics: pull rate + amplitude range of the last chunk (see
        // __zxgoAudio). A healthy idle stream pulls ~44100/s of near-zero
        // samples; DC rails, steps and starvation all show up here.
        this.diagPulled = (this.diagPulled || 0) + n;
        const s16 = new Int16Array(chunk.buffer, 0, n);
        let mn = 32767, mx = -32768;
        for (let i = 0; i < n; i++) { const v = s16[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        this.diagMin = mn; this.diagMax = mx;
        this.audioNode.port.postMessage(chunk.buffer, [chunk.buffer]);
    }

    // Poll the core's tape deck and surface state changes as the events the
    // site UI expects (playingTape / stoppedTape enable the tape button).
    pollTape() {
        if (!globalThis.zxTapeStatus) return;
        const st = globalThis.zxTapeStatus();
        if (st.playing !== this.tapeIsPlaying) {
            this.tapeIsPlaying = st.playing;
            this.emit(st.playing ? 'playingTape' : 'stoppedTape');
        }
    }

    // One rAF tick. Pacing (ported from the PoC): clock the 50Hz machine off
    // the audio clock when it runs — produce whatever keeps audioCushion
    // samples in flight ahead of playback — else bank wall-clock time at 20ms
    // per frame. Both cap at 4 frames per tick so a hidden tab catches up
    // briefly instead of bursting.
    loop(t) {
        if (!this.isRunning) return;
        let owed;
        const actx = this.audioNode && this.audioNode.context;
        if (actx && actx.state === 'running') {
            if (this.audioBase === null) { this.audioBase = actx.currentTime; this.audioProduced = 0; }
            const consumed = (actx.currentTime - this.audioBase) * 44100;
            if (this.audioProduced < consumed) this.audioProduced = consumed;
            owed = Math.min(Math.max(Math.ceil((consumed + this.audioCushion - this.audioProduced) / SAMPLES_PER_FRAME), 0), 4);
            this.audioProduced += owed * SAMPLES_PER_FRAME;
            this.acc = 0; this.lastTick = t;
        } else {
            this.acc = Math.min(this.acc + (this.lastTick ? t - this.lastTick : 20), 80);
            this.lastTick = t;
            owed = Math.floor(this.acc / 20);
            this.acc -= owed * 20;
        }
        // Emulated-frames-per-second, published once a second for the page's
        // discreet FPS readout (50 = full speed; counts frames EXECUTED, so a
        // late rAF that catches up with 2 frames isn't a spurious dip).
        this.fpsCount = (this.fpsCount || 0) + (owed || 0);
        if (!this.fpsT) this.fpsT = t;
        if (t - this.fpsT >= 1000) {
            window.__zxgoFps = Math.round(this.fpsCount * 1000 / (t - this.fpsT));
            this.fpsCount = 0;
            this.fpsT = t;
        }
        if (owed && globalThis.zxFrame) {
            for (let i = 1; i < owed; i++) globalThis.zxFrame();
            // No destination buffer until the core has reported its frame
            // dimensions once — zxFrame() without args runs the frame and
            // just returns {w,h}.
            const d = this.frameBuf ? globalThis.zxFrame(this.frameBuf) : globalThis.zxFrame();
            this.pumpAudio();
            this.pollTape();
            if (d.w) {
                if (d.w !== this.frameW || d.h !== this.frameH) {
                    this.frameW = d.w; this.frameH = d.h;
                    this.canvas.width = d.w; this.canvas.height = d.h;
                    this.frameBuf = new Uint8Array(d.w * d.h * 4);
                    this.imageData = new ImageData(new Uint8ClampedArray(this.frameBuf.buffer), d.w, d.h);
                    // The Next's frame size is video-mode-dependent (taller
                    // rasters; 640-wide half-width-pixel modes), while the
                    // UI pins the canvas CSS box to the classic 320x240 at
                    // the chosen zoom. Keep the UI's width and rescale the
                    // CSS height to this frame's VISIBLE shape so the image
                    // fits the layout without gaps or stretching. Frames
                    // >=600px wide are half-width-pixel modes spanning the
                    // same raster as 320, so halve their aspect width.
                    const cssW = parseFloat(this.canvas.style.width) || d.w;
                    const visW = d.w >= 600 ? d.w / 2 : d.w;
                    this.canvas.style.height = (cssW * d.h / visW) + 'px';
                } else if (this.frameBuf) {
                    this.imageData.data.set(this.frameBuf);
                    this.ctx.putImageData(this.imageData, 0, 0);
                }
            }
        }
        this.rafId = window.requestAnimationFrame((tt) => this.loop(tt));
    }

    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.isInitiallyPaused = false;
            this.lastTick = 0;
            this.audioBase = null; // re-anchor the audio clock after a pause
            if (this.keyboardEnabled) this.keyboardHandler.start();
            this.resumeAudio();
            this.emit('start');
            this.rafId = window.requestAnimationFrame((t) => this.loop(t));
        }
    }

    pause() {
        if (this.isRunning) {
            this.isRunning = false;
            if (this.rafId !== null) { window.cancelAnimationFrame(this.rafId); this.rafId = null; }
            if (this.keyboardEnabled) this.keyboardHandler.stop();
            this.emit('pause');
        }
    }

    setMachine(type) {
        if (type === 'next') {
            this.bootNext().catch(err => {
                console.error('zxgo: Next boot failed:', err);
                alert('Spectrum Next boot failed: ' + (err.message || err));
            });
            return;
        }
        // 5 was Pentagon in the JSSpeccy3 engine — deliberately unsupported
        // here; old ?m=5 links get the closest supported machine.
        if (type != 48) type = 128;
        if (globalThis.zxBoot) {
            const err = globalThis.zxBoot(String(type));
            if (err) console.error('zxgo setMachine:', err);
        }
        this.machineType = type;
        this.emit('setMachine', type);
    }

    // Boot (or reboot) the ZX Spectrum Next: fetch the NextZXOS system assets
    // once (served from /next/ — staged, never committed; see
    // @zxplay/emulator-core LICENSES.md), register the ROMs and boot off the
    // SD image. Resolves once the Next machine has actually constructed
    // (boots run in Go goroutines), so callers can chain zxRunNex safely.
    async bootNext() {
        if (!this.nextAssets) {
            const fetchBin = async (name) => {
                const r = await fetch(new URL(`/next/${name}?ver=${window.zxplay_ver}`, scriptUrl));
                // A SPA fallback answers missing files with the index page
                // (HTTP 200, text/html) — treat that as absent too.
                if (r.status === 404 || (r.headers.get('Content-Type') || '').includes('text/html')) return null;
                if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
                return new Uint8Array(await r.arrayBuffer());
            };
            const [zx, mmc, sd] = await Promise.all(
                ['enNextZX.rom', 'enNxtmmc.rom', 'tbblue.mmc'].map(fetchBin));
            if (!zx || !mmc || !sd) {
                throw new Error('Next system assets missing from /next/ — stage them (packages/emulator-core/scripts/stage-zxnext-assets.sh)');
            }
            this.nextAssets = { zx, mmc, sd };
        }
        globalThis.zxRegisterROM('enNextZX.rom', this.nextAssets.zx);
        globalThis.zxRegisterROM('enNxtmmc.rom', this.nextAssets.mmc);
        const err = globalThis.zxBootNext(this.nextAssets.sd);
        if (err) throw new Error(err);
        // Wait for the Next machine to replace the previous one (goroutine).
        await new Promise((resolve, reject) => {
            const t0 = performance.now();
            const poll = () => {
                if ((globalThis.zxModel ? globalThis.zxModel() : '').includes('Next')) return resolve();
                if (performance.now() - t0 > 15000) return reject(new Error('Next machine did not come up'));
                setTimeout(poll, 100);
            };
            poll();
        });
        this.machineType = 'next';
        this.emit('setMachine', 'next');
    }

    // Open a .nex: needs the Next, so switch to it first if required, then
    // hand the file to the core — it copies it onto the SD card and drives
    // NextZXOS's own .nexload command to run it (expect a short reboot).
    async openNEXFile(arrayBuffer, name) {
        const data = new Uint8Array(arrayBuffer);
        if (this.machineType !== 'next') await this.bootNext();
        const err = globalThis.zxRunNex(name || 'game.nex', data);
        if (err) throw new Error(err);
        return { mediaType: 'nex' };
    }

    reset() {
        if (globalThis.zxReset) globalThis.zxReset();
    }

    loadSnapshot(snapshot) {
        // Struct-based snapshot loading was a JSSpeccy3 internal; no app code
        // calls it (the file/url paths below go straight to the core).
        console.warn('zxgo: loadSnapshot(struct) is not supported');
        return Promise.resolve({ mediaType: 'snapshot' });
    }

    loadSnapshotBytes(arrayBuffer, ext) {
        const res = globalThis.zxLoadSnapshot(new Uint8Array(arrayBuffer), ext);
        if (res === '48' || res === '128') {
            this.machineType = parseInt(res, 10);
            this.emit('setMachine', this.machineType);
            return Promise.resolve({ mediaType: 'snapshot' });
        }
        return Promise.reject(res);
    }

    openTapeBytes(arrayBuffer) {
        const data = new Uint8Array(arrayBuffer);
        let err;
        if (this.autoLoadTapes) {
            // Reboot + drive LOAD"" / the 128 Tape Loader in the core (its
            // keystroke macro), fast-loaded by the LD-BYTES trap when traps
            // are on, real-time otherwise.
            err = globalThis.zxLoadTap(data);
        } else {
            err = globalThis.zxTapeInsert(data);
        }
        if (err) return Promise.reject(err);
        this.emit('openedTapeFile');
        return Promise.resolve({ mediaType: 'tape' });
    }

    openTAPFile(data) { return this.openTapeBytes(data); }
    openTZXFile(data) { return this.openTapeBytes(data); }

    getFileOpener(filename) {
        const cleanName = filename.toLowerCase();
        if (cleanName.endsWith('.z80')) {
            return arrayBuffer => this.loadSnapshotBytes(arrayBuffer, 'z80');
        } else if (cleanName.endsWith('.szx')) {
            return arrayBuffer => this.loadSnapshotBytes(arrayBuffer, 'szx');
        } else if (cleanName.endsWith('.sna')) {
            return arrayBuffer => this.loadSnapshotBytes(arrayBuffer, 'sna');
        } else if (cleanName.endsWith('.tap') || cleanName.endsWith('.tzx')) {
            return arrayBuffer => this.openTapeBytes(arrayBuffer);
        } else if (cleanName.endsWith('.nex')) {
            const baseName = cleanName.split('/').pop();
            return arrayBuffer => this.openNEXFile(arrayBuffer, baseName);
        } else if (cleanName.endsWith('.zip')) {
            return async arrayBuffer => {
                const zip = await JSZip.loadAsync(arrayBuffer);
                const openers = [];
                zip.forEach((path, file) => {
                    if (path.startsWith('__MACOSX/')) return;
                    const opener = this.getFileOpener(path);
                    if (opener) {
                        openers.push(async () => opener(await file.async('arraybuffer')));
                    }
                });
                if (openers.length == 1) {
                    return openers[0]();
                } else if (openers.length == 0) {
                    throw 'No loadable files found inside ZIP file: ' + filename;
                } else {
                    throw 'Multiple loadable files found inside ZIP file: ' + filename;
                }
            };
        }
    }

    async openFile(file) {
        const opener = this.getFileOpener(file.name);
        if (opener) {
            const buf = await file.arrayBuffer();
            return opener(buf).catch(err => { alert(err); });
        } else {
            throw 'Unrecognised file type: ' + file.name;
        }
    }

    async openUrl(url) {
        const opener = this.getFileOpener(url.toString());
        if (opener) {
            const response = await fetch(url);
            const buf = await response.arrayBuffer();
            return opener(buf);
        } else {
            throw 'Unrecognised file type: ' + url.split('/').pop();
        }
    }

    async openUrlList(urls) {
        if (typeof (urls) === 'string') {
            return await this.openUrl(urls);
        } else {
            for (const url of urls) {
                await this.openUrl(url);
            }
        }
    }

    setAutoLoadTapes(val) {
        this.autoLoadTapes = val;
        this.emit('setAutoLoadTapes', val);
    }

    setTapeTraps(val) {
        this.tapeTrapsEnabled = val;
        if (globalThis.zxTapeTraps) globalThis.zxTapeTraps(val);
        this.emit('setTapeTraps', val);
    }

    playTape() {
        if (globalThis.zxTapePlay) globalThis.zxTapePlay();
    }

    stopTape() {
        if (globalThis.zxTapeStop) globalThis.zxTapeStop();
    }

    exit() {
        this.pause();
        // The Go runtime is a page-level singleton and keeps running (a fresh
        // GoEmulator reuses it); just release this instance's audio.
        if (this.audioNode) {
            try { this.audioNode.context.close(); } catch (e) { /* already closed */ }
            this.audioNode = null;
        }
    }
}
