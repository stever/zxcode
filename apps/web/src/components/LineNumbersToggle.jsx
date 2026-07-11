import React from "react";
import { useDispatch, useSelector } from "react-redux";
import { InputSwitch } from "primereact/inputswitch";
import { ToggleButton } from "primereact/togglebutton";
import { toggleLineNumbers } from "../redux/app/actions";
import { useTranslation } from "@zxplay/i18n";

// iconOnly renders a compact toggle button for the project toolbar, which
// has to fit on one line; the demo pages keep the labelled switch.
export default function LineNumbersToggle({ iconOnly = false }) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const lineNumbers = useSelector((state) => state?.app?.lineNumbers ?? true);

  const handleToggle = (value) => {
    dispatch(toggleLineNumbers(value));
  };

  if (iconOnly) {
    return (
      <ToggleButton
        checked={lineNumbers}
        onChange={(e) => handleToggle(e.value)}
        onIcon="pi pi-list"
        offIcon="pi pi-list"
        onLabel=""
        offLabel=""
        aria-label={t("pages.lineNumbers")}
        tooltip={t("pages.lineNumbers")}
        tooltipOptions={{ position: "top" }}
      />
    );
  }

  return (
    <div className="flex align-items-center gap-2">
      <i className="pi pi-list" />
      <span>{t("pages.lineNumbers")}</span>
      <InputSwitch
        checked={lineNumbers}
        onChange={(e) => handleToggle(e.value)}
      />
    </div>
  );
}
