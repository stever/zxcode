import React, { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { Titled } from "react-titled";
import { TabPanel, TabView } from "primereact/tabview";
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
import { getLanguageLabel } from "../lib/lang";
import { useTranslation } from "@zxplay/i18n";
import { sep } from "../constants";
import {
  computeMode,
  resolveKeyboard,
  tabEmulatorWidth,
} from "../lib/layout";

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
    if (!debugActive && selectedTabIndex > 1) {
      dispatch(setSelectedTabIndex(1));
    }
  }, [debugActive]);

  if (!effectiveId || !lang) {
    return <></>;
  }

  const mode = computeMode(windowWidth, windowHeight);
  // The 128K and the Next draw their own keyboards, a different shape from
  // the 48K rubber grid, so the machine feeds the layout maths.
  const kbAspect = resolveKeyboard(machine, keyboardLayout).aspect;
  // Tab mode sizes the emulator to its box (fixing portrait clipping and
  // landscape overflow); split keeps the original 640px (2x) size.
  const emuW =
    mode === "tab"
      ? tabEmulatorWidth({ width: windowWidth, height: windowHeight, kbAspect })
      : 640;
  const zoom = emuW / 320;
  const editorTitle = getLanguageLabel(lang);
  const className = mode === "tab" ? "" : "mx-2 mb-1";

  return (
    <Titled title={(s) => `${title} ${sep} ${t("nav.project")} ${sep} ${s}`}>
      <Toast ref={toast} />
      <div className={className}>
        {mode === "tab" && (
          <TabView
            activeIndex={selectedTabIndex}
            onTabChange={(e) => dispatch(setSelectedTabIndex(e.index))}
          >
            {[
              <TabPanel key="emulator" header={t("home.tabEmulator")}>
                <div className="flex justify-content-center">
                  <Emulator zoom={zoom} width={emuW} />
                </div>
              </TabPanel>,
              <TabPanel key="editor" header={editorTitle}>
                <ProjectFileTabView />
                <ProjectToolbar />
              </TabPanel>,
              ...(debugAttached
                ? [
                    <TabPanel key="debug" header={t("debug.tab")}>
                      <DebuggerDock />
                    </TabPanel>,
                  ]
                : []),
            ]}
          </TabView>
        )}
        {mode === "split" && (
          <>
            <div className="grid full-width-grid">
              <div
                className={clsx("col p-0 mr-2", debugAttached && "debug-session")}
                style={{ maxWidth: `calc(100vw - ${emuW + 41}px` }}
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
                  "col-fixed p-0 pt-1",
                  debugPausedRing && "debug-paused-ring"
                )}
                style={{ width: `${emuW}px` }}
              >
                <div className="height-53 pt-3 pl-1 flex align-items-center justify-content-between">
                  <h3 className="m-0">
                    {title ? t("home.projectLabel", { title }) : ""}
                  </h3>
                  {effectiveId && <StarButton projectId={effectiveId} />}
                </div>
                <Emulator zoom={zoom} width={emuW} />
              </div>
            </div>
            {/* Toolbar spans the full page width, beneath both columns. */}
            <ProjectToolbar />
          </>
        )}
      </div>
    </Titled>
  );
}
