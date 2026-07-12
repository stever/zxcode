// Next tile map files (.map): a W x H grid of one-byte tile indices, no
// header and no stored dimensions (zx-tools prompts for them; NextZXOS
// LOADs the raw bytes into a bank). The editor persists the chosen width
// per file and derives the height; a +3DOS header, when present, rides
// along via the same split/join machinery as .spr. The hardware's optional
// 2-byte cell mode (attribute byte with palette offset/mirror/rotate) is
// not covered yet.

import { base64ByteLength, bytesToBase64 } from "./spr";

export const DEFAULT_MAP_WIDTH = 32;
export const DEFAULT_MAP_HEIGHT = 24;

export function isMapFileName(name) {
  return /\.map$/i.test(name || "");
}

// Any non-empty payload is paintable — the width chooser only offers
// divisors of the byte count.
export function isEditableMapContent(content) {
  return base64ByteLength(content) > 0;
}

// Content for a newly created .map: a blank 32x24 screen of tile 0.
export function defaultMapBase64() {
  return bytesToBase64(
    new Uint8Array(DEFAULT_MAP_WIDTH * DEFAULT_MAP_HEIGHT)
  );
}

// Widths offered for a map of this many cells: divisors in a sane range,
// widest-common first so 32 (the hardware's screen width) wins as default.
export function mapWidthOptions(cellCount) {
  const widths = [];
  for (let w = 1; w <= Math.min(cellCount, 1024); w++) {
    if (cellCount % w === 0) widths.push(w);
  }
  return widths;
}

export function defaultMapWidth(cellCount) {
  if (cellCount % DEFAULT_MAP_WIDTH === 0) return DEFAULT_MAP_WIDTH;
  const options = mapWidthOptions(cellCount);
  // The divisor closest to 32.
  return options.reduce((best, w) =>
    Math.abs(w - DEFAULT_MAP_WIDTH) < Math.abs(best - DEFAULT_MAP_WIDTH)
      ? w
      : best
  );
}
