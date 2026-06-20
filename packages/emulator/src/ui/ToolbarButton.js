export class ToolbarButton {
    constructor(icon, opts, onClick) {
        this.elem = document.createElement('button');
        this.elem.style.margin = '2px';
        this.setIcon(icon);
        if (opts.label) this.setLabel(opts.label);
        this.elem.addEventListener('click', onClick);
    }

    setIcon(icon) {
        this.elem.innerHTML = icon;
        // The icon markup may be preceded by an XML declaration or whitespace
        // (depending on how the .svg asset was loaded), which would make
        // firstChild a comment/text node. Select the <svg> explicitly and cache
        // it for enable()/disable().
        this.svg = this.elem.querySelector('svg');
        if (this.svg) {
            this.svg.style.height = '20px';
            this.svg.style.verticalAlign = 'middle';
        }
    }

    setLabel(label) {
        this.elem.title = label;
    }

    disable() {
        this.elem.disabled = true;
        if (this.svg) this.svg.style.opacity = '0.5';
    }

    enable() {
        this.elem.disabled = false;
        if (this.svg) this.svg.style.opacity = '1';
    }
}
