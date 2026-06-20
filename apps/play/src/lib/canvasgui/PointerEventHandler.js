export class PointerEventHandler {
    constructor(element) {
        this.element = element;

        const that = this;

        this.element.addEventListener('mousedown', function (e) {
            that._onMouseDown(e);
        });

        this.element.addEventListener('mousemove', function (e) {
            that._onMouseMove(e);
        });

        this.element.addEventListener('mouseup', function (e) {
            that._onMouseUp(e);
        });

        this.element.addEventListener('mouseout', function (e) {
            that._onMouseOut(e);
        });

        this.element.addEventListener('touchstart', function (e) {
            that._onTouchStart(e);
        });

        this.element.addEventListener('touchmove', function (e) {
            that._onTouchMove(e);
        });

        this.element.addEventListener('touchend', function (e) {
            that._onTouchEnd(e);
        });

        this.element.addEventListener('touchleave', function (e) {
            that._onTouchLeave(e);
        });

        this.element.addEventListener('touchcancel', function (e) {
            that._onTouchCancel(e);
        });

        this.pointerActive = {};

        this.logEvents = false;
        this.logMoveEvents = false;
        this.logNofityEvent = false;

        this.tbegin = 'begin';
        this.tmove = 'move';
        this.tend = 'end';

        this.pidmouse = 'm';

        this.listeners = [];
    }

    addEventListener(listener) {
        this.listeners.push(listener);
    }

    _notifyEvent(e, type, pointerId) {
        const x = e.pageX - e.target.offsetLeft;
        const y = e.pageY - e.target.offsetTop;

        if (this.logNofityEvent) {
            console.log("notifyEvent: type=" + type + ", pid=" + pointerId + ", x=" + x + ", y=" + y);
        }

        for (let i = 0; i < this.listeners.length; i++) {
            this.listeners[i]({
                type: type,
                pointerId: pointerId,
                x: x,
                y: y,
                originalEvent: e
            });
        }
    }

    _onMouseDown(e) {
        if (this.logEvents) {
            console.log('_onMouseDown');
            console.log(e);
        }

        this.pointerActive[this.pidmouse] = true;
        this._notifyEvent(e, this.tbegin, this.pidmouse);
    }

    _onMouseMove(e) {
        if (this.logMoveEvents) {
            console.log('_onMouseMove');
            console.log(e);
        }

        if (!this.pointerActive[this.pidmouse]) return;
        this._notifyEvent(e, this.tmove, this.pidmouse);
    }

    _onMouseUp(e) {
        if (this.logEvents) {
            console.log('_onMouseUp');
            console.log(e);
        }

        if (!this.pointerActive[this.pidmouse]) return;
        this.pointerActive[this.pidmouse] = false;
        this._notifyEvent(e, this.tend, this.pidmouse);
    }

    _onMouseOut(e) {
        if (this.logEvents) {
            console.log('_onMouseOut');
            console.log(e);
        }

        if (!this.pointerActive[this.pidmouse]) return;
        this.pointerActive[this.pidmouse] = false;
        this._notifyEvent(e, this.tend, this.pidmouse);
    }

    _onTouchStart(e) {
        if (this.logEvents) {
            console.log('_onTouchStart');
            console.log(e);
        }

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            this.pointerActive[touch.identifier] = true;
            this._notifyEvent(touch, this.tbegin, touch.identifier);
        }

        if (e.preventDefault()) {
            e.preventDefault();
        }

        return true;
    }

    _onTouchMove(e) {
        if (this.logMoveEvents) {
            console.log('_onTouchMove');
            console.log(e);
        }

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            this._notifyEvent(touch, this.tmove, touch.identifier);
        }
    }

    _onTouchEnd(e) {
        if (this.logEvents) {
            console.log('_onTouchEnd');
            console.log(e);
        }

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            if (!this.pointerActive[touch.identifier]) return;
            this.pointerActive[touch.identifier] = true;
            this._notifyEvent(touch, this.tend, touch.identifier);
        }
    }

    _onTouchLeave(e) {
        if (this.logEvents) {
            console.log('_onTouchLeave');
            console.log(e);
        }

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            if (!this.pointerActive[touch.identifier]) return;
            this.pointerActive[touch.identifier] = true;
            this._notifyEvent(touch, this.tend, touch.identifier);
        }
    }

    _onTouchCancel(e) {
        if (this.logEvents) {
            console.log('_onTouchCancel');
            console.log(e);
        }

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            if (!this.pointerActive[touch.identifier]) return;
            this.pointerActive[touch.identifier] = true;
            this._notifyEvent(touch, this.tend, touch.identifier);
        }
    }
}
