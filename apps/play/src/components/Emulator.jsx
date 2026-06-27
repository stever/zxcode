import React, {useEffect} from "react";
import PropTypes from "prop-types";
import {useDispatch, useSelector} from "react-redux";
import {Keyboard} from "./Keyboard";
import Nav from "./Nav";
import {loadEmulator} from "../redux/jsspeccy/actions";

Emulator.propTypes = {
    mode: PropTypes.oneOf(['stacked', 'side']),
    height: PropTypes.number,
    kbW: PropTypes.number,
    kbH: PropTypes.number,
    colW: PropTypes.number,
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

    const {mode, height, kbW, kbH, colW, side, keystr} = props;
    const isSide = mode === 'side';

    // The screen DOM is appended into #jsspeccy-screen once and must stay
    // mounted across layout changes, so it is always the first child here.
    const screen = <div id="jsspeccy-screen" style={{flex: '0 0 auto'}}/>;
    const keyboard = <Keyboard cssWidth={kbW} cssHeight={kbH} keystr={keystr} rounded={!isSide && !isMobile}/>;

    if (isSide) {
        // Screen fills the full height; nav + keyboard share the opposite side.
        return (
            <div className="emulator-flat" style={{
                display: 'flex',
                flexDirection: side === 'left' ? 'row-reverse' : 'row',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                height: height ? `${height}px` : '100vh',
            }}>
                {screen}
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    width: colW ? `${colW}px` : 'auto',
                    height: '100%',
                }}>
                    <Nav compact/>
                    <div style={{
                        flex: '1 1 auto',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minHeight: 0,
                    }}>
                        {keyboard}
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'flex-start',
            width: '100%',
            // Keep the desktop's original top spacing; phones sit flush.
            paddingTop: isMobile ? 0 : '8px',
        }}>
            {screen}
            {keyboard}
        </div>
    )
}
