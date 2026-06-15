export interface ProjectRef {
    userSlug: string;
    projectSlug: string;
}

const SLUG = '[a-z0-9-]+';

/**
 * Find a code.zxplay.org project link in a status's HTML content and return its
 * user/project slugs. Matches the canonical URL, https://<host>/u/<user>/<project>,
 * whether it appears as an <a href> or as plain text. Returns null when there
 * is no such link.
 */
export function extractProjectRef(content: string, host: string): ProjectRef | null {
    const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`https?://${escapedHost}/u/(${SLUG})/(${SLUG})`, 'i');
    const match = content.match(re);
    return match
        ? { userSlug: match[1].toLowerCase(), projectSlug: match[2].toLowerCase() }
        : null;
}
