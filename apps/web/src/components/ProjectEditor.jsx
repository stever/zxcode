import React, { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import CodeMirror from "./CodeMirror";
import "codemirror/mode/z80/z80";
import { setCode } from "../redux/project/actions";
import "../lib/syntax/pasmo";
import "../lib/syntax/zmakebas";
import "../lib/syntax/nextbas";
import "../lib/syntax/z88dk-c";
import "../lib/syntax/zxbasic";

export function ProjectEditor() {
  const dispatch = useDispatch();
  const cmRef = useRef(null);

  const lang = useSelector((state) => state?.project.lang);
  const code = useSelector((state) => state?.project.code);
  const lineNumbers = useSelector((state) => state?.app?.lineNumbers || false);

  let mode;
  switch (lang) {
    case "asm":
      mode = "text/x-pasmo";
      break;
    case "basic":
      mode = "text/x-zmakebas";
      break;
    case "bas2tap":
      mode = "text/x-zmakebas";
      break;
    case "nextbas":
      mode = "text/x-nextbas";
      break;
    case "c":
      mode = "text/x-z88dk-csrc";
      break;
    case "sdcc":
      mode = "text/x-z88dk-csrc";
      break;
    case "sjasmplus":
      mode = "text/x-pasmo";
      break;
    case "zmac":
      mode = "text/x-pasmo";
      break;
    case "zxbasic":
      mode = "text/x-zxbasic";
      break;
    default:
      throw `unexpected case: ${lang}`;
  }

  const options = {
    mode,
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
    cm.setValue(code || "");
    // Undo must stop at the loaded content, not the empty pre-load document.
    cm.clearHistory();
    dispatch(setCode(cm.getValue()));
  }, []);

  useEffect(() => {
    if (cmRef.current) {
      const cm = cmRef.current.getCodeMirror();
      cm.setOption("lineNumbers", lineNumbers);
    }
  }, [lineNumbers]);

  return (
    <CodeMirror
      ref={cmRef}
      options={options}
      onChange={(cm, _) => dispatch(setCode(cm.getValue()))}
    />
  );
}
