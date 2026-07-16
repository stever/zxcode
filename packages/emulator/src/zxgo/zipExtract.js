// Native zip extraction: parse the central directory ourselves and inflate
// entries with the browser's DecompressionStream ('deflate-raw' — native
// zlib, an order of magnitude faster than JSZip's JavaScript inflate), so a
// multi-MB game zip stages onto the SD card in seconds instead of minutes.
// Returns null when the zip needs features this parser doesn't cover
// (encryption, zip64, exotic compression methods) — callers fall back to
// JSZip for those.
//
// Entry shape (shared with the JSZip fallback in GoEmulator):
//   { path, size, bytes: async () => Uint8Array }

export function nativeZipEntries(buf) {
    if (typeof DecompressionStream === 'undefined') return null;
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    // End-of-central-directory: scan back over the (up to 64KB) trailing
    // comment for the signature.
    let eocd = -1;
    const lo = Math.max(0, u8.length - 65558);
    for (let i = u8.length - 22; i >= lo; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || off === 0xffffffff) return null; // zip64
    const utf8 = new TextDecoder();
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) return null;
        const flags = dv.getUint16(off + 8, true);
        const method = dv.getUint16(off + 10, true);
        const csize = dv.getUint32(off + 20, true);
        const usize = dv.getUint32(off + 24, true);
        const nameLen = dv.getUint16(off + 28, true);
        const extraLen = dv.getUint16(off + 30, true);
        const commentLen = dv.getUint16(off + 32, true);
        const localOff = dv.getUint32(off + 42, true);
        if (flags & 0x0001) return null; // encrypted
        if (method !== 0 && method !== 8) return null; // stored/deflate only
        if (csize === 0xffffffff || usize === 0xffffffff || localOff === 0xffffffff) return null; // zip64
        // A data-descriptor flag (bit 3) is fine: the central directory
        // read above still carries the entry's real sizes.
        const path = utf8.decode(u8.subarray(off + 46, off + 46 + nameLen));
        if (!path.endsWith('/')) {
            entries.push({
                path,
                size: usize,
                bytes: () => extractEntry(buf, dv, localOff, csize, usize, method),
            });
        }
        off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

async function extractEntry(buf, dv, localOff, csize, usize, method) {
    if (dv.getUint32(localOff, true) !== 0x04034b50) {
        throw new Error('zip: bad local file header');
    }
    // The local header's name/extra lengths can differ from the central
    // directory's, so the data offset must come from here.
    const nameLen = dv.getUint16(localOff + 26, true);
    const extraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + nameLen + extraLen;
    const raw = new Uint8Array(buf, start, csize);
    if (method === 0) return raw;
    const out = new Uint8Array(await new Response(
        new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    ).arrayBuffer());
    if (out.length !== usize) throw new Error('zip: inflated size mismatch');
    return out;
}
