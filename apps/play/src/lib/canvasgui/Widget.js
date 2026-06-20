export class Widget {
    constructor(parent, x, y, w, h) {
        this.parent = parent;
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;

        if (this.parent)
            this.parent._add(this);
    }

    requestRedraw() {
        if (this.parent != null)
            this.parent.requestRedraw();
    }

    isPointerInside(x, y) {
        if (x < this.x) return false;
        if (y < this.y) return false;
        if (x > this.x + this.w) return false;
        if (y > this.y + this.h) return false;
        return true;
    }
}
