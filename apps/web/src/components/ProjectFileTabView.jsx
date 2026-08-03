import React, { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Button } from "primereact/button";
import { Dialog } from "primereact/dialog";
import { InputText } from "primereact/inputtext";
import { Menu } from "primereact/menu";
import { TabPanel, TabView } from "primereact/tabview";
import { Toast } from "primereact/toast";
import { ConfirmPopup, confirmPopup } from "primereact/confirmpopup";
import { ProjectEditor } from "./ProjectEditor";
import {
  addFile,
  deleteFile,
  renameFile,
  setActiveFile,
  setSelectedTabIndex,
} from "../redux/project/actions";
import {stripActiveIndex, stripLayout, stripTarget} from "../lib/projectTabs";
import { selectFiles } from "../redux/project/selectors";
import {
  getLanguageLabel,
  isTextFileName,
  joinProjectFilePath,
  languageSupportsProjectFiles,
  projectFilePathError,
  splitProjectFilePath,
  MAX_FILE_CONTENT_SIZE,
  MAX_PROJECT_FILES,
} from "../lib/lang";
import {
  blankSpriteBase64,
  blankTileBase64,
  isSpriteFileName,
  isTileFileName,
} from "../lib/sprites/spr";
import { defaultPaletteBase64, isPaletteFileName } from "../lib/sprites/pal";
import { defaultMapBase64, isMapFileName } from "../lib/sprites/map";
import { useTranslation } from "@zxplay/i18n";

