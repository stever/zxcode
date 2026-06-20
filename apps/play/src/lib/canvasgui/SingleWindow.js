import {PointerEventHandler} from "./PointerEventHandler";
import {Group} from "./Group";
import {ImageManager} from "./ImageManager";

export class SingleWindow extends Group {
    constructor(canvasId) {
        super(null, null, 0, 0, 0, 0);
        this.win = this;

        this.dolog = false;
        this.canvasId = canvasId;

        this.canvas = null;
        this.ctx = null;

        this.outerColor = '#000';
        this.bgColor = '#000';

        // window dimensions
        this.wi = {w: 0, h: 0};
        this.wiw = 0;
        this.wih = 0;

        // world dimensions
        this.wo = {x: 0, y: 0, w: 0, h: 0}

        // target dimensions
        this.dst = {w: 0, h: 0};

        // transform factors
        this.xf = {x: 0, y: 0, w: 1, h: 1}

        // redraw flag
        this.mustRedraw = false;

        // image manager
        this.imagemgr = new ImageManager(this);

        let that = this;
        window.addEventListener('load', function () {
            that._onload();
        });
    }

    _onload() {
        if (this.dolog) console.log("SingleWindow._onload");

        this.canvas = document.getElementById(this.canvasId);

        if (!this.canvas) {
            console.log("SingleWindow._onload: unable to find element with id " + this.canvasId);
            return;
        }

        this.ctx = this.canvas.getContext('2d');

        this._onresize();

        let that = this;
        window.addEventListener('resize', function () {
            that._onresize();
        })

        this._setTouchHandler();
        this._ondraw();
    }

    _onresize() {
        if (this.dolog) console.log("SingleWindow._onresize");

        this.wi.w = this.dst.w;
        this.wi.h = this.dst.h;

        if (this.dolog) console.log("window size: " + this.wi.w + ' x ' + this.wi.h);

        this.canvas.width = this.wi.w;
        this.canvas.height = this.wi.h;

        this.wo.x = 0;
        this.wo.y = 0;
        this.wo.w = this.wi.w;
        this.wo.h = this.wi.h;

        this.xf.x = 0;
        this.xf.y = 0;
        this.xf.w = 1;
        this.xf.h = 1;

        this._ondraw();
    }

    _ondraw() {
        // this._setTransform(0, 0, 1, 1);
        // this.ctx.fillStyle = this.outerColor;
        // this.ctx.fillRect(0, 0, this.wi.w, this.wi.h);

        this._setTransform(this.xf.x, this.xf.y, this.xf.w, this.xf.h);
        this.ctx.fillStyle = this.bgColor;
        this.ctx.fillRect(0, 0, this.wo.w, this.wo.h);

        super.onDraw(this.ctx);
    }

    _setTransform(x, y, w, h) {
        this.ctx.setTransform(w, 0, 0, h, x, y);
    }

    setTargetSize(w, h) {
        this.dst.w = w;
        this.dst.h = h;
    }

    _setTouchHandler() {
        let that = this;
        this._pehandler = new PointerEventHandler(this.canvas);
        this._pehandler.addEventListener(function (e) {
            const wox = (e.x - that.xf.x) / that.xf.w;
            const woy = (e.y - that.xf.y) / that.xf.h;
            that.onPointerEvent(e.pointerId, e.type, wox, woy);
            that.redrawIfRequested();
        });
    }

    requestRedraw() {
        //console.log("redraw requested");
        this.mustRedraw = true;
    }

    redrawIfRequested() {
        if (this.mustRedraw) {
            this._ondraw();
            this.mustRedraw = false;
        }
    }
}
