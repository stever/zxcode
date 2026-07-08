import React, { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import clsx from "clsx";
import {
  setMemoryAddress,
  toggleAddrBreakpoint,
} from "../../redux/debugger/actions";
import { hex16, hex8 } from "./format";
import { useTranslation } from "@zxplay/i18n";

export function DebugDisassembly() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const bodyRef = useRef(null);

  const disasm = useSelector((state) => state?.debugger.disasm);
  const pc = useSelector((state) => state?.debugger.pc);
  const status = useSelector((state) => state?.debugger.status);
  const addrBreakpoints = useSelector(
    (state) => state?.debugger.addrBreakpoints
  );

  // While the machine runs, the live updates rewrite this pane 4x a second
  // and snap it back to the PC — which would make manual scrolling
  // impossible. Hovering the pane freezes its rows (registers and memory
  // stay live); moving away resumes the live follow. Pause/step always
  // shows fresh rows.
  const [hovered, setHovered] = useState(false);
  const frozen = hovered && status === "running";
  const frozenRowsRef = useRef(null);
  if (frozen && frozenRowsRef.current === null) {
    frozenRowsRef.current = disasm;
  } else if (!frozen && frozenRowsRef.current !== null) {
    frozenRowsRef.current = null;
  }
  const rows = frozen ? frozenRowsRef.current : disasm;

  // Keep the pc row in view as stepping (or the live follow) moves it.
  useEffect(() => {
    if (frozen) return;
    const row = bodyRef.current?.querySelector(".debug-disasm-row.pc");
    if (row) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [pc, rows, frozen]);

  return (
    <div
      className="debug-pane debug-pane-disasm"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="debug-pane-head">
        {t("debug.disassembly")}
        <span className="hint">
          {frozen ? t("debug.disasmHeld") : t("debug.memoryHint")}
        </span>
      </div>
      <div className="debug-pane-body" ref={bodyRef}>
        {rows.map((row) => (
          <React.Fragment key={row.addr}>
            {row.symbol && (
              <div className="debug-disasm-symbol">{row.symbol}:</div>
            )}
            <div
              className={clsx("debug-disasm-row", row.addr === pc && "pc")}
            >
              <span
                className={clsx(
                  "marker",
                  addrBreakpoints.includes(row.addr) && "bp"
                )}
                title={t("debug.toggleAddrBp")}
                onClick={() => dispatch(toggleAddrBreakpoint(row.addr))}
              >
                {row.addr === pc
                  ? "➤"
                  : addrBreakpoints.includes(row.addr)
                    ? "●"
                    : ""}
              </span>
              <span
                className="addr"
                onClick={() => dispatch(setMemoryAddress(row.addr))}
              >
                {hex16(row.addr)}
              </span>
              <span className="bytes">
                {row.bytes.map((b) => hex8(b)).join(" ")}
              </span>
              <span className="mnem">{row.text}</span>
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
