import { Router, Request, Response } from 'express';
import { mkdir, readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import { GIFGenerator } from '../gif-generator.js';
import { fetchProjectById } from '../hasura.js';
import { compileProjectIsolated } from '../compile-isolated.js';
import { withRenderSlot } from '../concurrency.js';
import { CompileError } from '../errors.js';

const router = Router();

const CACHE_DIR = process.env.SCREENSHOT_CACHE_DIR ?? '/cache';
// Bump when the render output changes (size, padding, etc.) so cached PNGs
// from older logic are superseded without manually clearing the volume.
const RENDER_VERSION = 'v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Single-flight: collapse concurrent requests for the same cache key onto one render.
const inFlight = new Map<string, Promise<Buffer>>();

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Serve a PNG screenshot of a public project, with the ZX ribbon baked into a
 * corner. Cached per project + updated_at, so it self-invalidates on edit and
 * the cache can't be exploded with arbitrary keys. 404 (→ web shows the
 * cartridge fallback) when the project is missing or not public.
 */
router.get('/:id', async (req: Request, res: Response) => {
    const id = (req.params.id || '').replace(/\.png$/i, '').toLowerCase();
    if (!UUID.test(id)) {
        res.status(400).end();
        return;
    }

    try {
        const project = await fetchProjectById(id);
        if (!project) {
            // Negative-cache so the browser doesn't re-request missing/private
            // projects on every page load (web shows the cartridge fallback).
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.status(404).end();
            return;
        }

        const key = `${RENDER_VERSION}-${id}-${Date.parse(project.updated_at) || 0}`;
        const file = join(CACHE_DIR, `${key}.png`);

        let png: Buffer;
        if (await fileExists(file)) {
            png = await readFile(file);
        } else {
            let pending = inFlight.get(key);
            if (!pending) {
                pending = withRenderSlot(async () => {
                    const tap = await compileProjectIsolated(project.lang, project.code);
                    const generator = new GIFGenerator({ maxDurationMs: 2500, scale: 2 });
                    await generator.initialize();
                    const out = await generator.generatePngFromTAP(tap, 48);
                    await mkdir(CACHE_DIR, { recursive: true }).catch(() => undefined);
                    await writeFile(file, out).catch(() => undefined);
                    return out;
                });
                inFlight.set(key, pending);
                // Clear the slot when done. The trailing .catch is essential: the
                // real error is surfaced via `await pending` below, but this
                // derived promise would otherwise reject unhandled and crash the
                // process (Node exits on unhandledRejection).
                pending.finally(() => inFlight.delete(key)).catch(() => undefined);
            }
            png = await pending;
        }

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(png);
    } catch (err) {
        if (err instanceof CompileError) {
            // Unrenderable (e.g. zmac/sdcc not supported, or bad source) → web
            // falls back to the cartridge. Negative-cache to avoid re-rendering
            // it on every page load.
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.status(422).end();
            return;
        }
        console.error('Screenshot error:', err);
        res.status(500).end();
    }
});

export default router;
