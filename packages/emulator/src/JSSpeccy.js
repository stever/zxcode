import fileDialog from 'file-dialog';

import { UIController } from './ui';

import openIcon from './ui/icons/open.svg';
import resetIcon from './ui/icons/reset.svg';
import playIcon from './ui/icons/play.svg';
import pauseIcon from './ui/icons/pause.svg';
import fullscreenIcon from './ui/icons/fullscreen.svg';
import exitFullscreenIcon from './ui/icons/exitfullscreen.svg';
import tapePlayIcon from './ui/icons/tape_play.svg';
import tapePauseIcon from './ui/icons/tape_pause.svg';

import { GoEmulator } from "./zxgo/GoEmulator";

export const JSSpeccy = (container, opts) => {
    opts = opts || {};

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;

    const emu = new GoEmulator(canvas, {
        machine: opts.machine || 48,
        autoStart: opts.autoStart || false,
        autoLoadTapes: opts.autoLoadTapes || false,
        openUrl: opts.openUrl,
        tapeTrapsEnabled: ('tapeTrapsEnabled' in opts) ? opts.tapeTrapsEnabled : true,
        // IDE mode: translate compiled TAPs to run ON the Next.
        tapToNext: opts.tapToNext || false,
        // Joystick interface the host gamepad drives (see the Joystick
        // menu below). Apps pass their persisted choice here.
        joystick: opts.joystick || 'None',
    });

    const ui = new UIController(container, emu, {zoom: opts.zoom || 1, sandbox: opts.sandbox});

    const fileMenu = ui.menuBar.addMenu('File');

    if (!opts.sandbox) {

        fileMenu.addItem('Open...', () => {
            openFileDialog();
        });

        const autoLoadTapesMenuItem = fileMenu.addItem('Auto-load tapes', () => {
            emu.setAutoLoadTapes(!emu.autoLoadTapes);
        });

        const updateAutoLoadTapesCheckbox = () => {
            if (emu.autoLoadTapes) {
                autoLoadTapesMenuItem.setCheckbox();
            } else {
                autoLoadTapesMenuItem.unsetCheckbox();
            }
        }

        emu.on('setAutoLoadTapes', updateAutoLoadTapesCheckbox);

        updateAutoLoadTapesCheckbox();
    }

    const tapeTrapsMenuItem = fileMenu.addItem('Instant tape loading', () => {
        emu.setTapeTraps(!emu.tapeTrapsEnabled);
    });

    const updateTapeTrapsCheckbox = () => {
        if (emu.tapeTrapsEnabled) {
            tapeTrapsMenuItem.setCheckbox();
        } else {
            tapeTrapsMenuItem.unsetCheckbox();
        }
    }

    emu.on('setTapeTraps', updateTapeTrapsCheckbox);
    updateTapeTrapsCheckbox();

    const machineMenu = ui.menuBar.addMenu('Machine');

    const machine48Item = machineMenu.addItem('Spectrum 48K', () => {
        emu.setMachine(48);
    });

    const machine128Item = machineMenu.addItem('Spectrum 128K', () => {
        emu.setMachine(128);
    });

    const machineNextItem = machineMenu.addItem('ZX Spectrum Next', () => {
        emu.setMachine('next');
    });

    // No Joystick menu here: both apps call hideUI() the moment they
    // mount, so anything added to this menu bar is unreachable. The
    // picker belongs in each app's own UI, driven through the
    // setJoystick/onJoystickChange handle below.

    const displayMenu = ui.menuBar.addMenu('Display');

    const zoomItemsBySize = {
        1: displayMenu.addItem('100%', () => ui.setZoom(1)),
        2: displayMenu.addItem('200%', () => ui.setZoom(2)),
        3: displayMenu.addItem('300%', () => ui.setZoom(3)),
    }

    const fullscreenItem = displayMenu.addItem('Fullscreen', () => {
        ui.enterFullscreen();
    })

    const setZoomCheckbox = (factor) => {
        if (factor == 'fullscreen') {
            fullscreenItem.setBullet();
            for (let i in zoomItemsBySize) {
                zoomItemsBySize[i].unsetBullet();
            }
        } else {
            fullscreenItem.unsetBullet();
            for (let i in zoomItemsBySize) {
                if (parseInt(i) == factor) {
                    zoomItemsBySize[i].setBullet();
                } else {
                    zoomItemsBySize[i].unsetBullet();
                }
            }
        }
    }

    ui.on('setZoom', setZoomCheckbox);
    setZoomCheckbox(ui.zoom);

    emu.on('setMachine', (type) => {
        if (type == 48) {
            machine48Item.setBullet();
            machine128Item.unsetBullet();
            machineNextItem.unsetBullet();
        } else if (type == 128) {
            machine48Item.unsetBullet();
            machine128Item.setBullet();
            machineNextItem.unsetBullet();
        } else { // next
            machine48Item.unsetBullet();
            machine128Item.unsetBullet();
            machineNextItem.setBullet();
        }
    });

    if (!opts.sandbox) {
        ui.toolbar.addButton(openIcon, {label: 'Open file'}, () => {
            openFileDialog();
        });
    }

    ui.toolbar.addButton(resetIcon, {label: 'Reset'}, () => {
        emu.reset();
    });

    const pauseButton = ui.toolbar.addButton(playIcon, {label: 'Unpause'}, () => {
        if (emu.isRunning) {
            emu.pause();
        } else {
            emu.start();
        }
    });

    emu.on('pause', () => {
        pauseButton.setIcon(playIcon);
        pauseButton.setLabel('Unpause');
    });

    emu.on('start', () => {
        pauseButton.setIcon(pauseIcon);
        pauseButton.setLabel('Pause');
    });

    const tapeButton = ui.toolbar.addButton(tapePlayIcon, {label: 'Start tape'}, () => {
        if (emu.tapeIsPlaying) {
            emu.stopTape();
        } else {
            emu.playTape();
        }
    });

    tapeButton.disable();

    emu.on('openedTapeFile', () => {
        tapeButton.enable();
    });

    emu.on('playingTape', () => {
        tapeButton.setIcon(tapePauseIcon);
        tapeButton.setLabel('Stop tape');
    });

    emu.on('stoppedTape', () => {
        tapeButton.setIcon(tapePlayIcon);
        tapeButton.setLabel('Start tape');
    });

    const fullscreenButton = ui.toolbar.addButton(
        fullscreenIcon,
        {label: 'Enter full screen mode', align: 'right'},
        () => {
            ui.toggleFullscreen();
        }
    )

    ui.on('setZoom', (factor) => {
        if (factor == 'fullscreen') {
            fullscreenButton.setIcon(exitFullscreenIcon);
            fullscreenButton.setLabel('Exit full screen mode');
        } else {
            fullscreenButton.setIcon(fullscreenIcon);
            fullscreenButton.setLabel('Enter full screen mode');
        }
    });

    const openFileDialog = () => {
        fileDialog().then(files => {
            const file = files[0];
            emu.openFile(file).then(() => {
                emu.start();
            }).catch((err) => {
                alert(err);
            });
        });
    }

    const exit = () => {
        emu.exit();
        ui.unload();
    }

    /*
    const benchmarkElement = document.getElementById('benchmark');
    setInterval(() => {
        benchmarkElement.innerText = (
            "Running at " + benchmarkRunCount + "fps, rendering at "
            + benchmarkRenderCount + "fps"
        );
        benchmarkRunCount = 0;
        benchmarkRenderCount = 0;
    }, 1000)
    */

    return {
        setZoom: (zoom) => ui.setZoom(zoom),
        toggleFullscreen: () => ui.toggleFullscreen(),
        enterFullscreen: () => ui.enterFullscreen(),
        exitFullscreen: () => ui.exitFullscreen(),
        setMachine: (model) => emu.setMachine(model),
        openFileDialog: () => openFileDialog(),
        openUrl: (url) => emu.openUrl(url).catch((err) => {alert(err)}),
        openTAPFile: (data, sdFiles) => emu.openTAPFile(data, sdFiles),
        onMachineChange: (callback) => {
            emu.on('setMachine', callback);
        },
        setJoystick: (type) => emu.setJoystick(type),
        onJoystickChange: (callback) => {
            emu.on('setJoystick', callback);
        },
        onReady: (callback) => {
            if (emu.isReady) {
                callback();
            } else {
                emu.onReadyHandlers.push(callback);
            }
        },
        exit: () => exit(),
        hideUI: () => ui.hideUI(),
        showUI: () => ui.showUI(),
        pause: () => emu.pause(),
        start: () => emu.start(),
        reset: () => emu.reset(),
        // Debugger bridge — see GoEmulator's debug* methods. available()
        // is false until the wasm core (with zxDebug* exports) has loaded.
        debug: {
            available: () => emu.debugAvailable(),
            attach: () => emu.debugAttach(),
            detach: () => emu.debugDetach(),
            cmd: (line) => emu.debugCmd(line),
            state: () => emu.debugState(),
            mem: (addr, len) => emu.debugMem(addr, len),
            disasm: (addr, count) => emu.debugDisasm(addr, count),
            paging: () => emu.debugPaging(),
            stepFrame: () => emu.debugStepFrame(),
            render: () => emu.debugRender(),
            resume: () => emu.debugResume(),
            onPause: (callback) => emu.on('debugpause', callback),
            offPause: (callback) => emu.removeListener('debugpause', callback)
        }
    };
};
