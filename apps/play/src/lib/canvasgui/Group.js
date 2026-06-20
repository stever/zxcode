import {Widget} from "./Widget";

export class Group extends Widget {
    constructor(win, parent, x, y, w, h) {
        super(parent, x, y, w, h);
        this.win = win;
        this.children = [];
        this.cwrb = {};   // child who received begin
        this.cwrb_entered = {};
    }

    _add(child) {
        this.children.push(child);
    }

    onDraw(ctx) {
        for (let i = 0; i < this.children.length; i++) {
            let child = this.children[i];
            child.onDraw(ctx);
        }
    }

    onPointerEvent(pointerId, type, x, y) {
        //console.log("Group.onPointerEvent: id = " + pointerId + ", type = " + type + ", x = " + x + ", y = " + y);
        let cuc = this._childUnderCursor(x, y);
        if (type == 'begin') {
            if (cuc != null) {
                this.cwrb[pointerId] = cuc;
                cuc.onPointerEvent('begin', x, y);
                this.cwrb_entered[pointerId] = true;
                cuc.onPointerEvent('enter', x, y);
            }
        } else if (type == 'move') {
            if (pointerId in this.cwrb) {
                if (this.cwrb_entered[pointerId]) {
                    if (cuc != this.cwrb[pointerId]) {
                        this.cwrb_entered[pointerId] = false;
                        this.cwrb[pointerId].onPointerEvent('leave', x, y);
                    }
                } else {
                    if (cuc == this.cwrb[pointerId]) {
                        this.cwrb_entered[pointerId] = true;
                        this.cwrb[pointerId].onPointerEvent('enter', x, y);
                    }
                }
            }

            if (cuc != null) {
                cuc.onPointerEvent('move', x, y);
            }
        } else if (type == 'end') {
            if (pointerId in this.cwrb) {
                if (cuc == this.cwrb[pointerId]) {
                    this.cwrb[pointerId].onPointerEvent('leave', x, y);
                }
            }

            if (cuc != null) {
                if (cuc == this.cwrb[pointerId]) {
                    cuc.onPointerEvent('end', x, y);
                }
            }

            delete this.cwrb[pointerId];
            delete this.cwrb_entered[pointerId];
        }
    }

    _childUnderCursor(x, y) {
        for (let i = this.children.length - 1; i >= 0; i--) {
            let child = this.children[i];
            if (child.isPointerInside(x, y)) {
                return child;
            }
        }
        return null;
    }

    requestRedraw() {
        if (this.parent != null) {
            this.parent.requestRedraw();
        }

        else if (this.win != null) {
            this.win.requestRedraw();
        }
    }
}
