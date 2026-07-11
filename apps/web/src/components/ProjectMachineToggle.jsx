import React, { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { SelectButton } from "primereact/selectbutton";
import gql from "graphql-tag";
import { gqlFetch } from "../graphql_fetch";
import { setMachine } from "../redux/app/actions";
import { languageAllowedOnMachine } from "../lib/lang";
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
const toDb = (m) => (m === "next" ? "next" : String(m));

// Owner-only control on the project page for the machine the project targets.
// This is the authoritative source for project.machine: gif-service renders
// the screenshot on it, and picking it switches the live emulator so the
// program runs (and its screenshot matches) the machine it was written for.
// A Next-only program on a 48K just freezes on the tape loader.
//
// The buttons display the LIVE machine, and persistence follows it: the nav
// MACHINE menu switches the same app state, so on the owner's own project
// page both controls are one thing — switch the machine, and the project's
// target follows. (Boot-time settling is naturally a no-op: the machine the
// page boots IS the saved target, so there is nothing to write.)
export default function ProjectMachineToggle({ project, userId }) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const lang = useSelector((state) => state?.project.lang);
  const appMachine = useSelector((state) => state?.app.machine);
  const machineLocked = useSelector((state) => state?.app.machineLocked);
  const machine = toDb(appMachine);
  const [updating, setUpdating] = useState(false);
  const savedRef = useRef(project?.machine || "48");
  // Persistence arms only once the live machine has matched the saved
  // target: until then a mismatch is boot-settling (the load saga converges
  // app.machine to project.machine after this mounts), not user intent.
  const syncedRef = useRef(false);

  // A project's language pins its machines (#68): NextBASIC is Next-only,
  // Sinclair BASIC is 48/128-only, everything else is free. Only offer machines
  // the language can target (the current value always qualifies for a valid
  // project, so it stays selectable).
  // Short labels — the "Target machine" caption already gives the context
  // and the toolbar has to fit on one line (the nav menu keeps full names).
  const options = [
    { label: t("machine.short48"), value: "48" },
    { label: t("machine.short128"), value: "128" },
    { label: t("machine.shortNext"), value: "next" },
  ].filter((o) => languageAllowedOnMachine(lang, o.value));

  // Route changes reuse this mounted component: re-seed against the new
  // project before the persist effect below can compare against it.
  useEffect(() => {
    savedRef.current = project?.machine || "48";
    syncedRef.current = false;
  }, [project?.project_id]);

  // Persist whatever machine the owner lands on, however they got there.
  // Machines the language cannot target are never written (the nav menu
  // allows a session-only excursion; the target keeps its last valid value),
  // and a "?m=" URL lock is a viewing preference, not a retargeting.
  useEffect(() => {
    if (machine === savedRef.current) {
      syncedRef.current = true;
      return;
    }
    if (!syncedRef.current || machineLocked) return;
    if (!languageAllowedOnMachine(lang, machine)) return;
    let cancelled = false;
    setUpdating(true);
    (async () => {
      try {
        const response = await gqlFetch(userId, UPDATE_PROJECT_MACHINE, {
          project_id: project.project_id,
          machine,
        });
        if (response?.data?.update_project_by_pk && !cancelled) {
          savedRef.current = machine;
        }
      } catch (error) {
        console.error("Failed to update project machine:", error);
      } finally {
        if (!cancelled) setUpdating(false);
      }
    })();
    return () => { cancelled = true; };
  }, [machine, lang, userId, project?.project_id, machineLocked]);

  const handleChange = (value) => {
    // SelectButton fires null when the active button is re-clicked; ignore it
    // (a project always targets some machine) along with no-op re-selection.
    if (!value || value === machine || updating) return;
    // Switch the live emulator; the effect above persists the new target.
    dispatch(setMachine(toApp(value)));
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
