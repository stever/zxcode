import React, { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "primereact/button";
import { ConfirmPopup, confirmPopup } from "primereact/confirmpopup";
import { Tag } from "primereact/tag";
import { Toast } from "primereact/toast";
import CodeMirror from "./CodeMirror";
import "codemirror/mode/z80/z80";
import {
  deleteProject,
  renameProject,
  saveCodeChanges,
  copyProject,
} from "../redux/project/actions";
import { setCode } from "../redux/project/actions";
import { runProjectCode } from "../redux/eightbit/actions";
import "../lib/syntax/pasmo";
import "../lib/syntax/zmac";
import "../lib/syntax/zmakebas";
import "../lib/syntax/z88dk-c";
import "../lib/syntax/sdcc";
import "../lib/syntax/zxbasic";
import { dashboardLock } from "../dashboard_lock";
import clsx from "clsx";
import { Dialog } from "primereact/dialog";
import { InputText } from "primereact/inputtext";
import { Divider } from "primereact/divider";
import ProjectVisibilityToggle from "./ProjectVisibilityToggle";

export function ProjectEditor() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const cmRef = useRef(null);
  const renameInputReference = useRef(null);
  const toast = useRef(null);

  const [renameDialogVisible, setRenameDialogVisible] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectSlug, setNewProjectSlug] = useState("");
  const [copyDialogVisible, setCopyDialogVisible] = useState(false);
  const [copyProjectName, setCopyProjectName] = useState("");

  const lang = useSelector((state) => state?.project.lang);
  const code = useSelector((state) => state?.project.code);
  const savedCode = useSelector((state) => state?.project.savedCode);
  const isMobile = useSelector((state) => state?.window.isMobile);
  const projectName = useSelector((state) => state?.project.title);
  const projectId = useSelector((state) => state?.project.id);
  const isPublic = useSelector((state) => state?.project.isPublic);
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
    case "c":
      mode = "text/x-z88dk-csrc";
      break;
    case "sdcc":
      mode = "text/x-sdcc-csrc";
      break;
    case "zmac":
      mode = "text/x-zmac";
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
    lineNumbers: true,
    matchBrackets: true,
    tabSize: 4,
    indentAuto: true,
  };

  useEffect(() => {
    const cm = cmRef.current.getCodeMirror();
    cm.setValue(code || "");
    dispatch(setCode(cm.getValue()));
  }, []);

  const deleteConfirm = (event) => {
    confirmPopup({
      target: event.currentTarget,
      message: "Are you sure you want to permanently remove this project?",
      icon: "pi pi-exclamation-triangle",
      accept: () => dispatch(deleteProject()),
      reject: () => {},
    });
  };

  const handleCopyProject = () => {
    const newTitle = copyProjectName || `${projectName} (Copy)`;

    // Use the new copyProject action which handles everything
    dispatch(copyProject(newTitle, lang, code));

    if (toast.current) {
      toast.current.show({
        severity: "success",
        summary: "Project Copied",
        detail: `Created "${newTitle}"`,
        life: 3000,
      });
    }

    setCopyDialogVisible(false);
    setCopyProjectName("");
  };

  return (
    <>
      <Toast ref={toast} />
      <CodeMirror
        ref={cmRef}
        options={options}
        onChange={(cm, _) => dispatch(setCode(cm.getValue()))}
      />

      <Button
        label="Play"
        icon="pi pi-play"
        className={clsx("mt-2 mr-2", isMobile && "ml-2")}
        onClick={() => {
          dashboardLock();
          dispatch(runProjectCode());
        }}
      />

      {/* Show Copy button for non-owners (if logged in) */}
      {!isOwner && userId && (
        <Button
          label="Copy"
          icon="pi pi-copy"
          className="p-button-outlined p-button-secondary mt-2 mr-2"
          onClick={() => {
            setCopyProjectName(`${projectName} (Copy)`);
            setCopyDialogVisible(true);
          }}
        />
      )}

      {/* Show Save, Rename, Delete only for owner */}
      {isOwner && (
        <>
          <Button
            label="Save"
            icon="pi pi-save"
            className="p-button-outlined mt-2 mr-2"
            disabled={code === savedCode}
            onClick={() => dispatch(saveCodeChanges())}
          />
          <Button
            label="Rename"
            icon="pi pi-eraser"
            className="p-button-outlined mt-2 mr-2"
            onClick={() => {
              // Always set to current values when opening
              setNewProjectName(projectName || "");
              setNewProjectSlug(projectSlug || "");
              setRenameDialogVisible(true);
              setTimeout(() => renameInputReference.current.focus(), 100);
            }}
          />
          <Button
            label="Delete"
            icon="pi pi-times"
            className="p-button-outlined p-button-danger mt-2 mr-2"
            onClick={(e) => deleteConfirm(e)}
          />
        </>
      )}

      {/* Owner info for non-owned projects */}
      {!isOwner && ownerSlug && (
        <>
          <Divider
            layout="vertical"
            className="hidden md:inline-flex project-divider"
          />
          <div className="inline-flex align-items-center">
            <Tag
              icon="pi pi-user"
              className="tag-user-icon project-divider-after"
            >
              Project by:{" "}
              {ownerProfileIsPublic ? (
                <Link to={`/u/${ownerSlug}`} className="ml-1 text-white">
                  {ownerName || ownerSlug}
                </Link>
              ) : (
                <span className="ml-1">{ownerName || ownerSlug}</span>
              )}
            </Tag>
          </div>
        </>
      )}

      {/* Show visibility toggle only for owner */}
      {isOwner && userId && projectId && (
        <>
          <Divider
            layout="vertical"
            className="hidden md:inline-flex project-divider"
          />
          <div className="mt-2 inline-flex project-divider-after">
            <ProjectVisibilityToggle
              project={{
                project_id: projectId,
                is_public: isPublic,
                slug: projectSlug,
              }}
              userId={userId}
            />
          </div>
        </>
      )}
      <ConfirmPopup />
      <Dialog
        header="Rename Project"
        visible={renameDialogVisible}
        className="editor-dialog-50vw"
        onHide={() => setRenameDialogVisible(false)}
        footer={
          <>
            <Button
              label="Cancel"
              icon="pi pi-times"
              onClick={() => {
                setNewProjectName("");
                setNewProjectSlug("");
                setRenameDialogVisible(false);
              }}
              className="p-button-text"
            />
            <Button
              label="OK"
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
            <label htmlFor="project-name">Project Name</label>
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
            <small id="project-name-help">
              Update or enter text to rename the project.
            </small>
          </div>
          <div className="flex flex-column gap-2">
            <label htmlFor="project-slug">URL Slug</label>
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
            <small id="project-slug-help">
              Optional: Custom URL slug for the project. Leave empty to
              auto-generate from title.
            </small>
          </div>
        </div>
      </Dialog>
      <Dialog
        header="Copy Project"
        visible={copyDialogVisible}
        className="editor-dialog-50vw"
        onHide={() => setCopyDialogVisible(false)}
        footer={
          <>
            <Button
              label="Cancel"
              icon="pi pi-times"
              onClick={() => {
                setCopyProjectName("");
                setCopyDialogVisible(false);
              }}
              className="p-button-text"
            />
            <Button
              label="Copy"
              icon="pi pi-copy"
              onClick={handleCopyProject}
              autoFocus
            />
          </>
        }
      >
        <div className="flex flex-column gap-3">
          <div className="flex flex-column gap-2">
            <label htmlFor="copy-project-name">New Project Name</label>
            <InputText
              id="copy-project-name"
              aria-describedby="copy-project-name-help"
              value={copyProjectName}
              onChange={(e) => setCopyProjectName(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleCopyProject();
                }
              }}
            />
            <small id="copy-project-name-help">
              Enter a name for your copy of this project.
            </small>
          </div>
        </div>
      </Dialog>
    </>
  );
}
