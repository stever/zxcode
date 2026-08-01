import { Router, Request, Response } from 'express';
import { GIFGenerator } from '../gif-generator.js';
import { compileProjectIsolated } from '../compile-isolated.js';
import { withRenderSlot } from '../concurrency.js';
import { CompileError } from '../errors.js';

const router = Router();

type Format = 'gif' | 'mp4';

function readSource(req: Request): { code: string; lang: string } | null {
    if (typeof req.body === 'string') {
        return req.body.trim() ? { code: req.body, lang: 'basic' } : null;
    }
    const body = req.body ?? {};
    const code: unknown = body.code;
    const lang: unknown = body.lang;
    if (typeof code === 'string' && code.trim()) {
        return { code, lang: typeof lang === 'string' && lang ? lang : 'basic' };
    }
    return null;
}

/**
 * Compile inline source for a given language and render it. Generalises the
 * BASIC route via compileProject, so the bot can render pasted assembly
 * (lang=asm, pasmo) as well as BASIC. A compile failure responds 400 with the
 * compiler messages.
 */
async function handle(format: Format, req: Request, res: Response): Promise<void> {
    try {
        const source = readSource(req);
        if (!source) {
            res.status(400).json({ error: 'No source provided' });
            return;
        }

        const maxSeconds = parseInt(req.query.maxSeconds as string) || 30;
        const staleThreshold = parseInt(req.query.staleThreshold as string) || 150;
        const machineType = req.query.machineType === 'next'
            ? ('next' as const)
            : parseInt(req.query.machineType as string) || 48;
        const scale = parseInt(req.query.scale as string) || (format === 'mp4' ? 3 : 2);

        let tap: Buffer;
        try {
            tap = await compileProjectIsolated(source.lang, source.code, String(machineType));
        } catch (err) {
            if (err instanceof CompileError) {
                res.status(400).json({ error: 'Compilation failed', detail: err.message });
                return;
            }
            throw err;
        }

        // Serialise every render through the one shared slot: the zxplay_go core is
        // a single global wasm machine, so concurrent renders corrupt each
        // other and sum their peak memory (OOM). See concurrency.ts.
        const media = await withRenderSlot(async () => {
            const generator = new GIFGenerator({
                maxDurationMs: maxSeconds * 1000,
                staleFrameThreshold: staleThreshold,
                scale,
            });
            await generator.initialize();
            console.log(
                `Generating ${format.toUpperCase()} from ${source.code.length} bytes of ${source.lang}...`,
            );
            return format === 'mp4'
                ? generator.generateMp4FromTAP(tap, machineType)
                : generator.generateFromTAP(tap, machineType);
        });
        res.setHeader('Content-Type', format === 'mp4' ? 'video/mp4' : 'image/gif');
        res.send(media);
    } catch (error: any) {
        console.error(`Error generating ${format} from source:`, error);
        res.status(500).json({ error: error.message });
    }
}

router.post('/source-to-gif', (req, res) => handle('gif', req, res));
router.post('/source-to-mp4', (req, res) => handle('mp4', req, res));

export default router;
