import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { Button } from "primereact/button";
import { setFileContent } from "../redux/project/actions";
import { MAX_FILE_CONTENT_SIZE } from "../lib/lang";
import {
  SPRITE_BYTES,
  SPRITE_SIZE,
  TRANSPARENT_INDEX,
  base64ToBytes,
  bytesToBase64,
  defaultSpritePalette,
  joinSpriteFile,
  splitSpriteFile,
  spritePatternCount,
} from "../lib/sprites/spr";
import { useTranslation } from "@zxplay/i18n";

// Editor pixels per sprite pixel on the drawing canvas.
const ZOOM = 24;
// Undo history depth (snapshots of the whole file, one per committed edit).
const MAX_HISTORY = 100;
const CANVAS_SIZE = SPRITE_SIZE * ZOOM;
// Checkerboard shades marking transparent ($E3) pixels.
const CHECKER_DARK = "#2e2e2e";
const CHECKER_LIGHT = "#3a3a3a";

// base64 length of a file holding this many bytes (the content-size cap is
// on the encoded form, matching the upload path).
function base64Length(byteLength) {
  return 4 * Math.ceil(byteLength / 3);
}

// NOTE: the pattern bytes must never travel through React props. The file
// can be 192KB, and React's development-build instrumentation serialises
// changed props element by element — a Uint8Array prop swapped by
// undo/add/delete froze the page for tens of seconds on large files. The
// thumbnails are plain canvases the editor paints imperatively instead.

