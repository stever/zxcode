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
import { tapToNext } from './tapToNext.js';
import { assetUrl } from './assetManifest.js';

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
            const execUrl = await assetUrl('/dist/wasm_exec.js', scriptUrl);
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = execUrl;
                s.onload = resolve;
                s.onerror = () => reject(new Error('failed to load wasm_exec.js'));
                document.head.appendChild(s);
            });
        }
        const go = new globalThis.Go();
        const resp = await fetch(await assetUrl('/dist/zx.wasm', scriptUrl));
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
// The worklet processor lives in zx-feeder.worklet.js, served from /dist as a
// real static file: the sites run behind a CSP of script-src 'self', which
// blocks blob:/data: worklet modules (the IDE behind the Caddy proxy was
// silent because of exactly that).

const SAMPLES_PER_FRAME = 882; // 44100 / 50: one emulated frame of mono audio

// Fixed display box (see the constructor): every machine and video mode is
// composited into this, so the on-page element never changes size.
const DISPLAY_W = 640;
const DISPLAY_H = 512;

// A PLUS3DOS file (the on-disk +3/NextZXOS program format) begins with the
// 8-byte "PLUS3DOS" signature. NextBASIC compiled by txt2bas arrives in this
// form rather than as a TAP.
const PLUS3DOS_SIG = [0x50, 0x4C, 0x55, 0x53, 0x33, 0x44, 0x4F, 0x53];
function isPlus3Dos(data) {
    if (data.length < PLUS3DOS_SIG.length) return false;
    return PLUS3DOS_SIG.every((b, i) => data[i] === b);
}

// A NEX file (the Next's native program format, e.g. sjasmplus SAVENEX
// output) begins with the 4-byte "Next" signature. Compiled programs arrive
// through the same byte pipeline as TAPs, so sniff and route accordingly.
const NEX_SIG = [0x4E, 0x65, 0x78, 0x74];
function isNexImage(data) {
    if (data.length < NEX_SIG.length) return false;
    return NEX_SIG.every((b, i) => data[i] === b);
}

