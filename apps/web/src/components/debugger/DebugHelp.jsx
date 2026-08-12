import React from "react";
import { useTranslation } from "@zxplay/i18n";

// Command reference for the debugger console, curated for the browser
// debugger (the engine's DEBUGGER.md documents the full desktop/telnet
// surface). The console itself is English-only — commands, arguments, and
// engine responses — so this reference stays in that language too; only the
// framing text is translated. Syntax lines mirror the engine's own usage
// strings; update alongside command changes in zxplay_go's cmd dispatch.
const SECTIONS = [
  {
    title: "Running",
    note: "The transport buttons issue these for you.",
    items: [
      ["continue", "resume; steps off a breakpoint under the cursor first"],
      ["pause", "halt at the next instruction"],
      ["step", "one instruction (interrupts delivered as on real hardware)"],
      ["step-over", "run a CALL/RST to the instruction after it"],
      ["step-line [over]", "run to the next mapped source line (the Step Over button when a compile's map is live); `over` skips lines inside called functions"],
      ["cont-until EXPR", "run until the expression holds, e.g. cont-until a=$41"],
    ],
  },
  {
    title: "Breakpoints",
    note: "The editor gutter and the disassembly marker column set these too.",
    items: [
      ["set-breakpoint $ADDR", "also: bank=N | any-bank, if EXPR, do \"cmd; cmd\""],
      ["clear-breakpoint $ADDR", "remove one"],
      ["list-breakpoints", "everything armed, with bank filters and conditions"],
    ],
  },
  {
    title: "Watches and tracepoints",
    note: "Set these while paused: arming from a running machine halts it.",
    items: [
      ["watch-reg REG [from V] [to V]", "halt when the register changes (pc sp a f b c d e h l ix iy iff1 iff2 im halted bank)"],
      ["list-watches / clear-watch", "register watches (shown in the Watches panel)"],
      ["watch-mem ram BANK FROM TO", "halt on writes into a 16K RAM bank range (48K map: bank 5=$4000, 2=$8000, 0=$C000)"],
      ["watch-read ram BANK FROM TO", "same for reads; clear-watch-mem / clear-watch-read"],
      ["watch-port PORT [=VAL] [log]", "halt (or just log) on an OUT; bare watch-port lists, watch-port off clears"],
      ["tp $ADDR", "tracepoint: log registers at the address without halting; list-tp / clear-tp"],
    ],
  },
  {
    title: "Inspecting and poking",
    items: [
      ["get-registers", "full register set"],
      ["set-reg NAME VAL", "e.g. set-reg pc $8000"],
      ["backtrace [N]", "stack walk with return-address classification"],
      ["disassemble [$ADDR] [N]", "around the pc by default"],
      ["hexdump $ADDR LEN", "memory as the CPU sees it"],
      ["read-memory $ADDR / write-memory $ADDR VAL", "single bytes"],
      ["sym $ADDR NAME", "name an address (compiled labels load automatically); bare sym lists"],
    ],
  },
  {
    title: "Instruction history",
    note: "Off by default; arming adds a small per-instruction cost.",
    items: [
      ["history-on [SIZE] [wide]", "arm the ring (the History panel's button sends history-on 4096)"],
      ["prev [N]", "the last N instructions, with registers"],
      ["history / history-off", "ring status / disarm"],
    ],
  },
  {
    title: "Spectrum Next",
    items: [
      ["nr-panel", "NextReg summary (the Next State panel)"],
      ["get-mmu / get-divmmc / list-banks", "paging and bank state"],
      ["bank-peek KIND BANK OFF [LEN]", "read any bank unpaged (kinds: ram rom altrom divmmc-ram)"],
      ["nextreg-read REG / nextreg-write REG VAL", "individual NextRegs"],
      ["sprite-list / palette-dump / layer-state / copper-disasm", "video state"],
    ],
  },
];

export function DebugHelp() {
  const { t } = useTranslation();
  return (
    <div className="debug-tab-body debug-help">
      <div className="debug-placeholder">{t("debug.helpIntro")}</div>
      {SECTIONS.map((s) => (
        <section key={s.title}>
          <h4>{s.title}</h4>
          {s.note && <div className="debug-help-note">{s.note}</div>}
          {s.items.map(([cmd, text]) => (
            <div className="debug-help-row" key={cmd}>
              <code>{cmd}</code>
              <span>{text}</span>
            </div>
          ))}
        </section>
      ))}
      <div className="debug-help-note">{t("debug.helpOutro")}</div>
    </div>
  );
}
