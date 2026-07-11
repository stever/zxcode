import React from "react";
import { useDispatch, useSelector } from "react-redux";
import { ToggleButton } from "primereact/togglebutton";
import { toggleBreakpointGutter } from "../redux/app/actions";
import { languageSupportsSourceDebug } from "../lib/lang";
import { useTranslation } from "@zxplay/i18n";

// Icon-only toggle (filled dot = gutter shown, hollow = hidden) so the
// toolbar stays on one line; the label lives in the tooltip. ToggleButton's
// highlight state shares the machine SelectButton's theme styling.
export default function BreakpointGutterToggle() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const lang = useSelector((state) => state?.project.lang);
  const breakpointGutter = useSelector(
    (state) => state?.app?.breakpointGutter ?? true
  );
  const debugActive = useSelector((state) => state?.debugger.active);

  // The gutter only shows while the debug panel is open and the language
  // supports source debug (#113); outside that the toggle would be a no-op —
  // hide it rather than present a dead control.
  if (!languageSupportsSourceDebug(lang) || !debugActive) return null;

  return (
    <ToggleButton
      checked={breakpointGutter}
      onChange={(e) => dispatch(toggleBreakpointGutter(e.value))}
      onIcon="pi pi-circle-fill"
      offIcon="pi pi-circle"
      onLabel=""
      offLabel=""
      aria-label={t("pages.breakpointGutter")}
      tooltip={t("pages.breakpointGutter")}
      tooltipOptions={{ position: "top" }}
    />
  );
}
