import React, { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Button } from "primereact/button";
import CodeMirror from "./CodeMirror";
import { setAssemblyCode, runAssembly } from "../redux/demo/actions";
import "../lib/syntax/pasmo";
import { dashboardLock } from "../dashboard_lock";
import LineNumbersToggle from "./LineNumbersToggle";
import { Divider } from "primereact/divider";

export function DemoAssemblyEditor() {
  const dispatch = useDispatch();
  const cmRef = useRef(null);
  const asmCode = useSelector((state) => state?.demo.asmCode);
  const lineNumbers = useSelector((state) => state?.app?.lineNumbers || false);

  const options = {
    mode: "text/x-pasmo",
    theme: "mbo",
    readOnly: false,
    lineWrapping: false,
    lineNumbers: lineNumbers,
    matchBrackets: true,
    tabSize: 4,
    indentAuto: true,
  };

  useEffect(() => {
    const cm = cmRef.current.getCodeMirror();
    cm.setValue(asmCode || "");
    dispatch(setAssemblyCode(cm.getValue()));
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
        onChange={(cm, _) => dispatch(setAssemblyCode(cm.getValue()))}
      />
      <Button
        label="Play"
        icon="pi pi-play"
        className="margin-top-8"
        onClick={() => {
          dashboardLock();
          dispatch(runAssembly());
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
  );
}
