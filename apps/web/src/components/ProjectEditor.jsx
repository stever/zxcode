import React, { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import CodeMirror from "./CodeMirror";
import "codemirror/mode/z80/z80";
import { setCode, setFileContent } from "../redux/project/actions";
import { selectActiveFile } from "../redux/project/selectors";
import { toggleBreakpoint } from "../redux/debugger/actions";
import { joinProjectFilePath, languageSupportsSourceDebug } from "../lib/lang";
import { useTranslation } from "@zxplay/i18n";
import "../lib/syntax/pasmo";
import "../lib/syntax/pasta80";
import "../lib/syntax/sjasmplus";
import "../lib/syntax/zmakebas";
import "../lib/syntax/nextbas";
import "../lib/syntax/z88dk-c";
import "../lib/syntax/zxbasic";

export function ProjectEditor() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const cmRef = useRef(null);

  const lang = useSelector((state) => state?.project.lang);
  const code = useSelector((state) => state?.project.code);
  // The editor buffer follows the active file tab; null means the main
  // source (project.code). Binary assets swap the editor for an info panel.
  const activeFile = useSelector(selectActiveFile);
  const activeFileId = activeFile?.id ?? null;
  // Breakpoints and the source map key files by relative PATH (folder/name,
  // matching the SLD records — sjasmplus stages files under their folders and
  // records the include path); null means the main source.
  const activeFileName = activeFile
    ? joinProjectFilePath(activeFile.folder, activeFile.name)
    : null;
  const activeIsBinary = Boolean(activeFile?.isBinary);
  // The change handler and the mount-time gutter handler need the current
  // active file without re-binding CodeMirror events.
  const activeFileIdRef = useRef(null);
  activeFileIdRef.current = activeFileId;
  const activeFileNameRef = useRef(null);
  activeFileNameRef.current = activeFileName;
  const lineNumbers = useSelector((state) => state?.app?.lineNumbers || false);
  const breakpoints = useSelector((state) => state?.debugger.breakpoints);
  const debugActive = useSelector((state) => state?.debugger.active);
  const pausedLine = useSelector((state) => state?.debugger.pausedLine);
  const pausedFile = useSelector((state) => state?.debugger.pausedFile);
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

  // Only languages with a source map get the breakpoint gutter — a dot the
  // debugger can never arm would just mislead. Lang is fixed for the life of
  // this mount (the page remounts per project), so a static option is safe.
  const sourceDebug = languageSupportsSourceDebug(lang);

  const options = {
    mode,
    theme: "mbo",
    readOnly: false,
    lineWrapping: false,
    lineNumbers: lineNumbers,
    // The breakpoint gutter is present whenever the language supports it, so
    // breakpoints can be set before a debug session starts. The line-numbers
    // gutter is appended implicitly when enabled.
    gutters: sourceDebug ? ["zx-bp-gutter"] : [],
    matchBrackets: true,
    tabSize: 4,
    indentAuto: true,
  };

  useEffect(() => {
    const cm = cmRef.current.getCodeMirror();
    cm.setValue(code || "");
    // Undo must stop at the loaded content, not the empty pre-load document.
    cm.clearHistory();
    // Sync CodeMirror's line-ending normalisation back to the store — but
    // only when it changed something. The editor remounts on every file-tab
    // switch, and an unconditional setCode here would stale the debugger's
    // source map (any setCode marks it stale) and disarm line breakpoints.
    if (cm.getValue() !== (code || "")) {
      dispatch(setCode(cm.getValue()));
    }
    if (sourceDebug) {
      cm.on("gutterClick", (instance, line, gutter) => {
        // Breakpoints carry the file they belong to (null = main source);
        // the SLD map places included files' lines too.
        if (gutter === "zx-bp-gutter") {
          dispatch(toggleBreakpoint(line + 1, activeFileNameRef.current));
        }
      });
    }
  }, []);

  // Swap the editor buffer when the active file changes. setValue doesn't
  // fire the change handler (the wrapper filters origin 'setValue'), so this
  // can't loop back into the store.
  useEffect(() => {
    const cm = cmRef.current?.getCodeMirror();
    if (!cm || activeIsBinary) return;
    const content = (activeFile ? activeFile.content : code) || "";
    if (cm.getValue() !== content) {
      cm.setValue(content);
      // Undo must not cross file boundaries.
      cm.clearHistory();
    }
  }, [activeFileId, activeIsBinary]);

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
    if (!cmRef.current || !sourceDebug) return;
    const cm = cmRef.current.getCodeMirror();
    cm.clearGutter("zx-bp-gutter");
    // Each buffer shows only its own file's dots.
    for (const bp of breakpoints) {
      if (bp.file === activeFileName && bp.line <= cm.lineCount()) {
        const marker = document.createElement("div");
        marker.className = bpsInert ? "zx-bp-marker inert" : "zx-bp-marker";
        marker.textContent = "●";
        cm.setGutterMarker(bp.line - 1, "zx-bp-gutter", marker);
      }
    }
  }, [breakpoints, bpsInert, activeFileName]);

  // Highlight the source line the debugger is paused on and keep it in view.
  useEffect(() => {
    if (!cmRef.current) return;
    const cm = cmRef.current.getCodeMirror();
    if (pausedLineRef.current !== null) {
      cm.removeLineClass(pausedLineRef.current, "background", "debug-paused-line");
      pausedLineRef.current = null;
    }
    // Highlight only when the paused location's file is the one on screen.
    if (
      pausedFile === activeFileName &&
      debugActive &&
      pausedLine &&
      pausedLine <= cm.lineCount()
    ) {
      cm.addLineClass(pausedLine - 1, "background", "debug-paused-line");
      cm.scrollIntoView({ line: pausedLine - 1, ch: 0 }, 40);
      pausedLineRef.current = pausedLine - 1;
    }
  }, [debugActive, pausedLine, pausedFile, activeFileName]);

  // Binary asset size in raw bytes (content is base64).
  const assetSize = activeIsBinary
    ? Math.floor((activeFile.content.length * 3) / 4)
      - (activeFile.content.endsWith("==") ? 2 : activeFile.content.endsWith("=") ? 1 : 0)
    : 0;

  return (
    <>
      {activeIsBinary && (
        <div className="binary-asset-panel">
          <i className="pi pi-box" style={{ fontSize: "2rem" }} />
          <div className="binary-asset-name">{activeFileName}</div>
          <div>{t("editor.files.assetSize", { size: assetSize })}</div>
          <p>{t("editor.files.assetHint")}</p>
        </div>
      )}
      <div style={activeIsBinary ? { display: "none" } : undefined}>
        <CodeMirror
          ref={cmRef}
          options={options}
          onChange={(cm, _) => {
            const fileId = activeFileIdRef.current;
            dispatch(
              fileId === null
                ? setCode(cm.getValue())
                : setFileContent(fileId, cm.getValue())
            );
          }}
        />
      </div>
    </>
  );
}
