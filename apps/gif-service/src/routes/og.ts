import { Router, Request, Response } from 'express';
import { fetchProjectMetaBySlug, fetchProjectMetaById, ProjectMeta } from '../hasura.js';

// OpenGraph cards for shared project links. Caddy routes only social-crawler
// requests for /u/* and /projects/* here; real users fall through to the SPA.
// So we serve a small purpose-built page with the project's card metadata
// (og:image -> the rendered screenshot) — crawlers parse the tags, they don't
// run the app.
const router = Router();

const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN ?? 'https://code.zxplay.org').replace(/\/$/, '');
const SLUG = /^[a-z0-9-]+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function esc(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

const SITE_TITLE = 'Code · ZX Play';
const SITE_DESC = 'A ZX Spectrum emulator & programming environment for the browser.';
const SITE_IMAGE = `${PUBLIC_ORIGIN}/assets/images/embed-preview.png`;

function ogPage(opts: { title: string; description: string; image: string; url: string }): string {
    const title = esc(opts.title);
    const description = esc(opts.description);
    const image = esc(opts.image);
    const url = esc(opts.url);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${image}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
</head>
<body><p><a href="${esc(opts.url || PUBLIC_ORIGIN)}">View on ZX Play</a></p></body>
</html>`;
}

function projectCard(meta: ProjectMeta, canonicalUrl: string): string {
    const version = Date.parse(meta.updatedAt) || 0;
    return ogPage({
        title: `${meta.title} · ZX Play`,
        description: `${meta.title} — a ZX Spectrum program on ZX Play.`,
        image: `${PUBLIC_ORIGIN}/screenshots/${meta.projectId}.png?v=${version}`,
        url: canonicalUrl,
    });
}

const genericCard = (url: string): string =>
    ogPage({ title: SITE_TITLE, description: SITE_DESC, image: SITE_IMAGE, url: url || PUBLIC_ORIGIN });

async function send(res: Response, html: string): Promise<void> {
    // Short cache: a crawler re-fetch picks up edits / new screenshots reasonably soon.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('html').send(html);
}

router.get('/u/:user/:project', async (req: Request, res: Response) => {
    const user = (req.params.user || '').toLowerCase();
    const project = (req.params.project || '').toLowerCase();
    const canonical = `${PUBLIC_ORIGIN}/u/${req.params.user}/${req.params.project}`;
    if (SLUG.test(user) && SLUG.test(project)) {
        try {
            const meta = await fetchProjectMetaBySlug(user, project);
            if (meta) {
                await send(res, projectCard(meta, canonical));
                return;
            }
        } catch (err) {
            console.error('OG slug lookup failed:', err);
        }
    }
    await send(res, genericCard(canonical));
});

router.get('/projects/:id', async (req: Request, res: Response) => {
    const id = (req.params.id || '').toLowerCase();
    const canonical = `${PUBLIC_ORIGIN}/projects/${req.params.id}`;
    if (UUID.test(id)) {
        try {
            const meta = await fetchProjectMetaById(id);
            if (meta) {
                await send(res, projectCard(meta, canonical));
                return;
            }
        } catch (err) {
            console.error('OG id lookup failed:', err);
        }
    }
    await send(res, genericCard(canonical));
});

// Other crawler hits under these prefixes (profiles, lists) → generic site card.
router.get(['/u', '/u/*', '/projects', '/projects/*'], async (_req: Request, res: Response) => {
    await send(res, genericCard(''));
});

export default router;
