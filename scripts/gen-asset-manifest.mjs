#!/usr/bin/env node
// Generate <publicDir>/asset-manifest.json: maps each servable /dist and /next
// asset to a short content hash, consumed at runtime for ?v=<hash> cache-
// busting (see packages/emulator/src/zxgo/assetManifest.js). Run as a late
// build step, after webpack, the emulator copy, and the 8bitworker build have
// populated public/dist, and with public/next staged.
//
// Usage: node scripts/gen-asset-manifest.mjs <publicDir>

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const publicDir = process.argv[2];
if (!publicDir) {
    console.error('usage: gen-asset-manifest.mjs <publicDir>');
    process.exit(1);
}

// Precompressed sidecars share their parent's content; skip them and the
// manifest itself.
const skip = (name) => name.endsWith('.br') || name.endsWith('.gz') || name === 'asset-manifest.json';

function walk(dir, out) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return out; // dir absent (e.g. no /next staged) — fine
    }
    for (const name of entries) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            walk(full, out);
        } else if (!skip(name)) {
            const hash = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16);
            out['/' + relative(publicDir, full).split('\\').join('/')] = hash;
        }
    }
    return out;
}

const manifest = {};
walk(join(publicDir, 'dist'), manifest);
walk(join(publicDir, 'next'), manifest);

// Stable key order keeps the file diff-friendly.
const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
writeFileSync(join(publicDir, 'asset-manifest.json'), JSON.stringify(sorted, null, 2) + '\n');
console.log(`asset-manifest.json: ${Object.keys(sorted).length} entries`);
