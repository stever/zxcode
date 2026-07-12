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

// The editor opens a .spr only when it holds a whole number of 8-bit
// patterns; anything else (empty, truncated, or an odd 4-bit layout) keeps
// the plain binary-asset panel.
export function isEditableSpriteContent(content) {
  const size = base64ByteLength(content);
  return size > 0 && size % SPRITE_BYTES === 0;
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
