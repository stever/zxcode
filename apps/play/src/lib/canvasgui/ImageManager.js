export class ImageManager {
    constructor(win) {
        this.imgtable = {};
        this.win = win;
    }

    imageForPath(path) {
        if (path in this.imgtable) {
            return this.imgtable[path];
        }

        const img = new Image();
        img.src = path;
        let that = this;

        img.onload = function (e) {
            that.imgtable[path] = img;
            if (that.win.ctx == null) return;
            that.win.requestRedraw();
            that.win.redrawIfRequested();
        }

        return img;
    }
}
