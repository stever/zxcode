import {ToolbarButton} from "./ToolbarButton";

export class Toolbar {
    constructor(container) {
        this.elem = document.createElement('div');
        this.elem.style.backgroundColor = '#ccc';
        this.elem.style.bottom = '0';
        this.elem.style.width = '100%';
        container.appendChild(this.elem);
        this.currentMouseenterEvent = null;
        this.currentMouseoutEvent = null;
    }

    addButton(icon, opts, onClick) {
        opts = opts || {};
        const button = new ToolbarButton(icon, opts, onClick);
        if (opts.align == 'right') button.elem.style.float = 'right';
        this.elem.appendChild(button.elem);
        return button;
    }

    enterFullscreen() {
        this.elem.style.position = 'absolute';
    }

    exitFullscreen() {
        this.elem.style.position = 'static';
    }

    show() {
        this.elem.style.visibility = 'visible';
        this.elem.style.display = 'block';
    }

    hide() {
        this.elem.style.visibility = 'hidden';
        this.elem.style.display = 'none';
    }

    onmouseenter(e) {
        if (this.currentMouseenterEvent) {
            this.elem.removeEventListener('mouseenter', this.currentMouseenterEvent);
        }

        if (e) {
            this.elem.addEventListener('mouseenter', e);
        }

        this.currentMouseenterEvent = e;
    }

    onmouseout(e) {
        if (this.currentMouseoutEvent) {
            this.elem.removeEventListener('mouseleave', this.currentMouseoutEvent);
        }

        if (e) {
            this.elem.addEventListener('mouseleave', e);
        }

        this.currentMouseoutEvent = e;
    }
}
