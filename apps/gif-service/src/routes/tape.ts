import { Router } from 'express';
import multer from 'multer';
import { GIFGenerator } from '../gif-generator.js';
import { withRenderSlot } from '../concurrency.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/tape-to-gif', upload.single('tape'), async (req, res) => {
    try {
        if (!req.file) {
            res.status(400).json({ error: 'No tape file uploaded' });
            return;
        }

        const maxSeconds = parseInt(req.query.maxSeconds as string) || 30;
        const staleThreshold = parseInt(req.query.staleThreshold as string) || 150;
        const machineType = req.query.machineType === 'next'
            ? ('next' as const)
            : parseInt(req.query.machineType as string) || 128;

        // Serialise every render through the one shared slot: the zxplay_go core is
        // a single global wasm machine, so concurrent renders corrupt each
        // other and sum their peak memory (OOM). See concurrency.ts.
        const gifBuffer = await withRenderSlot(async () => {
            const generator = new GIFGenerator({
                maxDurationMs: maxSeconds * 1000,
                staleFrameThreshold: staleThreshold,
            });
            await generator.initialize();
            console.log(`Generating GIF from ${req.file!.originalname}...`);
            return generator.generateFromTAP(req.file!.buffer, machineType);
        });
        console.log(`GIF generated: ${gifBuffer.length} bytes`);

        res.setHeader('Content-Type', 'image/gif');
        res.setHeader('Content-Disposition', `attachment; filename="${req.file.originalname}.gif"`);
        res.send(gifBuffer);
    } catch (error: any) {
        console.error('Error generating GIF:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
