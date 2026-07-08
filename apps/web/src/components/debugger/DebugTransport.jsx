import React from "react";
import { useDispatch, useSelector } from "react-redux";
import { Button } from "primereact/button";
import {
  debugContinue,
  debugPause,
  debugStep,
  debugStepOver,
  debugStepFrame,
} from "../../redux/debugger/actions";
import { hex16 } from "./format";
import { useTranslation } from "@zxplay/i18n";

export function DebugTransport() {
  const { t } = useTranslation();
  const dispatch = useDispatch();

  const status = useSelector((state) => state?.debugger.status);
  const reason = useSelector((state) => state?.debugger.reason);
  const pc = useSelector((state) => state?.debugger.pc);
  const backend = useSelector((state) => state?.debugger.backend);

  const paused = status === "paused";

  const reasonLabel = {
    entry: t("debug.reasonEntry"),
    step: t("debug.reasonStep"),
    breakpoint: t("debug.reasonBreakpoint"),
    pause: t("debug.reasonPause"),
  }[reason];

  return (
    <div className="debug-transport">
      <Button
        label={t("debug.continue")}
        icon="pi pi-play"
        className="p-button-sm p-button-success"
        disabled={!paused}
        onClick={() => dispatch(debugContinue())}
      />
      <Button
        label={t("debug.pause")}
        icon="pi pi-pause"
        className="p-button-sm p-button-outlined"
        disabled={paused}
        onClick={() => dispatch(debugPause())}
      />
      <Button
        label={t("debug.step")}
        icon="pi pi-step-forward"
        className="p-button-sm p-button-outlined"
        disabled={!paused}
        onClick={() => dispatch(debugStep())}
      />
      <Button
        label={t("debug.stepOver")}
        icon="pi pi-forward"
        className="p-button-sm p-button-outlined"
        disabled={!paused}
        onClick={() => dispatch(debugStepOver())}
      />
      <Button
        label={t("debug.stepFrame")}
        icon="pi pi-fast-forward"
        className="p-button-sm p-button-outlined"
        disabled={!paused}
        onClick={() => dispatch(debugStepFrame())}
      />
      <div className="debug-transport-status">
        {backend === "mock" && (
          <span className="debug-mock-chip">{t("debug.mockBackend")}</span>
        )}
        {paused ? (
          <span className="debug-status-chip">
            ⏸ {t("debug.pausedAt")} ${hex16(pc)}
            {reasonLabel ? ` · ${reasonLabel}` : ""}
          </span>
        ) : (
          <span className="debug-status-chip running">
            ▶ {t("debug.running")}
          </span>
        )}
      </div>
    </div>
  );
}
