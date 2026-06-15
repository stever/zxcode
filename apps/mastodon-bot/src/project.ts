const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Find a code.zxplay.org project link in a status's HTML content and return its
 * id. Matches the canonical project URL, https://<host>/projects/<uuid>, whether
 * it appears as an <a href> or as plain text. Returns null when there is none.
 *
 * The prettier /u/<user>/<slug> URLs are not handled yet: they need a slug
 * lookup, so for now a sharer links the /projects/<id> form.
 */
export function extractProjectId(content: string, host: string): string | null {
    const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`https?://${escapedHost}/projects/(${UUID})`, 'i');
    const match = content.match(re);
    return match ? match[1].toLowerCase() : null;
}
