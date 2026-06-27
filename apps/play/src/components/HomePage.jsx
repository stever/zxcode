import React, {useEffect, useLayoutEffect, useRef, useState} from "react";
import {useDispatch, useSelector} from "react-redux";
import {Toast} from "primereact/toast";
import {Emulator} from "./Emulator";
import {reset, setZoom} from "../redux/jsspeccy/actions";
import {computeLayout} from "../lib/layout";

export default function HomePage() {
    const dispatch = useDispatch();

    const toast = useRef(null);

    const width = useSelector(state => state?.window.width);
    const height = useSelector(state => state?.window.height);
    const isMobile = useSelector(state => state?.window.isMobile);
    const keyConfig = useSelector(state => state?.app.keyConfig);
    const keyboardSide = useSelector(state => state?.app.keyboardSide);

    const [navHeight, setNavHeight] = useState(0);

    // Measure the nav bar so the landscape layout can use the remaining height.
    useLayoutEffect(() => {
        const nav = document.querySelector('.p-menubar');
        setNavHeight(nav ? nav.offsetHeight : 0);
    }, [width, height]);

    const layout = computeLayout({
        width,
        height,
        navHeight,
        kbAspect: keyConfig.aspect,
        side: keyboardSide
    });

    // Size the emulator screen to match the computed layout (fractional zoom).
    useEffect(() => {
        if (layout.screenW > 0) {
            dispatch(setZoom(layout.screenW / 320));
        }
    }, [layout.screenW]);

    useEffect(() => {
        return () => {
            dispatch(reset());
        }
    }, []);

    const isSide = layout.mode === 'side';

    // In side-by-side (landscape) the screen and keyboard are sized to fit the
    // viewport, so lock body scrolling to avoid iOS rubber-banding while playing.
    useEffect(() => {
        if (!isSide) return undefined;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previous;
        };
    }, [isSide]);

    const containerStyle = {
        display: 'flex',
        justifyContent: 'center',
        width: '100%',
        margin: 0,
        ...(isSide
            ? {alignItems: 'center', height: `${Math.max(0, height - navHeight)}px`}
            // Keep the desktop's original top spacing; phones sit flush.
            : {alignItems: 'flex-start', paddingTop: isMobile ? 0 : '8px'})
    };

    return (
        <>
            <Toast ref={toast}/>
            <div style={containerStyle}>
                <Emulator
                    mode={layout.mode}
                    screenW={layout.screenW}
                    screenH={layout.screenH}
                    kbW={layout.kbW}
                    kbH={layout.kbH}
                    side={layout.side}
                    keystr={keyConfig.keystr}
                />
            </div>
        </>
    )
}
