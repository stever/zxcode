import React, { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import CodeMirror from "./CodeMirror";
import "codemirror/mode/z80/z80";
import { setCode } from "../redux/project/actions";
import { toggleBreakpoint } from "../redux/debugger/actions";
import "../lib/syntax/pasmo";
import "../lib/syntax/pasta80";
import "../lib/syntax/sjasmplus";
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
  const breakpoints = useSelector((state) => state?.debugger.breakpoints);
  const debugActive = useSelector((state) => state?.debugger.active);
  const pausedLine = useSelector((state) => state?.debugger.pausedLine);
  const backend = useSelector((state) => state?.debugger.backend);
  const sourceMapLive = useSelector(
    (state) => Boolean(state?.debugger.sourceMap && !state.debugger.sourceMap.stale)
  );
  const pausedLineRef = useRef(null);

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
    case "pascal":
      mode = "text/x-pasta80";
      break;
    case "sjasmplus":
      mode = "text/x-sjasmplus";
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
    // The breakpoint gutter is always present, so breakpoints can be set
    // before a debug session starts. The line-numbers gutter is appended
    // implicitly when enabled.
    gutters: ["zx-bp-gutter"],
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
    cm.on("gutterClick", (instance, line, gutter) => {
      if (gutter === "zx-bp-gutter") {
        dispatch(toggleBreakpoint(line + 1));
      }
    });
  }, []);

  useEffect(() => {
    if (cmRef.current) {
      const cm = cmRef.current.getCodeMirror();
      cm.setOption("lineNumbers", lineNumbers);
    }
  }, [lineNumbers]);

  // Render breakpoint dots into the gutter (breakpoint lines are 1-based).
  // During a real-backend session they dim to hollow when no live source map
  // backs them (none compiled, or the source changed since the compile).
  const bpsInert = debugActive && backend === "zxgo" && !sourceMapLive;
  useEffect(() => {
    if (!cmRef.current) return;
    const cm = cmRef.current.getCodeMirror();
    cm.clearGutter("zx-bp-gutter");
    for (const bp of breakpoints) {
      if (bp.line <= cm.lineCount()) {
        const marker = document.createElement("div");
        marker.className = bpsInert ? "zx-bp-marker inert" : "zx-bp-marker";
        marker.textContent = "●";
        cm.setGutterMarker(bp.line - 1, "zx-bp-gutter", marker);
      }
    }
  }, [breakpoints, bpsInert]);

  // Highlight the source line the debugger is paused on and keep it in view.
  useEffect(() => {
    if (!cmRef.current) return;
    const cm = cmRef.current.getCodeMirror();
    if (pausedLineRef.current !== null) {
      cm.removeLineClass(pausedLineRef.current, "background", "debug-paused-line");
      pausedLineRef.current = null;
    }
    if (debugActive && pausedLine && pausedLine <= cm.lineCount()) {
      cm.addLineClass(pausedLine - 1, "background", "debug-paused-line");
      cm.scrollIntoView({ line: pausedLine - 1, ch: 0 }, 40);
      pausedLineRef.current = pausedLine - 1;
    }
  }, [debugActive, pausedLine]);

  return (
    <CodeMirror
      ref={cmRef}
      options={options}
      onChange={(cm, _) => dispatch(setCode(cm.getValue()))}
    />
  );
}
