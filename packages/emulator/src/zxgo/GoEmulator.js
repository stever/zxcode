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
import { nativeZipEntries } from './zipExtract.js';
import { GamepadPoller } from './gamepad.js';

const scriptUrl = document.currentScript.src;

// Bump ENGINE_REV whenever engine/translator behavior changes: the boot
// log shows at a glance whether a dev server is serving a stale bundle
// (workspace-package edits don't reliably trigger webpack-dev-server
// rebuilds through the node_modules symlinks), and the wasm fetch below
// carries it as a cache-buster so a rev bump always forces the browser
// to refetch the core (the JS tag and a cached zx.wasm can otherwise
// silently diverge).
const ENGINE_REV = 'r100-vhdl-allgreen';

// The official SpecNext distro the Next boots from, fetched through the
// same-origin /specnext/ Caddy proxy route (specnext.com sends no CORS
// headers, and the CSP pins connect-src to 'self'). TEMPORARILY DISABLED
// (null): SpecNext have not yet hosted the small emulator-targeted image,
// and relaying the full 1 GB-card distro zip is not wanted in production,
// so the Next boots from the staged /next/ assets (the small prepared
// tbblue.mmc.zip) until it lands. When SpecNext host it, point this at
// its path (e.g. '/specnext/distro/<ver>/<name>.zip') — the version is
// PINNED then: the direct-boot NextReg seed table and the menu-navigation
// cursor index are verified against the distro's exact SD content, so
// re-run the "Next boot modes" checks in packages/emulator-core's README
// against the new image. Staged /next/ assets remain the fallback.
const SPECNEXT_DISTRO_PATH = null;

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
        // Direct-core Next boot: skip the FPGA bootrom splash + TBBLUE.FW
        // stage and reset straight into NextZXOS with the post-firmware
        // NextReg personality seeded (zx_go next_directboot.go). NextZXOS
        // still performs its entire init from the unmodified staged assets;
        // combined with the boot fast-forward this takes boot-to-welcome
        // from ~384 to ~80 emulated frames. The hardware-faithful bootrom
        // path stays the core default — delete these two entries to get it
        // back. Env is snapshotted at go.run(), so it must be set here.
        go.env.ZX_GO_NO_FPGA_BOOTROM = '1';
        go.env.ZX_GO_NEXT_DIRECT_BOOT = '1';
        const resp = await fetch(`${await assetUrl('/dist/zx.wasm', scriptUrl)}?v=${ENGINE_REV}`);
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
        this.heldMatrixKeys = new Map();
        this.worker = {
            postMessage: (msg) => {
                if (!msg) return;
                if (msg.message === 'keyDown' || msg.message === 'keyUp') {
                    this.resumeAudio(); // key gestures unlock the AudioContext
                    this.setMatrixKey(msg.row, msg.mask, msg.message === 'keyDown');
                }
            },
            terminate: () => {},
        };

        this.keyboardEnabled = ('keyboardEnabled' in opts) ? opts.keyboardEnabled : true;
        if (this.keyboardEnabled) {
            // Keyboard capture is scoped by focus: the canvas is focusable
            // and is the default event root, so keys are swallowed only
            // while the display has focus (the apps mark that state with a
            // cyan ring via :focus-within). Clicking anywhere else hands the
            // keyboard back to the page while the emulator keeps running.
            // Virtual keyboards dispatch synthetic key events directly at
            // the canvas, which needs no focus.
            this.canvas.tabIndex = 0;
            this.canvas.style.outline = 'none';
            this.keyboardHandler = (opts.keyboardMap == 'recreated')
                ? new RecreatedZXSpectrumHandler(this.worker, opts.keyboardEventRoot || this.canvas)
                : new StandardKeyboardHandler(this.worker, opts.keyboardEventRoot || this.canvas);
            // Focus loss mid-keypress means the matching keyup will never
            // reach the canvas listener; release everything so keys can't
            // stay held down in the machine (or on the mirrored on-screen
            // keyboard).
            this.canvas.addEventListener('blur', () => this.releaseAllMatrixKeys());
        }

        // Gamepad input, polled per displayed frame from loop(). Unlike the
        // keyboard this is deliberately NOT focus-scoped: a pad can't type
        // into the page, so there is nothing to steal by reading it whenever
        // the machine runs.
        this.gamepad = new GamepadPoller();
        // A pad is invisible to the page until the user presses something on
        // it (a browser fingerprinting defence), and the page must have focus
        // at that moment. That makes "nothing happens" ambiguous: no pad, or
        // a pad the browser is still hiding? These log the transition, so the
        // console answers it without anyone having to poll from devtools —
        // which is itself unreliable, since devtools can hold the focus the
        // browser is waiting on.
        window.addEventListener('gamepadconnected', (e) => {
            console.info(`[zxplay] gamepad connected: ${e.gamepad.id}`
                + ` (mapping: ${e.gamepad.mapping || 'none'},`
                + ` ${e.gamepad.buttons.length} buttons, ${e.gamepad.axes.length} axes)`);
        });
        window.addEventListener('gamepaddisconnected', (e) => {
            console.info(`[zxplay] gamepad disconnected: ${e.gamepad.id}`);
        });
        // Joystick interface the pad drives. Defaults to None, which the
        // core turns into Kempston on the Next (the FPGA always decodes
        // port $1F) while leaving classic machines untouched — enabling
        // Kempston there would make port $1F answer for 48K titles that
        // read it expecting the floating bus.
        // The app supplies and persists this (its own UI owns the picker —
        // this package's menu bar is hidden by every consumer). 'None' is
        // "decide for me": the core routes it to Kempston on the Next, and
        // on classic machines auto-arms Kempston once a game is seen
        // polling port $1F.
        this.joystickType = opts.joystick || 'None';
        window.__zxgoPads = () => this.gamepad.describe();
        // Companion to __zxgoPads: that one says what the BROWSER sees,
        // this one what the MACHINE sees. Together they localise a dead
        // pad to the host, the interface, or the game itself.
        window.__zxgoJoy = () => {
            const core = globalThis.zxJoystickDebug ? globalThis.zxJoystickDebug() : {};
            const hostBits = this.gamepad.bitsSeen;
            return {
                selected: this.joystickType,
                // Host side, cumulative — what the BROWSER produced.
                hostBitsSeen: '0x' + hostBits.toString(16).padStart(3, '0'),
                hostNonZeroPolls: this.gamepad.nonZeroCount,
                ...core,
                // If the browser saw input the core never did, the loss is
                // at the wasm boundary; if neither saw it, the pad or the
                // mapping is at fault; if both saw it, the game simply
                // isn't acting on it.
                boundaryOK: hostBits === (core.bitsSeen ?? 0),
            };
        };

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
        // Loading overlay state (see showLoading/doneLoading below).
        this.loadingHold = false;
        this.loadingVisible = false;
        this.macroWatch = null;
        // Coalesced Next boots (see bootNext).
        this.bootNextInFlight = null;
        // Frame-loop hold during game imports (see openNexGameZip/loop).
        this.frameHold = false;

        // Frame buffer (sized on the first frame the core reports).
        this.frameW = 0; this.frameH = 0;
        this.frameBuf = null; this.imageData = null;

        // Pacing state (see loop()).
        this.acc = 0; this.lastTick = 0;
        this.audioBase = null; this.audioProduced = 0;
        this.audioCushion = 2646; // 60ms; widened on worklet underrun reports
        this.frameCostEma = 0; // measured ms per zxFrame call; gates bursts
        this.rafId = null;

        this.audioNode = null;
        this.audioPullU8 = new Uint8Array(8192); // ≤4096 samples per drain

        this.initAudio(); // fire and forget; pump no-ops until it lands

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
                // Rate-limited to one line per 5s: when the machine can't
                // hold real time, underruns arrive at the stutter frequency
                // and per-event console output (expensive with DevTools
                // open) compounds the very stall it reports.
                const now = performance.now();
                if (!this.underrunLogT || now - this.underrunLogT > 5000) {
                    this.underrunLogT = now;
                    console.debug('[zxplay] audio underrun #' + this.audioUnderruns
                        + ' - cushion now ' + Math.round(this.audioCushion / 44.1) + 'ms');
                }
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
            this.audioDiag = true; // enables pumpAudio's amplitude scan
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

    // Drains the core's audio ring into the worklet. Returns the number of
    // samples pulled (0 when the ring was empty) so the frame loop can pace
    // off REAL production: a guest NR$03/$05 timing retune (48K/Pentagon/
    // 60 Hz frame geometry) makes the core emit ≠882 samples per frame.
    pumpAudio() {
        if (!this.audioNode || !globalThis.zxPullAudio) return 0;
        const n = globalThis.zxPullAudio(this.audioPullU8);
        if (!n) return 0;
        const chunk = this.audioPullU8.slice(0, n * 2);
        // Diagnostics: pull rate + amplitude range of the last chunk (see
        // __zxgoAudio). A healthy idle stream pulls ~44100/s of near-zero
        // samples; DC rails, steps and starvation all show up here. The
        // amplitude scan only runs while a __zxgoAudio() session watches —
        // no per-sample work on the hot path otherwise.
        this.diagPulled = (this.diagPulled || 0) + n;
        if (this.audioDiag) {
            const s16 = new Int16Array(chunk.buffer, 0, n);
            let mn = 32767, mx = -32768;
            for (let i = 0; i < n; i++) { const v = s16[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
            this.diagMin = mn; this.diagMax = mx;
        }
        this.audioNode.port.postMessage(chunk.buffer, [chunk.buffer]);
        return n;
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
            // Rolling per-frame core cost (ms, EMA over zxFrame calls) —
            // the wasm-side execute+render+copy budget. Read it from the
            // console as window.__zxgoFrameMs; under 20 means the core
            // can hold 50fps and any shortfall is host-side. Logged (at
            // most once per 5s) only while it exceeds the real-time
            // budget, so a healthy machine stays silent.
            window.__zxgoFrameMs = Math.round(this.frameCostEma * 100) / 100;
            // Wasm-side execute-vs-render split (zxPerfSplit drains the
            // core's accumulators): per-frame averages over the last
            // second, published beside __zxgoFrameMs so the two halves of
            // the core cost can be attributed separately.
            if (globalThis.zxPerfSplit) {
                const p = globalThis.zxPerfSplit();
                if (p && p.frames > 0) {
                    window.__zxgoExecMs = Math.round(p.execMs / p.frames * 100) / 100;
                    window.__zxgoRenderMs = Math.round(p.renderMs / p.frames * 100) / 100;
                }
            }
            if (this.frameCostEma > 20
                && (!this.frameMsLogT || t - this.frameMsLogT > 5000)) {
                this.frameMsLogT = t;
                console.debug('[zxplay] core frame cost '
                    + window.__zxgoFrameMs + 'ms (>20ms budget) - fps '
                    + window.__zxgoFps
                    + ' - exec ' + (window.__zxgoExecMs ?? '?')
                    + 'ms render ' + (window.__zxgoRenderMs ?? '?') + 'ms');
            }
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
            // No copy here: imageData.data was constructed OVER
            // frameBuf.buffer (same ArrayBuffer), and zxFrame's
            // CopyBytesToJS has already written this frame into it.
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
        // Import hold: a game import is staging files — run no frames (the
        // machine reboots when the import launches, so nothing shown now
        // would survive anyway) and keep the pacing anchors reset so frames
        // resume cleanly, without a catch-up burst, when the hold lifts.
        if (this.frameHold) {
            this.audioBase = null;
            this.acc = 0; this.lastTick = t;
            this.rafId = window.requestAnimationFrame((tt) => this.loop(tt));
            return;
        }
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
        // Catch-up burst cap, gated by the MEASURED per-frame core cost
        // (frameCostEma, updated below). Bursting owed>1 frames into one
        // rAF tick only helps when the core outruns real time (a late
        // tick's backlog clears and the cushion refills). When a heavy
        // title pushes one frame's execute+render near or past the 20ms
        // real-time budget, a 3-4 frame burst just stretches the tick —
        // every burst frame pays a full compositor render — so the
        // DISPLAYED rate collapses to a fraction of what the core can do
        // while the audio ledger's clamp discards the debt anyway (#187:
        // Atic Atac at 28MHz fell into a locked owed=3 cadence, one
        // presented frame per ~3 rendered). One frame per tick is then
        // the fastest the machine can visibly run. The EMA tracks a
        // 100ms-clamped sample per tick, so a one-off GC/resume spike
        // cannot pin the cap low for long, and bursts return as soon as
        // the core shows headroom again (hidden-tab catch-up unchanged
        // for classic machines).
        const burstCap = this.frameCostEma > 3.5
            ? Math.max(1, Math.floor(14 / this.frameCostEma))
            : 4;
        const actx = this.audioNode && this.audioNode.context;
        const audioPaced = !!(actx && actx.state === 'running');
        if (audioPaced) {
            if (this.audioBase === null) { this.audioBase = actx.currentTime; this.audioProduced = 0; }
            const consumed = (actx.currentTime - this.audioBase) * 44100;
            if (this.audioProduced < consumed) this.audioProduced = consumed;
            owed = Math.min(Math.max(Math.ceil((consumed + this.audioCushion - this.audioProduced) / SAMPLES_PER_FRAME), 0), burstCap);
            this.acc = 0; this.lastTick = t;
        } else {
            this.acc = Math.min(this.acc + (this.lastTick ? t - this.lastTick : 20), 80);
            this.lastTick = t;
            owed = Math.min(Math.floor(this.acc / 20), burstCap);
            this.acc -= owed * 20;
        }
        this.tallyFps(t, owed || 0);
        // Input before execution: polled here rather than next to pollTape()
        // below, so a button pressed this tick is visible to the frames this
        // tick is about to run instead of landing one frame late.
        this.pollGamepad();
        if (owed && globalThis.zxFrame) {
            const tf0 = performance.now();
            for (let i = 1; i < owed; i++) globalThis.zxFrame();
            // No destination buffer until the core has reported its frame
            // dimensions once — zxFrame() without args runs the frame and
            // just returns {w,h}.
            const d = this.frameBuf ? globalThis.zxFrame(this.frameBuf) : globalThis.zxFrame();
            // Per-frame core cost feeding the burst cap above.
            const cost = Math.min((performance.now() - tf0) / owed, 100);
            this.frameCostEma = this.frameCostEma ? this.frameCostEma * 0.8 + cost * 0.2 : cost;
            const pumped = this.pumpAudio();
            if (audioPaced) {
                // Account what the core REALLY produced: under a guest
                // NR$03/$05 timing retune (48K/Pentagon/60 Hz geometry,
                // r58) a frame yields ≠882 samples, and fictional
                // 882-per-frame accounting would starve (60 Hz: 748) or
                // overfill the cushion. The boot geometry still yields
                // exactly 882/frame, so the default path is unchanged; an
                // empty pull (core audio not flowing) falls back to the
                // fictional estimate so pacing cannot run away.
                this.audioProduced += pumped > 0 ? pumped : owed * SAMPLES_PER_FRAME;
            }
            this.pollTape();
            this.presentFrame(d);
            this.noteDebugFrame(d);
        } else if (owed && audioPaced) {
            // Core not ready yet: keep the audio clock's ledger moving.
            this.audioProduced += owed * SAMPLES_PER_FRAME;
        }
        this.rafId = window.requestAnimationFrame((tt) => this.loop(tt));
    }

    // Watch zxFrame's debug fields for a transition into paused — a
    // breakpoint / watchpoint hit or a step-over landing. Stops the frame
    // loop (audio re-anchors on the next start, as after a manual pause)
    // and tells the page why the screen froze.
    noteDebugFrame(d) {
        if (!d || !d.debug) {
            this.debugWasPaused = false;
            return;
        }
        if (d.paused && !this.debugWasPaused) {
            this.debugWasPaused = true;
            this.pause();
            this.emit('debugpause', {pc: d.pc});
        } else if (!d.paused) {
            this.debugWasPaused = false;
        }
    }

    // Route one keyboard-matrix transition to the core, remember held keys
    // so blur can release them, and broadcast the transition as a DOM event
    // for UI mirrors: the apps' on-screen keyboards light the matching keys.
    // Because the KeyboardHandler has already translated the PC key, mirrors
    // see the real Spectrum combo (Backspace = CAPS SHIFT + 0, '.' =
    // SYMBOL SHIFT + M), and only while the emulator is trapping keys.
    setMatrixKey(row, mask, down) {
        const key = row * 256 + mask;
        if (down) this.heldMatrixKeys.set(key, {row, mask});
        else this.heldMatrixKeys.delete(key);
        if (globalThis.zxMatrixKey) globalThis.zxMatrixKey(row, mask, down);
        document.dispatchEvent(new CustomEvent('zx-matrix-key', {detail: {row, mask, down}}));
    }

    releaseAllMatrixKeys() {
        for (const {row, mask} of Array.from(this.heldMatrixKeys.values())) {
            this.setMatrixKey(row, mask, false);
        }
    }

    // pollGamepad reads the host pad and forwards it to the core. The
    // poller returns null when there is nothing to say (no pad, or an
    // unchanged vector), so an idle session costs one getGamepads() call
    // per frame and no wasm boundary crossing at all.
    pollGamepad() {
        if (!globalThis.zxJoystickState) return;
        const bits = this.gamepad.poll();
        if (bits === null) return;
        globalThis.zxJoystickState(bits);
    }

    // setJoystick selects which interface the pad drives: 'None',
    // 'Kempston', 'Sinclair1' (keys 6-0), 'Sinclair2' (keys 1-5) or
    // 'Cursor'. Remembered locally so it can be re-applied after a
    // machine boot, which rebuilds the core's emulator and takes its
    // joystick state with it. On the Next the selection is written to
    // the machine's own NR$05 joystick-1 mode (r98, #202) and the
    // FPGA-modelled routing — Kempston/MD ports or Sinclair/Cursor
    // membrane keypresses — does the rest, exactly like hardware; on
    // classic machines the Sinclair/Cursor schemes inject matrix keys.
    setJoystick(type) {
        this.joystickType = type;
        this.applyJoystickType();
        this.emit('setJoystick', type);
    }

    applyJoystickType() {
        if (!globalThis.zxJoystickType) return;
        const err = globalThis.zxJoystickType(String(this.joystickType));
        if (err) console.warn(`[zxplay] joystick: ${err}`);
    }

    start() {
        // Every start request is user-initiated (Play/Run, Reset, the
        // overlay button) — hand the keyboard straight to the program
        // without demanding an extra click on the screen. Deliberately
        // outside the isRunning guard: pressing Play while the machine is
        // already running must still move focus to the emulator.
        if (this.keyboardEnabled) {
            this.canvas.focus({preventScroll: true});
        }
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

    // --- Debugger bridge (zxDebug* exports from wasm_debug_js.go) ---
    // Thin primitives; session policy (when to pause the loop, what to
    // refresh) lives with the caller. 'debugpause' fires from the frame
    // loop when a breakpoint or step-over lands (see noteDebugFrame).

    debugAvailable() {
        return !!globalThis.zxDebugAttach;
    }

    debugAttach() {
        this.debugWasPaused = false;
        this.debugActive = !!(globalThis.zxDebugAttach && globalThis.zxDebugAttach());
        return this.debugActive;
    }

    debugDetach() {
        if (globalThis.zxDebugDetach) globalThis.zxDebugDetach();
        this.debugWasPaused = false;
        this.debugActive = false;
    }

    debugCmd(line) {
        return globalThis.zxDebugCmd ? globalThis.zxDebugCmd(line) : 'ERR debugger unavailable';
    }

    debugState() {
        return globalThis.zxDebugState ? globalThis.zxDebugState() : null;
    }

    debugMem(addr, len) {
        const dst = new Uint8Array(len);
        if (globalThis.zxDebugMem) globalThis.zxDebugMem(addr, dst);
        return dst;
    }

    debugDisasm(addr, count) {
        return globalThis.zxDebugDisasm ? globalThis.zxDebugDisasm(addr, count) : [];
    }

    debugPaging() {
        return globalThis.zxDebugPaging ? globalThis.zxDebugPaging() : null;
    }

    debugStepFrame() {
        return globalThis.zxDebugStepFrame ? globalThis.zxDebugStepFrame() : 'ERR debugger unavailable';
    }

    // Repaint while the debugger holds the machine paused: zxFrame skips
    // execution in that state, so this is render-only.
    debugRender() {
        if (globalThis.zxFrame && this.frameBuf) {
            this.presentFrame(globalThis.zxFrame(this.frameBuf));
        }
    }

    // Resume the frame loop after a debugger continue/step-over.
    debugResume() {
        console.debug('[zxdbg] debugResume()');
        this.debugWasPaused = false;
        this.start();
    }

    setMachine(type) {
        // A machine switch replaces the core emulator instance; any debug
        // session would be left bound to the dead one.
        this.debugDetach();
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
        // A boot builds a fresh core emulator, whose joystick selection
        // starts at the default — re-assert ours.
        this.applyJoystickType();
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

    // Fetch the official SpecNext distro zip (ROMs + full 1GB card image)
    // through the same-origin /specnext/ proxy route — specnext.com sends no
    // CORS headers and the CSP pins connect-src to 'self', so the Caddy
    // proxy passes /specnext/distro/* through to www.specnext.com. The zip
    // is kept in the Cache API so the ~52MB download happens once per
    // browser; the versioned path is its own cache key. Returns the assets
    // bundle or throws (caller falls back to the staged /next/ assets).
    async fetchSpecnextDistro() {
        if (!globalThis.zxSdIngestBegin || !globalThis.zxSdPrepDistro) {
            throw new Error('core lacks sparse ingest/prep exports');
        }
        const url = new URL(SPECNEXT_DISTRO_PATH, scriptUrl).href;
        let resp = null;
        let cache = null;
        try {
            cache = await caches.open('zx-specnext-distro');
            resp = await cache.match(url);
        } catch (e) { /* Cache API unavailable — plain fetch below */ }
        let zipBytes;
        if (resp) {
            this.showLoading('Loading NextZXOS…');
            zipBytes = new Uint8Array(await resp.arrayBuffer());
        } else {
            console.log('zxgo: downloading the official NextZXOS distro,', SPECNEXT_DISTRO_PATH);
            resp = await fetch(url);
            if (!resp.ok || (resp.headers.get('Content-Type') || '').includes('text/html')) {
                throw new Error(`${SPECNEXT_DISTRO_PATH}: HTTP ${resp.status}`);
            }
            zipBytes = await this.readResponseWithProgress(resp, 'Downloading NextZXOS…');
            if (cache) {
                // The body was consumed by the streamed read, so cache the
                // assembled bytes (Response copies its BufferSource body).
                try {
                    await cache.put(url, new Response(zipBytes,
                        { headers: { 'Content-Type': 'application/zip' } }));
                } catch (e) { /* quota — not fatal */ }
            }
        }
        const zip = await JSZip.loadAsync(zipBytes);
        const entryBytes = async (suffix) => {
            const entry = zip.filter((p) => p.toLowerCase().endsWith(suffix))[0];
            return entry ? entry.async('uint8array') : null;
        };
        const [zx, mmc] = await Promise.all(
            [entryBytes('ennextzx.rom'), entryBytes('ennxtmmc.rom')]);
        const img = zip.filter((p) => /\.(img|mmc)$/i.test(p))[0];
        if (!zx || !mmc || !img || !(img._data && img._data.uncompressedSize)) {
            throw new Error(`${SPECNEXT_DISTRO_PATH}: not a Next distro zip (ROMs or streamable card image missing)`);
        }
        return { zx, mmc, sdZip: zipBytes, sdRaw: null, distro: true };
    }

    // Read a fetch response body to completion, driving the loading pill
    // with a byte-accurate fraction from Content-Length (indeterminate when
    // the server doesn't send one). Ring updates are throttled to whole
    // percents so a chunky stream doesn't spam the DOM.
    async readResponseWithProgress(resp, message) {
        if (!resp.body || !resp.body.getReader) {
            this.showLoading(message);
            return new Uint8Array(await resp.arrayBuffer());
        }
        const total = Number(resp.headers.get('Content-Length')) || 0;
        this.showLoading(message, total ? 0 : null);
        const reader = resp.body.getReader();
        const parts = [];
        let received = 0;
        let lastPct = -1;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            received += value.length;
            if (total) {
                const pct = Math.floor((received / total) * 100);
                if (pct !== lastPct) {
                    lastPct = pct;
                    this.showLoading(message, received / total);
                }
            }
        }
        const out = new Uint8Array(received);
        let off = 0;
        for (const p of parts) {
            out.set(p, off);
            off += p.length;
        }
        return out;
    }

    // Fetch the locally staged NextZXOS assets from /next/ (staged, never
    // committed; see @zxplay/emulator-core LICENSES.md). The primary source
    // while SPECNEXT_DISTRO_PATH is null, otherwise the fallback when the
    // official distro is unreachable — and the only source gif-service's
    // Node harness uses.
    async fetchStagedNextAssets() {
        this.showLoading('Loading NextZXOS…');
        const fetchBin = async (name) => {
            const r = await fetch(await assetUrl(`/next/${name}`, scriptUrl));
            // A SPA fallback answers missing files with the index page
            // (HTTP 200, text/html) — treat that as absent too.
            if (r.status === 404 || (r.headers.get('Content-Type') || '').includes('text/html')) return null;
            if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
            return new Uint8Array(await r.arrayBuffer());
        };
        // The staged SD image is mostly empty space — the zip is a few-MB
        // download whatever the card's virtual size. Deployments staged
        // before the zip existed only have the raw image; fall back to it
        // (flat mount) then.
        const [zx, mmc, sdZip] = await Promise.all(
            [fetchBin('enNextZX.rom'), fetchBin('enNxtmmc.rom'), fetchBin('tbblue.mmc.zip')]);
        const sdRaw = sdZip ? null : await fetchBin('tbblue.mmc');
        if (!zx || !mmc || (!sdZip && !sdRaw)) {
            throw new Error('Next system assets missing: nothing staged in /next/ (packages/emulator-core/scripts/stage-zxnext-assets.sh) and no official distro source is available');
        }
        return { zx, mmc, sdZip, sdRaw, distro: false };
    }

    // Boot (or reboot) the ZX Spectrum Next: acquire the NextZXOS system
    // assets once — the official SpecNext distro first when
    // SPECNEXT_DISTRO_PATH is set (full card: NextZXOS plus its bundled
    // games/demos/docs), staged /next/ assets otherwise or as the
    // fallback — register the ROMs and boot off the SD image. The ZIPPED
    // bytes are kept and re-inflated per boot (each boot gets a fresh card),
    // streamed into the core's SPARSE card so the flat image is never
    // materialised — RAM cost is only the card's real content. Resolves once
    // the Next machine has actually constructed (boots run in Go
    // goroutines), so callers can chain zxRunNex safely.
    //
    // Boots are COALESCED: the ingest state (zxSdIngestBegin/Chunk) is
    // page-global in the core, so two overlapping boots interleave their
    // chunk streams and corrupt the card ("no MBR signature"). This happens
    // in practice — a page whose persisted machine choice auto-boots the
    // Next while the user clicks the machine menu. The second caller wants
    // a running Next, not a second boot, so it gets the in-flight promise
    // (queueing a back-to-back reboot instead would also crawl: an ingest
    // run under the first boot's fastboot fast-forward is starved of main
    // thread). A call arriving AFTER the boot settled starts a fresh boot —
    // that is the reboot semantics of re-selecting the machine.
    bootNext() {
        if (this.bootNextInFlight) return this.bootNextInFlight;
        this.bootNextInFlight = this.bootNextNow().finally(() => {
            this.bootNextInFlight = null;
        });
        return this.bootNextInFlight;
    }

    // The boot drives the loading pill through its stages (Downloading /
    // Loading → Preparing SD card → Starting). Pill ownership: when the
    // overlay was already up (a game-launch opener showed it and will keep
    // driving it), the stage messages just update it and the owner closes
    // it; when this boot opened it (the machine-menu path, which used to
    // show nothing through a multi-second download+ingest), it closes it —
    // unless a launch macro took the loadingHold in the meantime.
    async bootNextNow() {
        const ownsPill = !this.loadingVisible;
        try {
            await this.bootNextStages();
        } finally {
            if (ownsPill && !this.loadingHold) this.doneLoading();
        }
    }

    async bootNextStages() {
        if (!this.nextAssets) {
            if (SPECNEXT_DISTRO_PATH) {
                try {
                    this.nextAssets = await this.fetchSpecnextDistro();
                } catch (e) {
                    console.warn('zxgo: official distro unavailable (' + (e.message || e) + '), using staged /next/ assets');
                }
            }
            if (!this.nextAssets) {
                this.nextAssets = await this.fetchStagedNextAssets();
            }
        }
        globalThis.zxRegisterROM('enNextZX.rom', this.nextAssets.zx);
        globalThis.zxRegisterROM('enNxtmmc.rom', this.nextAssets.mmc);
        let err;
        const { sdZip, sdRaw, distro } = this.nextAssets;
        if (sdZip) {
            const zip = await JSZip.loadAsync(sdZip);
            const entry = zip.file('tbblue.mmc') ||
                zip.filter((path) => /\.(mmc|img)$/i.test(path))[0];
            if (!entry) throw new Error('SD zip: no .mmc/.img image inside');
            const size = entry._data && entry._data.uncompressedSize;
            if (size && globalThis.zxSdIngestBegin) {
                const beginErr = globalThis.zxSdIngestBegin(size);
                if (beginErr) throw new Error(beginErr);
                this.showLoading('Preparing SD card…', 0);
                let fed = 0;
                let lastPct = -1;
                await new Promise((resolve, reject) => {
                    entry.internalStream('uint8array')
                        .on('data', (chunk) => {
                            const e = globalThis.zxSdIngestChunk(chunk);
                            if (e) reject(new Error(e));
                            fed += chunk.length;
                            const pct = Math.floor((fed / size) * 100);
                            if (pct !== lastPct) {
                                lastPct = pct;
                                this.showLoading('Preparing SD card…', fed / size);
                            }
                        })
                        .on('error', reject)
                        .on('end', resolve)
                        .resume();
                });
                if (distro) {
                    // A pristine official card re-shows the first-boot
                    // welcome pager every boot and lacks the config.ini the
                    // faithful firmware path needs — normalise it to the
                    // shape a configured card has (see distro_prep.go).
                    const prepErr = globalThis.zxSdPrepDistro();
                    if (prepErr) console.error('zxgo:', prepErr);
                }
                err = globalThis.zxBootNext();
            } else {
                // No streamable size metadata: inflate flat (legacy mount).
                err = globalThis.zxBootNext(await entry.async('uint8array'));
            }
        } else {
            err = globalThis.zxBootNext(sdRaw);
        }
        if (err) throw new Error(err);
        this.showLoading('Starting NextZXOS…');
        // Wait for the Next machine to replace the previous one (goroutine).
        await this.waitForModel('Next');
        this.machineType = 'next';
        this.applyJoystickType(); // fresh core emulator — see setMachine
        this.emit('setMachine', 'next');
    }

    // Open a folder-distributed Next game: a zip holding one .nex plus its
    // data files — the layout a player unzips onto a real card and runs
    // from the game's own folder. Stage EVERY entry (the .nex included)
    // under the GAME'S OWN FOLDER on the card — the zip's folder name when
    // it has one, else a folder named after the .nex — and launch the .nex
    // by its original name inside it (importAndRunNex + the Browser
    // macro). Preserving the real folder/filename matters: some games
    // verify their location or build data paths from it, and self-
    // streaming titles F_OPEN their own .nex by name (#178). Staging
    // happens before zxRunNex — its reboot re-reads the card. Long names
    // land as VFAT LFN entries (like a real card), so games load them
    // literally; a rejected file (FAT-illegal path, full card) is skipped
    // with a warning rather than failing the whole load — it only matters
    // if the game LOADs it, which then fails visibly in-game.
    async openNexGameZip(entries, nexEntry) {
        // Hold the frame loop for the whole import: the user never sees the
        // preliminary boot-to-menu that used to precede the launch reboot
        // (the confusing "double entry"), and the emulator stops competing
        // with the inflater for the main thread. zxPutFile/zxRunNex are pure
        // data calls — no frames needed. The launch macro's reboot is the
        // one boot that gets displayed (fast-forwarded by loop()).
        this.frameHold = true;
        try {
            // Every load starts from a PRISTINE card (#186): bootNext
            // re-ingests the kept zip, so a previous load's game folder,
            // /zx.nex and in-game writes never leak into this one. A boot
            // already in flight (the ?m=next&u= race) is joined, not
            // duplicated — bootNext coalesces.
            await this.bootNext();
            const nexDir = nexEntry.path.slice(0, nexEntry.path.lastIndexOf('/') + 1);
            const nexName = nexEntry.path.split('/').pop();
            const dirParts = nexDir.split('/').filter(Boolean);
            const gameDir = dirParts.length
                ? dirParts[dirParts.length - 1]
                : (nexName.replace(/\.nex$/i, '') || 'game');
            const totalBytes = entries.reduce((sum, e) => sum + (e.size || 0), 0);
            let doneBytes = 0;
            for (const entry of entries) {
                if (entry.path === nexEntry.path) continue; // zxRunNex stages the .nex itself
                this.showLoading(`Loading ${gameDir}…`,
                    totalBytes ? doneBytes / totalBytes : null);
                const rel = entry.path.startsWith(nexDir) ? entry.path.slice(nexDir.length) : entry.path;
                const err = globalThis.zxPutFile(`${gameDir}/${rel}`, await entry.bytes());
                if (err) console.warn(`zxplay: SD stage skipped "${gameDir}/${rel}": ${err}`);
                doneBytes += entry.size || 0;
            }
            this.showLoading(`Starting ${nexName}…`);
            const err = globalThis.zxRunNex(`${gameDir}/${nexName}`, await nexEntry.bytes());
            if (err) throw new Error(err);
            this.watchMacroThenDoneLoading();
            return { mediaType: 'nex' };
        } finally {
            this.frameHold = false;
        }
    }

    // Open a bare .nex: needs the Next, so switch to it first if required,
    // then hand the file to the core under its BARE basename — the core
    // imports it as the fixed root /zx.nex and drives the typed Command
    // Line `.nexload` launch (#184; expect a short reboot). Games that need
    // their own folder/filename are folder-distributed: openNexGameZip's
    // folder-qualified name selects the Browser-launch route instead.
    async openNEXFile(arrayBuffer, name) {
        const data = new Uint8Array(arrayBuffer);
        this.frameHold = true; // see openNexGameZip
        try {
            // Fresh card per load (#186) — see openNexGameZip. bootNext
            // joins a boot already in flight (the ?m=next&u= race), so
            // there is no double-boot; a settled Next re-ingests.
            await this.bootNext();
            this.showLoading(`Starting ${name || 'game.nex'}…`);
            const err = globalThis.zxRunNex(name || 'game.nex', data);
            if (err) throw new Error(err);
            this.watchMacroThenDoneLoading();
            return { mediaType: 'nex' };
        } finally {
            this.frameHold = false;
        }
    }

    reset() {
        this.debugDetach();
        if (globalThis.zxReset) globalThis.zxReset();
        this.applyJoystickType(); // reboot clears the core's selection
    }

    loadSnapshotBytes(arrayBuffer, ext) {
        const res = globalThis.zxLoadSnapshot(new Uint8Array(arrayBuffer), ext);
        if (res === '48' || res === '128') {
            this.machineType = parseInt(res, 10);
            // A snapshot whose model differs from the running machine makes
            // the core build a WHOLE NEW emulator (wasm_js.go: newEmulator +
            // wasmEmu reassign), so the joystick selection goes with it —
            // re-assert it, exactly as the boot paths do.
            this.applyJoystickType();
            this.emit('setMachine', this.machineType);
            return Promise.resolve({ mediaType: 'snapshot' });
        }
        return Promise.reject(res);
    }

    // Stage project asset files onto the SD card before a program is run on
    // the Next, so it can LOAD them at runtime (sprite files etc.). Each name
    // is a path relative to the card root — folders are created as needed —
    // mirroring the project ZIP's layout unzipped onto a real card; the
    // program itself lands at the root as /zx.bas, so its LOAD paths resolve
    // the same way in both worlds. sdFiles: [{name, data: Uint8Array}]. Every
    // path segment must fit FAT 8.3 (the program references the path
    // literally); callers validate, the core also rejects.
    // Returns an error string, or null when all files landed.
    stageSdFiles(sdFiles) {
        for (const f of (sdFiles || [])) {
            const err = globalThis.zxPutFile(f.name, f.data);
            if (err) return `SD file "${f.name}": ${err}`;
        }
        return null;
    }

    async openTapeBytes(arrayBuffer, sdFiles) {
        // A Next boot from setMachine('next') may still be in flight (its SD
        // image fetch takes a moment over the network). Wait for it so machineType
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
            // Assets go on before zxRunBas: its reboot re-reads the card.
            const ferr = this.stageSdFiles(sdFiles);
            if (ferr) return Promise.reject('Next: ' + ferr);
            const err = globalThis.zxRunBas('program.bas', data);
            if (err) return Promise.reject('Next: ' + err);
            this.emit('openedTapeFile');
            return Promise.resolve({ mediaType: 'bas' });
        }

        // A NEX image (e.g. sjasmplus SAVENEX output) is Next-native: like the
        // PLUS3DOS path, boot the Next if needed and run it via .nexload.
        if (isNexImage(data)) {
            if (this.machineType !== 'next') await this.bootNext();
            const ferr = this.stageSdFiles(sdFiles);
            if (ferr) return Promise.reject('Next: ' + ferr);
            // Root-anchored name: IDE contract — the program runs from the
            // card root where stageSdFiles put its assets (typed .nexload
            // launch in the core, not the Browser game launch).
            const err = globalThis.zxRunNex('/program.nex', data);
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
                    const ferr = this.stageSdFiles(sdFiles);
                    if (ferr) throw new Error(ferr);
                    const next = tapToNext(data);
                    // Root-anchored .nex name: IDE contract (see above).
                    const err = (next.kind === 'bas')
                        ? globalThis.zxRunBas(next.name, next.data)
                        : globalThis.zxRunNex('/' + next.name, next.data);
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

    openTAPFile(data, sdFiles) { return this.openTapeBytes(data, sdFiles); }
    openTZXFile(data, sdFiles) { return this.openTapeBytes(data, sdFiles); }

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
            // Bare basename: the core imports it as /zx.nex and launches
            // via the typed Command Line (#184); the name only labels the
            // loading pill.
            const baseName = filename.split('/').pop();
            return arrayBuffer => this.openNEXFile(arrayBuffer, baseName);
        } else if (cleanName.endsWith('.zip')) {
            return async arrayBuffer => {
                // Prefer the native extractor (DecompressionStream — native
                // inflate, so big game zips stage in seconds); JSZip covers
                // the zips it can't parse (zip64, encryption, odd methods).
                // Both produce {path, size, bytes: async () => Uint8Array}.
                let entries = nativeZipEntries(arrayBuffer);
                if (entries) {
                    entries = entries.filter((e) => !e.path.startsWith('__MACOSX/'));
                } else {
                    const zip = await JSZip.loadAsync(arrayBuffer);
                    entries = [];
                    zip.forEach((path, file) => {
                        if (file.dir || path.startsWith('__MACOSX/')) return;
                        entries.push({
                            path,
                            size: (file._data && file._data.uncompressedSize) || 0,
                            bytes: () => file.async('uint8array'),
                        });
                    });
                }
                // A zip holding exactly one .nex is a folder-distributed Next
                // game: its other entries are the game's data files, staged
                // onto the SD card before the .nex runs. Anything else keeps
                // the single-program behaviour (e.g. a .tap inside a zip).
                const nexes = entries.filter((e) => e.path.toLowerCase().endsWith('.nex'));
                if (nexes.length === 1) {
                    return this.openNexGameZip(entries, nexes[0]);
                }
                const openers = [];
                for (const entry of entries) {
                    const opener = this.getFileOpener(entry.path);
                    if (opener) {
                        openers.push(async () => {
                            // Openers take an ArrayBuffer; a stored native
                            // entry views into the zip's buffer, so detach
                            // it into an exact one first.
                            const u8 = await entry.bytes();
                            const exact = (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength);
                            return opener(exact ? u8.buffer : u8.slice().buffer);
                        });
                    }
                }
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

    // Loading overlay drivers. 'loading' shows the loading pill (or updates
    // it); 'loadingDone' removes it. UIController renders them. progress is
    // a 0..1 fraction for the circular progress ring, or null/undefined for
    // an indeterminate spinner (the ring is CSS-animated so it keeps moving
    // even when the main thread is busy).
    showLoading(message, progress) {
        this.lastLoadingMessage = message;
        this.loadingVisible = true;
        this.emit('loading', message, (progress === undefined) ? null : progress);
    }

    doneLoading() {
        this.loadingHold = false;
        this.loadingVisible = false;
        if (this.macroWatch) { clearInterval(this.macroWatch); this.macroWatch = null; }
        this.emit('loadingDone');
    }

    // Keep the overlay up (message already set by the caller) until the
    // core's launch macro finishes driving NextZXOS — the stretch between
    // zxRunNex and the game actually starting, where the screen shows a
    // reboot the user didn't ask for. loadingHold tells openFile/openUrl
    // not to hide the overlay when their opener resolves.
    watchMacroThenDoneLoading() {
        this.loadingHold = true;
        if (this.macroWatch) clearInterval(this.macroWatch);
        const t0 = Date.now();
        let best = 0; // keep the ring monotonic across estimate jitter
        this.macroWatch = setInterval(() => {
            const active = globalThis.zxMacroActive && globalThis.zxMacroActive();
            if (!active || Date.now() - t0 > 180000) {
                this.doneLoading();
                return;
            }
            // Fill the ring with the macro's own progress through its
            // script (boot + menu + Browser navigation).
            const p = globalThis.zxMacroProgress ? globalThis.zxMacroProgress() : -1;
            if (p >= 0) {
                best = Math.max(best, p);
                this.showLoading(this.lastLoadingMessage, best);
            }
        }, 300);
    }

    async openFile(file) {
        const opener = this.getFileOpener(file.name);
        if (opener) {
            this.showLoading('Loading…');
            try {
                const buf = await file.arrayBuffer();
                return await opener(buf).catch(err => { alert(err); });
            } finally {
                if (!this.loadingHold) this.doneLoading();
            }
        } else {
            throw 'Unrecognised file type: ' + file.name;
        }
    }

    async openUrl(url) {
        const opener = this.getFileOpener(url.toString());
        if (opener) {
            this.showLoading('Downloading…');
            try {
                // no-cache: always revalidate with the host so an updated
                // game at the same URL is picked up (unchanged files still
                // answer 304 from the HTTP cache when the host sends
                // validators).
                const response = await fetch(url, { cache: 'no-cache' });
                if (!response.ok) {
                    throw `Download failed (HTTP ${response.status}): ` +
                        url.toString();
                }
                const buf = await response.arrayBuffer();
                return await opener(buf);
            } finally {
                if (!this.loadingHold) this.doneLoading();
            }
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
