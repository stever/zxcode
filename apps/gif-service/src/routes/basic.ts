import { Router } from 'express';
import zmakebas, { ZmakebasMessage } from 'zmakebas';
import { GIFGenerator } from '../gif-generator.js';

const router = Router();

/**
 * POST /api/basic-to-gif
 *
 * Body: JSON `{ "code": "10 PRINT ..." }` or raw `text/plain` BASIC source.
 * Compiles the source to a .tap with zmakebas, runs it, and returns an
 * animated GIF. On a compile error responds 400 with the compiler messages so
 * the caller can show the user what to fix.
 */
router.post('/basic-to-gif', async (req, res) => {
    try {
        const code: unknown = typeof req.body === 'string' ? req.body : req.body?.code;
        if (typeof code !== 'string' || !code.trim()) {
            res.status(400).json({ error: 'No BASIC source provided' });
            return;
        }

        const maxSeconds = parseInt(req.query.maxSeconds as string) || 30;
        const staleThreshold = parseInt(req.query.staleThreshold as string) || 150;
        const machineType = parseInt(req.query.machineType as string) || 128;

        let tap: Uint8Array;
        try {
            tap = await zmakebas(code);
        } catch (messages) {
            const detail = Array.isArray(messages)
                ? (messages as ZmakebasMessage[])
                    .filter((m) => m.type === 'err')
                    .map((m) => m.text)
                    .join('\n')
                : String(messages);
            res.status(400).json({ error: 'BASIC compilation failed', detail: detail || 'unknown error' });
            return;
        }

        const generator = new GIFGenerator({
            maxDurationMs: maxSeconds * 1000,
            staleFrameThreshold: staleThreshold,
        });
        await generator.initialize();

        console.log(`Generating GIF from ${code.length} bytes of BASIC...`);
        const gifBuffer = await generator.generateFromTAP(Buffer.from(tap), machineType);
        console.log(`GIF generated: ${gifBuffer.length} bytes`);

        res.setHeader('Content-Type', 'image/gif');
        res.send(gifBuffer);
    } catch (error: any) {
        console.error('Error generating GIF from BASIC:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
