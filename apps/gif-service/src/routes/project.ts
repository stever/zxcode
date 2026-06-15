import { Router, Request, Response } from 'express';
import { GIFGenerator } from '../gif-generator.js';
import { fetchProject } from '../hasura.js';
import { compileProject } from '../compile.js';
import { CompileError } from '../errors.js';

const router = Router();

type Format = 'gif' | 'mp4';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readProjectId(req: Request): string | null {
    const id: unknown = typeof req.body === 'object' && req.body ? req.body.projectId : undefined;
    return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
}

/**
 * Look up a public code.zxplay.org project, compile it for its language, and
 * render it. Mirrors the BASIC route but resolves the source from Hasura and
 * picks a compiler by `lang`. A compile failure responds 400 with the detail;
 * a missing or private project responds 404.
 */
async function handle(format: Format, req: Request, res: Response): Promise<void> {
    try {
        const projectId = readProjectId(req);
        if (!projectId) {
            res.status(400).json({ error: 'No valid projectId provided' });
            return;
        }

        const project = await fetchProject(projectId);
        if (!project) {
            res.status(404).json({ error: 'Project not found or not public' });
            return;
        }

        const maxSeconds = parseInt(req.query.maxSeconds as string) || 30;
        const staleThreshold = parseInt(req.query.staleThreshold as string) || 150;
        const machineType = parseInt(req.query.machineType as string) || 48;
        const scale = parseInt(req.query.scale as string) || (format === 'mp4' ? 4 : 2);

        let tap: Buffer;
        try {
            tap = await compileProject(project.lang, project.code);
        } catch (err) {
            if (err instanceof CompileError) {
                res.status(400).json({ error: 'Project failed to compile', detail: err.message });
                return;
            }
            throw err;
        }

        const generator = new GIFGenerator({
            maxDurationMs: maxSeconds * 1000,
            staleFrameThreshold: staleThreshold,
            scale,
        });
        await generator.initialize();

        console.log(
            `Generating ${format.toUpperCase()} from project ${projectId} (lang=${project.lang})...`,
        );
        if (format === 'mp4') {
            const mp4 = await generator.generateMp4FromTAP(tap, machineType);
            res.setHeader('Content-Type', 'video/mp4');
            res.send(mp4);
        } else {
            const gif = await generator.generateFromTAP(tap, machineType);
            res.setHeader('Content-Type', 'image/gif');
            res.send(gif);
        }
    } catch (error: any) {
        console.error(`Error generating ${format} from project:`, error);
        res.status(500).json({ error: error.message });
    }
}

router.post('/project-to-gif', (req, res) => handle('gif', req, res));
router.post('/project-to-mp4', (req, res) => handle('mp4', req, res));

export default router;