export class GoEmulator extends EventEmitter {
    constructor(canvas, opts) {
        super();
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        // One fixed display box for every machine: 640x512 (2x the Next's
        // tallest common raster). Each emulator frame — whatever its mode-
        // dependent size — is composited in centered, with the spare rows
        // painted in the frame's own border colour so they read as border.
        // Classic 320x240 frames land at exact 2x with 16 border rows top
        // and bottom; the page layout never moves when machines or video
        // modes change.
        this.canvas.width = DISPLAY_W;
        this.canvas.height = DISPLAY_H;

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
        // Opt-in (the IDE sets it): translate compiled TAPs for the Next
        // (tapToNext.js). Without it, tapes are treated as classic media —
        // opening one while the Next is selected switches to the 128K.
        this.tapToNextEnabled = !!opts.tapToNext;
        this.machineType = null;
        // Promise for an in-flight machine boot (currently only the Next, whose
        // boot is async: it fetches the ~64MB SD image and constructs in a Go
        // goroutine). run/tape/nex calls await this so they can't race the boot
        // and hit "not booted", or branch on a machineType that hasn't settled.
        this.pendingBoot = null;
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

        // Bump ENGINE_REV whenever engine/translator behavior changes: the
        // boot log then shows at a glance whether a dev server is serving a
        // stale bundle (workspace-package edits don't reliably trigger
        // webpack-dev-server rebuilds through the node_modules symlinks).
        const ENGINE_REV = 'r19-fast-boot';
        console.info(`[zxplay] emulator engine: zxgo (zx_go wasm core) ${ENGINE_REV}`
            + (this.tapToNextEnabled ? ' +tapToNext' : ' (tapes->128K on Next)'));
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
            // A real file served from /dist (CSP script-src 'self' compliant;
            // blob:/data: module URLs are blocked behind the Caddy proxy).
            await actx.audioWorklet.addModule(
                await assetUrl('/dist/zx-feeder.worklet.js', scriptUrl));
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
            // Browsers keep the context suspended until a user gesture, and
            // the apps' own buttons (the IDE's Play, the nav items) never
            // route through the emulator — so unlock on ANY page gesture.
            // resumeAudio is idempotent; the capture-phase listeners are
            // cheap and removed on exit.
            this.gestureUnlock = () => this.resumeAudio();
            document.addEventListener('click', this.gestureUnlock, true);
            document.addEventListener('keydown', this.gestureUnlock, true);
            document.addEventListener('touchend', this.gestureUnlock, true);
        } catch (e) {
            this.audioInitError = String((e && e.message) || e);
            console.error('zxgo: AudioWorklet init FAILED - the emulator will be silent:', e);
        }
        // Diagnostic hook: run window.__zxgoAudio() in the console. Installed
        // whether or not init succeeded, so a failed pipeline can still be
        // inspected (audioInitError says why).
        window.__zxgoAudio = () => {
            const actx = this.audioNode && this.audioNode.context;
            const now = performance.now();
            const dt = (now - (this.diagT0 || now)) / 1000;
            const rate = dt > 0 ? Math.round((this.diagPulled || 0) / dt) : 0;
            this.diagT0 = now; this.diagPulled = 0;
            return {
                machine: this.machineType,
                audioInitError: this.audioInitError || null,
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

    // Emulated-frames-per-second, published once a second for the page's
    // discreet FPS readout (50 = full speed; counts frames EXECUTED, so a
    // late rAF that catches up with 2 frames isn't a spurious dip — and the
    // boot fast-forward shows up as the multi-hundred rate it really runs at).
    tallyFps(t, frames) {
        this.fpsCount = (this.fpsCount || 0) + frames;
        if (!this.fpsT) this.fpsT = t;
        if (t - this.fpsT >= 1000) {
            window.__zxgoFps = Math.round(this.fpsCount * 1000 / (t - this.fpsT));
            this.fpsCount = 0;
            this.fpsT = t;
        }
    }

    // Composite one core frame ({w,h} as returned by zxFrame) into the fixed
    // display box. Shared by the normal and fast-boot paths.
    presentFrame(d) {
        if (!d.w) return;
        if (d.w !== this.frameW || d.h !== this.frameH) {
            this.frameW = d.w; this.frameH = d.h;
            this.frameBuf = new Uint8Array(d.w * d.h * 4);
            this.imageData = new ImageData(new Uint8ClampedArray(this.frameBuf.buffer), d.w, d.h);
            // Raw frame goes to an offscreen canvas, composited into
            // the fixed display box each tick.
            this.off = document.createElement('canvas');
            this.off.width = d.w; this.off.height = d.h;
            this.offCtx = this.off.getContext('2d');
        } else if (this.frameBuf) {
            this.imageData.data.set(this.frameBuf);
            this.offCtx.putImageData(this.imageData, 0, 0);
            const g = this.ctx;
            // Filler in the frame's own border colour (corner
            // pixel), so it reads as border, not letterboxing.
            g.fillStyle = 'rgb(' + this.frameBuf[0] + ',' + this.frameBuf[1] + ',' + this.frameBuf[2] + ')';
            g.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
            g.imageSmoothingEnabled = false;
            // Frames >=600px wide are half-width-pixel modes spanning
            // the same visible raster as the 320-wide ones, so every
            // mode maps to 640 wide x 2-per-line tall.
            const visW = this.frameW >= 600 ? this.frameW / 2 : this.frameW;
            let dw = DISPLAY_W, dh = Math.round(this.frameH * (DISPLAY_W / visW));
            if (dh > DISPLAY_H) { dw = Math.round(dw * DISPLAY_H / dh); dh = DISPLAY_H; }
            g.drawImage(this.off, (DISPLAY_W - dw) >> 1, (DISPLAY_H - dh) >> 1, dw, dh);
        }
    }

    // One rAF tick. Pacing (ported from the PoC): clock the 50Hz machine off
    // the audio clock when it runs — produce whatever keeps audioCushion
    // samples in flight ahead of playback — else bank wall-clock time at 20ms
    // per frame. Both cap at 4 frames per tick so a hidden tab catches up
    // briefly instead of bursting.
    loop(t) {
        if (!this.isRunning) return;
        // Boot fast-forward: while the core reports the Next still booting
        // (or its load macro still typing keystrokes — zx_go fastboot.go),
        // run as many frames as fit a ~10ms budget per displayed frame
        // instead of the audio-paced 1x cadence. Nothing is skipped: the
        // FPGA bootrom, TBBLUE.FW and NextZXOS all execute unmodified —
        // pure time compression, so the ~20s boot-and-type sequence passes
        // in a second or two of wall clock.
        if (globalThis.zxFastBoot && globalThis.zxFrame && globalThis.zxFastBoot()) {
            const t0 = performance.now();
            let ran = 0;
            while (globalThis.zxFastBoot() && performance.now() - t0 < 10) {
                globalThis.zxFrame();
                ran++;
            }
            const d = this.frameBuf ? globalThis.zxFrame(this.frameBuf) : globalThis.zxFrame();
            ran++;
            // Time-compressed audio is garbled noise — drain the core's ring
            // and drop it, then re-anchor the audio clock so normal pacing
            // resumes cleanly at the boundary (as after a pause).
            if (globalThis.zxPullAudio) {
                while (globalThis.zxPullAudio(this.audioPullU8) > 0) { /* discard */ }
            }
            this.audioBase = null;
            this.acc = 0; this.lastTick = t;
            this.tallyFps(t, ran);
            this.presentFrame(d);
            this.rafId = window.requestAnimationFrame((tt) => this.loop(tt));
            return;
        }
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
        this.tallyFps(t, owed || 0);
        if (owed && globalThis.zxFrame) {
            for (let i = 1; i < owed; i++) globalThis.zxFrame();
            // No destination buffer until the core has reported its frame
            // dimensions once — zxFrame() without args runs the frame and
            // just returns {w,h}.
            const d = this.frameBuf ? globalThis.zxFrame(this.frameBuf) : globalThis.zxFrame();
            this.pumpAudio();
            this.pollTape();
            this.presentFrame(d);
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
            // Record the boot promise so run/tape/nex calls can await it.
            this.pendingBoot = this.bootNext();
            this.pendingBoot.catch(err => {
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
        this.pendingBoot = null; // classic boot completes synchronously here
        this.emit('setMachine', type);
    }

    // Await any in-flight machine boot (see this.pendingBoot). No-op when the
    // machine is already up. Boot errors are swallowed here — they are already
    // surfaced by setMachine's own catch — so callers only wait, never rethrow.
    async whenMachineReady() {
        if (this.pendingBoot) {
            try { await this.pendingBoot; } catch (e) { /* surfaced in setMachine */ }
        }
    }

    // Machine construction runs in a Go goroutine; poll the core's reported
    // model name until the requested machine has actually replaced the old
    // one, so follow-up calls (zxRunNex, tape mounts) cannot land on the
    // previous machine.
    waitForModel(nameFragment, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const t0 = performance.now();
            const poll = () => {
                if ((globalThis.zxModel ? globalThis.zxModel() : '').includes(nameFragment)) return resolve();
                if (performance.now() - t0 > timeoutMs) {
                    return reject(new Error(`machine "${nameFragment}" did not come up`));
                }
                setTimeout(poll, 100);
            };
            poll();
        });
    }

    // Boot (or reboot) the ZX Spectrum Next: fetch the NextZXOS system assets
    // once (served from /next/ — staged, never committed; see
    // @zxplay/emulator-core LICENSES.md), register the ROMs and boot off the
    // SD image. Resolves once the Next machine has actually constructed
    // (boots run in Go goroutines), so callers can chain zxRunNex safely.
    async bootNext() {
        if (!this.nextAssets) {
            const fetchBin = async (name) => {
                const r = await fetch(await assetUrl(`/next/${name}`, scriptUrl));
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
        await this.waitForModel('Next');
        this.machineType = 'next';
        this.emit('setMachine', 'next');
    }

    // Open a .nex: needs the Next, so switch to it first if required, then
    // hand the file to the core — it copies it onto the SD card and drives
    // NextZXOS's own .nexload command to run it (expect a short reboot).
    async openNEXFile(arrayBuffer, name) {
        const data = new Uint8Array(arrayBuffer);
        // Wait out a boot already started by setMachine('next') before deciding
        // whether to boot — otherwise machineType lags and we double-boot.
        await this.whenMachineReady();
        if (this.machineType !== 'next') await this.bootNext();
        const err = globalThis.zxRunNex(name || 'game.nex', data);
        if (err) throw new Error(err);
        return { mediaType: 'nex' };
    }

    reset() {
        if (globalThis.zxReset) globalThis.zxReset();
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

    async openTapeBytes(arrayBuffer) {
        // A Next boot from setMachine('next') may still be in flight (its 64MB
        // SD fetch takes seconds over the network). Wait for it so machineType
        // has settled to 'next' and the core is constructed before we branch or
        // call in — otherwise the Next path is missed and the classic branch
        // loads a tape into a not-yet-booted core ("not booted").
        await this.whenMachineReady();
        const data = new Uint8Array(arrayBuffer);

        // NextBASIC (txt2bas) is delivered as a tokenised PLUS3DOS program, not
        // a tape. It only runs on the Next: boot it if needed, then hand the
        // bytes straight to NextZXOS's LOAD delivery (zxRunBas), bypassing the
        // TAP translation. The autostart line baked into the header runs it.
        if (isPlus3Dos(data)) {
            if (this.machineType !== 'next') await this.bootNext();
            const err = globalThis.zxRunBas('program.bas', data);
            if (err) return Promise.reject('Next: ' + err);
            this.emit('openedTapeFile');
            return Promise.resolve({ mediaType: 'bas' });
        }

        // A NEX image (e.g. sjasmplus SAVENEX output) is Next-native: like the
        // PLUS3DOS path, boot the Next if needed and run it via .nexload.
        if (isNexImage(data)) {
            if (this.machineType !== 'next') await this.bootNext();
            const err = globalThis.zxRunNex('program.nex', data);
            if (err) return Promise.reject('Next: ' + err);
            this.emit('openedTapeFile');
            return Promise.resolve({ mediaType: 'nex' });
        }

        if (this.machineType === 'next') {
            if (this.tapToNextEnabled) {
                // IDE mode: the TAP is a compiler artifact — translate it
                // into NextZXOS's native delivery (a LOADable PLUS3DOS
                // program or a generated .nex) so it runs ON the Next.
                try {
                    const next = tapToNext(data);
                    const err = (next.kind === 'bas')
                        ? globalThis.zxRunBas(next.name, next.data)
                        : globalThis.zxRunNex(next.name, next.data);
                    if (err) return Promise.reject(err);
                    this.emit('openedTapeFile');
                    return Promise.resolve({ mediaType: 'tape' });
                } catch (e) {
                    return Promise.reject('Next: ' + (e.message || e));
                }
            }
            // Player mode: a .tap is classic-machine media (the Next cannot
            // tape-load in zx_go yet) — switch to the 128K and play it there.
            this.setMachine(128);
            return this.waitForModel('128').then(() => this.classicTapeLoad(data));
        }
        return this.classicTapeLoad(data);
    }

    classicTapeLoad(data) {
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
        if (this.gestureUnlock) {
            document.removeEventListener('click', this.gestureUnlock, true);
            document.removeEventListener('keydown', this.gestureUnlock, true);
            document.removeEventListener('touchend', this.gestureUnlock, true);
            this.gestureUnlock = null;
        }
        // The Go runtime is a page-level singleton and keeps running (a fresh
        // GoEmulator reuses it); just release this instance's audio.
        if (this.audioNode) {
            try { this.audioNode.context.close(); } catch (e) { /* already closed */ }
            this.audioNode = null;
        }
    }
}