// The editor TabView: the language-named tab is the project's main source,
// followed by one tab per additional file/asset, plus a "+" header (owners
// only) for adding or uploading files. Each panel hosts the editor bound to
// that file via the store's activeFileId (renderActiveOnly keeps a single
// CodeMirror instance alive).
//
// Tab mode merges the page's own tabs into this one strip rather than stacking
// a second strip above it (see lib/projectTabs.js): leadingTabs carries the
// emulator, trailingTabs the debugger, and panelFooter the toolbar that sits
// under the editor there. Split mode passes none of them, and every expression
// below collapses to the file strip exactly as it was.
//
// Each outer tab is {key, tabIndex, header, content}, where tabIndex is the
// project.selectedTabIndex value that selects it.
export function ProjectFileTabView({
  leadingTabs = [],
  trailingTabs = [],
  fileTabIndex = null,
  panelFooter = null,
}) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const toast = useRef(null);
  const addMenu = useRef(null);
  const uploadInput = useRef(null);
  const nameInputReference = useRef(null);
  const tabViewRef = useRef(null);

  const [nameDialogVisible, setNameDialogVisible] = useState(false);
  // null: the dialog creates a new file; a file id: it renames that file.
  const [nameDialogFileId, setNameDialogFileId] = useState(null);
  const [fileName, setFileName] = useState("");

  const lang = useSelector((state) => state?.project.lang);
  const files = useSelector(selectFiles);
  const activeFileId = useSelector((state) => state?.project.activeFileId);
  const userId = useSelector((state) => state?.identity.userId);
  const ownerId = useSelector((state) => state?.project.ownerId);
  const isOwner = Boolean(userId && ownerId && userId === ownerId);
  const windowWidth = useSelector((state) => state?.window.width);

  // Existing files still render (and can be deleted) even when the language
  // can't use them, e.g. after a project's language stopped supporting files.
  const canAdd =
    isOwner &&
    languageSupportsProjectFiles(lang) &&
    files.length < MAX_PROJECT_FILES;
  const activeFileIndex = files.findIndex((f) => f.id === activeFileId);
  const region = useSelector((state) => state?.project.selectedTabIndex);
  const stripArgs = {
    layout: stripLayout({
      leadingCount: leadingTabs.length,
      fileCount: files.length,
      hasAdd: canAdd,
    }),
    leading: leadingTabs,
    trailing: trailingTabs,
  };
  const activeIndex = stripActiveIndex({...stripArgs, region, activeFileIndex});

  // PrimeReact recomputes the scroll-arrow visibility only inside its own
  // scroll handler (and the forward arrow starts enabled), so adding,
  // deleting or renaming tabs — or resizing the window — leaves stale
  // arrows, e.g. a right arrow lingering after enough tabs were removed
  // that nothing overflows. Nudge the handler with a synthetic scroll
  // whenever the tab set or the layout width changes.
  const tabSetKey = [
    ...leadingTabs.map((tab) => tab.key),
    ...files.map((f) => joinProjectFilePath(f.folder, f.name)),
    ...trailingTabs.map((tab) => tab.key),
  ].join("\n");
  useEffect(() => {
    const nav = tabViewRef.current
      ?.getElement()
      ?.querySelector(".p-tabview-nav-content");
    if (nav) nav.dispatchEvent(new Event("scroll"));
  }, [tabSetKey, canAdd, windowWidth]);

  const showError = (detail) => {
    if (toast.current) {
      toast.current.show({
        severity: "error",
        summary: t("editor.files.title"),
        detail,
        life: 5000,
      });
    }
  };

  const otherPaths = (excludeId) =>
    files
      .filter((f) => f.id !== excludeId)
      .map((f) => joinProjectFilePath(f.folder, f.name));

  const closeNameDialog = () => {
    setNameDialogVisible(false);
    setFileName("");
    setNameDialogFileId(null);
  };

  const submitNameDialog = () => {
    // The single input edits the full "folder/name" path, so renaming and
    // moving between folders are the same gesture.
    const path = fileName.trim();
    const errorKey = projectFilePathError(path, otherPaths(nameDialogFileId));
    if (errorKey) {
      showError(t(errorKey));
      return;
    }
    const { folder, name } = splitProjectFilePath(path);
    if (nameDialogFileId === null) {
      // A new .spr/.pal is born binary with ready-to-edit content (a blank
      // pattern / the hardware default palette), landing straight in its
      // editor rather than a text buffer.
      if (isSpriteFileName(name)) {
        dispatch(addFile(name, blankSpriteBase64(), true, folder));
      } else if (isTileFileName(name)) {
        dispatch(addFile(name, blankTileBase64(), true, folder));
      } else if (isPaletteFileName(name)) {
        dispatch(addFile(name, defaultPaletteBase64(), true, folder));
      } else if (isMapFileName(name)) {
        dispatch(addFile(name, defaultMapBase64(), true, folder));
      } else {
        dispatch(addFile(name, "", false, folder));
      }
    } else {
      dispatch(renameFile(nameDialogFileId, name, folder));
    }
    closeNameDialog();
  };

  const openNameDialog = (fileId, initialName) => {
    setNameDialogFileId(fileId);
    setFileName(initialName);
    setNameDialogVisible(true);
    setTimeout(() => nameInputReference.current?.focus(), 100);
  };

  const handleUpload = (event) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file next time.
    event.target.value = "";
    if (!file) return;

    // Uploads land at the project root (browser File names carry no path).
    const errorKey = projectFilePathError(file.name, otherPaths(null));
    if (errorKey) {
      showError(t(errorKey));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      if (isTextFileName(file.name)) {
        const content = new TextDecoder().decode(bytes);
        if (content.length > MAX_FILE_CONTENT_SIZE) {
          showError(t("editor.files.tooLarge"));
          return;
        }
        dispatch(addFile(file.name, content, false));
      } else {
        let binary = "";
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }
        const content = btoa(binary);
        if (content.length > MAX_FILE_CONTENT_SIZE) {
          showError(t("editor.files.tooLarge"));
          return;
        }
        dispatch(addFile(file.name, content, true));
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const deleteConfirm = (event, file) => {
    confirmPopup({
      target: event.currentTarget,
      message: t("editor.files.deleteConfirm", {
        name: joinProjectFilePath(file.folder, file.name),
      }),
      icon: "pi pi-exclamation-triangle",
      accept: () => dispatch(deleteFile(file.id)),
      reject: () => {},
    });
  };

  const addMenuItems = [
    {
      label: t("editor.files.newFile"),
      icon: "pi pi-file",
      command: () => openNameDialog(null, ""),
    },
    {
      label: t("editor.files.uploadAsset"),
      icon: "pi pi-upload",
      command: () => uploadInput.current?.click(),
    },
  ];

  // A tab header for an additional file: the standard header anatomy plus a
  // binary icon, an unsaved-dot, and rename/delete actions while selected.
  const fileHeaderTemplate = (file) => (options) => (
    <a
      role="tab"
      href="#"
      className={options.className}
      aria-controls={options.ariaControls}
      aria-selected={options.selected}
      tabIndex={0}
      onClick={(e) => {
        e.preventDefault();
        options.onClick(e);
      }}
      onKeyDown={options.onKeyDown}
    >
      {file.isBinary && <i className="pi pi-box mr-1" />}
      <span className={options.titleClassName}>
        {joinProjectFilePath(file.folder, file.name)}
        {file.content !== file.savedContent && " •"}
      </span>
      {isOwner && options.selected && (
        <>
          <i
            className="pi pi-pencil file-tab-action"
            title={t("editor.files.rename")}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              openNameDialog(file.id, joinProjectFilePath(file.folder, file.name));
            }}
          />
          <i
            className="pi pi-times file-tab-action"
            title={t("editor.files.delete")}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              deleteConfirm(e, file);
            }}
          />
        </>
      )}
    </a>
  );

  // The "+" pseudo-tab never activates: its header opens the add menu
  // instead of calling the TabView's own click handler.
  const addHeaderTemplate = (options) => (
    <a
      role="button"
      href="#"
      className={options.className}
      aria-label={t("editor.files.add")}
      tabIndex={0}
      onClick={(e) => {
        e.preventDefault();
        addMenu.current?.toggle(e);
      }}
    >
      <i className="pi pi-plus" />
    </a>
  );

  return (
    <>
      <Toast ref={toast} />
      <ConfirmPopup />
      <TabView
        ref={tabViewRef}
        // Arrow buttons appear at the strip's edges when the tabs overflow
        // (matching the debugger panel's tab bar behaviour).
        scrollable
        activeIndex={activeIndex}
        onTabChange={(e) => {
          const target = stripTarget({...stripArgs, index: e.index});
          // The "+" pseudo-tab never activates (this guards keyboard nav).
          if (target.kind === "add") return;
          if (target.kind === "region") {
            dispatch(setSelectedTabIndex(target.region));
            return;
          }
          dispatch(
            setActiveFile(
              target.fileIndex < 0 ? null : files[target.fileIndex].id
            )
          );
          // Only when the REGION changes: setting it pauses the emulator, so
          // dispatching it on every file-tab click would stop the machine
          // whenever you switch source files.
          if (fileTabIndex !== null && region !== fileTabIndex) {
            dispatch(setSelectedTabIndex(fileTabIndex));
          }
        }}
      >
        {[
          ...leadingTabs.map((tab) => (
            <TabPanel key={tab.key} header={tab.header}>
              {tab.content}
            </TabPanel>
          )),
          <TabPanel key="main" header={getLanguageLabel(lang)}>
            <ProjectEditor />
            {panelFooter}
          </TabPanel>,
          ...files.map((file) => (
            <TabPanel key={file.id} headerTemplate={fileHeaderTemplate(file)}>
              <ProjectEditor />
              {panelFooter}
            </TabPanel>
          )),
          ...(canAdd
            ? [<TabPanel key="add" headerTemplate={addHeaderTemplate} />]
            : []),
          ...trailingTabs.map((tab) => (
            <TabPanel key={tab.key} header={tab.header}>
              {tab.content}
            </TabPanel>
          )),
        ]}
      </TabView>
      {canAdd && (
        <>
          <Menu model={addMenuItems} popup ref={addMenu} />
          <input
            type="file"
            ref={uploadInput}
            style={{ display: "none" }}
            onChange={handleUpload}
          />
        </>
      )}
      <Dialog
        header={
          nameDialogFileId === null
            ? t("editor.files.newFileTitle")
            : t("editor.files.renameTitle")
        }
        visible={nameDialogVisible}
        className="editor-dialog-50vw"
        onHide={closeNameDialog}
        footer={
          <>
            <Button
              label={t("actions.cancel")}
              icon="pi pi-times"
              className="p-button-text"
              onClick={closeNameDialog}
            />
            <Button
              label={t("actions.ok")}
              icon="pi pi-check"
              onClick={submitNameDialog}
              autoFocus
            />
          </>
        }
      >
        <div className="flex flex-column gap-2">
          <label htmlFor="project-file-name">{t("editor.files.fileName")}</label>
          <InputText
            id="project-file-name"
            aria-describedby="project-file-name-help"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                submitNameDialog();
              }
            }}
            ref={nameInputReference}
          />
          <small id="project-file-name-help">
            {t("editor.files.fileNameHelp")}
          </small>
        </div>
      </Dialog>
    </>
  );
}
