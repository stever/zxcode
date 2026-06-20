import {Widget} from "./Widget";

export class Control extends Widget {
    constructor(parent, x, y, w, h) {
        super(parent, x, y, w, h);
        this.disabled = false;
        this.pressed = false;
        this.checked = false;
        this.rcvd_begin = false;
        this.on_begin = null;
        this.on_enter = null;
        this.on_leave = null;
        this.on_end = null;
    }

    onPointerEvent(type, x, y) {
        if (this.disabled) {
            return;
        }

        if (type == 'begin') {
            this.rcvd_begin = true;
            if (this.on_begin) this.on_begin();
            return;
        }

        if (this.rcvd_begin) {
            if (type == 'enter') {
                this.pressed = true;
                this.requestRedraw();
                if (this.on_enter) this.on_enter();
                return;
            }

            if (type == 'leave') {
                this.pressed = false;
                this.requestRedraw();
                if (this.on_leave) this.on_leave();
                return;
            }

            if (type == 'end') {
                if (this.on_end) this.on_end.call(this);
                return;
            }
        }
    }
}
