import React from "react";
import { useSelector } from "react-redux";
import clsx from "clsx";
import { hex16 } from "./format";

const FLAG_BITS = [
  ["S", 0x80],
  ["Z", 0x40],
  ["H", 0x10],
  ["P", 0x04],
  ["N", 0x02],
  ["C", 0x01],
];

// One line of registers under the transport bar. Values that changed on the
// last step are highlighted — the thing you watch while single-stepping.
export function DebugRegisters() {
  const registers = useSelector((state) => state?.debugger.registers);
  const previous = useSelector((state) => state?.debugger.previousRegisters);

  if (!registers) return null;

  const af = ((registers.a & 0xFF) << 8) | (registers.f & 0xFF);
  const prevAf = previous
    ? ((previous.a & 0xFF) << 8) | (previous.f & 0xFF)
    : af;

  const main = [
    ["PC", registers.pc, previous?.pc],
    ["SP", registers.sp, previous?.sp],
    ["AF", af, prevAf],
    ["BC", registers.bc, previous?.bc],
    ["DE", registers.de, previous?.de],
    ["HL", registers.hl, previous?.hl],
    ["IX", registers.ix, previous?.ix],
    ["IY", registers.iy, previous?.iy],
  ];

  return (
    <div className="debug-registers">
      {main.map(([name, value, prevValue]) => (
        <span
          key={name}
          className={clsx(
            "debug-reg",
            previous && prevValue !== value && "changed"
          )}
        >
          <b>{name}</b>
          {hex16(value)}
        </span>
      ))}
      <span className="debug-reg debug-reg-alt">
        <b>AF'</b>
        {hex16(registers.afAlt)} <b>BC'</b>
        {hex16(registers.bcAlt)} <b>DE'</b>
        {hex16(registers.deAlt)} <b>HL'</b>
        {hex16(registers.hlAlt)}
      </span>
      <span className="debug-flags">
        {FLAG_BITS.map(([name, bit]) => (
          <span key={name} className={registers.f & bit ? "on" : undefined}>
            {name}{" "}
          </span>
        ))}
        · IM {registers.im} · IFF {registers.iff1 ? "✓" : "✗"}
      </span>
    </div>
  );
}
