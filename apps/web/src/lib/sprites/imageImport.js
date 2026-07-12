// Image -> sprite pattern conversion for the sprite editor's PNG import.
// Each pixel quantises to the default sprite palette, which is plain RGB332,
// so the nearest palette entry is exact channel maths rather than a search
// (zx-tools searches because it supports custom palettes). Transparency by
// alpha; opaque pixels that happen to land on the transparency index are
// nudged one blue step so they stay visible on hardware.

import { SPRITE_BYTES, SPRITE_SIZE, TRANSPARENT_INDEX } from "./spr";

const ALPHA_THRESHOLD = 128;

// Nearest RGB332 index for an opaque colour.
export function quantiseRGB(r, g, b) {
  const index =
    (Math.round((r * 7) / 255) << 5) |
    (Math.round((g * 7) / 255) << 2) |
    Math.round((b * 3) / 255);
  // $E3 (bright red + full blue) is the default transparency index; the
  // closest visible neighbour differs by one blue step.
  return index === TRANSPARENT_INDEX ? index - 1 : index;
}

// Converts RGBA pixels ({width, height, data} as from getImageData) into
// whole 16x16 patterns, left to right then top to bottom, padding partial
// edge cells with transparency. Returns a Uint8Array of N*256 bytes.
export function imageDataToPatterns(image) {
  const cols = Math.ceil(image.width / SPRITE_SIZE);
  const rows = Math.ceil(image.height / SPRITE_SIZE);
  const out = new Uint8Array(cols * rows * SPRITE_BYTES).fill(
    TRANSPARENT_INDEX
  );
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const o = (y * image.width + x) * 4;
      if (image.data[o + 3] < ALPHA_THRESHOLD) continue;
      const cell = Math.floor(y / SPRITE_SIZE) * cols + Math.floor(x / SPRITE_SIZE);
      const index =
        cell * SPRITE_BYTES +
        (y % SPRITE_SIZE) * SPRITE_SIZE +
        (x % SPRITE_SIZE);
      out[index] = quantiseRGB(
        image.data[o],
        image.data[o + 1],
        image.data[o + 2]
      );
    }
  }
  return out;
}
