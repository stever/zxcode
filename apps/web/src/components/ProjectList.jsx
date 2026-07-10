import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Link } from "react-router-dom";
import { formatDistance } from "date-fns";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import { Button } from "primereact/button";
import { ConfirmDialog, confirmDialog } from "primereact/confirmdialog";
import { Dialog } from "primereact/dialog";
import { Dropdown } from "primereact/dropdown";
import { InputText } from "primereact/inputtext";
import { Menu } from "primereact/menu";
import { Paginator } from "primereact/paginator";
import { ProgressSpinner } from "primereact/progressspinner";
import ProjectCard from "./ProjectCard";
import {
  subscribeToProjectList,
  unsubscribeFromProjectList,
  setProjectListPreferences,
  renameListProject,
  copyListProject,
  deleteListProject,
} from "../redux/projectList/actions";
import { getLanguageLabel } from "../lib/lang";
import { useTranslation, useDateFnsLocale } from "@zxplay/i18n";

// Sort choices offered in grid view, encoded as "field:order" so the same
// preference drives the table's column sort. Table-only sorts (e.g. by
// compiler) simply aren't representable here and fall back to the default.
const DEFAULT_SORT = "updated_at:-1";

function sortProjects(projects, sortKey) {
  const [field, orderStr] = sortKey.split(":");
  const order = Number(orderStr);
  const sorted = [...projects];
  sorted.sort((a, b) => {
    let cmp;
    if (field === "title" || field === "lang_title") {
      cmp = (a[field] || "").localeCompare(b[field] || "", undefined, {
        sensitivity: "base",
      });
    } else {
      cmp = (Date.parse(a[field]) || 0) - (Date.parse(b[field]) || 0);
    }
    return cmp * order;
  });
  return sorted;
}

