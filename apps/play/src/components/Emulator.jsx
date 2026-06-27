import React, {useEffect} from "react";
import PropTypes from "prop-types";
import {useDispatch, useSelector} from "react-redux";
import {Keyboard} from "./Keyboard";
import {loadEmulator} from "../redux/jsspeccy/actions";

Emulator.propTypes = {
    mode: PropTypes.oneOf(['stacked', 'side']),
    screenW: PropTypes.number,
    screenH: PropTypes.number,
    kbW: PropTypes.number,
    kbH: PropTypes.number,
    side: PropTypes.oneOf(['left', 'right']),
    keystr: PropTypes.string
}

export function Emulator(props) {
    const dispatch = useDispatch();
    const isMobile = useSelector(state => state?.window.isMobile);

    useEffect(() => {
        const elem = document.getElementById('jsspeccy-screen');
        dispatch(loadEmulator(elem));
    }, []);

    const {mode, kbW, kbH, side, keystr} = props;
    const isSide = mode === 'side';

    // Stacked: screen above keyboard. Side: beside it, keyboard on the chosen
    // side (right-handed default = keyboard on the right).
    const flexDirection = isSide
        ? (side === 'left' ? 'row-reverse' : 'row')
        : 'column';

    // The rounded "window" chrome only suits a stacked desktop window, not a
    // phone (portrait or landscape). emulator-flat strips the corner radius the
    // .desktop CSS would otherwise apply.
    const rounded = !isSide && !isMobile;

    return (
        <div className={rounded ? undefined : 'emulator-flat'} style={{
            display: 'flex',
            flexDirection,
            alignItems: 'center',
            justifyContent: 'center',
        }}>
            <div id="jsspeccy-screen" style={{flex: '0 0 auto'}}/>
            <Keyboard cssWidth={kbW} cssHeight={kbH} keystr={keystr} rounded={rounded}/>
        </div>
    )
}
