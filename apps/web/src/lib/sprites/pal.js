// ZX Spectrum Next .pal palette files: 256 entries of 2 bytes, exactly the
// pair written to the palette value nextregs (and what zx-tools reads and
// writes) — first byte RRRGGGBB, second byte %P000000B carrying the Layer 2
// priority flag in bit 7 and the 9-bit blue LSB in bit 0. Internally an
// entry is the 9-bit colour RRRGGGBBB plus a priority boolean.

import {
  base64ByteLength,
  base64HasPlus3DosSignature,
  bytesToBase64,
  PLUS3DOS_HEADER_SIZE,
} from "./spr";

export const PALETTE_ENTRIES = 256;
export const PAL_FILE_SIZE = PALETTE_ENTRIES * 2;

export function isPaletteFileName(name) {
  return /\.pal$/i.test(name || "");
}

// A .pal opens in the palette editor when it is exactly 256 entries — bare
// or behind a +3DOS header.
export function isEditablePaletteContent(content) {
  const size = base64ByteLength(content);
  if (size === PAL_FILE_SIZE) return true;
  return (
    size === PAL_FILE_SIZE + PLUS3DOS_HEADER_SIZE &&
    base64HasPlus3DosSignature(content)
  );
}

// 9-bit colour (RRRGGGBBB) -> CSS hex, channels scaled 0..7 -> 0..255.
export function css9(value9) {
  const r = Math.round((((value9 >> 6) & 7) * 255) / 7);
  const g = Math.round((((value9 >> 3) & 7) * 255) / 7);
  const b = Math.round(((value9 & 7) * 255) / 7);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// The hardware reset palette: each index expanded RGB332 -> 9-bit with the
// blue LSB the OR of the two blue bits.
export function defaultPalette9() {
  const values = new Uint16Array(PALETTE_ENTRIES);
  for (let i = 0; i < PALETTE_ENTRIES; i++) {
    values[i] = (i << 1) | (((i & 2) >> 1) | (i & 1));
  }
  return values;
}

// Parses the 512 data bytes (caller strips any +3DOS header first).
export function parsePalette(bytes) {
  const values = new Uint16Array(PALETTE_ENTRIES);
  const priority = new Array(PALETTE_ENTRIES).fill(false);
  for (let i = 0; i < PALETTE_ENTRIES; i++) {
    const b0 = bytes[i * 2];
    const b1 = bytes[i * 2 + 1];
    values[i] = (b0 << 1) | (b1 & 1);
    priority[i] = (b1 & 0x80) !== 0;
  }
  return { values, priority };
}

export function serialisePalette({ values, priority }) {
  const bytes = new Uint8Array(PAL_FILE_SIZE);
  for (let i = 0; i < PALETTE_ENTRIES; i++) {
    bytes[i * 2] = (values[i] >> 1) & 0xff;
    bytes[i * 2 + 1] = (priority[i] ? 0x80 : 0) | (values[i] & 1);
  }
  return bytes;
}

// Content for a newly created .pal file: the hardware default palette.
export function defaultPaletteBase64() {
  return bytesToBase64(
    serialisePalette({
      values: defaultPalette9(),
      priority: new Array(PALETTE_ENTRIES).fill(false),
    })
  );
}

// CSS colours for rendering sprites through a stored .pal (any +3DOS
// header already stripped by the caller); falls back to null when the
// content is not a readable palette.
export function paletteCssFromBytes(bytes) {
  if (bytes.length !== PAL_FILE_SIZE) return null;
  const { values } = parsePalette(bytes);
  return Array.from(values, css9);
}