export default function ProjectList() {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();
  const dispatch = useDispatch();

  const projects = useSelector((state) => state?.projectList.projectList);
  const isMobile = useSelector((state) => state?.window.isMobile);
  const userSlug = useSelector((state) => state?.identity.userSlug);

  // Get preferences from Redux store
  const storedRowsPerPage =
    useSelector((state) => state?.projectList.rowsPerPage) || 10;
  const storedCurrentPage =
    useSelector((state) => state?.projectList.currentPage) || 0;
  const storedSortField = useSelector((state) => state?.projectList.sortField);
  const storedSortOrder = useSelector((state) => state?.projectList.sortOrder);
  const viewMode =
    useSelector((state) => state?.projectList.viewMode) || "grid";

  const [first, setFirst] = useState(storedCurrentPage);
  const [rows, setRows] = useState(storedRowsPerPage);
  const [sortField, setSortField] = useState(storedSortField);
  const [sortOrder, setSortOrder] = useState(storedSortOrder);
  const [query, setQuery] = useState("");
  const [langFilter, setLangFilter] = useState(null);

  // One popup menu shared by every card/row; menuProject is the project it
  // was opened for. The dialogs likewise hold their target project.
  const menuRef = useRef(null);
  const [menuProject, setMenuProject] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameName, setRenameName] = useState("");
  const [renameSlug, setRenameSlug] = useState("");
  const [copyTarget, setCopyTarget] = useState(null);
  const [copyName, setCopyName] = useState("");

  // Update local state when Redux state changes (e.g., from localStorage on mount)
  useEffect(() => {
    setFirst(storedCurrentPage);
    setRows(storedRowsPerPage);
    setSortField(storedSortField);
    setSortOrder(storedSortOrder);
  }, [storedCurrentPage, storedRowsPerPage, storedSortField, storedSortOrder]);

  useEffect(() => {
    dispatch(subscribeToProjectList());
    return () => {
      dispatch(unsubscribeFromProjectList());
    };
  }, [dispatch]);

  // A narrower result set can strand the saved page offset past the end;
  // jump back to the first page whenever the filters change.
  useEffect(() => {
    setFirst(0);
  }, [query, langFilter]);

  const sortOptions = [
    { label: t("projectList.sortUpdated"), value: "updated_at:-1" },
    { label: t("projectList.sortCreated"), value: "created_at:-1" },
    { label: t("projectList.sortOldest"), value: "created_at:1" },
    { label: t("projectList.sortTitleAz"), value: "title:1" },
    { label: t("projectList.sortTitleZa"), value: "title:-1" },
  ];

  const sortKey = `${sortField}:${sortOrder}`;
  const gridSortKey = sortOptions.some((o) => o.value === sortKey)
    ? sortKey
    : DEFAULT_SORT;

  // The subscription result is shared state; derive display rows (with the
  // compiler label added for sorting) instead of mutating it.
  const langOptions = useMemo(() => {
    if (!projects) return [];
    const langs = [...new Set(projects.map((p) => p.lang))];
    return langs
      .map((lang) => ({ label: getLanguageLabel(lang), value: lang }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [projects]);

  const filtered = useMemo(() => {
    if (!projects) return [];
    const q = query.trim().toLowerCase();
    return projects
      .map((p) => ({ ...p, lang_title: getLanguageLabel(p.lang) }))
      .filter(
        (p) =>
          (!q || p.title.toLowerCase().includes(q)) &&
          (!langFilter || p.lang === langFilter)
      );
  }, [projects, query, langFilter]);

  const gridSorted = useMemo(
    () => sortProjects(filtered, gridSortKey),
    [filtered, gridSortKey]
  );

  function projectUrl(data) {
    // Use slug-based URL if both user and project slugs are available
    return userSlug && data["slug"]
      ? `/u/${userSlug}/${data["slug"]}`
      : `/projects/${data["project_id"]}`;
  }

  function formatLinkName(data) {
    return <Link to={projectUrl(data)}>{data["title"]}</Link>;
  }

  const now = new Date();

  function formatCreated(data) {
    const date = new Date(data["created_at"]);
    return formatDistance(date, now, { addSuffix: true, locale });
  }

  function formatUpdated(data) {
    const date = new Date(data["updated_at"]);
    return formatDistance(date, now, { addSuffix: true, locale });
  }

  const onPage = (event) => {
    setFirst(event.first);
    setRows(event.rows);
    // Save preferences to Redux
    dispatch(
      setProjectListPreferences({
        currentPage: event.first,
        rowsPerPage: event.rows,
      })
    );
  };

  const onSort = (event) => {
    setSortField(event.sortField);
    setSortOrder(event.sortOrder);
    // Save preferences to Redux
    dispatch(
      setProjectListPreferences({
        sortField: event.sortField,
        sortOrder: event.sortOrder,
      })
    );
  };

  const onGridSortChange = (e) => {
    const [field, orderStr] = e.value.split(":");
    onSort({ sortField: field, sortOrder: Number(orderStr) });
  };

  const setViewMode = (mode) => {
    dispatch(setProjectListPreferences({ viewMode: mode }));
  };

  const openMenu = (e, project) => {
    setMenuProject(project);
    menuRef.current.show(e);
  };

  const confirmDelete = (project) => {
    confirmDialog({
      message: t("editor.deleteConfirm"),
      header: t("actions.delete"),
      icon: "pi pi-exclamation-triangle",
      acceptClassName: "p-button-danger",
      accept: () => dispatch(deleteListProject(project.project_id)),
    });
  };

  const menuItems = [
    {
      label: t("actions.rename"),
      icon: "pi pi-eraser",
      command: () => {
        setRenameName(menuProject?.title || "");
        setRenameSlug(menuProject?.slug || "");
        setRenameTarget(menuProject);
      },
    },
    {
      label: t("actions.copy"),
      icon: "pi pi-copy",
      command: () => {
        setCopyName(`${menuProject?.title} (Copy)`);
        setCopyTarget(menuProject);
      },
    },
    { separator: true },
    {
      label: t("actions.delete"),
      icon: "pi pi-times",
      command: () => confirmDelete(menuProject),
    },
  ];

  const submitRename = () => {
    dispatch(
      renameListProject(
        renameTarget.project_id,
        renameTarget.slug,
        renameName,
        renameSlug
      )
    );
    setRenameTarget(null);
  };

  const submitCopy = () => {
    dispatch(copyListProject(copyTarget.project_id, copyName));
    setCopyTarget(null);
  };

  function formatActions(data) {
    return (
      <Button
        icon="pi pi-ellipsis-h"
        className="p-button-text p-button-secondary p-button-sm"
        onClick={(e) => openMenu(e, data)}
        aria-label={t("projectList.actions")}
        aria-haspopup="menu"
      />
    );
  }

  const paginatorTemplate = {
    layout: "RowsPerPageDropdown CurrentPageReport PrevPageLink NextPageLink",
    RowsPerPageDropdown: (options) => {
      const dropdownOptions = [
        { label: 10, value: 10 },
        { label: 20, value: 20 },
        { label: 50, value: 50 },
      ];

      return (
        <React.Fragment>
          <span className="user-select-none paginator-label">
            {t("projectList.itemsPerPage")}{" "}
          </span>
          <Dropdown
            value={options.value}
            options={dropdownOptions}
            onChange={options.onChange}
          />
        </React.Fragment>
      );
    },
    CurrentPageReport: (options) => {
      return (
        <span className="user-select-none paginator-count">
          {options.first} - {options.last} of {options.totalRecords}
        </span>
      );
    },
  };

  if (!projects) {
    return (
      <div className="flex justify-content-center align-items-center py-6">
        <ProgressSpinner />
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="text-center py-6">
        <i className="pi pi-inbox text-4xl text-300 mb-3" />
        <p className="text-500">{t("projectList.none")}</p>
        <p className="text-sm">{t("projectList.noneHint")}</p>
      </div>
    );
  }

  // Page-offset clamp for the grid: filtering can leave the saved offset past
  // the end of the shorter result set before the reset effect has run.
  const gridFirst = first < gridSorted.length ? first : 0;

  return (
    <div>
      <div className="flex flex-wrap gap-2 align-items-center mt-4 mb-4">
        <span className="p-input-icon-left flex-auto" style={{ maxWidth: "20rem" }}>
          <i className="pi pi-search" />
          <InputText
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("projectList.searchPlaceholder")}
            className="w-full"
          />
        </span>
        <Dropdown
          value={langFilter}
          options={langOptions}
          onChange={(e) => setLangFilter(e.value ?? null)}
          placeholder={t("projectList.allCompilers")}
          showClear
        />
        {viewMode === "grid" && (
          <Dropdown
            value={gridSortKey}
            options={sortOptions}
            onChange={onGridSortChange}
            aria-label={t("projectList.sortBy")}
          />
        )}
        <div className="flex gap-1 ml-auto">
          <Button
            icon="pi pi-th-large"
            className={viewMode === "grid" ? "" : "p-button-text"}
            onClick={() => setViewMode("grid")}
            aria-label={t("projectList.gridView")}
            title={t("projectList.gridView")}
          />
          <Button
            icon="pi pi-bars"
            className={viewMode === "table" ? "" : "p-button-text"}
            onClick={() => setViewMode("table")}
            aria-label={t("projectList.tableView")}
            title={t("projectList.tableView")}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-6">
          <i className="pi pi-search text-4xl text-300 mb-3" />
          <p className="text-500">{t("projectList.noMatches")}</p>
        </div>
      ) : viewMode === "grid" ? (
        <>
          <div className="flex flex-wrap gap-3 align-items-start">
            {gridSorted.slice(gridFirst, gridFirst + rows).map((project) => (
              <ProjectCard
                key={project.project_id}
                project={project}
                projectUrl={projectUrl(project)}
                showPublic
                onMenuClick={openMenu}
              />
            ))}
          </div>
          {gridSorted.length > rows && (
            <Paginator
              first={gridFirst}
              rows={rows}
              totalRecords={gridSorted.length}
              rowsPerPageOptions={[10, 20, 50]}
              onPageChange={onPage}
              className="mt-3"
            />
          )}
        </>
      ) : (
        <DataTable
          value={filtered}
          removableSort
          paginator
          paginatorTemplate={paginatorTemplate}
          first={first}
          rows={rows}
          onPage={onPage}
          sortField={sortField}
          sortOrder={sortOrder}
          onSort={onSort}
          paginatorClassName="justify-content-end"
          responsiveLayout="scroll"
        >
          <Column
            field="title"
            header={t("projectList.title")}
            body={formatLinkName}
            className="col-width-34-mobile-70"
            sortable
          />
          {!isMobile && (
            <Column
              field="lang_title"
              header={t("projectList.compiler")}
              className="col-width-22"
              sortable
            />
          )}
          {!isMobile && (
            <Column
              field="created_at"
              header={t("projectList.created")}
              body={formatCreated}
              className="col-width-22"
              sortable
            />
          )}
          <Column
            field="updated_at"
            header={t("projectList.updated")}
            body={formatUpdated}
            className="col-width-22-mobile-30"
            sortable
          />
          {!isMobile && <Column body={formatActions} style={{ width: "4rem" }} />}
        </DataTable>
      )}

      <Menu model={menuItems} popup ref={menuRef} />
      <ConfirmDialog />

      <Dialog
        header={t("editor.renameTitle")}
        visible={!!renameTarget}
        className="editor-dialog-50vw"
        onHide={() => setRenameTarget(null)}
        footer={
          <>
            <Button
              label={t("actions.cancel")}
              icon="pi pi-times"
              onClick={() => setRenameTarget(null)}
              className="p-button-text"
            />
            <Button
              label={t("actions.ok")}
              icon="pi pi-check"
              onClick={submitRename}
              autoFocus
            />
          </>
        }
      >
        <div className="flex flex-column gap-3">
          <div className="flex flex-column gap-2">
            <label htmlFor="list-project-name">{t("editor.projectName")}</label>
            <InputText
              id="list-project-name"
              aria-describedby="list-project-name-help"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
              }}
              autoFocus
            />
            <small id="list-project-name-help">{t("editor.renameNameHelp")}</small>
          </div>
          <div className="flex flex-column gap-2">
            <label htmlFor="list-project-slug">{t("editor.urlSlug")}</label>
            <InputText
              id="list-project-slug"
              aria-describedby="list-project-slug-help"
              value={renameSlug}
              onChange={(e) => setRenameSlug(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
              }}
            />
            <small id="list-project-slug-help">{t("editor.renameSlugHelp")}</small>
          </div>
        </div>
      </Dialog>

      <Dialog
        header={t("editor.copyTitle")}
        visible={!!copyTarget}
        className="editor-dialog-50vw"
        onHide={() => setCopyTarget(null)}
        footer={
          <>
            <Button
              label={t("actions.cancel")}
              icon="pi pi-times"
              onClick={() => setCopyTarget(null)}
              className="p-button-text"
            />
            <Button
              label={t("actions.copy")}
              icon="pi pi-copy"
              onClick={submitCopy}
              autoFocus
            />
          </>
        }
      >
        <div className="flex flex-column gap-2">
          <label htmlFor="list-copy-name">{t("editor.newProjectName")}</label>
          <InputText
            id="list-copy-name"
            aria-describedby="list-copy-name-help"
            value={copyName}
            onChange={(e) => setCopyName(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCopy();
            }}
            autoFocus
          />
          <small id="list-copy-name-help">{t("editor.copyNameHelp")}</small>
        </div>
      </Dialog>
    </div>
  );
}
