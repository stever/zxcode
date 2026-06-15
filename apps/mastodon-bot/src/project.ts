export interface ProjectRef {
    userSlug: string;
    projectSlug: string;
    machineType?: number; // from a ?m=128 / ?m=48 hint on the URL
}

const SLUG = '[a-z0-9-]+';

/**
 * Find a code.zxplay.org project link in a status's HTML content and return its
 * user/project slugs. Matches the canonical URL, https://<host>/u/<user>/<project>,
 * whether it appears as an <a href> or as plain text, and reads an optional
 * ?m=128 / ?m=48 machine hint. Returns null when there is no such link.
 */
export function extractProjectRef(content: string, host: string): ProjectRef | null {
    const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`https?://${escapedHost}/u/(${SLUG})/(${SLUG})(?:\\?m=(48|128))?`, 'i');
    const match = content.match(re);
    if (!match) return null;
    return {
        userSlug: match[1].toLowerCase(),
        projectSlug: match[2].toLowerCase(),
        machineType: match[3] ? parseInt(match[3], 10) : undefined,
    };
}
