import React from "react";
import { useDispatch, useSelector } from "react-redux";
import { InputSwitch } from "primereact/inputswitch";
import { toggleLineNumbers } from "../redux/app/actions";

export default function LineNumbersToggle() {
  const dispatch = useDispatch();
  const lineNumbers = useSelector((state) => state?.app?.lineNumbers || false);

  const handleToggle = (value) => {
    dispatch(toggleLineNumbers(value));
  };

  return (
    <div className="flex align-items-center gap-2">
      <i className="pi pi-list" />
      <span>Line Numbers</span>
      <InputSwitch
        checked={lineNumbers}
        onChange={(e) => handleToggle(e.value)}
      />
    </div>
  );
}
