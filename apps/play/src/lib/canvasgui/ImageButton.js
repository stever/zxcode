import {Control} from "./Control";

export class ImageButton extends Control {
    constructor(parent, x, y, w, h, imgup, imgdown) {
        super(parent, x, y, w, h);
        this.imgup = parent.win.imagemgr.imageForPath(imgup);
        if (imgdown) {
            this.imgdown = parent.win.imagemgr.imageForPath(imgdown);
        } else {
            this.imgdown = null;
        }
    }

    onDraw(ctx) {
        let x = this.x;
        let y = this.y;
        let w = this.w;
        let h = this.h;

        if (this.pressed) {
            if (this.imgdown != null) {
                ctx.drawImage(this.imgdown, x, y, w, h);
            } else {
                ctx.drawImage(this.imgup, x, y, w, h);
                ctx.globalAlpha = 0.5;
                ctx.fillStyle = 'black';
                ctx.fillRect(x, y, w, h);
                ctx.globalAlpha = 1.0;
            }
        } else {
            ctx.drawImage(this.imgup, x, y, w, h);
        }
    }

    onPointerEvent(type, x, y) {
        super.onPointerEvent(type, x, y);
        //console.log("ImageButton.onPointerEvent: type = " + type + ", x = " + x + ", y = " + y + ", text = " + this.text);
    }
}
