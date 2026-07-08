import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import clsx from "clsx";
import { Button } from "primereact/button";
import {
  setDebugTab,
  toggleBreakpoint,
  toggleAddrBreakpoint,
  clearBreakpoints,
} from "../../redux/debugger/actions";
import { DebugConsole } from "./DebugConsole";
import { hex16 } from "./format";
import { useTranslation } from "@zxplay/i18n";

// The secondary panel group. Console and Breakpoints are live; the rest are
// stubs that fill in as the emulator bridge exposes their data (they map to
// zx_go's Next State / Backtrace / History views).
export function DebugPanels() {
  const { t } = useTranslation();
  const dispatch = useDispatch();

  const selectedTab = useSelector((state) => state?.debugger.selectedTab);
  const breakpoints = useSelector((state) => state?.debugger.breakpoints);
  const addrBreakpoints = useSelector(
    (state) => state?.debugger.addrBreakpoints
  );
  const backend = useSelector((state) => state?.debugger.backend);

  const bpCount = breakpoints.length + addrBreakpoints.length;

  // The tab strip hides its scrollbar (it would sit over the labels) and
  // shows edge buttons instead when the tabs overflow.
  const tabsRef = useRef(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });

  const updateTabScroll = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 0;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setTabScroll((s) =>
      s.left === left && s.right === right ? s : { left, right }
    );
  }, []);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    updateTabScroll();
    const observer = new ResizeObserver(updateTabScroll);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateTabScroll]);

  // Label widths change when the breakpoint count chip appears.
  useEffect(updateTabScroll, [bpCount, updateTabScroll]);

  const scrollTabs = (direction) => {
    tabsRef.current?.scrollBy({ left: direction * 120, behavior: "smooth" });
  };

  const tabs = [
    { key: "console", label: t("debug.console") },
    { key: "breakpoints", label: t("debug.breakpoints"), count: bpCount },
    { key: "watches", label: t("debug.watches") },
    { key: "nextState", label: t("debug.nextState") },
    { key: "backtrace", label: t("debug.backtrace") },
    { key: "history", label: t("debug.history") },
  ];

  return (
    <div className="debug-pane debug-pane-panels">
      <div className="debug-tabbar">
        {tabScroll.left && (
          <button
            type="button"
            className="debug-tab-scroll left"
            aria-label={t("debug.tabsScrollLeft")}
            onClick={() => scrollTabs(-1)}
          >
            ‹
          </button>
        )}
        <div className="debug-tabs" ref={tabsRef} onScroll={updateTabScroll}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={clsx("debug-tab", selectedTab === tab.key && "on")}
              onClick={() => dispatch(setDebugTab(tab.key))}
            >
              {tab.label}
              {tab.count > 0 && <span className="count">{tab.count}</span>}
            </button>
          ))}
        </div>
        {tabScroll.right && (
          <button
            type="button"
            className="debug-tab-scroll right"
            aria-label={t("debug.tabsScrollRight")}
            onClick={() => scrollTabs(1)}
          >
            ›
          </button>
        )}
      </div>
      {selectedTab === "console" && <DebugConsole />}
      {selectedTab === "breakpoints" && (
        <div className="debug-tab-body">
          {bpCount === 0 && (
            <div className="debug-placeholder">{t("debug.noBreakpoints")}</div>
          )}
          {addrBreakpoints.map((address) => (
            <div className="debug-bp-row" key={`addr:${address}`}>
              <span className="debug-bp-dot" />
              <span>${hex16(address)}</span>
              <Button
                icon="pi pi-times"
                className="p-button-sm p-button-text p-button-danger"
                onClick={() => dispatch(toggleAddrBreakpoint(address))}
              />
            </div>
          ))}
          {breakpoints.map((bp) => (
            <div className="debug-bp-row" key={`${bp.file}:${bp.line}`}>
              <span
                className={clsx(
                  "debug-bp-dot",
                  backend === "zxgo" && "inert"
                )}
              />
              <span>{t("debug.line", { line: bp.line })}</span>
              <Button
                icon="pi pi-times"
                className="p-button-sm p-button-text p-button-danger"
                onClick={() => dispatch(toggleBreakpoint(bp.line))}
              />
            </div>
          ))}
          {backend === "zxgo" && breakpoints.length > 0 && (
            <div className="debug-placeholder">
              {t("debug.lineBpsPending")}
            </div>
          )}
          {bpCount > 0 && (
            <div className="debug-bp-row">
              <Button
                label={t("debug.clearAll")}
                className="p-button-sm p-button-outlined p-button-danger"
                onClick={() => dispatch(clearBreakpoints())}
              />
            </div>
          )}
        </div>
      )}
      {["watches", "nextState", "backtrace", "history"].includes(selectedTab) && (
        <div className="debug-tab-body">
          <div className="debug-placeholder">{t("debug.placeholderPanel")}</div>
        </div>
      )}
    </div>
  );
}
