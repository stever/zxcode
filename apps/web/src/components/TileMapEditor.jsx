import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Button } from "primereact/button";
import { Dropdown } from "primereact/dropdown";
import { setFileContent } from "../redux/project/actions";
import { selectFiles } from "../redux/project/selectors";
import { joinProjectFilePath } from "../lib/lang";
import {
  SPRITE_BYTES,
  TILE_PIXELS,
  TILE_SIZE,
  SPRITE_SIZE,
  FOUR_BIT_TRANSPARENT,
  TRANSPARENT_INDEX,
  base64ToBytes,
  bytesToBase64,
  defaultSpritePalette,
  expandFourBit,
  isSpriteFileName,
  isTileFileName,
  joinSpriteFile,
  splitSpriteFile,
} from "../lib/sprites/spr";
import { defaultMapWidth, mapWidthOptions } from "../lib/sprites/map";
import { useTranslation } from "@zxplay/i18n";

// Undo depth for map snapshots.
const MAX_HISTORY = 100;
// On-screen scale: each tile pixel is doubled.
const DISPLAY_SCALE = 2;

// Editor for .map files: a grid of one-byte tile indices painted with a
// tile picked from a project .til/.spr. Follows the sprite editor's
// architecture — bytes in refs (never in props), imperative canvas
// painting, edits through setFileContent so save/SD-staging/ZIP carry
// them, snapshot undo/redo. Dimensions are not part of the format: the
// chosen width is remembered per file and the height derived.
export function TileMapEditor({ fileId, content }) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const mapCanvasRef = useRef(null);
  const cellsRef = useRef(null);
  const headerRef = useRef(null);
  const lastEmittedRef = useRef(null);
  const strokeRef = useRef(false);
  const historyRef = useRef(null);
  const tileCanvasesRef = useRef(new Map());
  const statusRef = useRef(null);
  const widthKey = `zxcoder-map-width-${fileId}`;

  const [version, setVersion] = useState(0);
  const [selectedTile, setSelectedTile] = useState(0);
  const [width, setWidth] = useState(0);

  const loadFile = () => {
    const file = splitSpriteFile(base64ToBytes(content || ""));
    headerRef.current = file.header;
    cellsRef.current = file.data;
  };

  if (cellsRef.current === null) {
    loadFile();
    lastEmittedRef.current = content || "";
    historyRef.current = {
      stack: [{ cells: cellsRef.current.slice() }],
      index: 0,
    };
    // Render-phase setState on first render only (cellsRef guards): React
    // discards this pass and re-renders with the width in place.
    const stored = parseInt(localStorage.getItem(widthKey), 10);
    const cellCount = cellsRef.current.length;
    if (stored > 0 && cellCount % stored === 0) {
      setWidth(stored);
    } else {
      setWidth(defaultMapWidth(cellCount));
    }
  }

  useEffect(() => {
    if ((content || "") === lastEmittedRef.current) return;
    loadFile();
    lastEmittedRef.current = content || "";
    historyRef.current = {
      stack: [{ cells: cellsRef.current.slice() }],
      index: 0,
    };
    if (cellsRef.current.length % width !== 0) {
      setWidth(defaultMapWidth(cellsRef.current.length));
    }
    setVersion((v) => v + 1);
  }, [content]);

  const cellCount = cellsRef.current.length;
  const height = width > 0 ? cellCount / width : 0;

  // Tile source: any editable .til/.spr in the project, interpreted with
  // the depth that file's own editor last used (shared localStorage keys),
  // but always sliced as 8x8 tiles unless its grid mode says 16x16 — tile
  // maps address 8x8 tiles on the hardware.
  const projectFiles = useSelector(selectFiles);
  const tileFiles = projectFiles.filter(
    (f) =>
      f.isBinary && (isTileFileName(f.name) || isSpriteFileName(f.name))
  );
  const [tileFileId, setTileFileId] = useState(null);
  const tileFile =
    tileFiles.find((f) => f.id === tileFileId) ||
    tileFiles.find((f) => isTileFileName(f.name)) ||
    tileFiles[0] ||
    null;

  const source = useMemo(() => {
    if (!tileFile) return null;
    const data = splitSpriteFile(base64ToBytes(tileFile.content)).data;
    if (!data.length) return null;
    const til = isTileFileName(tileFile.name);
    const stored4 = localStorage.getItem(`zxcoder-sprite-4bit-${tileFile.id}`);
    const storedG = localStorage.getItem(`zxcoder-sprite-grid8-${tileFile.id}`);
    let four = stored4 !== null ? stored4 === "1" : til;
    let grid8 = storedG !== null ? storedG === "1" : true;
    const fits = (f, g8) =>
      (f ? data.length * 2 : data.length) % (g8 ? TILE_PIXELS : SPRITE_BYTES) === 0;
    if (!fits(four, grid8)) {
      if (fits(!four, grid8)) four = !four;
      else if (fits(four, true)) grid8 = true;
      else if (fits(!four, true)) {
        four = !four;
        grid8 = true;
      } else return null;
    }
    const pixels = four ? expandFourBit(data) : data;
    const size = grid8 ? TILE_SIZE : SPRITE_SIZE;
    return {
      pixels,
      size,
      count: pixels.length / (size * size),
      transparent: four ? FOUR_BIT_TRANSPARENT : TRANSPARENT_INDEX,
    };
  }, [tileFile ? tileFile.id : null, tileFile ? tileFile.content : null]);

  const tileSize = source ? source.size : TILE_SIZE;
  const tileCount = source ? source.count : 256;

  const palette = useMemo(defaultSpritePalette, []);
  const rgb = useMemo(
    () =>
      palette.map((c) => {
        const v = parseInt(c.slice(1), 16);
        return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
      }),
    [palette]
  );

  // Paint one tile's pixels into an ImageData at the given cell origin.
  // Without a usable source, cells render as a flat grey by index.
  const blitTile = (image, imageWidth, tileIndex, ox, oy) => {
    for (let y = 0; y < tileSize; y++) {
      for (let x = 0; x < tileSize; x++) {
        const o = ((oy + y) * imageWidth + ox + x) * 4;
        let r = 0x1a;
        let g = 0x1a;
        let b = 0x1a;
        if (source && tileIndex < source.count) {
          const value =
            source.pixels[tileIndex * tileSize * tileSize + y * tileSize + x];
          if (value !== source.transparent) {
            const entry = rgb[value];
            r = entry[0];
            g = entry[1];
            b = entry[2];
          }
        } else {
          r = g = b = tileIndex & 0xff;
        }
        image.data[o] = r;
        image.data[o + 1] = g;
        image.data[o + 2] = b;
        image.data[o + 3] = 0xff;
      }
    }
  };

  const drawMap = () => {
    const canvas = mapCanvasRef.current;
    if (!canvas || !width) return;
    const w = width * tileSize;
    const h = height * tileSize;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(w, h);
    for (let cy = 0; cy < height; cy++) {
      for (let cx = 0; cx < width; cx++) {
        blitTile(
          image,
          w,
          cellsRef.current[cy * width + cx],
          cx * tileSize,
          cy * tileSize
        );
      }
    }
    ctx.putImageData(image, 0, 0);
  };

  useEffect(drawMap, [version, width, source]);

  const drawTileThumb = (index) => {
    const canvas = tileCanvasesRef.current.get(index);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(tileSize, tileSize);
    blitTile(image, tileSize, index, 0, 0);
    ctx.putImageData(image, 0, 0);
  };

  useEffect(() => {
    for (let i = 0; i < Math.min(tileCount, 256); i++) drawTileThumb(i);
  }, [source, version]);

  const emit = () => {
    const b64 = bytesToBase64(
      joinSpriteFile(headerRef.current, cellsRef.current)
    );
    lastEmittedRef.current = b64;
    dispatch(setFileContent(fileId, b64));
    setVersion((v) => v + 1);
  };

  const commit = () => {
    emit();
    const h = historyRef.current;
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push({ cells: cellsRef.current.slice() });
    if (h.stack.length > MAX_HISTORY) h.stack.shift();
    h.index = h.stack.length - 1;
  };

  const restore = (entry) => {
    cellsRef.current = entry.cells.slice();
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

  const undoRef = useRef(null);
  const redoRef = useRef(null);
  undoRef.current = undo;
  redoRef.current = redo;
  useEffect(() => {
    const onKeyDown = (e) => {
      const target = e.target;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "CANVAS" ||
          target.isContentEditable)
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (key !== "z" && key !== "y") return;
      e.preventDefault();
      if (key === "y" || e.shiftKey) redoRef.current();
      else undoRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Map-canvas position -> cell coordinates.
  const cellAt = (e) => {
    const rect = mapCanvasRef.current.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * height);
    if (x < 0 || x >= width || y < 0 || y >= height) return null;
    return { x, y };
  };

  const paintCell = (e) => {
    const c = cellAt(e);
    if (!c) return;
    const i = c.y * width + c.x;
    if (cellsRef.current[i] !== selectedTile) {
      cellsRef.current[i] = selectedTile;
      drawMap();
    }
  };

  const updateStatus = (e) => {
    const el = statusRef.current;
    if (!el) return;
    const c = cellAt(e);
    el.textContent = c
      ? `${c.x},${c.y}  #${cellsRef.current[c.y * width + c.x]}`
      : "";
  };

  const handlePointerDown = (e) => {
    if (e.button === 2) {
      const c = cellAt(e);
      if (c) {
        setSelectedTile(cellsRef.current[c.y * width + c.x]);
      }
      return;
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    strokeRef.current = true;
    paintCell(e);
  };

  const handlePointerMove = (e) => {
    updateStatus(e);
    if (strokeRef.current) paintCell(e);
  };

  const endStroke = () => {
    if (!strokeRef.current) return;
    strokeRef.current = false;
    commit();
  };

  const fillMap = () => {
    cellsRef.current.fill(selectedTile);
    drawMap();
    commit();
  };

  const changeWidth = (w) => {
    if (!w || cellCount % w !== 0) return;
    localStorage.setItem(widthKey, String(w));
    setWidth(w);
  };

  const canUndo = historyRef.current.index > 0;
  const canRedo =
    historyRef.current.index < historyRef.current.stack.length - 1;

  return (
    <div className="tilemap-editor">
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
          <Button
            icon="pi pi-stop"
            className="p-button-sm p-button-outlined"
            title={t("editor.tilemap.fill")}
            onClick={fillMap}
          />
        </div>
        <div className="sprite-editor-toolbar-group">
          <span className="sprite-editor-hint">{t("editor.tilemap.width")}</span>
          <Dropdown
            className="p-inputtext-sm"
            value={width}
            options={mapWidthOptions(cellCount).map((w) => ({
              label: `${w} × ${cellCount / w}`,
              value: w,
            }))}
            onChange={(e) => changeWidth(e.value)}
            title={t("editor.tilemap.widthHint")}
          />
        </div>
        {tileFiles.length > 0 && (
          <div className="sprite-editor-toolbar-group">
            <span className="sprite-editor-hint">{t("editor.tilemap.tiles")}</span>
            <Dropdown
              className="p-inputtext-sm"
              value={tileFile ? tileFile.id : null}
              options={tileFiles.map((f) => ({
                label: joinProjectFilePath(f.folder, f.name),
                value: f.id,
              }))}
              onChange={(e) => setTileFileId(e.value)}
              title={t("editor.tilemap.tilesHint")}
            />
          </div>
        )}
        <span className="sprite-editor-hint">
          {t("editor.tilemap.pickHint")}
        </span>
      </div>
      <div className="tilemap-canvas-scroll">
        <canvas
          ref={mapCanvasRef}
          className="tilemap-canvas"
          style={{ width: width * tileSize * DISPLAY_SCALE }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={() => {
            if (statusRef.current) statusRef.current.textContent = "";
          }}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <div className="sprite-editor-status">
        <span ref={statusRef} />
        <span className="sprite-editor-hint">
          {t("editor.tilemap.tileLabel", { index: selectedTile, count: tileCount })}
        </span>
      </div>
      <div className="sprite-pattern-strip tilemap-tile-strip">
        {Array.from({ length: Math.min(tileCount, 256) }, (_, index) => (
          <canvas
            key={index}
            width={tileSize}
            height={tileSize}
            className={
              index === selectedTile
                ? "sprite-pattern-thumb selected"
                : "sprite-pattern-thumb"
            }
            ref={(el) => {
              if (el) tileCanvasesRef.current.set(index, el);
              else tileCanvasesRef.current.delete(index);
            }}
            onClick={() => setSelectedTile(index)}
          />
        ))}
      </div>
    </div>
  );
}
