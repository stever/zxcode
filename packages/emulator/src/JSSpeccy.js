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

import { Emulator } from "./Emulator";

export const JSSpeccy = (container, opts) => {
    // let benchmarkRunCount = 0;
    // let benchmarkRenderCount = 0;
    opts = opts || {};

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    // canvas.style.imageRendering = 'pixelated';

    const emu = new Emulator(canvas, {
        machine: opts.machine || 48,
        autoStart: opts.autoStart || false,
        autoLoadTapes: opts.autoLoadTapes || false,
        tapeAutoLoadMode: opts.tapeAutoLoadMode || 'default',
        openUrl: opts.openUrl,
        tapeTrapsEnabled: ('tapeTrapsEnabled' in opts) ? opts.tapeTrapsEnabled : true,
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

    const machinePentagonItem = machineMenu.addItem('Pentagon 128', () => {
        emu.setMachine(5);
    });

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
            machinePentagonItem.unsetBullet();
        } else if (type == 128) {
            machine48Item.unsetBullet();
            machine128Item.setBullet();
            machinePentagonItem.unsetBullet();
        } else { // pentagon
            machine48Item.unsetBullet();
            machine128Item.unsetBullet();
            machinePentagonItem.setBullet();
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
        openTAPFile: (data) => emu.openTAPFile(data),
        exit: () => exit(),
        hideUI: () => ui.hideUI(),
        showUI: () => ui.showUI(),
        pause: () => emu.pause(),
        start: () => emu.start(),
        reset: () => emu.reset()
    };
};
