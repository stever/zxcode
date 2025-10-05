import React, {useEffect, useRef} from "react";
import {useDispatch, useSelector} from "react-redux";
import {Button} from "primereact/button";
import CodeMirror from "./CodeMirror";
import {setSinclairBasicCode, runSinclairBasic} from "../redux/demo/actions";
import "../lib/syntax/zmakebas";
import {dashboardLock} from "../dashboard_lock";

export function DemoSinclairBasicEditor() {
    const dispatch = useDispatch();
    const cmRef = useRef(null);
    const code = useSelector(state => state?.demo.sinclairBasicCode);

    const options = {
        mode: 'text/x-zmakebas',
        theme: 'mbo',
        readOnly: false,
        lineWrapping: false,
        lineNumbers: true,
        matchBrackets: true,
        tabSize: 4,
        indentAuto: true
    };

    useEffect(() => {
        const cm = cmRef.current.getCodeMirror();
        cm.setValue(code || '');
        dispatch(setSinclairBasicCode(cm.getValue()))
    }, []);

    return (
        <>
            <CodeMirror
                ref={cmRef}
                options={options}
                onChange={(cm, _) => dispatch(setSinclairBasicCode(cm.getValue()))}
            />
            <Button
                label="Play"
                icon="pi pi-play"
                className="margin-top-8"
                onClick={() => {
                    dashboardLock();
                    dispatch(runSinclairBasic());
                }}
            />
        </>
    )
}
