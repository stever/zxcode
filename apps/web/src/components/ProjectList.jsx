import React, { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Link } from "react-router-dom";
import { formatDistance } from "date-fns";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import {
  subscribeToProjectList,
  unsubscribeFromProjectList,
  setProjectListPreferences,
} from "../redux/projectList/actions";
import { Dropdown } from "primereact/dropdown";
import { getLanguageLabel } from "../lib/lang";

export default function ProjectList() {
  const dispatch = useDispatch();

  const projects = useSelector((state) => state?.projectList.projectList);
  const isMobile = useSelector((state) => state?.window.isMobile);
  const userSlug = useSelector((state) => state?.identity.userSlug);
  const userId = useSelector((state) => state?.identity.userId);

  // Get preferences from Redux store
  const storedRowsPerPage =
    useSelector((state) => state?.projectList.rowsPerPage) || 10;
  const storedCurrentPage =
    useSelector((state) => state?.projectList.currentPage) || 0;
  const storedSortField = useSelector((state) => state?.projectList.sortField);
  const storedSortOrder = useSelector((state) => state?.projectList.sortOrder);

  const [first, setFirst] = useState(storedCurrentPage);
  const [rows, setRows] = useState(storedRowsPerPage);
  const [sortField, setSortField] = useState(storedSortField);
  const [sortOrder, setSortOrder] = useState(storedSortOrder);

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

  function formatLinkName(data) {
    // Use slug-based URL if both user and project slugs are available
    const projectUrl =
      userSlug && data["slug"]
        ? `/u/${userSlug}/${data["slug"]}`
        : `/projects/${data["project_id"]}`;

    return <Link to={projectUrl}>{data["title"]}</Link>;
  }

  const now = new Date();

  function formatCreated(data) {
    const date = new Date(data["created_at"]);
    return formatDistance(date, now, { addSuffix: true });
  }

  function formatUpdated(data) {
    const date = new Date(data["updated_at"]);
    return formatDistance(date, now, { addSuffix: true });
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
          <span
            className="mx-1 user-select-none"
            style={{ color: "var(--text-color)" }}
          >
            Items per page:{" "}
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
        <span
          className="user-select-none text-nowrap-min-160"
          style={{
            color: "var(--text-color)",
          }}
        >
          {options.first} - {options.last} of {options.totalRecords}
        </span>
      );
    },
  };

  if (projects) {
    // Add language title to support sorting.
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      project["lang_title"] = getLanguageLabel(project.lang);
    }
  }

  return (
    <DataTable
      value={projects}
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
      className="mt-6"
      responsiveLayout="scroll"
    >
      <Column
        field="title"
        header="Project Title"
        body={formatLinkName}
        className="col-width-34-mobile-70"
        sortable
      />
      {!isMobile && (
        <Column
          field="lang_title"
          header="Compiler"
          className="col-width-22"
          sortable
        />
      )}
      {!isMobile && (
        <Column
          field="created_at"
          header="Created"
          body={formatCreated}
          className="col-width-22"
          sortable
        />
      )}
      <Column
        field="updated_at"
        header="Updated"
        body={formatUpdated}
        className="col-width-22-mobile-30"
        sortable
      />
    </DataTable>
  );
}
