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
    keystr: PropTypes.string,
    kbLayout: PropTypes.oneOf(['rubber', 'plus', 'next']),
    kbHidden: PropTypes.bool
}

export function Emulator(props) {
    const dispatch = useDispatch();
    const isMobile = useSelector(state => state?.window.isMobile);

    useEffect(() => {
        const elem = document.getElementById('jsspeccy-screen');
        dispatch(loadEmulator(elem));
    }, []);

    const {mode, height, kbW, kbH, colW, side, keystr, kbLayout, kbHidden} = props;
    const isSide = mode === 'side';

    // The emulator's screen DOM is appended into #jsspeccy-screen once
    // (loadEmulator) and is never re-appended, so both modes must render the
    // SAME tree shape - only classNames and styles may differ. A structural
    // difference makes React repurpose or drop the screen div on a mode flip,
    // taking the imperatively-attached canvas with it (#190: rotating a phone
    // to landscape blanked the screen for good).
    // With no keyboard asked for, the wrapper divs stay exactly as they are and
    // only the innermost slot empties, so the screen div keeps its place.
    const screen = <div id="jsspeccy-screen" style={{flex: '0 0 auto'}}/>;
    const keyboard = kbHidden ? null : (
        <Keyboard cssWidth={kbW} cssHeight={kbH} keystr={keystr} layout={kbLayout}
                  rounded={!isSide && !isMobile}/>
    );

    return (
        <div
            className={isSide ? 'emulator-flat' : undefined}
            style={isSide ? {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                height: height ? `${height}px` : '100vh',
            } : {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-start',
                width: '100%',
                // Keep the desktop's original top spacing; phones sit flush.
                paddingTop: isMobile ? 0 : '8px',
            }}
        >
            {/* Side: screen fills the full height; nav + keyboard share the
                opposite side. Stacked: the frame wraps screen + keyboard. */}
            <div
                className={isSide ? undefined : 'emulator-frame'}
                style={isSide ? {
                    display: 'flex',
                    flexDirection: side === 'left' ? 'row-reverse' : 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '100%',
                    height: '100%',
                } : undefined}
            >
                {screen}
                <div style={isSide ? {
                    display: 'flex',
                    flexDirection: 'column',
                    width: colW ? `${colW}px` : 'auto',
                    height: '100%',
                } : undefined}>
                    {isSide && <Nav compact/>}
                    <div style={isSide ? {
                        flex: '1 1 auto',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minHeight: 0,
                    } : undefined}>
                        {keyboard}
                    </div>
                </div>
            </div>
        </div>
    )
}
