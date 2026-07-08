import React, { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { InputText } from "primereact/inputtext";
import { setMemoryAddress } from "../../redux/debugger/actions";
import { hex16, hex8, asciiByte, parseAddress } from "./format";
import { useTranslation } from "@zxplay/i18n";

// The pane holds the entire 64K address space and virtualises the rows:
// only what the viewport shows (plus a little overscan) is in the DOM, so
// scrolling from $0000 to $FFFF is one native scrollbar drag. Row height is
// pinned in CSS so scroll offsets map exactly onto addresses.
const BYTES_PER_ROW = 8;
const ROW_HEIGHT = 19;
const OVERSCAN = 8;
const TOTAL_ROWS = 0x10000 / BYTES_PER_ROW;

export function DebugMemory() {
  const { t } = useTranslation();
  const dispatch = useDispatch();

  const bytes = useSelector((state) => state?.debugger.memory.bytes);
  const jump = useSelector((state) => state?.debugger.memoryJump);
  const [addressText, setAddressText] = useState(hex16(jump.address));
  const [scrollTop, setScrollTop] = useState(0);
  const bodyRef = useRef(null);

  // Every jump (seq bumps even when the address repeats) scrolls the target
  // row to the top of the viewport.
  useEffect(() => {
    setAddressText(hex16(jump.address));
    if (bodyRef.current) {
      bodyRef.current.scrollTop =
        Math.floor(jump.address / BYTES_PER_ROW) * ROW_HEIGHT;
    }
  }, [jump]);

  const goTo = () => {
    const address = parseAddress(addressText);
    if (address !== null) {
      dispatch(setMemoryAddress(address));
    } else {
      setAddressText(hex16(jump.address));
    }
  };

  const viewportRows = bodyRef.current
    ? Math.ceil(bodyRef.current.clientHeight / ROW_HEIGHT)
    : 16;
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastRow = Math.min(TOTAL_ROWS, firstRow + viewportRows + OVERSCAN * 2);

  const rows = [];
  if (bytes && bytes.length) {
    for (let r = firstRow; r < lastRow; r++) {
      const address = r * BYTES_PER_ROW;
      rows.push({
        address,
        bytes: Array.from(bytes.subarray(address, address + BYTES_PER_ROW)),
      });
    }
  }

  return (
    <div className="debug-pane debug-pane-memory">
      <div className="debug-pane-head">
        {t("debug.memory")}
        <span className="debug-mem-controls">
          $
          <InputText
            value={addressText}
            onChange={(e) => setAddressText(e.target.value)}
            onBlur={goTo}
            onKeyDown={(e) => {
              if (e.key === "Enter") goTo();
            }}
          />
        </span>
      </div>
      <div
        className="debug-pane-body"
        ref={bodyRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: TOTAL_ROWS * ROW_HEIGHT, position: "relative" }}>
          <div
            style={{
              position: "absolute",
              top: firstRow * ROW_HEIGHT,
              left: 0,
              right: 0,
            }}
          >
            {rows.map((row) => (
              <div className="debug-mem-row" key={row.address}>
                <span className="addr">{hex16(row.address)}</span>
                <span>{row.bytes.map((b) => hex8(b)).join(" ")}</span>
                <span className="ascii">
                  {row.bytes.map((b) => asciiByte(b)).join("")}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
