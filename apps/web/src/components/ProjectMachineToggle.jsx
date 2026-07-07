import React, { useState } from "react";
import { useDispatch } from "react-redux";
import { SelectButton } from "primereact/selectbutton";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { setMachine } from "../redux/app/actions";
import { useTranslation } from "@zxplay/i18n";

const UPDATE_PROJECT_MACHINE = gql`
  mutation ($project_id: uuid!, $machine: String!) {
    update_project_by_pk(
      pk_columns: { project_id: $project_id }
      _set: { machine: $machine }
    ) {
      project_id
      machine
    }
  }
`;

// The DB stores machine as a string ('48' | '128' | 'next'); the app's machine
// state (redux/app) uses 48/128 as numbers and 'next' as a string. Map across.
const toApp = (m) => (m === "next" ? "next" : m === "128" ? 128 : 48);

// Owner-only control on the project page for the machine the project targets.
// This is the authoritative source for project.machine: gif-service renders
// the screenshot on it, and picking it switches the live emulator so the
// program runs (and its screenshot matches) the machine it was written for.
// A Next-only program on a 48K just freezes on the tape loader.
export default function ProjectMachineToggle({ project, userId }) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const [machine, setMachineValue] = useState(project?.machine || "48");
  const [updating, setUpdating] = useState(false);

  const options = [
    { label: t("nav.machine48"), value: "48" },
    { label: t("nav.machine128"), value: "128" },
    { label: t("machine.next"), value: "next" },
  ];

  const handleChange = async (value) => {
    // SelectButton fires null when the active button is re-clicked; ignore it
    // (a project always targets some machine) along with no-op re-selection.
    if (!value || value === machine || updating) return;
    setUpdating(true);
    // Switch the live emulator right away so what runs matches the target.
    dispatch(setMachine(toApp(value)));
    try {
      const response = await gqlFetch(userId, UPDATE_PROJECT_MACHINE, {
        project_id: project.project_id,
        machine: value,
      });
      if (response?.data?.update_project_by_pk) {
        setMachineValue(value);
      }
    } catch (error) {
      console.error("Failed to update project machine:", error);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="flex align-items-center gap-2">
      <i className="pi pi-desktop" />
      <span>{t("machine.label")}</span>
      <SelectButton
        value={machine}
        options={options}
        onChange={(e) => handleChange(e.value)}
        disabled={updating}
        allowEmpty={false}
      />
    </div>
  );
}
