import EventEmitter from 'events';
import JSZip from 'jszip';

import { DisplayHandler } from './DisplayHandler.js';
import { parseSNAFile, parseZ80File, parseSZXFile } from './snapshot.js';
import { TAPFile, TZXFile } from './tape';
import { StandardKeyboardHandler, RecreatedZXSpectrumHandler } from './KeyboardHandler.js';
import { AudioHandler } from './AudioHandler.js';

const scriptUrl = document.currentScript.src;

export class Emulator extends EventEmitter {
    constructor(canvas, opts) {
        super();
        this.canvas = canvas;
        this.worker = new Worker(new URL(`/dist/jsspeccy-worker.js?ver=${window.zxplay_ver}`, scriptUrl));
        this.keyboardEnabled = ('keyboardEnabled' in opts) ? opts.keyboardEnabled : true;
        if (this.keyboardEnabled) {
            this.keyboardHandler = (opts.keyboardMap == 'recreated')
                ? new RecreatedZXSpectrumHandler(this.worker, opts.keyboardEventRoot || document)
                : new StandardKeyboardHandler(this.worker, opts.keyboardEventRoot || document);
        }
        this.displayHandler = new DisplayHandler(this.canvas);
        this.audioHandler = new AudioHandler();
        this.isRunning = false;
        this.isInitiallyPaused = (!opts.autoStart);
        this.autoLoadTapes = opts.autoLoadTapes || false;
        this.tapeIsPlaying = false;
        this.tapeTrapsEnabled = ('tapeTrapsEnabled' in opts) ? opts.tapeTrapsEnabled : true;

        this.msPerFrame = 20;

        this.isExecutingFrame = false;
        this.nextFrameTime = null;
        this.machineType = null;

        this.nextFileOpenID = 0;
        this.fileOpenPromiseResolutions = {};

        this.isReady = false;
        this.onReadyHandlers = [];

        this.worker.onmessage = (e) => {
            switch(e.data.message) {
                case 'ready':
                    this.loadRoms().then(() => {
                        this.setMachine(opts.machine || 128);
                        this.setTapeTraps(this.tapeTrapsEnabled);
                        if (opts.openUrl) {
                            this.openUrlList(opts.openUrl).catch(err => {
                                alert(err);
                            }).then(() => {
                                if (opts.autoStart) this.start();
                            });
                        } else if (opts.autoStart) {
                            this.start();
                        }

                        this.isReady = true;
                        for (let i = 0; i < this.onReadyHandlers.length; i++) {
                            this.onReadyHandlers[i]();
                        }
                    });
                    break;
                case 'frameCompleted':
                    // benchmarkRunCount++;
                    this.advanceAutoType();
                    if ('audioBufferLeft' in e.data) {
                        this.audioHandler.frameCompleted(e.data.audioBufferLeft, e.data.audioBufferRight);
                    }

                    this.displayHandler.frameCompleted(e.data.frameBuffer);
                    if (this.isRunning) {
                        const time = performance.now();
                        if (time > this.nextFrameTime) {
                            /* running at full blast - start next frame but adjust time base
                            to give it the full time allocation */
                            this.runFrame();
                            this.nextFrameTime = time + this.msPerFrame;
                        } else {
                            this.isExecutingFrame = false;
                        }
                    } else {
                        this.isExecutingFrame = false;
                    }
                    break;
                case 'fileOpened':
                    if (e.data.mediaType == 'tape' && this.autoLoadTapes) {
                        if (this.machineType == 5) {
                            /* Pentagon boots to a menu, but its ROM/timing isn't
                               covered by the keypress autoload, so keep driving it
                               via the tapeloader snapshot. */
                            this.openUrl(new URL('../tapeloaders/tape_pentagon.szx', scriptUrl));
                        } else {
                            /* 48K and 128K: cold-boot and drive the ROM with injected
                               keypresses (the keys differ per machine - see
                               beginAutoTypeLoad). The tapeloader snapshots park the
                               machine in a captured state that breaks some games'
                               loaders (e.g. report 5 "Out of screen"); a cold boot
                               matches a real load. */
                            this.reset();
                            this.beginAutoTypeLoad();
                        }
                        if (!this.tapeTrapsEnabled) {
                            this.playTape();
                        }
                    }
                    this.fileOpenPromiseResolutions[e.data.id]({
                        mediaType: e.data.mediaType,
                    });
                    if (e.data.mediaType == 'tape') {
                        this.emit('openedTapeFile');
                    }
                    break;
                case 'playingTape':
                    this.tapeIsPlaying = true;
                    this.emit('playingTape');
                    break;
                case 'stoppedTape':
                    this.tapeIsPlaying = false;
                    this.emit('stoppedTape');
                    break;
                default:
                    console.log('message received by host:', e.data);
            }
        }
        this.worker.postMessage({
            message: 'loadCore',
            baseUrl: scriptUrl,
        })
    }

    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.isInitiallyPaused = false;
            this.nextFrameTime = performance.now();
            if (this.keyboardEnabled) this.keyboardHandler.start();
            this.audioHandler.start();
            this.emit('start');
            window.requestAnimationFrame((t) => {
                this.runAnimationFrame(t);
            });
        }
    }

    pause() {
        if (this.isRunning) {
            this.isRunning = false;
            if (this.keyboardEnabled) this.keyboardHandler.stop();
            this.audioHandler.stop();
            this.emit('pause');
        }
    }

    async loadRom(url, page) {
        const response = await fetch(new URL(url, scriptUrl));
        const data = new Uint8Array(await response.arrayBuffer());
        this.worker.postMessage({
            message: 'loadMemory',
            data,
            page: page,
        });
    }

    async loadRoms() {
        await this.loadRom('../roms/128-0.rom', 8);
        await this.loadRom('../roms/128-1.rom', 9);
        await this.loadRom('../roms/48.rom', 10);
        await this.loadRom('../roms/pentagon-0.rom', 12);
        await this.loadRom('../roms/trdos.rom', 13);
    }


    runFrame() {
        this.isExecutingFrame = true;
        const frameBuffer = this.displayHandler.getNextFrameBuffer();

        if (this.audioHandler.isActive) {
            const [audioBufferLeft, audioBufferRight] = this.audioHandler.frameBuffers;

            this.worker.postMessage({
                message: 'runFrame',
                frameBuffer,
                audioBufferLeft,
                audioBufferRight,
            }, [frameBuffer, audioBufferLeft, audioBufferRight]);
        } else {
            this.worker.postMessage({
                message: 'runFrame',
                frameBuffer,
            }, [frameBuffer]);
        }
    }

    runAnimationFrame(time) {
        if (this.displayHandler.readyToShow()) {
            this.displayHandler.show();
            // benchmarkRenderCount++;
        }
        if (this.isRunning) {
            if (time > this.nextFrameTime && !this.isExecutingFrame) {
                this.runFrame();
                this.nextFrameTime += this.msPerFrame;
            }
            window.requestAnimationFrame((t) => {
                this.runAnimationFrame(t);
            });
        }
    };

    setMachine(type) {
        if (type != 128 && type != 5) type = 48;
        this.worker.postMessage({
            message: 'setMachineType',
            type,
        });
        this.machineType = type;
        this.emit('setMachine', type);
    }

    reset() {
        this.worker.postMessage({message: 'reset'});
    }

    /* Cold-boot autoload by injecting matrix keypresses. Driven off completed
       emulator frames (not wall-clock time), so the keystrokes only advance while
       the CPU is actually executing - they wait for the machine to start and the
       ROM to boot rather than guessing. The keys differ per machine; tune the frame
       counts if the keystrokes land before the ROM is ready or get merged. */
    beginAutoTypeLoad() {
        const HOLD_FRAMES = 5;    // frames each key/chord is held down
        const GAP_FRAMES = 5;     // frames between keystrokes so the ROM debounces

        const SYMBOL_SHIFT = {row: 7, mask: 0x02};
        const P = {row: 5, mask: 0x01};
        const J = {row: 6, mask: 0x08};
        const ENTER = {row: 6, mask: 0x01};

        let bootFrames, chords;
        if (this.machineType == 128) {
            /* 128K boots to a menu with "Tape Loader" highlighted; pressing ENTER
               selects it, which runs LOAD "". The menu (standard 128 ROM, no RAM
               test) is ready in about the same time as the 48K BASIC prompt. Press
               too early and the keypress lands before the menu scans the keyboard
               and is lost, so this is the floor worth trusting without measuring. */
            bootFrames = 120;  // ~2.4s for the menu to come up and start scanning
            chords = [[ENTER]];
        } else {
            /* 48K boots straight to BASIC: type LOAD "" (J = the LOAD keyword,
               " = symbol-shift + P twice) then ENTER. */
            bootFrames = 120;  // ~2.4s for the ROM to reach the input loop
            chords = [[J], [SYMBOL_SHIFT, P], [SYMBOL_SHIFT, P], [ENTER]];
        }

        const actions = [];
        let frame = bootFrames;
        for (const chord of chords) {
            actions.push({frame, message: 'keyDown', keys: chord});
            frame += HOLD_FRAMES;
            actions.push({frame, message: 'keyUp', keys: chord});
            frame += GAP_FRAMES;
        }
        this.autoTypeActions = actions;
        this.autoTypeFrame = 0;
    }

    advanceAutoType() {
        if (!this.autoTypeActions) return;
        this.autoTypeFrame++;
        while (this.autoTypeActions.length && this.autoTypeActions[0].frame <= this.autoTypeFrame) {
            const action = this.autoTypeActions.shift();
            for (const k of action.keys) {
                this.worker.postMessage({message: action.message, row: k.row, mask: k.mask});
            }
        }
        if (!this.autoTypeActions.length) this.autoTypeActions = null;
    }

    loadSnapshot(snapshot) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'loadSnapshot',
            id: fileID,
            snapshot,
        })
        this.emit('setMachine', snapshot.model);
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    openTAPFile(data) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTAPFile',
            id: fileID,
            data,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    openTZXFile(data) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTZXFile',
            id: fileID,
            data,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    getFileOpener(filename) {
        const cleanName = filename.toLowerCase();
        if (cleanName.endsWith('.z80')) {
            return arrayBuffer => {
                const z80file = parseZ80File(arrayBuffer);
                return this.loadSnapshot(z80file);
            };
        } else if (cleanName.endsWith('.szx')) {
            return arrayBuffer => {
                const szxfile = parseSZXFile(arrayBuffer);
                return this.loadSnapshot(szxfile);
            };
        } else if (cleanName.endsWith('.sna')) {
            return arrayBuffer => {
                const snafile = parseSNAFile(arrayBuffer);
                return this.loadSnapshot(snafile);
            };
        } else if (cleanName.endsWith('.tap')) {
            return arrayBuffer => {
                if (!TAPFile.isValid(arrayBuffer)) {
                    alert('Invalid TAP file');
                } else {
                    return this.openTAPFile(arrayBuffer);
                }
            };
        } else if (cleanName.endsWith('.tzx')) {
            return arrayBuffer => {
                if (!TZXFile.isValid(arrayBuffer)) {
                    alert('Invalid TZX file');
                } else {
                    return this.openTZXFile(arrayBuffer);
                }
            };
        } else if (cleanName.endsWith('.zip')) {
            return async arrayBuffer => {
                const zip = await JSZip.loadAsync(arrayBuffer);
                const openers = [];
                zip.forEach((path, file) => {
                    if (path.startsWith('__MACOSX/')) return;
                    const opener = this.getFileOpener(path);
                    if (opener) {
                        const boundOpener = async () => {
                            const buf = await file.async('arraybuffer');
                            return opener(buf);
                        };
                        openers.push(boundOpener);
                    }
                });
                if (openers.length == 1) {
                    return openers[0]();
                } else if (openers.length == 0) {
                    throw 'No loadable files found inside ZIP file: ' + filename;
                } else {
                    // TODO: prompt to choose a file
                    throw 'Multiple loadable files found inside ZIP file: ' + filename;
                }
            }
        }
    }

    async openFile(file) {
        const opener = this.getFileOpener(file.name);
        if (opener) {
            const buf = await file.arrayBuffer();
            return opener(buf).catch(err => {alert(err);});
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
        if (typeof(urls) === 'string') {
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
        this.worker.postMessage({
            message: 'setTapeTraps',
            value: val,
        })
        this.emit('setTapeTraps', val);
    }

    playTape() {
        this.worker.postMessage({
            message: 'playTape',
        });
    }
    stopTape() {
        this.worker.postMessage({
            message: 'stopTape',
        });
    }

    exit() {
        this.pause();
        this.worker.terminate();
    }
}
