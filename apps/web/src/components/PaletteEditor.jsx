import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { Checkbox } from "primereact/checkbox";
import { setFileContent } from "../redux/project/actions";
import {
  TRANSPARENT_INDEX,
  base64ToBytes,
  bytesToBase64,
  joinSpriteFile,
  splitSpriteFile,
} from "../lib/sprites/spr";
import {
  PALETTE_ENTRIES,
  css9,
  parsePalette,
  serialisePalette,
} from "../lib/sprites/pal";
import { useTranslation } from "@zxplay/i18n";

// Editor for Next .pal files (256 two-byte entries, the nextreg pair). The
// palette itself is small, so unlike the sprite editor plain state/props
// are fine; edits flow through setFileContent so save/staging/ZIP carry
// them unchanged. A +3DOS header, when present, is preserved like the
// sprite editor does.
export function PaletteEditor({ fileId, content }) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const palRef = useRef(null);
  const headerRef = useRef(null);
  const lastEmittedRef = useRef(null);

  const [selected, setSelected] = useState(0);
  const [version, setVersion] = useState(0);

  if (palRef.current === null) {
    const file = splitSpriteFile(base64ToBytes(content || ""));
    palRef.current = parsePalette(file.data);
    headerRef.current = file.header;
    lastEmittedRef.current = content || "";
  }

  useEffect(() => {
    if ((content || "") === lastEmittedRef.current) return;
    const file = splitSpriteFile(base64ToBytes(content || ""));
    palRef.current = parsePalette(file.data);
    headerRef.current = file.header;
    lastEmittedRef.current = content || "";
    setVersion((v) => v + 1);
  }, [content]);

  // All 512 colours of the Next, for the picker.
  const all512 = useMemo(
    () => Array.from({ length: 512 }, (_, v) => css9(v)),
    []
  );

  const commit = () => {
    const b64 = bytesToBase64(
      joinSpriteFile(headerRef.current, serialisePalette(palRef.current))
    );
    lastEmittedRef.current = b64;
    dispatch(setFileContent(fileId, b64));
    setVersion((v) => v + 1);
  };

  const setEntry = (value9) => {
    if (palRef.current.values[selected] === value9) return;
    palRef.current.values[selected] = value9;
    commit();
  };

  const togglePriority = () => {
    palRef.current.priority[selected] = !palRef.current.priority[selected];
    commit();
  };

  // version has no direct reading here; its state changes re-render the
  // swatches after ref mutations.
  void version;
  const { values, priority } = palRef.current;
  const hex = (v, width) => `$${v.toString(16).toUpperCase().padStart(width, "0")}`;

  return (
    <div className="palette-editor">
      <div className="palette-editor-info">
        <span
          className="sprite-editor-swatch"
          style={{ backgroundColor: css9(values[selected]) }}
        />
        <span>
          {t("editor.palette.index")} {hex(selected, 2)}
          {selected === TRANSPARENT_INDEX &&
            ` (${t("editor.sprites.transparent")})`}
        </span>
        <span>
          {t("editor.palette.value")} {hex(values[selected], 3)}
        </span>
        <label className="palette-editor-priority">
          <Checkbox
            checked={priority[selected]}
            onChange={togglePriority}
          />
          {t("editor.palette.priority")}
        </label>
      </div>
      <div className="sprite-palette palette-editor-entries">
        {Array.from({ length: PALETTE_ENTRIES }, (_, index) => (
          <div
            key={index}
            className={
              index === selected
                ? "sprite-palette-swatch selected"
                : "sprite-palette-swatch"
            }
            style={{ backgroundColor: css9(values[index]) }}
            title={`${hex(index, 2)}: ${hex(values[index], 3)}${
              priority[index] ? " P" : ""
            }`}
            onClick={() => setSelected(index)}
          />
        ))}
      </div>
      <div>
        <div className="sprite-editor-hint">{t("editor.palette.pickerHint")}</div>
        <div className="palette-editor-picker">
          {all512.map((colour, value9) => (
            <div
              key={value9}
              className={
                value9 === values[selected]
                  ? "sprite-palette-swatch selected"
                  : "sprite-palette-swatch"
              }
              style={{ backgroundColor: colour }}
              title={hex(value9, 3)}
              onClick={() => setEntry(value9)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
