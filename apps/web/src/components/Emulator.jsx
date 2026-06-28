import React, {useEffect} from "react";
import PropTypes from "prop-types";
import {useDispatch} from "react-redux";
import {Keyboard} from "./Keyboard";
import {loadEmulator, setZoom} from "../redux/jsspeccy/actions";

Emulator.propTypes = {
    zoom: PropTypes.number,
    width: PropTypes.number
}

export function Emulator(props) {
    const dispatch = useDispatch();

    const zoom = props.zoom || 3;
    const width = props.width || zoom * 320;

    useEffect(() => {
        const elem = document.getElementById('jsspeccy-screen');
        dispatch(loadEmulator(elem));
    }, []);

    // Keep the screen sized to match the (responsive) keyboard width so the
    // whole emulator fits the viewport on mobile.
    useEffect(() => {
        dispatch(setZoom(width / 320));
    }, [width]);

    return (
        <div className="emulator-frame">
            <div id="jsspeccy-screen"/>
            <Keyboard width={width}/>
        </div>
    )
}
