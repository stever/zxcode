const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
};

function decodeEntities(text: string): string {
    return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        const named = NAMED_ENTITIES[body.toLowerCase()];
        return named ?? match;
    });
}

/**
 * Convert a Mastodon status `content` (HTML) into plain BASIC source.
 *
 * Mastodon wraps lines in <p> and <br>, renders @mentions as anchors, and
 * HTML-escapes the quotes and operators that BASIC relies on. Line breaks are
 * preserved because the program is line-numbered. Leading @mentions (the bot's
 * own handle and any others) are stripped.
 */
export function htmlToBasic(content: string): string {
    let text = content
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
        .replace(/<\/?p[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '');

    text = decodeEntities(text);
    text = text.replace(/ /g, ' ');
    // Drop any run of leading @mentions left behind once the anchors are gone.
    text = text.replace(/^\s*(?:@[^\s]+[ \t]*)+/, '');

    return text.replace(/[ \t]+$/gm, '').trim();
}
