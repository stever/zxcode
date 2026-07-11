import React, {useEffect, useRef} from "react";
import {useDispatch, useSelector} from "react-redux";
import {Button} from "primereact/button";
import CodeMirror from "./CodeMirror";
import {setSinclairBasicCode, runSinclairBasic} from "../redux/demo/actions";
import "../lib/syntax/zmakebas";
import "../lib/syntax/nextbas";
import {dashboardLock} from "../dashboard_lock";
import {showLoading} from "../dashboard_loading";
import LineNumbersToggle from "./LineNumbersToggle";
import {Divider} from "primereact/divider";
import {useTranslation} from "@zxplay/i18n";

export function DemoSinclairBasicEditor() {
    const {t} = useTranslation();
    const dispatch = useDispatch();
    const cmRef = useRef(null);
    const code = useSelector(state => state?.demo.sinclairBasicCode);
    const lineNumbers = useSelector((state) => state?.app?.lineNumbers ?? true);
    const machine = useSelector(state => state?.app.machine);

    // Highlight the BASIC dialect that matches the selected machine: NextBASIC
    // on the Next (tokenised by txt2bas), Sinclair BASIC on the 48K/128K.
    const options = {
        mode: machine === 'next' ? 'text/x-nextbas' : 'text/x-zmakebas',
        theme: 'mbo',
        readOnly: false,
        lineWrapping: false,
        lineNumbers: lineNumbers,
        matchBrackets: true,
        tabSize: 4,
        indentAuto: true
    };

    useEffect(() => {
        const cm = cmRef.current.getCodeMirror();
        cm.setValue(code || '');
        // Undo must stop at the loaded content, not the empty pre-load document.
        cm.clearHistory();
        dispatch(setSinclairBasicCode(cm.getValue()))
    }, []);

    useEffect(() => {
        if (cmRef.current) {
            const cm = cmRef.current.getCodeMirror();
            cm.setOption("lineNumbers", lineNumbers);
        }
    }, [lineNumbers]);

    return (
        <>
            <CodeMirror
                ref={cmRef}
                options={options}
                onChange={(cm, _) => dispatch(setSinclairBasicCode(cm.getValue()))}
            />
            <Button
                label={t("actions.play")}
                icon="pi pi-play"
                className="zx-run margin-top-8"
                onClick={() => {
                    dashboardLock();
                    showLoading();
                    dispatch(runSinclairBasic());
                }}
            />
            <Divider
                layout="vertical"
                className="hidden md:inline-flex project-divider ml-4"
            />
            <div className="mt-2 inline-flex project-divider-after">
                <LineNumbersToggle />
            </div>
        </>
    )
}
