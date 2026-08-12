import React, { useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Dialog } from "primereact/dialog";
import { Checkbox } from "primereact/checkbox";
import { setBuildOutputVisible } from "../redux/project/actions";
import { useTranslation } from "@zxplay/i18n";

// One line of the last failed build's output, rendered the way the toasts
// present it: worker diagnostics get their file/line prefix back, service
// stderr lines are already complete.
function formatUnit(unit, t) {
  const text = unit.text || " ";
  if (unit.path && unit.line) {
    return `${unit.path}(${unit.line}): ${unit.text}`;
  }
  if (unit.line) {
    return t("errors.lineMsg", { line: unit.line, msg: unit.text });
  }
  return text;
}

// The complete classified output of the last failed compile
// (state.project.buildOutput, lib/buildDiagnostics.js), opened from the
// build-summary toast. The warnings filter is the point of #217: with
// warnings hidden, only the error and context lines remain.
export default function BuildOutputDialog() {
  const { t } = useTranslation();
  const dispatch = useDispatch();

  const units = useSelector((state) => state?.project.buildOutput);
  const visible = useSelector((state) => state?.project.buildOutputVisible);
  const [hideWarnings, setHideWarnings] = useState(false);

  if (!units || units.length === 0) {
    return null;
  }

  const warningCount = units.filter((u) => u.severity === "warning").length;
  const shown = hideWarnings
    ? units.filter((u) => u.severity !== "warning")
    : units;

  return (
    <Dialog
      header={t("errors.buildOutput")}
      visible={Boolean(visible)}
      modal
      maximizable
      className="build-output-dialog"
      onHide={() => dispatch(setBuildOutputVisible(false))}
    >
      {warningCount > 0 && (
        <div className="build-output-controls">
          <Checkbox
            inputId="build-output-hide-warnings"
            checked={hideWarnings}
            onChange={(e) => setHideWarnings(e.checked)}
          />
          <label htmlFor="build-output-hide-warnings">
            {t("errors.hideWarnings", { n: warningCount })}
          </label>
        </div>
      )}
      <div className="build-output-body">
        {shown.map((unit, i) => (
          <div key={i} className={`build-output-line ${unit.severity}`}>
            {formatUnit(unit, t)}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
