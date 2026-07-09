import React from "react";
import { useDispatch, useSelector } from "react-redux";
import { setMemoryAddress } from "../../redux/debugger/actions";
import { hex16, hex8 } from "./format";
import { useTranslation } from "@zxplay/i18n";

// Live memory-map pane: which bank each slot of the address space exposes,
// colour-coded by role. The classification mirrors the desktop debugger's
// PageMapWidget (zx_go pkg/debugger/pagemap.go) so both debuggers read the
// same. Bank labels stay untranslated deliberately — they are the same
// technical vocabulary the disassembly pane already uses.

function classifyClassic(slot, paging) {
  if (!paging.is128K) {
    // 48K: no paging hardware — one ROM, fixed RAM. The core models it
    // with 128K-style bank numbers internally; don't surface them.
    if (slot >= 16) {
      return { label: "ROM", role: "rom" };
    }
    if (slot === paging.screenPage) {
      // On 48K the $4000-$7FFF slot is both the screen and the
      // ULA-contended region.
      return { label: "RAM (screen, contended)", role: "screen" };
    }
    return { label: "RAM", role: "normal" };
  }
  if (slot >= 16) {
    // ROM. 16=ROM0, 17=ROM1, 18=ROM2, 19=ROM3. Annotated with what
    // lives there: 128K/+2 carry the 128 editor and 48 BASIC; the
    // 4-ROM +2A/+3 add the syntax checker and +3DOS.
    const n = slot - 16;
    const names = paging.plus3
      ? ["editor", "syntax", "+3DOS", "48"]
      : ["128", "48"];
    const name = names[n];
    return { label: name ? `ROM ${n} (${name})` : `ROM ${n}`, role: "rom" };
  }
  if (slot === paging.screenPage) {
    return { label: `RAM ${slot} (screen)`, role: "screen" };
  }
  if (slot === 7) {
    // Shadow screen bank (selected by 7FFD bit 3).
    return { label: "RAM 7 (shadow)", role: "shadow" };
  }
  if ((slot & 1) === 1) {
    // On 128K, odd-numbered RAM banks are contended.
    return { label: `RAM ${slot} (contended)`, role: "contend" };
  }
  return { label: `RAM ${slot}`, role: "normal" };
}

function classifyNext(slot, index, paging) {
  if (paging.divmmcPaged && index < 2) {
    // The overlay covers the bottom 16K when paged in; reads come from it,
    // not the MMU bank.
    return { label: "divMMC overlay", role: "divmmc" };
  }
  if (slot === 0xFF) {
    // 0xFF is the ROM sentinel in the 8K MMU shadow.
    return { label: "ROM", role: "rom" };
  }
  if (slot === 10 || slot === 11) {
    // 8K halves of classic bank 5 — the default screen RAM.
    return { label: `bank ${slot} (screen)`, role: "screen" };
  }
  if (slot === 14 || slot === 15) {
    // 8K halves of classic bank 7 — shadow screen RAM.
    return { label: `bank ${slot} (shadow)`, role: "shadow" };
  }
  if (slot >= 0x20) {
    // Spectrum Next high banks, beyond the classic 128K allocation.
    return { label: `bank ${slot} ($${hex8(slot)})`, role: "high" };
  }
  return { label: `bank ${slot}`, role: "normal" };
}

export function DebugPaging() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const paging = useSelector((state) => state?.debugger.paging);

  const isNext = paging?.mode === "next";

  // Footer: the raw paging-port state the cells can't express — the
  // 7FFD value itself, which screen bank the ULA displays (bit 3:
  // "showing 5" or "showing 7") and the paging lock (bit 5, frozen
  // until reset once set). 1FFD and the +3 special all-RAM mode
  // appear on the 4-ROM machines only.
  let footer = null;
  if (!isNext && paging?.is128K && typeof paging.port7FFD === "number") {
    const v = paging.port7FFD;
    const parts = [`7FFD=$${hex8(v)}`];
    if (paging.plus3) {
      parts.push(`1FFD=$${hex8(paging.port1FFD)}`);
    }
    if (paging.specialPaging) {
      parts.push("special");
    }
    parts.push(v & 0x08 ? "showing 7" : "showing 5");
    parts.push(v & 0x20 ? "LOCKED" : "unlocked");
    footer = parts.join(" · ");
  }

  let cells = [];
  if (paging && Array.isArray(paging.slots)) {
    const slotSize = isNext ? 0x2000 : 0x4000;
    cells = paging.slots.map((slot, i) => {
      const base = i * slotSize;
      const { label, role } = isNext
        ? classifyNext(slot, i, paging)
        : classifyClassic(slot, paging);
      return {
        base,
        range: `$${hex16(base)}-$${hex16(base + slotSize - 1)}`,
        label,
        role,
      };
    });
  }

  return (
    <div className="debug-pane debug-pane-paging">
      <div className="debug-pane-head">
        {t("debug.paging")}
        <span className="hint">{t("debug.pagingHint")}</span>
      </div>
      <div className={`debug-pane-body debug-pagemap${isNext ? " compact" : ""}`}>
        {cells.length === 0 ? (
          <div className="debug-placeholder">{t("debug.pagingUnknown")}</div>
        ) : (
          <>
            {cells.map((cell) => (
              // Click-through to the memory pane at the slot's base address
              // (the pane also refreshes its address input from the jump).
              <div
                className={`debug-pagemap-cell ${cell.role}`}
                key={cell.base}
                role="button"
                tabIndex={0}
                title={t("debug.pagingJump")}
                onClick={() => dispatch(setMemoryAddress(cell.base))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    dispatch(setMemoryAddress(cell.base));
                  }
                }}
              >
                <div className="range">{cell.range}</div>
                <div className="bank">{cell.label}</div>
              </div>
            ))}
            {footer && <div className="debug-pagemap-foot">{footer}</div>}
          </>
        )}
      </div>
    </div>
  );
}
