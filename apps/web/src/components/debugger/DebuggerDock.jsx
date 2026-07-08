import React from "react";
import { DebugTransport } from "./DebugTransport";
import { DebugRegisters } from "./DebugRegisters";
import { DebugDisassembly } from "./DebugDisassembly";
import { DebugMemory } from "./DebugMemory";
import { DebugPaging } from "./DebugPaging";
import { DebugPanels } from "./DebugPanels";
import "./debugger.css";

// The debugger surface: transport + registers on top, then disassembly,
// memory, the paging map, and the tabbed panel group. The pane grid wraps
// on narrow viewports, so the same component serves the split-mode dock and
// the tab-mode Debug tab.
export function DebuggerDock() {
  return (
    <div className="debug-dock">
      <DebugTransport />
      <DebugRegisters />
      <div className="debug-panes">
        <DebugDisassembly />
        <DebugMemory />
        <DebugPaging />
        <DebugPanels />
      </div>
    </div>
  );
}
