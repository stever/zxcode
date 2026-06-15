import { Router } from 'express';
import multer from 'multer';
import { GIFGenerator } from '../gif-generator.js';

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
        const machineType = parseInt(req.query.machineType as string) || 128;

        const generator = new GIFGenerator({
            maxDurationMs: maxSeconds * 1000,
            staleFrameThreshold: staleThreshold,
        });

        await generator.initialize();

        console.log(`Generating GIF from ${req.file.originalname}...`);
        const gifBuffer = await generator.generateFromTAP(req.file.buffer, machineType);
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
