import React, { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Link } from "react-router-dom";
import { Button } from "primereact/button";
import { ConfirmPopup, confirmPopup } from "primereact/confirmpopup";
import { Tag } from "primereact/tag";
import { Dialog } from "primereact/dialog";
import { InputText } from "primereact/inputtext";
import {
  deleteProject,
  renameProject,
  saveCodeChanges,
  downloadProjectZip,
} from "../redux/project/actions";
import { selectHasUnsavedChanges } from "../redux/project/selectors";
import { runProjectCode } from "../redux/eightbit/actions";
import { openDebugger, closeDebugger } from "../redux/debugger/actions";
import { dashboardLock } from "../dashboard_lock";
import { showLoading } from "../dashboard_loading";
import clsx from "clsx";
import ProjectVisibilityToggle from "./ProjectVisibilityToggle";
import ProjectMachineToggle from "./ProjectMachineToggle";
import LineNumbersToggle from "./LineNumbersToggle";
import BreakpointGutterToggle from "./BreakpointGutterToggle";
import { useTranslation } from "@zxplay/i18n";

// The action bar beneath the editor/emulator. It is rendered full page width
// (outside the editor column) so the controls span the whole page rather than
// being trapped in the code column — see ProjectPage's split layout.
//
// rootRef measures the bar itself rather than a wrapper: it wraps to a second
// row at narrow widths, and the height it takes is height the panels above it
// have to give up (its own margin included, hence the bar and not a parent).
export function ProjectToolbar({ rootRef = null }) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const renameInputReference = useRef(null);

  const [renameDialogVisible, setRenameDialogVisible] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectSlug, setNewProjectSlug] = useState("");

  const debugActive = useSelector((state) => state?.debugger.active);
  const hasUnsavedChanges = useSelector(selectHasUnsavedChanges);
  const isMobile = useSelector((state) => state?.window.isMobile);
  const projectName = useSelector((state) => state?.project.title);
  const projectId = useSelector((state) => state?.project.id);
  const isPublic = useSelector((state) => state?.project.isPublic);
  const projectMachine = useSelector((state) => state?.project.machine);
  const projectSlug = useSelector((state) => state?.project.slug);
  const userId = useSelector((state) => state?.identity.userId);
  const ownerId = useSelector((state) => state?.project.ownerId);
  const ownerSlug = useSelector((state) => state?.project.ownerSlug);
  const ownerName = useSelector((state) => state?.project.ownerName);
  const ownerProfileIsPublic = useSelector(
    (state) => state?.project.ownerProfileIsPublic
  );

  // Check if current user owns this project
  const isOwner = userId && ownerId && userId === ownerId;

  // Ctrl+S / Cmd+S mirrors the Save button (and suppresses the browser's
  // save-page dialog even when there is nothing to save). Keys aimed at the
  // emulator stay game input: Ctrl is the Spectrum's Symbol Shift there.
  useEffect(() => {
    if (!isOwner) return undefined;
    const handler = (event) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "s"
      ) {
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest("#jsspeccy-screen")
      ) {
        return;
      }
      event.preventDefault();
      if (hasUnsavedChanges) {
        dispatch(saveCodeChanges());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOwner, hasUnsavedChanges]);

  const deleteConfirm = (event) => {
    confirmPopup({
      target: event.currentTarget,
      message: t("editor.deleteConfirm"),
      icon: "pi pi-exclamation-triangle",
      accept: () => dispatch(deleteProject()),
      reject: () => {},
    });
  };

  return (
    <>
      <div className="editor-toolbar mt-2" ref={rootRef}>
        <div className="editor-toolbar-group">
          <Button
            label={t("actions.play")}
            icon="pi pi-play"
            className={clsx("zx-run", isMobile && "ml-2")}
            onClick={() => {
              dashboardLock();
              showLoading();
              dispatch(runProjectCode());
            }}
          />

          <Button
            label={t("debug.debug")}
            icon="pi pi-wrench"
            className={clsx(
              "p-button-warning zx-debug-button",
              debugActive ? "active" : "p-button-outlined"
            )}
            aria-pressed={debugActive ? "true" : "false"}
            onClick={() => {
              dispatch(debugActive ? closeDebugger() : openDebugger());
            }}
          />

          {/* Show Save, Rename, Delete only for owner */}
          {isOwner && (
            <>
              <Button
                label={t("actions.save")}
                icon="pi pi-save"
                className="p-button-outlined"
                disabled={!hasUnsavedChanges}
                onClick={() => dispatch(saveCodeChanges())}
              />
              <Button
                label={t("actions.rename")}
                icon="pi pi-eraser"
                className="p-button-outlined"
                onClick={() => {
                  // Always set to current values when opening
                  setNewProjectName(projectName || "");
                  setNewProjectSlug(projectSlug || "");
                  setRenameDialogVisible(true);
                  setTimeout(() => renameInputReference.current.focus(), 100);
                }}
              />
              <Button
                label={t("editor.downloadZip")}
                icon="pi pi-download"
                className="p-button-outlined"
                onClick={() => dispatch(downloadProjectZip())}
              />
              <Button
                label={t("actions.delete")}
                icon="pi pi-times"
                className="p-button-outlined p-button-danger"
                onClick={(e) => deleteConfirm(e)}
              />
            </>
          )}
        </div>

        <div className="editor-toolbar-group">
          {/* Owner info for non-owned projects */}
          {!isOwner && ownerSlug && (
            <div className="inline-flex">
              <Tag
                icon="pi pi-user"
                className="tag-user-icon"
              >
                {t("editor.projectBy")}{" "}
                {ownerProfileIsPublic ? (
                  <Link to={`/u/${ownerSlug}`} className="ml-1 text-white">
                    {ownerName || ownerSlug}
                  </Link>
                ) : (
                  <span className="ml-1">{ownerName || ownerSlug}</span>
                )}
              </Tag>
            </div>
          )}

          {/* Show visibility toggle only for owner */}
          {isOwner && userId && projectId && (
            <>
              <div className="inline-flex">
                <ProjectVisibilityToggle
                  project={{
                    project_id: projectId,
                    is_public: isPublic,
                    slug: projectSlug,
                  }}
                  userId={userId}
                />
              </div>
              <div className="inline-flex ml-2">
                <ProjectMachineToggle
                  project={{
                    project_id: projectId,
                    machine: projectMachine,
                  }}
                  userId={userId}
                />
              </div>
            </>
          )}

          {/* Editor display toggles for everyone (the breakpoint gutter
              toggle renders nothing unless the debug panel is open for a
              language with source debug) */}
          <div className="inline-flex">
            <LineNumbersToggle iconOnly />
          </div>
          <div className="inline-flex">
            <BreakpointGutterToggle />
          </div>
        </div>
      </div>
      <ConfirmPopup />
      <Dialog
        header={t("editor.renameTitle")}
        visible={renameDialogVisible}
        className="editor-dialog-50vw"
        onHide={() => setRenameDialogVisible(false)}
        footer={
          <>
            <Button
              label={t("actions.cancel")}
              icon="pi pi-times"
              onClick={() => {
                setNewProjectName("");
                setNewProjectSlug("");
                setRenameDialogVisible(false);
              }}
              className="p-button-text"
            />
            <Button
              label={t("actions.ok")}
              icon="pi pi-check"
              onClick={() => {
                dispatch(renameProject(newProjectName, newProjectSlug));
                setNewProjectName("");
                setNewProjectSlug("");
                setRenameDialogVisible(false);
              }}
              autoFocus
            />
          </>
        }
      >
        <div className="flex flex-column gap-3">
          <div className="flex flex-column gap-2">
            <label htmlFor="project-name">{t("editor.projectName")}</label>
            <InputText
              id="project-name"
              aria-describedby="project-name-help"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  dispatch(renameProject(newProjectName, newProjectSlug));
                  setNewProjectName("");
                  setNewProjectSlug("");
                  setRenameDialogVisible(false);
                }
              }}
              ref={renameInputReference}
            />
            <small id="project-name-help">{t("editor.renameNameHelp")}</small>
          </div>
          <div className="flex flex-column gap-2">
            <label htmlFor="project-slug">{t("editor.urlSlug")}</label>
            <InputText
              id="project-slug"
              aria-describedby="project-slug-help"
              value={newProjectSlug}
              onChange={(e) => setNewProjectSlug(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  dispatch(renameProject(newProjectName, newProjectSlug));
                  setNewProjectName("");
                  setNewProjectSlug("");
                  setRenameDialogVisible(false);
                }
              }}
            />
            <small id="project-slug-help">{t("editor.renameSlugHelp")}</small>
          </div>
        </div>
      </Dialog>
    </>
  );
}
