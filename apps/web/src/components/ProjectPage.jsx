import React, { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { Titled } from "react-titled";
import { Toast } from "primereact/toast";
import clsx from "clsx";
import { Emulator } from "./Emulator";
import { ProjectFileTabView } from "./ProjectFileTabView";
import { ProjectToolbar } from "./ProjectToolbar";
import { DebuggerDock } from "./debugger/DebuggerDock";
import StarButton from "./StarButton";
import {
  loadProject,
  setSelectedTabIndex,
  setErrorItems,
} from "../redux/project/actions";
import { showToastsForErrorItems } from "../errors";
import { useTranslation } from "@zxplay/i18n";
import { sep } from "../constants";
import {
  computeMode,
  dockSplit,
  editorHeight,
  emulatorBottom,
  panelHeight,
  resolveKeyboard,
  splitEmulator,
  SPLIT_EMU_CHROME,
  tabEmulator,
} from "../lib/layout";
import {
  useChromeAround,
  useDescendantHeight,
  useElementHeight,
  useElementTop,
} from "../lib/usePageMetrics";
import { PROJECT_TAB } from "../lib/projectTabs";

export default function ProjectPage({ projectId }) {
  const { t } = useTranslation();
  const { id } = useParams();
  // Use the prop if provided, otherwise use the param
  const effectiveId = projectId || id;

  const dispatch = useDispatch();

  const userId = useSelector((state) => state?.identity.userId);
  const selectedTabIndex = useSelector(
    (state) => state?.project.selectedTabIndex
  );
  const lang = useSelector((state) => state?.project.lang);
  let title = useSelector((state) => state?.project.title);
  const errorItems = useSelector((state) => state?.project.errorItems);
  const windowWidth = useSelector((state) => state?.window.width);
  const windowHeight = useSelector((state) => state?.window.height);
  const machine = useSelector((state) => state?.app.machine);
  const keyboardLayout = useSelector((state) => state?.app.keyboardLayout);
  const pixelPerfect = useSelector((state) => state?.app.pixelPerfect);
  const debugActive = useSelector((state) => state?.debugger.active);
  // The dock (and the editor-column resize it forces) waits for the session
  // attach: `active` flips in the click's task and that paint must stay
  // cheap. `backend` is set a beat later, once the machine is paused and
  // the first snapshot is in.
  const debugAttached = useSelector(
    (state) => state?.debugger.backend !== null
  );
  const debugStatus = useSelector((state) => state?.debugger.status);
  const debugPausedRing = debugActive && debugStatus === "paused";

  const toast = useRef(null);
  // Measured, not guessed — see usePageMetrics.js. The emulator's own top is
  // what decides its size, so nothing above it (a collapsed nav, a tab strip,
  // the title) has to be predicted; the toolbar's height is what the columns
  // above it give up, and it wraps to a second row at a width that differs per
  // locale; and the gap below the editor is its tab strip's page furniture, the
  // debug dock, and on the home page a Run button.
  const toolbarRef = useRef(null);
  const emuRef = useRef(null);
  const editorColRef = useRef(null);
  const toolbarH = useElementHeight(toolbarRef);
  const emuTop = useElementTop(emuRef);
  const editorColTop = useElementTop(editorColRef);
  const editorChrome = useChromeAround(editorColRef, ".p-tabview", ".CodeMirror");
  // The emulator's header slot is the editor's tab strip, mirrored.
  const headerH = useDescendantHeight(editorColRef, ".p-tabview-nav");

  useEffect(() => {
    dispatch(loadProject(effectiveId));
    return () => {};
  }, [effectiveId, userId]);

  useEffect(() => {
    if (errorItems !== undefined) {
      console.log("[build-errors] ProjectPage errorItems changed", {
        isArray: Array.isArray(errorItems),
        count: errorItems?.length,
        hasToast: Boolean(toast.current),
        items: errorItems,
      });
    }
    if (errorItems && errorItems.length > 0 && toast.current) {
      showToastsForErrorItems(errorItems, toast);
      dispatch(setErrorItems(undefined));
    }

    return () => {};
  }, [errorItems, toast.current]);

  // The Debug tab disappears with the session; step the selection back to
  // the editor if it was showing.
  useEffect(() => {
    if (!debugActive && selectedTabIndex > PROJECT_TAB.editor) {
      dispatch(setSelectedTabIndex(PROJECT_TAB.editor));
    }
  }, [debugActive]);

  if (!effectiveId || !lang) {
    return <></>;
  }

  const mode = computeMode(windowWidth, windowHeight);
  // The 128K and the Next draw their own keyboards, a different shape from
  // the 48K rubber grid, so the machine feeds the layout maths. Asking for no
  // keyboard gives its space to the screen rather than leaving it blank.
  const { aspect: kbAspect, hidden: kbHidden } = resolveKeyboard(
    machine,
    keyboardLayout
  );
  // Both modes size every panel to the height it actually has, so nothing below
  // the nav can push the page into scrolling. The emulator's box runs from
  // where it starts to the bottom of the viewport, less the toolbar spanning
  // the page beneath both columns in split mode.
  const isTab = mode === "tab";
  const emuAvailH = panelHeight({
    viewportH: windowHeight,
    top: emuTop,
    reserveBelow: isTab ? 0 : toolbarH + SPLIT_EMU_CHROME,
  });
  const box = { availH: emuAvailH, kbAspect, hidden: kbHidden, width: windowWidth, pixelPerfect };
  const { emuW, kbW, emuH } = isTab ? tabEmulator(box) : splitEmulator(box);
  // The editor column is levelled with the emulator column beside it, which is
  // what the fixed 770px CodeMirror used to do by construction; in tab mode its
  // panel simply runs to the bottom of the page.
  const columnH = isTab
    ? panelHeight({ viewportH: windowHeight, top: editorColTop })
    : emulatorBottom({ emuTop, emuH }) - editorColTop;
  // The dock's panes give up height before the editor does, since they scroll.
  // What the two share is the column less the editor's own chrome (its tab
  // strip), which is height neither of them can have.
  const { dockH, paneH } = dockSplit(Math.max(0, columnH - editorChrome));
  // Only split mode stacks the dock under the editor; in tab mode it has a tab
  // of its own and takes nothing from the editor's.
  const editorH = editorHeight({
    columnH,
    chrome: editorChrome,
    dockH: !isTab && debugAttached ? dockH : 0,
  });
  const zoom = emuW / 320;
  const className = isTab ? "" : "mx-2 mb-1";
  // The heights the stylesheets read, so the sizing stays one piece of
  // arithmetic here rather than constants spread across two CSS files.
  const heights = {
    "--zx-editor-h": `${editorH}px`,
    "--zx-dock-h": `${dockH}px`,
    "--zx-dock-pane-h": `${paneH}px`,
    ...(headerH ? { "--zx-title-slot": `${headerH}px` } : {}),
  };

  return (
    <Titled title={(s) => `${title} ${sep} ${t("nav.project")} ${sep} ${s}`}>
      <Toast ref={toast} />
      {/* In tab mode the page IS the editor's column, so it carries the ref the
          editor is measured against; split mode puts it on the column itself. */}
      <div
        className={className}
        style={heights}
        ref={isTab ? editorColRef : null}
      >
        {/* One strip, not two: the emulator and the debugger join the project's
            own file tabs rather than sitting in a second strip above them. The
            editor tab is headed by the language, exactly as it was. */}
        {mode === "tab" && (
          <ProjectFileTabView
            fileTabIndex={PROJECT_TAB.editor}
            leadingTabs={[
              {
                key: "emulator",
                tabIndex: PROJECT_TAB.emulator,
                header: t("home.tabEmulator"),
                content: (
                  <div className="flex justify-content-center" ref={emuRef}>
                    <Emulator zoom={zoom} width={emuW} keyboardWidth={kbW}
                              hideKeyboard={kbHidden} />
                  </div>
                ),
              },
            ]}
            trailingTabs={
              debugAttached
                ? [
                    {
                      key: "debug",
                      tabIndex: PROJECT_TAB.debug,
                      header: t("debug.tab"),
                      content: <DebuggerDock />,
                    },
                  ]
                : []
            }
            panelFooter={
              <ProjectToolbar rootRef={toolbarRef} />
            }
          />
        )}
        {mode === "split" && (
          <>
            <div className="grid full-width-grid">
              <div
                className={clsx("col p-0 mr-2", debugAttached && "debug-session")}
                style={{ maxWidth: `calc(100vw - ${emuW + 41}px)` }}
                ref={editorColRef}
              >
                {/* The tab bar is the project's file list: the language-named
                    tab is the main source, one tab per additional file, and a
                    "+" for owners. It tracks activeFileId, not the shared
                    selectedTabIndex (which belongs to tab mode's
                    emulator/editor/debug selector). */}
                <ProjectFileTabView />
                {debugAttached && <DebuggerDock />}
              </div>
              <div
                className={clsx(
                  "col-fixed p-0",
                  debugPausedRing && "debug-paused-ring"
                )}
                style={{ width: `${emuW}px` }}
              >
                {/* The slot sets its own display and alignment (style.css): the
                    title sits on the bottom edge, above the emulator it names. */}
                <div className="zx-title-slot pl-1 justify-content-between">
                  <h3 className="m-0">
                    {title ? t("home.projectLabel", { title }) : ""}
                  </h3>
                  {effectiveId && <StarButton projectId={effectiveId} />}
                </div>
                <div ref={emuRef}>
                  <Emulator zoom={zoom} width={emuW} keyboardWidth={kbW}
                              hideKeyboard={kbHidden} />
                </div>
              </div>
            </div>
            {/* Toolbar spans the full page width, beneath both columns. Its
                measured height is what the columns above give up. */}
            <ProjectToolbar rootRef={toolbarRef} />
          </>
        )}
      </div>
    </Titled>
  );
}
