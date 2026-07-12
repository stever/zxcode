// ZX Spectrum Next .spr sprite pattern files: raw 16x16-pixel patterns, one
// byte per pixel, 256 bytes per pattern, no header (the format Remy Sharp's
// zx-tools editor and NextBASIC's LOAD "file.spr" BANK workflow exchange).
// Each byte indexes the sprite palette; the hardware's default palette maps
// the index as RGB332 expanded to the Next's 9-bit colour (the blue LSB is
// the OR of the two blue bits), and index $E3 is the default transparency.
// 4-bit (128 bytes per pattern) files exist too but carry no marker that
// distinguishes them, so the editor treats every .spr as 8-bit.

export const SPRITE_SIZE = 16;
export const SPRITE_BYTES = SPRITE_SIZE * SPRITE_SIZE;
export const TRANSPARENT_INDEX = 0xe3;

// Files saved from NextZXOS (SAVE "x.spr" CODE / BANK) carry a 128-byte
// +3DOS header before the pattern data: "PLUS3DOS", $1A, issue/version,
// a total-length dword at 11, the BASIC header data (CODE type + data
// length) at 15, and a mod-256 checksum of bytes 0..126 at 127. The editor
// keeps the header byte for byte and rewrites its length fields and
// checksum when the pattern count changes, so a round-tripped file still
// LOADs on the machine.
export const PLUS3DOS_HEADER_SIZE = 128;
const PLUS3DOS_SIGNATURE = "PLUS3DOS\x1a";

export function isSpriteFileName(name) {
  return /\.spr$/i.test(name || "");
}

// Project files store binary content base64-encoded (see project_file's
// is_binary column); these mirror the upload path's encoding.
export function base64ToBytes(content) {
  const binary = atob(content || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// Raw byte length of a base64 string without decoding it.
export function base64ByteLength(content) {
  const b64 = content || "";
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function bytesHaveSignature(bytes) {
  if (bytes.length < PLUS3DOS_SIGNATURE.length) return false;
  for (let i = 0; i < PLUS3DOS_SIGNATURE.length; i++) {
    if (bytes[i] !== PLUS3DOS_SIGNATURE.charCodeAt(i)) return false;
  }
  return true;
}

function bytesHavePlus3DosHeader(bytes) {
  return bytes.length >= PLUS3DOS_HEADER_SIZE && bytesHaveSignature(bytes);
}

// Cheap +3DOS sniff on stored base64: the signature fits in the first 18
// bytes, so decoding a 24-char prefix suffices. Runs per render, so it
// must not decode the whole file. Callers gate on file size first.
export function base64HasPlus3DosSignature(content) {
  return bytesHaveSignature(base64ToBytes((content || "").slice(0, 24)));
}

// Only files sized header + whole patterns are candidates (their size mod
// 256 is exactly 128).
function contentHasPlus3DosHeader(content) {
  const size = base64ByteLength(content);
  if (size <= PLUS3DOS_HEADER_SIZE || size % SPRITE_BYTES !== PLUS3DOS_HEADER_SIZE) {
    return false;
  }
  return base64HasPlus3DosSignature(content);
}

// The editor opens a .spr only when it holds a whole number of 8-bit
// patterns — bare, or behind a +3DOS header; anything else (empty,
// truncated, or an odd 4-bit layout) keeps the plain binary-asset panel.
export function isEditableSpriteContent(content) {
  const size = base64ByteLength(content);
  if (size > 0 && size % SPRITE_BYTES === 0) return true;
  return contentHasPlus3DosHeader(content);
}

// Splits a sprite file into its optional +3DOS header and the pattern data.
export function splitSpriteFile(bytes) {
  if (bytesHavePlus3DosHeader(bytes)) {
    return {
      header: bytes.slice(0, PLUS3DOS_HEADER_SIZE),
      data: bytes.slice(PLUS3DOS_HEADER_SIZE),
    };
  }
  return { header: null, data: bytes };
}

// Rebuilds the file from a (possibly null) header and the pattern data,
// refreshing the header's total-length dword, CODE data length word and
// checksum so edits that grow or shrink the file stay loadable.
export function joinSpriteFile(header, data) {
  if (!header) return data;
  const bytes = new Uint8Array(PLUS3DOS_HEADER_SIZE + data.length);
  bytes.set(header);
  bytes.set(data, PLUS3DOS_HEADER_SIZE);
  const total = bytes.length;
  bytes[11] = total & 0xff;
  bytes[12] = (total >> 8) & 0xff;
  bytes[13] = (total >> 16) & 0xff;
  bytes[14] = (total >> 24) & 0xff;
  bytes[16] = data.length & 0xff;
  bytes[17] = (data.length >> 8) & 0xff;
  let sum = 0;
  for (let i = 0; i < PLUS3DOS_HEADER_SIZE - 1; i++) {
    sum += bytes[i];
  }
  bytes[PLUS3DOS_HEADER_SIZE - 1] = sum & 0xff;
  return bytes;
}

export function spritePatternCount(byteLength) {
  return Math.floor(byteLength / SPRITE_BYTES);
}

// A single all-transparent pattern: the content a newly created .spr file
// starts with.
export function blankSpriteBase64() {
  return bytesToBase64(new Uint8Array(SPRITE_BYTES).fill(TRANSPARENT_INDEX));
}

// The default sprite palette as CSS colours, index 0..255. RGB332: three
// bits red, three green, two blue, with the 9-bit blue reconstructed as
// (BB << 1) | (B1 OR B0) per the hardware's reset palette. 3-bit channels
// scale to 8 bits by rounding v * 255 / 7.
function channel(v3) {
  return Math.round((v3 * 255) / 7);
}

export function defaultSpritePalette() {
  const palette = [];
  for (let i = 0; i < 256; i++) {
    const r = channel((i >> 5) & 7);
    const g = channel((i >> 2) & 7);
    const b2 = i & 3;
    const b = channel((b2 << 1) | (b2 === 0 ? 0 : 1));
    palette.push(
      `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
    );
  }
  return palette;
}
