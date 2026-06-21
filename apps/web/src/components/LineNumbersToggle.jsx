import React from "react";
import { useDispatch, useSelector } from "react-redux";
import { InputSwitch } from "primereact/inputswitch";
import { toggleLineNumbers } from "../redux/app/actions";
import { useTranslation } from "@zxplay/i18n";

export default function LineNumbersToggle() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const lineNumbers = useSelector((state) => state?.app?.lineNumbers || false);

  const handleToggle = (value) => {
    dispatch(toggleLineNumbers(value));
  };

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
