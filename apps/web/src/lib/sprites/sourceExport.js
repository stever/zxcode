// Sprite data as source text for the editor's copy-to-clipboard actions:
// assembly `db` rows or BASIC DATA lines, over the packed file bytes (what
// INCBIN or a DATA loader would embed — never the +3DOS header). Sensible
// fixed formatting instead of zx-tools' option matrix: 16 bytes per row,
// one comment per pattern.

const BYTES_PER_ROW = 16;

function chunkRows(bytes, from, to) {
  const rows = [];
  for (let i = from; i < to; i += BYTES_PER_ROW) {
    rows.push(Array.from(bytes.subarray(i, Math.min(i + BYTES_PER_ROW, to))));
  }
  return rows;
}

// patternBytes: on-disk bytes per pattern (32..256 depending on grid/depth),
// used to group rows under one comment per pattern.
export function toAsmSource(bytes, patternBytes, description) {
  const lines = [`; ${description}`, "sprites:"];
  const patterns = Math.floor(bytes.length / patternBytes);
  for (let p = 0; p < patterns; p++) {
    lines.push(`; pattern ${p}`);
    for (const row of chunkRows(bytes, p * patternBytes, (p + 1) * patternBytes)) {
      lines.push(
        "    db " +
          row.map((b) => `$${b.toString(16).padStart(2, "0")}`).join(",")
      );
    }
  }
  return lines.join("\n") + "\n";
}

export function toBasicData(bytes, { startLine = 9000, step = 10 } = {}) {
  const lines = [];
  let line = startLine;
  for (const row of chunkRows(bytes, 0, bytes.length)) {
    lines.push(`${line} DATA ${row.join(",")}`);
    line += step;
  }
  return lines.join("\n") + "\n";
}
