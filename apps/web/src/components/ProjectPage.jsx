import React, { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { Titled } from "react-titled";
import { TabPanel, TabView } from "primereact/tabview";
import { Toast } from "primereact/toast";
import { Emulator } from "./Emulator";
import { ProjectEditor } from "./ProjectEditor";
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
  currentKeystr,
  keyboardAspect,
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

  const toast = useRef(null);

  useEffect(() => {
    dispatch(loadProject(effectiveId));
    return () => {};
  }, [effectiveId, userId]);

  useEffect(() => {
    if (errorItems && errorItems.length > 0 && toast.current) {
      showToastsForErrorItems(errorItems, toast);
      dispatch(setErrorItems(undefined));
    }

    return () => {};
  }, [errorItems, toast.current]);

  if (!effectiveId || !lang) {
    return <></>;
  }

  const mode = computeMode(windowWidth, windowHeight);
  const kbAspect = keyboardAspect(currentKeystr());
  // Tab mode sizes the emulator to its box (fixing portrait clipping and
  // landscape overflow); split keeps the original 640px (2x) size.
  const emuW =
    mode === "tab"
      ? tabEmulatorWidth({ width: windowWidth, height: windowHeight, kbAspect })
      : 640;
  const zoom = emuW / 320;
  const editorTitle = getLanguageLabel(lang);
  const className = mode === "tab" ? "" : "mx-2 my-1";

  return (
    <Titled title={(s) => `${title} ${sep} ${t("nav.project")} ${sep} ${s}`}>
      <Toast ref={toast} />
      <div className={className}>
        {mode === "tab" && (
          <TabView
            activeIndex={selectedTabIndex}
            onTabChange={(e) => dispatch(setSelectedTabIndex(e.index))}
          >
            <TabPanel header={t("home.tabEmulator")}>
              <div className="flex justify-content-center">
                <Emulator zoom={zoom} width={emuW} />
              </div>
            </TabPanel>
            <TabPanel header={editorTitle}>
              <ProjectEditor id={effectiveId} />
            </TabPanel>
          </TabView>
        )}
        {mode === "split" && (
          <div className="grid full-width-grid">
            <div
              className="col p-0 mr-2"
              style={{ maxWidth: `calc(100vw - ${emuW + 41}px` }}
            >
              <TabView
                activeIndex={selectedTabIndex}
                onTabChange={(e) => dispatch(setSelectedTabIndex(e.index))}
              >
                <TabPanel header={editorTitle}>
                  <ProjectEditor id={effectiveId} />
                </TabPanel>
              </TabView>
            </div>
            <div
              className="col-fixed p-0 pt-1"
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
        )}
      </div>
    </Titled>
  );
}
