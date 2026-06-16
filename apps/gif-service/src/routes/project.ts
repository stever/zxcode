import { Router, Request, Response } from 'express';
import { GIFGenerator } from '../gif-generator.js';
import { fetchProject } from '../hasura.js';
import { compileProjectIsolated } from '../compile-isolated.js';
import { CompileError } from '../errors.js';

const router = Router();

type Format = 'gif' | 'mp4';

const SLUG = /^[a-z0-9-]+$/i;

interface ProjectRef {
    userSlug: string;
    projectSlug: string;
}

function readProjectRef(req: Request): ProjectRef | null {
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const { userSlug, projectSlug } = body;
    if (
        typeof userSlug === 'string' &&
        typeof projectSlug === 'string' &&
        SLUG.test(userSlug) &&
        SLUG.test(projectSlug)
    ) {
        return { userSlug: userSlug.toLowerCase(), projectSlug: projectSlug.toLowerCase() };
    }
    return null;
}

/**
 * Look up a public code.zxplay.org project, compile it for its language, and
 * render it. Mirrors the BASIC route but resolves the source from Hasura and
 * picks a compiler by `lang`. A compile failure responds 400 with the detail;
 * a missing or private project responds 404.
 */
async function handle(format: Format, req: Request, res: Response): Promise<void> {
    try {
        const ref = readProjectRef(req);
        if (!ref) {
            res.status(400).json({ error: 'No valid project reference provided' });
            return;
        }

        const project = await fetchProject(ref.userSlug, ref.projectSlug);
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
            tap = await compileProjectIsolated(project.lang, project.code);
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
            `Generating ${format.toUpperCase()} from project ${ref.userSlug}/${ref.projectSlug} (lang=${project.lang})...`,
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
