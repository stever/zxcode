import { Router, Request, Response } from 'express';
import zmakebas, { ZmakebasMessage } from 'zmakebas';
import { GIFGenerator } from '../gif-generator.js';
import { withRenderSlot } from '../concurrency.js';

const router = Router();

type Format = 'gif' | 'mp4';

function readCode(req: Request): string | null {
    const code: unknown = typeof req.body === 'string' ? req.body : req.body?.code;
    return typeof code === 'string' && code.trim() ? code : null;
}

async function compile(code: string): Promise<{ tap: Uint8Array | null; detail: string }> {
    try {
        return { tap: await zmakebas(code), detail: '' };
    } catch (messages) {
        const detail = Array.isArray(messages)
            ? (messages as ZmakebasMessage[])
                .filter((m) => m.type === 'err')
                .map((m) => m.text)
                .join('\n')
            : String(messages);
        return { tap: null, detail: detail || 'unknown error' };
    }
}

/**
 * Compile BASIC and render it. GIF defaults to 2x (size-constrained), MP4 to 4x
 * (H.264 stays small at high resolution). On a compile error responds 400 with
 * the compiler messages so the caller can show the user what to fix.
 */
async function handle(format: Format, req: Request, res: Response): Promise<void> {
    try {
        const code = readCode(req);
        if (!code) {
            res.status(400).json({ error: 'No BASIC source provided' });
            return;
        }

        const maxSeconds = parseInt(req.query.maxSeconds as string) || 30;
        const staleThreshold = parseInt(req.query.staleThreshold as string) || 150;
        const machineType = req.query.machineType === 'next'
            ? ('next' as const)
            : parseInt(req.query.machineType as string) || 48;
        const scale = parseInt(req.query.scale as string) || (format === 'mp4' ? 4 : 2);

        const { tap: compiledTap, detail } = await compile(code);
        if (!compiledTap) {
            res.status(400).json({ error: 'BASIC compilation failed', detail });
            return;
        }

        const tap = Buffer.from(compiledTap);
        // Serialise every render through the one shared slot: the zx_go core is
        // a single global wasm machine, so concurrent renders corrupt each
        // other and sum their peak memory (OOM). See concurrency.ts.
        const media = await withRenderSlot(async () => {
            const generator = new GIFGenerator({
                maxDurationMs: maxSeconds * 1000,
                staleFrameThreshold: staleThreshold,
                scale,
            });
            await generator.initialize();
            console.log(`Generating ${format.toUpperCase()} from ${code.length} bytes of BASIC...`);
            return format === 'mp4'
                ? generator.generateMp4FromTAP(tap, machineType)
                : generator.generateFromTAP(tap, machineType);
        });
        res.setHeader('Content-Type', format === 'mp4' ? 'video/mp4' : 'image/gif');
        res.send(media);
    } catch (error: any) {
        console.error(`Error generating ${format} from BASIC:`, error);
        res.status(500).json({ error: error.message });
    }
}

router.post('/basic-to-gif', (req, res) => handle('gif', req, res));
router.post('/basic-to-mp4', (req, res) => handle('mp4', req, res));

export default router;
