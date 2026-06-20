import EventEmitter from "events";
import {MenuBar} from "./MenuBar";
import {Toolbar} from "./Toolbar";
import closeIcon from "./icons/close.svg";
import powerIcon from "./icons/power.svg";

export class UIController extends EventEmitter {
    constructor(container, emulator, opts) {
        super();
        this.canvas = emulator.canvas;

        /* build UI elements */
        this.dialog = document.createElement('div');
        this.dialog.style.display = 'none';
        container.appendChild(this.dialog);
        const dialogCloseButton = document.createElement('button');
        dialogCloseButton.innerHTML = closeIcon;
        dialogCloseButton.style.float = 'right';
        dialogCloseButton.style.border = 'none';
        // Select the <svg> rather than firstChild, which may be an XML
        // declaration/whitespace node depending on how the .svg was loaded.
        const closeSvg = dialogCloseButton.querySelector('svg');
        if (closeSvg) {
            closeSvg.style.height = '20px';
            closeSvg.style.verticalAlign = 'middle';
        }
        this.dialog.appendChild(dialogCloseButton);
        dialogCloseButton.addEventListener('click', () => {
            this.hideDialog();
        })

        this.dialogBody = document.createElement('div');
        this.dialogBody.style.clear = 'both';
        this.dialog.appendChild(this.dialogBody);

        this.appContainer = document.createElement('div');
        container.appendChild(this.appContainer);
        this.appContainer.style.position = 'relative';

        this.menuBar = new MenuBar(this.appContainer);
        this.appContainer.appendChild(this.canvas);
        this.canvas.style.objectFit = 'contain';
        this.canvas.style.display = 'block';

        this.toolbar = new Toolbar(this.appContainer);

        this.startButton = document.createElement('button');
        this.startButton.innerHTML = powerIcon;
        this.appContainer.appendChild(this.startButton);
        this.startButton.style.position = 'absolute';
        this.startButton.style.top = '50%';
        this.startButton.style.left = '50%';
        this.startButton.style.width = '192px';
        this.startButton.style.height = '128px';
        this.startButton.style.marginLeft = '-96px';
        this.startButton.style.marginTop = '-64px';
        this.startButton.style.backgroundColor = 'rgba(160, 160, 160, 0.7)';
        this.startButton.style.border = 'none';
        this.startButton.style.borderRadius = '4px';
        const startSvg = this.startButton.querySelector('svg');
        if (startSvg) {
            startSvg.style.height = '56px';
            startSvg.style.verticalAlign = 'middle';
        }

        this.startButton.addEventListener('mouseenter', () => {
            this.startButton.style.backgroundColor = 'rgba(128, 128, 128, 0.7)';
        });

        this.startButton.addEventListener('mouseleave', () => {
            this.startButton.style.backgroundColor = 'rgba(160, 160, 160, 0.7)';
        });

        this.startButton.addEventListener('click', (e) => {
            emulator.start();
        });

        emulator.on('start', () => {
            this.startButton.style.display = 'none';
        });

        emulator.on('pause', () => {
            this.startButton.style.display = 'block';
        });

        /* variables for tracking zoom / fullscreen state */
        this.zoom = null;
        this.isFullscreen = false;
        this.uiIsHidden = false;
        this.allowUIHiding = true;
        this.hideUITimeout = null;
        this.ignoreNextMouseMove = false;

        /* state changes when entering / exiting fullscreen */
        const fullscreenMouseMove = () => {
            if (this.ignoreNextMouseMove) {
                this.ignoreNextMouseMove = false;
                return;
            }

            this.showUI();

            if (this.hideUITimeout) clearTimeout(this.hideUITimeout);
            this.hideUITimeout = setTimeout(() => {this.hideUI();}, 3000);
        }

        this.appContainer.addEventListener('fullscreenchange', () => {
            if (document.fullscreenElement) {
                this.isFullscreen = true;
                this.canvas.style.width = '100%';
                this.canvas.style.height = '100%';
                document.addEventListener('mousemove', fullscreenMouseMove);
                /* a bogus mousemove event is emitted on entering fullscreen, so ignore it */
                this.ignoreNextMouseMove = true;

                this.menuBar.enterFullscreen();
                this.menuBar.onmouseenter(() => {this.allowUIHiding = false;});
                this.menuBar.onmouseout(() => {this.allowUIHiding = true;});

                this.toolbar.enterFullscreen();
                this.toolbar.onmouseenter(() => {this.allowUIHiding = false;});
                this.toolbar.onmouseout(() => {this.allowUIHiding = true;});

                this.hideUI();
                this.emit('setZoom', 'fullscreen');
            } else {
                this.isFullscreen = false;
                if (this.hideUITimeout) clearTimeout(this.hideUITimeout);
                this.showUI();

                this.menuBar.exitFullscreen();
                this.menuBar.onmouseenter(null);
                this.menuBar.onmouseout(null);

                this.toolbar.exitFullscreen();
                this.toolbar.onmouseenter(null);
                this.toolbar.onmouseout(null);

                document.removeEventListener('mousemove', fullscreenMouseMove);
                this.setZoom(this.zoom);
            }
        })

        this.setZoom(opts.zoom || 1);

        if (!opts.sandbox) {
            /* drag-and-drop for loading files */
            this.appContainer.addEventListener('drop', (ev) => {
                ev.preventDefault();
                let loadList = Promise.resolve();
                if (ev.dataTransfer.items) {
                    // Use DataTransferItemList interface to access the file(s)
                    for (const item of ev.dataTransfer.items) {
                        // If dropped items aren't files, reject them
                        if (item.kind === 'file') {
                            const file = item.getAsFile();
                            loadList = loadList.then(() => {
                                emulator.openFile(file);
                            });
                        }
                    }
                } else {
                    // Use DataTransfer interface to access the file(s)
                    for (const file of ev.dataTransfer.files) {
                        loadList = loadList.then(() => {
                            emulator.openFile(file);
                        });
                    }
                }
                loadList.then(() => {
                    if (emulator.isInitiallyPaused) emulator.start();
                })
            });
            this.appContainer.addEventListener('dragover', (ev) => {
                ev.preventDefault();
            });
        }
    }

