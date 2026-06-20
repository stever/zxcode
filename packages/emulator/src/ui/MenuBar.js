import {Menu} from "./Menu";

export class MenuBar {
    constructor(container) {
        this.elem = document.createElement('div');
        this.elem.style.display = 'flow-root';
        this.elem.style.backgroundColor = '#eee';
        this.elem.style.fontFamily = 'Arial, Helvetica, sans-serif';
        this.elem.style.top = '0';
        this.elem.style.width = '100%';
        container.appendChild(this.elem);
        this.currentMouseenterEvent = null;
        this.currentMouseoutEvent = null;
    }

    addMenu(title) {
        return new Menu(this.elem, title);
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
