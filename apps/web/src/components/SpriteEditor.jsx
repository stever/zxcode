import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Button } from "primereact/button";
import { Dropdown } from "primereact/dropdown";
import { setFileContent } from "../redux/project/actions";
import { selectFiles } from "../redux/project/selectors";
import { MAX_FILE_CONTENT_SIZE, joinProjectFilePath } from "../lib/lang";
import {
  isEditablePaletteContent,
  isPaletteFileName,
  paletteCssFromBytes,
} from "../lib/sprites/pal";
import {
  FOUR_BIT_TRANSPARENT,
  SPRITE_BYTES,
  SPRITE_SIZE,
  TILE_PIXELS,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  base64ToBytes,
  bytesToBase64,
  defaultSpritePalette,
  expandFourBit,
  joinSpriteFile,
  packFourBit,
  splitSpriteFile,
} from "../lib/sprites/spr";
import { imageDataToPatterns } from "../lib/sprites/imageImport";
import { toAsmSource, toBasicData } from "../lib/sprites/sourceExport";
import { useTranslation } from "@zxplay/i18n";

// Undo history depth (snapshots of the whole file, one per committed edit).
const MAX_HISTORY = 100;
// Fixed drawing surface; the per-pixel zoom follows the grid size (24 for
// 16x16 sprites, 48 for 8x8 tiles).
const CANVAS_SIZE = 384;
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
export function SpriteEditor({ fileId, content, tile = false }) {
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
  // Editor-internal pattern clipboard (a 256-byte copy) and the thumb being
  // dragged for reordering. hasClipboard mirrors the ref for button state.
  const clipboardRef = useRef(null);
  const dragIndexRef = useRef(null);
  const [hasClipboard, setHasClipboard] = useState(false);

  // Sprites can render through a project .pal instead of the hardware
  // default palette; the choice is per-session display state (the pattern
  // bytes are palette-agnostic indices either way). Edits to the .pal in
  // its own tab re-render here live via its content string.
  const projectFiles = useSelector(selectFiles);
  const palFiles = projectFiles.filter(
    (f) =>
      f.isBinary &&
      isPaletteFileName(f.name) &&
      isEditablePaletteContent(f.content)
  );
  const [palFileId, setPalFileId] = useState(null);
  const palFile = palFiles.find((f) => f.id === palFileId) || null;
  const palette = useMemo(() => {
    if (palFile) {
      const css = paletteCssFromBytes(
        splitSpriteFile(base64ToBytes(palFile.content)).data
      );
      if (css) return css;
    }
    return defaultSpritePalette();
  }, [palFile ? palFile.content : null]);
  const rgb = useMemo(
    () =>
      palette.map((c) => {
        const v = parseInt(c.slice(1), 16);
        return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
      }),
    [palette]
  );

  // Two per-file display modes, both remembered in localStorage: bit depth
  // (8-bit = one byte per pixel on disk, 4-bit = two pixels per byte) and
  // grid size (16x16 sprites or 8x8 tiles). The bytes carry no marker, so
  // these are user toggles; combinations that do not divide the file are
  // unavailable, and .til files default to the tilemap hardware's 8x8
  // 4-bit. In 4-bit mode bytesRef holds UNPACKED pixels (one nibble value
  // per byte) so every tool works unchanged; pack/unpack happen at the
  // load/emit boundary.
  const fourBitRef = useRef(false);
  const gridRef = useRef(SPRITE_SIZE);
  const [palOffset, setPalOffset] = useState(0);
  const modeKey = `zxcoder-sprite-4bit-${fileId}`;
  const gridKey = `zxcoder-sprite-grid8-${fileId}`;

  const loadFile = () => {
    const file = splitSpriteFile(base64ToBytes(content || ""));
    headerRef.current = file.header;
    const raw = file.data.length;
    const fits = (four, grid8) =>
      (four ? raw * 2 : raw) % (grid8 ? TILE_PIXELS : SPRITE_BYTES) === 0;
    const stored4 = localStorage.getItem(modeKey);
    const storedG = localStorage.getItem(gridKey);
    let four = stored4 !== null ? stored4 === "1" : tile;
    let grid8 = storedG !== null ? storedG === "1" : tile;
    if (!fits(four, grid8)) {
      if (fits(!four, grid8)) {
        four = !four;
      } else if (fits(four, true)) {
        grid8 = true;
      } else {
        // The editable-content gate guarantees 4-bit 8x8 always divides.
        four = true;
        grid8 = true;
      }
    }
    fourBitRef.current = four;
    gridRef.current = grid8 ? TILE_SIZE : SPRITE_SIZE;
    bytesRef.current = four ? expandFourBit(file.data) : file.data;
  };

  if (bytesRef.current === null) {
    loadFile();
    lastEmittedRef.current = content || "";
    historyRef.current = {
      stack: [{ bytes: bytesRef.current.slice(), pattern: 0 }],
      index: 0,
    };
  }

  useEffect(() => {
    if ((content || "") === lastEmittedRef.current) return;
    loadFile();
    lastEmittedRef.current = content || "";
    const clamped = Math.max(
      0,
      Math.min(
        pattern,
        bytesRef.current.length / (gridRef.current * gridRef.current) - 1
      )
    );
    historyRef.current = {
      stack: [{ bytes: bytesRef.current.slice(), pattern: clamped }],
      index: 0,
    };
    allThumbsDirtyRef.current = true;
    setPattern(clamped);
    setVersion((v) => v + 1);
  }, [content]);

  const fourBit = fourBitRef.current;
  // Pattern geometry for the current grid mode; all pattern maths below
  // works in unpacked pixels.
  const size = gridRef.current;
  const pixels = size * size;
  const zoom = CANVAS_SIZE / size;
  const count = bytesRef.current.length / pixels;
  // The value painted for "transparent" and the palette entry a stored
  // pixel value displays through (4-bit nibbles address a 16-colour row).
  const transparentIndex = fourBit ? FOUR_BIT_TRANSPARENT : TRANSPARENT_INDEX;
  const displayIndex = (value) =>
    fourBit ? (palOffset << 4) | (value & 0x0f) : value;

  const drawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const bytes = bytesRef.current;
    const base = pattern * pixels;
    const half = zoom / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const colour = bytes[base + y * size + x];
        const px = x * zoom;
        const py = y * zoom;
        if (colour === transparentIndex) {
          ctx.fillStyle = CHECKER_DARK;
          ctx.fillRect(px, py, zoom, zoom);
          ctx.fillStyle = CHECKER_LIGHT;
          ctx.fillRect(px, py, half, half);
          ctx.fillRect(px + half, py + half, half, half);
        } else {
          ctx.fillStyle = palette[displayIndex(colour)];
          ctx.fillRect(px, py, zoom, zoom);
        }
      }
    }
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    for (let i = 1; i < size; i++) {
      ctx.fillRect(i * zoom, 0, 1, CANVAS_SIZE);
      ctx.fillRect(0, i * zoom, CANVAS_SIZE, 1);
    }
  };

  useEffect(drawCanvas, [pattern, version, palette, palOffset]);

  // A palette or 4-bit offset change recolours every thumbnail too.
  useEffect(() => {
    allThumbsDirtyRef.current = true;
    setVersion((v) => v + 1);
  }, [palette, palOffset]);

  // A strip thumbnail: the 16x16 pattern rendered 1:1, scaled up by CSS.
  const drawThumb = (index) => {
    const canvas = thumbCanvasesRef.current.get(index);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(size, size);
    const bytes = bytesRef.current;
    const base = index * pixels;
    for (let i = 0; i < pixels; i++) {
      const colour = bytes[base + i];
      const o = i * 4;
      if (colour === transparentIndex) {
        image.data[o] = 0x1a;
        image.data[o + 1] = 0x1a;
        image.data[o + 2] = 0x1a;
      } else {
        const entry = rgb[displayIndex(colour)];
        image.data[o] = entry[0];
        image.data[o + 1] = entry[1];
        image.data[o + 2] = entry[2];
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

  // Push the current bytes to the store (and bump the thumbnails). 4-bit
  // pixels pack back to nibbles here.
  const emit = () => {
    const data = fourBitRef.current
      ? packFourBit(bytesRef.current)
      : bytesRef.current;
    const b64 = bytesToBase64(joinSpriteFile(headerRef.current, data));
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
        Math.min(entry.pattern, entry.bytes.length / pixels - 1)
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

  // Canvas-relative event position -> sprite pixel, or null outside.
  const pixelAt = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * size);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * size);
    if (x < 0 || x >= size || y < 0 || y >= size) return null;
    return { x, y };
  };

  const paintAt = (e) => {
    const p = pixelAt(e);
    if (!p) return;
    // Holding Shift erases regardless of the active tool (zx-tools habit).
    const value =
      tool === "erase" || e.shiftKey ? transparentIndex : selectedColour;
    const i = pattern * pixels + p.y * size + p.x;
    if (bytesRef.current[i] !== value) {
      bytesRef.current[i] = value;
      dirtyThumbsRef.current.add(pattern);
      drawCanvas();
    }
  };

  // 4-way flood fill from the clicked pixel; Shift fills with transparent.
  const floodFillAt = (e) => {
    const p = pixelAt(e);
    if (!p) return;
    const bytes = bytesRef.current;
    const base = pattern * pixels;
    const from = bytes[base + p.y * size + p.x];
    const to = e.shiftKey ? transparentIndex : selectedColour;
    if (from === to) return;
    const stack = [[p.x, p.y]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const i = base + y * size + x;
      if (bytes[i] !== from) continue;
      bytes[i] = to;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    dirtyThumbsRef.current.add(pattern);
    drawCanvas();
    commit();
  };

  const handlePointerDown = (e) => {
    if (e.button === 2) {
      // Right-click picks up the colour under the pointer.
      const p = pixelAt(e);
      if (p) {
        const colour =
          bytesRef.current[pattern * pixels + p.y * size + p.x];
        if (colour === transparentIndex) {
          setTool("erase");
        } else {
          setSelectedColour(colour);
          setTool("pen");
        }
      }
      return;
    }
    if (e.button !== 0) return;
    if (tool === "fill") {
      floodFillAt(e);
      return;
    }
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
      pattern * pixels,
      (pattern + 1) * pixels
    );
    fn(view);
    dirtyThumbsRef.current.add(pattern);
    commit();
  };

  const flipHorizontal = () =>
    transformPattern((view) => {
      for (let y = 0; y < size; y++) {
        view.subarray(y * size, (y + 1) * size).reverse();
      }
    });

  const flipVertical = () =>
    transformPattern((view) => {
      for (let y = 0; y < size / 2; y++) {
        const top = view.slice(y * size, (y + 1) * size);
        const opposite = size - 1 - y;
        view.copyWithin(y * size, opposite * size, (opposite + 1) * size);
        view.set(top, opposite * size);
      }
    });

  const clearPattern = () =>
    transformPattern((view) => view.fill(transparentIndex));

  // 90° clockwise: dst(x, y) = src(y, 15 - x).
  const rotatePattern = () =>
    transformPattern((view) => {
      const src = view.slice();
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          view[y * size + x] =
            src[(size - 1 - x) * size + y];
        }
      }
    });

  // Move the pattern with wraparound (zx-tools' pan).
  const shiftPattern = (dx, dy) =>
    transformPattern((view) => {
      const src = view.slice();
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const sx = (x - dx + size) % size;
          const sy = (y - dy + size) % size;
          view[y * size + x] = src[sy * size + sx];
        }
      }
    });

  // File bytes on disk per pattern (in-memory patterns are always 256
  // unpacked pixels).
  const filePatternBytes = fourBit ? pixels / 2 : pixels;
  const fileDataLength = fourBit
    ? bytesRef.current.length / 2
    : bytesRef.current.length;

  const canAddPattern =
    base64Length(
      (headerRef.current ? headerRef.current.length : 0) +
        fileDataLength +
        filePatternBytes
    ) <= MAX_FILE_CONTENT_SIZE;

  const addPattern = () => {
    const grown = new Uint8Array(bytesRef.current.length + pixels);
    grown.set(bytesRef.current);
    grown.fill(transparentIndex, bytesRef.current.length);
    bytesRef.current = grown;
    allThumbsDirtyRef.current = true;
    setPattern(count);
    commit(count);
  };

  const copyPattern = () => {
    clipboardRef.current = bytesRef.current.slice(
      pattern * pixels,
      (pattern + 1) * pixels
    );
    setHasClipboard(true);
  };

  // Paste replaces the pattern; paste-over keeps pixels where the clipboard
  // is transparent, so sprites can be composited (zx-tools' shift-paste).
  const pastePattern = (over) => {
    const clip = clipboardRef.current;
    if (!clip) return;
    transformPattern((view) => {
      for (let i = 0; i < pixels; i++) {
        // Clipboard values from the other bit mode mask down to nibbles.
        const value = fourBit ? clip[i] & 0x0f : clip[i];
        if (!over || value !== transparentIndex) {
          view[i] = value;
        }
      }
    });
  };

  const duplicatePattern = () => {
    if (!canAddPattern) return;
    const src = bytesRef.current;
    const end = (pattern + 1) * pixels;
    const grown = new Uint8Array(src.length + pixels);
    grown.set(src.subarray(0, end));
    grown.set(src.subarray(pattern * pixels, end), end);
    grown.set(src.subarray(end), end + pixels);
    bytesRef.current = grown;
    allThumbsDirtyRef.current = true;
    setPattern(pattern + 1);
    commit(pattern + 1);
  };

  // Reorder: lift the pattern out and reinsert it at the drop position.
  const movePattern = (from, to) => {
    if (from === to || from == null || to == null) return;
    const bytes = bytesRef.current;
    const chunk = bytes.slice(from * pixels, (from + 1) * pixels);
    if (from < to) {
      bytes.copyWithin(
        from * pixels,
        (from + 1) * pixels,
        (to + 1) * pixels
      );
    } else {
      bytes.copyWithin(
        (to + 1) * pixels,
        to * pixels,
        from * pixels
      );
    }
    bytes.set(chunk, to * pixels);
    allThumbsDirtyRef.current = true;
    setPattern(to);
    commit(to);
  };

  const selectPattern = (delta) => {
    setPattern((p) => Math.max(0, Math.min(count - 1, p + delta)));
  };

  // Whether the current data could also read as whole 8-bit patterns (a
  // 4-bit file with an odd pattern count cannot), and whether the other
  // grid size divides the pixel buffer.
  const canBeEightBit = fileDataLength % pixels === 0;
  const otherGridPixels =
    size === SPRITE_SIZE ? TILE_PIXELS : SPRITE_BYTES;
  const canToggleGrid = bytesRef.current.length % otherGridPixels === 0;

  // Copy the packed pattern data (never the +3DOS header) to the system
  // clipboard as assembly db rows or BASIC DATA lines.
  const [sourceCopied, setSourceCopied] = useState(false);
  const copySource = (asm) => {
    const data = fourBitRef.current
      ? packFourBit(bytesRef.current)
      : bytesRef.current;
    const description = `${count} x ${size}x${size} ${
      fourBit ? "4" : "8"
    }-bit pattern${count === 1 ? "" : "s"}`;
    const text = asm
      ? toAsmSource(data, filePatternBytes, description)
      : toBasicData(data);
    navigator.clipboard?.writeText(text).then(() => {
      setSourceCopied(true);
      setTimeout(() => setSourceCopied(false), 2000);
    });
  };

  // Reinterpret the same pixels on the other grid: content and depth stay,
  // only the pattern slicing changes. History and clipboard reset (their
  // pattern boundaries no longer apply).
  const toggleGrid = () => {
    if (!canToggleGrid) return;
    const grid8 = size === SPRITE_SIZE;
    gridRef.current = grid8 ? TILE_SIZE : SPRITE_SIZE;
    localStorage.setItem(gridKey, grid8 ? "1" : "0");
    clipboardRef.current = null;
    setHasClipboard(false);
    historyRef.current = {
      stack: [{ bytes: bytesRef.current.slice(), pattern: 0 }],
      index: 0,
    };
    allThumbsDirtyRef.current = true;
    setPattern(0);
    setVersion((v) => v + 1);
  };

  // Reinterpret the same file bytes in the other depth: the content does
  // not change (so nothing dirties), only the unpacked working copy and
  // the pattern count do. History resets like an external reload.
  const toggleFourBit = () => {
    const fileData = fourBitRef.current
      ? packFourBit(bytesRef.current)
      : bytesRef.current;
    const next = !fourBitRef.current;
    if (next === false && fileData.length % pixels !== 0) return;
    fourBitRef.current = next;
    localStorage.setItem(modeKey, next ? "1" : "0");
    bytesRef.current = next ? expandFourBit(fileData) : fileData;
    historyRef.current = {
      stack: [{ bytes: bytesRef.current.slice(), pattern: 0 }],
      index: 0,
    };
    allThumbsDirtyRef.current = true;
    setSelectedColour((c) => (next ? Math.min(c, 0x0f) : c));
    setPattern(0);
    setVersion((v) => v + 1);
  };

  // Import an image file: quantise to the default palette, slice into
  // 16x16 patterns and append as many as fit under the content-size cap.
  // The file loads through a data: URL — the proxy's CSP allows img-src
  // data: but not blob:, so createObjectURL images never render there.
  const importImageRef = useRef(null);
  const handleImportImage = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scratch = document.createElement("canvas");
        scratch.width = img.naturalWidth;
        scratch.height = img.naturalHeight;
        const ctx = scratch.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const patterns = imageDataToPatterns(
          ctx.getImageData(0, 0, scratch.width, scratch.height),
          size
        );
        const headerLength = headerRef.current ? headerRef.current.length : 0;
        const room = Math.floor(
          ((MAX_FILE_CONTENT_SIZE * 3) / 4 -
            headerLength -
            bytesRef.current.length) /
            pixels
        );
        const take = Math.min(patterns.length / pixels, room);
        if (take <= 0) return;
        const grown = new Uint8Array(
          bytesRef.current.length + take * pixels
        );
        grown.set(bytesRef.current);
        grown.set(
          patterns.subarray(0, take * pixels),
          bytesRef.current.length
        );
        const firstNew = bytesRef.current.length / pixels;
        bytesRef.current = grown;
        allThumbsDirtyRef.current = true;
        setPattern(firstNew);
        commit(firstNew);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const deletePattern = () => {
    if (count <= 1) return;
    const shrunk = new Uint8Array(bytesRef.current.length - pixels);
    shrunk.set(bytesRef.current.subarray(0, pattern * pixels));
    shrunk.set(
      bytesRef.current.subarray((pattern + 1) * pixels),
      pattern * pixels
    );
    bytesRef.current = shrunk;
    allThumbsDirtyRef.current = true;
    const next = Math.min(pattern, count - 2);
    setPattern(next);
    commit(next);
  };

  // Keyboard: Ctrl/Cmd+Z / Shift+Ctrl+Z / Ctrl+Y undo/redo, Ctrl/Cmd+C/V
  // copy/paste (Shift+V pastes over), plain Left/Right select the previous/
  // next pattern, Shift+arrows shift the pattern 8px, Ctrl+Shift+arrows 1px
  // (zx-tools' bindings) — while the editor is open, unless the keystroke
  // belongs to a focused text field, a canvas (the emulator swallows keys
  // when focused) or the tab strip. The handlers go through refs so the
  // listener binds once; the assignments must sit BELOW the handlers they
  // capture (these are vars after transpilation, so a forward reference
  // silently reads undefined).
  const undoRef = useRef(null);
  const redoRef = useRef(null);
  const shiftRef = useRef(null);
  const copyRef = useRef(null);
  const pasteRef = useRef(null);
  const selectRef = useRef(null);
  undoRef.current = undo;
  redoRef.current = redo;
  shiftRef.current = shiftPattern;
  copyRef.current = copyPattern;
  pasteRef.current = pastePattern;
  selectRef.current = selectPattern;
  useEffect(() => {
    const ARROWS = {
      arrowleft: [-1, 0],
      arrowright: [1, 0],
      arrowup: [0, -1],
      arrowdown: [0, 1],
    };
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
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (key === "z" || key === "y") {
          e.preventDefault();
          if (key === "y" || e.shiftKey) {
            redoRef.current();
          } else {
            undoRef.current();
          }
          return;
        }
        if (key === "c" && !e.shiftKey) {
          e.preventDefault();
          copyRef.current();
          return;
        }
        if (key === "v") {
          e.preventDefault();
          pasteRef.current(e.shiftKey);
          return;
        }
      }
      if (!ARROWS[key] || e.altKey) return;
      if (e.shiftKey) {
        e.preventDefault();
        const [dx, dy] = ARROWS[key];
        const step = e.ctrlKey || e.metaKey ? 1 : 8;
        shiftRef.current(dx * step, dy * step);
        return;
      }
      // Plain Left/Right: pattern navigation — but never while the focus is
      // on the tab strip, where the same keys drive PrimeReact's tabs.
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        (key === "arrowleft" || key === "arrowright") &&
        !(target.closest && target.closest(".p-tabview-nav"))
      ) {
        selectRef.current(key === "arrowright" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
          <Button
            icon="pi pi-circle-fill"
            className={`p-button-sm ${tool === "fill" ? "" : "p-button-outlined"}`}
            title={t("editor.sprites.fill")}
            onClick={() => setTool("fill")}
          />
        </div>
        <div className="sprite-editor-toolbar-group">
          <Button
            icon="pi pi-refresh"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.rotate")}
            onClick={rotatePattern}
          />
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
        <div className="sprite-editor-toolbar-group">
          <Button
            icon="pi pi-arrow-left"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.shift")}
            onClick={() => shiftPattern(-1, 0)}
          />
          <Button
            icon="pi pi-arrow-right"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.shift")}
            onClick={() => shiftPattern(1, 0)}
          />
          <Button
            icon="pi pi-arrow-up"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.shift")}
            onClick={() => shiftPattern(0, -1)}
          />
          <Button
            icon="pi pi-arrow-down"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.shift")}
            onClick={() => shiftPattern(0, 1)}
          />
        </div>
        <div className="sprite-editor-toolbar-group">
          <Button
            label={size === SPRITE_SIZE ? "16×16" : "8×8"}
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.gridMode")}
            disabled={!canToggleGrid}
            onClick={toggleGrid}
          />
          <Button
            label={fourBit ? "4-bit" : "8-bit"}
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.bitMode")}
            disabled={fourBit && !canBeEightBit}
            onClick={toggleFourBit}
          />
          {fourBit && (
            <Dropdown
              className="p-inputtext-sm"
              value={palOffset}
              options={Array.from({ length: 16 }, (_, i) => ({
                label: `${t("editor.sprites.palOffset")} ${i}`,
                value: i,
              }))}
              onChange={(e) => setPalOffset(e.value)}
              title={t("editor.sprites.palOffsetHint")}
            />
          )}
        </div>
        <div className="sprite-editor-toolbar-group">
          <Button
            icon="pi pi-code"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.copyAsm")}
            onClick={() => copySource(true)}
          />
          <Button
            icon="pi pi-database"
            className="p-button-sm p-button-outlined"
            title={t("editor.sprites.copyData")}
            onClick={() => copySource(false)}
          />
        </div>
        <span className="sprite-editor-hint">
          {sourceCopied
            ? t("editor.sprites.sourceCopied")
            : t("editor.sprites.pickHint")}
        </span>
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
          {palFiles.length > 0 && (
            <Dropdown
              className="sprite-editor-palette-pick p-inputtext-sm"
              value={palFileId}
              options={[
                { label: t("editor.sprites.paletteDefault"), value: null },
                ...palFiles.map((f) => ({
                  label: joinProjectFilePath(f.folder, f.name),
                  value: f.id,
                })),
              ]}
              onChange={(e) => setPalFileId(e.value)}
              title={t("editor.sprites.palettePick")}
            />
          )}
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
                  : { backgroundColor: palette[displayIndex(selectedColour)] }
              }
            />
            {tool === "erase"
              ? t("editor.sprites.transparent")
              : `$${selectedColour.toString(16).padStart(2, "0").toUpperCase()}`}
          </div>
          <div className="sprite-palette">
            {Array.from({ length: fourBit ? 16 : 256 }, (_, index) => (
              <div
                key={index}
                className={
                  index === selectedColour && tool === "pen"
                    ? "sprite-palette-swatch selected"
                    : "sprite-palette-swatch"
                }
                style={{ backgroundColor: palette[displayIndex(index)] }}
                title={
                  index === transparentIndex
                    ? `$${index.toString(16).padStart(2, "0").toUpperCase()} (${t("editor.sprites.transparent")})`
                    : `$${index.toString(16).padStart(2, "0").toUpperCase()}`
                }
                onClick={() => {
                  if (index === transparentIndex) {
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
            width={size}
            height={size}
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
            draggable
            onDragStart={(e) => {
              dragIndexRef.current = index;
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              movePattern(dragIndexRef.current, index);
              dragIndexRef.current = null;
            }}
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
        <Button
          icon="pi pi-clone"
          className="p-button-sm p-button-outlined"
          title={t("editor.sprites.duplicatePattern")}
          disabled={!canAddPattern}
          onClick={duplicatePattern}
        />
        <Button
          icon="pi pi-copy"
          className="p-button-sm p-button-outlined"
          title={t("editor.sprites.copyPattern")}
          onClick={copyPattern}
        />
        <Button
          icon="pi pi-clipboard"
          className="p-button-sm p-button-outlined"
          title={t("editor.sprites.pastePattern")}
          disabled={!hasClipboard}
          onClick={(e) => pastePattern(e.shiftKey)}
        />
        <Button
          icon="pi pi-image"
          className="p-button-sm p-button-outlined"
          title={
            fourBit
              ? t("editor.sprites.importImage4bit")
              : t("editor.sprites.importImage")
          }
          disabled={!canAddPattern || fourBit}
          onClick={() => importImageRef.current?.click()}
        />
        <input
          type="file"
          ref={importImageRef}
          accept="image/png,image/gif,image/jpeg,image/bmp,image/webp"
          style={{ display: "none" }}
          onChange={handleImportImage}
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
