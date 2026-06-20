import React, {useEffect, useRef} from "react";
import {useDispatch, useSelector} from "react-redux";
import {Toast} from "primereact/toast";
import {Emulator} from "./Emulator";
import {reset} from "../redux/jsspeccy/actions";
import clsx from "clsx";

export default function HomePage() {
    const dispatch = useDispatch();

    const toast = useRef(null);

    const isMobile = useSelector(state => state?.window.isMobile);
    const className = clsx('col-fixed p-0', !isMobile && 'pt-2');

    const zoom = 2;
    const width = zoom * 320;

    useEffect(() => {
        return () => {
            dispatch(reset());
        }
    }, []);

    return (
        <>
            <Toast ref={toast}/>
            <div className="grid" style={{width: "100%", padding: 0, margin: 0}}>
                <div className="col" style={{padding: 0}}>

                </div>
                <div className={className} style={{width: `${width}px`}}>
                    <Emulator zoom={zoom} width={width}/>
                </div>
                <div className="col" style={{padding: 0}}>

                </div>
            </div>
        </>
    )
}