    setZoom(factor) {
        this.zoom = factor;

        if (this.isFullscreen) {
            document.exitFullscreen();
            return;  // setZoom will be retriggered once fullscreen has exited
        }

        const displayWidth = 320 * this.zoom;
        const displayHeight = 240 * this.zoom;
        this.canvas.style.width = '' + displayWidth + 'px';
        this.canvas.style.height = '' + displayHeight + 'px';
        this.appContainer.style.width = '' + displayWidth + 'px';
        this.emit('setZoom', factor);
    }

    enterFullscreen() {
        this.appContainer.requestFullscreen();
    }

    exitFullscreen() {
        if (this.isFullscreen) {
            document.exitFullscreen();
        }
    }

    toggleFullscreen() {
        if (this.isFullscreen) {
            this.exitFullscreen();
        } else {
            this.enterFullscreen();
        }
    }

    hideUI() {
        if (this.allowUIHiding && !this.uiIsHidden) {
            this.uiIsHidden = true;
            this.menuBar.hide();
            this.toolbar.hide();
        }
    }

    showUI() {
        if (this.uiIsHidden) {
            this.uiIsHidden = false;
            // this.menuBar.show();
            // this.toolbar.show();
        }
    }

    showDialog() {
        this.dialog.style.display = 'block';
        this.dialog.style.position = 'absolute';
        this.dialog.style.backgroundColor = '#eee';
        this.dialog.style.zIndex = '100';
        this.dialog.style.width = '75%';
        this.dialog.style.height = '80%';
        this.dialog.style.left = '12%';
        this.dialog.style.top = '10%';
        this.dialog.style.overflow = 'scroll';  // TODO: less hacky scrolling that doesn't hide the close button
        this.dialogBody.style.paddingLeft = '8px';
        this.dialogBody.style.paddingRight = '8px';
        this.dialogBody.style.paddingBottom = '8px';
        return this.dialogBody;
    }

    hideDialog() {
        this.dialog.style.display = 'none';
        this.dialogBody.innerHTML = '';
    }

    unload() {
        this.dialog.remove();
        this.appContainer.remove();
    }
}
