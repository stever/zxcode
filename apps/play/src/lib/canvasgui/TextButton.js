import {Control} from "./Control";

export class TextButton extends Control {
    constructor(parent, x, y, w, h, text) {
        super(parent, x, y, w, h);
        this.text = (text ? text : 'button');
    }

    onDraw(ctx) {
        let x = this.x;
        let y = this.y;
        let w = this.w;
        let h = this.h;

        let d = 4;

        const grd = ctx.createLinearGradient(x, y, x, y + h);

        if (this.pressed) {
            grd.addColorStop(1, "#FFF");
            grd.addColorStop(0, "#000");
        } else {
            grd.addColorStop(0, "#FFF");    // gradient with transparent color: not supported
            grd.addColorStop(1, "#000");
        }

        ctx.fillStyle = '#E42';
        ctx.roundRect(x, y, w, h, 2 * d).fill();

        ctx.globalAlpha = 0.5;
        ctx.fillStyle = grd;
        ctx.roundRect(x, y, w, h, 2 * d).fill();

        ctx.globalAlpha = 0.7;
        ctx.fillStyle = '#E42';
        ctx.roundRect(x + d, y + d, w - d - d, h - d - d, d).fill();

        ctx.globalAlpha = 1;
        ctx.font = this.h / 2 + "px Arial";
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#FEA';
        ctx.fillText(this.text, this.x + this.w / 2, this.y + this.h / 2);
    }

    onPointerEvent(type, x, y) {
        super.onPointerEvent(type, x, y);
        //console.log("TextButton.onPointerEvent: type = " + type + ", x = " + x + ", y = " + y + ", text = " + this.text);
    }
}
