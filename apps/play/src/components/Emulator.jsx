import React, {useEffect} from "react";
import PropTypes from "prop-types";
import {useDispatch} from "react-redux";
import {Keyboard} from "./Keyboard";
import {loadEmulator} from "../redux/jsspeccy/actions";

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

    return (
        <>
            <div id="jsspeccy-screen"/>
            <Keyboard width={width}/>
        </>
    )
}