// Pixel editor for Next .spr files (16x16 8-bit patterns, default palette).
// The pattern bytes live in a ref so drag-painting redraws the canvas
// without re-rendering; each finished stroke (and every whole-pattern
// operation) writes the file back to the store as base64 through the
// ordinary setFileContent path, so dirty tracking, Save, SD staging and the
// ZIP all carry sprite edits like any other file change.
export function SpriteEditor({ fileId, content }) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const canvasRef = useRef(null);
  // Pattern bytes only; a +3DOS header (if the file carries one) is held
  // aside verbatim and re-attached on every emit.
  const bytesRef = useRef(null);
  const headerRef = useRef(null);
  // The last base64 this editor dispatched: content-prop changes that echo
  // it back are our own edits; anything else (revert, project reload) is
  // external and reloads the pattern bytes.
  const lastEmittedRef = useRef(null);
  const strokeRef = useRef(false);
  // Undo/redo: snapshots of the file bytes (plus the selected pattern) at
  // each committed edit; index points at the current state. External
  // content changes reset it — CodeMirror's history doesn't cross reverts
  // or reloads either.
  const historyRef = useRef(null);
  // Thumbnail canvases by pattern index, painted imperatively (see the
  // note above). Strokes mark just their pattern dirty; whole-file changes
  // (undo/redo, add/delete, reload) mark all.
  const thumbCanvasesRef = useRef(new Map());
  const dirtyThumbsRef = useRef(new Set());
  const allThumbsDirtyRef = useRef(true);

  const [pattern, setPattern] = useState(0);
  const [selectedColour, setSelectedColour] = useState(0xff);
  const [tool, setTool] = useState("pen");
  // Bumped when the bytes change outside a stroke; re-renders thumbnails.
  const [version, setVersion] = useState(0);

  const palette = useMemo(defaultSpritePalette, []);
  const rgb = useMemo(
    () =>
      palette.map((c) => {
        const v = parseInt(c.slice(1), 16);
        return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
      }),
    [palette]
  );

  if (bytesRef.current === null) {
    const file = splitSpriteFile(base64ToBytes(content || ""));
    bytesRef.current = file.data;
    headerRef.current = file.header;
    lastEmittedRef.current = content || "";
    historyRef.current = {
      stack: [{ bytes: bytesRef.current.slice(), pattern: 0 }],
      index: 0,
    };
  }

  useEffect(() => {
    if ((content || "") === lastEmittedRef.current) return;
    const file = splitSpriteFile(base64ToBytes(content || ""));
    bytesRef.current = file.data;
    headerRef.current = file.header;
    lastEmittedRef.current = content || "";
    const clamped = Math.max(
      0,
      Math.min(pattern, spritePatternCount(bytesRef.current.length) - 1)
    );
    historyRef.current = {
      stack: [{ bytes: bytesRef.current.slice(), pattern: clamped }],
      index: 0,
    };
    allThumbsDirtyRef.current = true;
    setPattern(clamped);
    setVersion((v) => v + 1);
  }, [content]);

  const count = spritePatternCount(bytesRef.current.length);

  const drawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const bytes = bytesRef.current;
    const base = pattern * SPRITE_BYTES;
    const half = ZOOM / 2;
    for (let y = 0; y < SPRITE_SIZE; y++) {
      for (let x = 0; x < SPRITE_SIZE; x++) {
        const colour = bytes[base + y * SPRITE_SIZE + x];
        const px = x * ZOOM;
        const py = y * ZOOM;
        if (colour === TRANSPARENT_INDEX) {
          ctx.fillStyle = CHECKER_DARK;
          ctx.fillRect(px, py, ZOOM, ZOOM);
          ctx.fillStyle = CHECKER_LIGHT;
          ctx.fillRect(px, py, half, half);
          ctx.fillRect(px + half, py + half, half, half);
        } else {
          ctx.fillStyle = palette[colour];
          ctx.fillRect(px, py, ZOOM, ZOOM);
        }
      }
    }
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    for (let i = 1; i < SPRITE_SIZE; i++) {
      ctx.fillRect(i * ZOOM, 0, 1, CANVAS_SIZE);
      ctx.fillRect(0, i * ZOOM, CANVAS_SIZE, 1);
    }
  };

  useEffect(drawCanvas, [pattern, version]);

  // A strip thumbnail: the 16x16 pattern rendered 1:1, scaled up by CSS.
  const drawThumb = (index) => {
    const canvas = thumbCanvasesRef.current.get(index);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(SPRITE_SIZE, SPRITE_SIZE);
    const bytes = bytesRef.current;
    const base = index * SPRITE_BYTES;
    for (let i = 0; i < SPRITE_BYTES; i++) {
      const colour = bytes[base + i];
      const o = i * 4;
      if (colour === TRANSPARENT_INDEX) {
        image.data[o] = 0x1a;
        image.data[o + 1] = 0x1a;
        image.data[o + 2] = 0x1a;
      } else {
        image.data[o] = rgb[colour][0];
        image.data[o + 1] = rgb[colour][1];
        image.data[o + 2] = rgb[colour][2];
      }
      image.data[o + 3] = 0xff;
    }
    ctx.putImageData(image, 0, 0);
  };

  // Repaint dirty thumbnails after each committed change. Ref callbacks run
  // before effects in the same React commit, so canvases added by a pattern
  // count change are already registered here.
  useEffect(() => {
    if (allThumbsDirtyRef.current) {
      for (let i = 0; i < count; i++) drawThumb(i);
      allThumbsDirtyRef.current = false;
    } else {
      for (const i of dirtyThumbsRef.current) {
        if (i < count) drawThumb(i);
      }
    }
    dirtyThumbsRef.current.clear();
  }, [version, count]);

  // Push the current bytes to the store (and bump the thumbnails).
  const emit = () => {
    const b64 = bytesToBase64(joinSpriteFile(headerRef.current, bytesRef.current));
    lastEmittedRef.current = b64;
    dispatch(setFileContent(fileId, b64));
    setVersion((v) => v + 1);
  };

  // A committed edit: emit it and snapshot it for undo. selectedPattern is
  // the pattern the edit leaves selected (pattern add/delete pass it
  // explicitly because their setPattern hasn't landed yet).
  const commit = (selectedPattern = pattern) => {
    emit();
    const h = historyRef.current;
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push({ bytes: bytesRef.current.slice(), pattern: selectedPattern });
    if (h.stack.length > MAX_HISTORY) {
      h.stack.shift();
    }
    h.index = h.stack.length - 1;
  };

  const restore = (entry) => {
    bytesRef.current = entry.bytes.slice();
    allThumbsDirtyRef.current = true;
    setPattern(
      Math.max(
        0,
        Math.min(entry.pattern, spritePatternCount(entry.bytes.length) - 1)
      )
    );
    emit();
  };

  const undo = () => {
    const h = historyRef.current;
    if (h.index === 0) return;
    h.index--;
    restore(h.stack[h.index]);
  };

  const redo = () => {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    h.index++;
    restore(h.stack[h.index]);
  };

  // Ctrl/Cmd+Z / Shift+Ctrl+Z / Ctrl+Y while the editor is open, unless the
  // keystroke belongs to a focused text field elsewhere on the page. The
  // handlers go through refs so the listener binds once.
  const undoRef = useRef(null);
  const redoRef = useRef(null);
  undoRef.current = undo;
  redoRef.current = redo;
  useEffect(() => {
    const onKeyDown = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      const target = e.target;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (key === "y" || e.shiftKey) {
        redoRef.current();
      } else {
        undoRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Canvas-relative event position -> sprite pixel, or null outside.
  const pixelAt = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * SPRITE_SIZE);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * SPRITE_SIZE);
    if (x < 0 || x >= SPRITE_SIZE || y < 0 || y >= SPRITE_SIZE) return null;
    return { x, y };
  };

  const paintAt = (e) => {
    const p = pixelAt(e);
    if (!p) return;
    const value = tool === "erase" ? TRANSPARENT_INDEX : selectedColour;
    const i = pattern * SPRITE_BYTES + p.y * SPRITE_SIZE + p.x;
    if (bytesRef.current[i] !== value) {
      bytesRef.current[i] = value;
      dirtyThumbsRef.current.add(pattern);
      drawCanvas();
    }
  };

  const handlePointerDown = (e) => {
    if (e.button === 2) {
      // Right-click picks up the colour under the pointer.
      const p = pixelAt(e);
      if (p) {
        const colour =
          bytesRef.current[pattern * SPRITE_BYTES + p.y * SPRITE_SIZE + p.x];
        if (colour === TRANSPARENT_INDEX) {
          setTool("erase");
        } else {
          setSelectedColour(colour);
          setTool("pen");
        }
      }
      return;
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    strokeRef.current = true;
    paintAt(e);
  };

  const handlePointerMove = (e) => {
    if (strokeRef.current) paintAt(e);
  };

  const endStroke = () => {
    if (!strokeRef.current) return;
    strokeRef.current = false;
    commit();
  };

  // Whole-pattern operations mutate the current pattern in place.
  const transformPattern = (fn) => {
    const view = bytesRef.current.subarray(
      pattern * SPRITE_BYTES,
      (pattern + 1) * SPRITE_BYTES
    );
    fn(view);
    dirtyThumbsRef.current.add(pattern);
    commit();
  };

  const flipHorizontal = () =>
    transformPattern((view) => {
      for (let y = 0; y < SPRITE_SIZE; y++) {
        view.subarray(y * SPRITE_SIZE, (y + 1) * SPRITE_SIZE).reverse();
      }
    });

  const flipVertical = () =>
    transformPattern((view) => {
      for (let y = 0; y < SPRITE_SIZE / 2; y++) {
        const top = view.slice(y * SPRITE_SIZE, (y + 1) * SPRITE_SIZE);
        const opposite = SPRITE_SIZE - 1 - y;
        view.copyWithin(y * SPRITE_SIZE, opposite * SPRITE_SIZE, (opposite + 1) * SPRITE_SIZE);
        view.set(top, opposite * SPRITE_SIZE);
      }
    });

  const clearPattern = () =>
    transformPattern((view) => view.fill(TRANSPARENT_INDEX));

  const canAddPattern =
    base64Length(
      (headerRef.current ? headerRef.current.length : 0) +
        bytesRef.current.length +
        SPRITE_BYTES
    ) <= MAX_FILE_CONTENT_SIZE;

  const addPattern = () => {
    const grown = new Uint8Array(bytesRef.current.length + SPRITE_BYTES);
    grown.set(bytesRef.current);
    grown.fill(TRANSPARENT_INDEX, bytesRef.current.length);
    bytesRef.current = grown;
    allThumbsDirtyRef.current = true;
    setPattern(count);
    commit(count);
  };

  const deletePattern = () => {
    if (count <= 1) return;
    const shrunk = new Uint8Array(bytesRef.current.length - SPRITE_BYTES);
    shrunk.set(bytesRef.current.subarray(0, pattern * SPRITE_BYTES));
    shrunk.set(
      bytesRef.current.subarray((pattern + 1) * SPRITE_BYTES),
      pattern * SPRITE_BYTES
    );
    bytesRef.current = shrunk;
    allThumbsDirtyRef.current = true;
    const next = Math.min(pattern, count - 2);
    setPattern(next);
    commit(next);
  };

  if (count === 0) return null;

  const canUndo = historyRef.current.index > 0;
  const canRedo = historyRef.current.index < historyRef.current.stack.length - 1;

  return (
    <div className="sprite-editor">
      <div className="sprite-editor-toolbar">
        <div className="sprite-editor-toolbar-group">
          <Button
            icon="pi pi-undo"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.undo")}
            disabled={!canUndo}
            onClick={undo}
          />
          <Button
            icon="pi pi-undo sprite-editor-redo-icon"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.redo")}
            disabled={!canRedo}
            onClick={redo}
          />
        </div>
        <div className="sprite-editor-toolbar-group">
          <Button
            icon="pi pi-pencil"
            className={`p-button-sm ${tool === "pen" ? "" : "p-button-outlined"}`}
            title={t("editor.sprites.draw")}
            onClick={() => setTool("pen")}
          />
          <Button
            icon="pi pi-eraser"
            className={`p-button-sm ${tool === "erase" ? "" : "p-button-outlined"}`}
            title={t("editor.sprites.erase")}
            onClick={() => setTool("erase")}
          />
        </div>
        <div className="sprite-editor-toolbar-group">
          <Button
            icon="pi pi-arrows-h"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.flipHorizontal")}
            onClick={flipHorizontal}
          />
          <Button
            icon="pi pi-arrows-v"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.flipVertical")}
            onClick={flipVertical}
          />
          <Button
            icon="pi pi-trash"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.clear")}
            onClick={clearPattern}
          />
        </div>
        <span className="sprite-editor-hint">{t("editor.sprites.pickHint")}</span>
      </div>
      <div className="sprite-editor-main">
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          className="sprite-editor-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div className="sprite-editor-side">
          <div className="sprite-editor-colour">
            <span
              className={
                tool === "erase"
                  ? "sprite-editor-swatch erase"
                  : "sprite-editor-swatch"
              }
              style={
                tool === "erase"
                  ? undefined
                  : { backgroundColor: palette[selectedColour] }
              }
            />
            {tool === "erase"
              ? t("editor.sprites.transparent")
              : `$${selectedColour.toString(16).padStart(2, "0").toUpperCase()}`}
          </div>
          <div className="sprite-palette">
            {palette.map((colour, index) => (
              <div
                key={index}
                className={
                  index === selectedColour && tool === "pen"
                    ? "sprite-palette-swatch selected"
                    : "sprite-palette-swatch"
                }
                style={{ backgroundColor: colour }}
                title={
                  index === TRANSPARENT_INDEX
                    ? `$${index.toString(16).padStart(2, "0").toUpperCase()} (${t("editor.sprites.transparent")})`
                    : `$${index.toString(16).padStart(2, "0").toUpperCase()}`
                }
                onClick={() => {
                  if (index === TRANSPARENT_INDEX) {
                    setTool("erase");
                  } else {
                    setSelectedColour(index);
                    setTool("pen");
                  }
                }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="sprite-pattern-strip">
        {Array.from({ length: count }, (_, index) => (
          <canvas
            key={index}
            width={SPRITE_SIZE}
            height={SPRITE_SIZE}
            className={
              index === pattern
                ? "sprite-pattern-thumb selected"
                : "sprite-pattern-thumb"
            }
            ref={(el) => {
              if (el) {
                thumbCanvasesRef.current.set(index, el);
              } else {
                thumbCanvasesRef.current.delete(index);
              }
            }}
            onClick={() => setPattern(index)}
          />
        ))}
        <Button
          icon="pi pi-plus"
          className="p-button-sm p-button-outlined"
          title={t("editor.sprites.addPattern")}
          disabled={!canAddPattern}
          onClick={addPattern}
        />
        <Button
          icon="pi pi-minus"
          className="p-button-sm p-button-outlined"
          title={t("editor.sprites.deletePattern")}
          disabled={count <= 1}
          onClick={deletePattern}
        />
        <span className="sprite-editor-hint">
          {t("editor.sprites.patternLabel", {
            index: pattern + 1,
            count,
          })}
        </span>
      </div>
    </div>
  );
}
