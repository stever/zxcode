// Hashtag directives a user can add to a toot to steer rendering.
const MACHINE_TAGS: Record<string, number> = { '128': 128, '48': 48 };
const LANG_TAGS: Record<string, string> = { asm: 'asm' };

export interface Directives {
    machineType?: number; // from #128 / #48
    lang?: string; // from #asm
    code: string; // source with recognised directive tags removed
}

/**
 * Pull rendering directives out of plain-text toot content (the output of
 * htmlToBasic) and return the remaining source.
 *
 * Only the exact recognised tags (#128, #48, #asm) are stripped; every other
 * `#token` is left in place — Sinclair BASIC uses # for stream numbers
 * (PRINT #2), so blanket stripping would corrupt valid programs.
 */
export function parseDirectives(text: string): Directives {
    let machineType: number | undefined;
    let lang: string | undefined;

    const code = text
        .replace(/(^|\s)#([A-Za-z0-9]+)\b/g, (whole, lead: string, tag: string) => {
            const key = tag.toLowerCase();
            if (key in MACHINE_TAGS) {
                machineType = MACHINE_TAGS[key];
                return lead;
            }
            if (key in LANG_TAGS) {
                lang = LANG_TAGS[key];
                return lead;
            }
            return whole; // unrecognised hashtag: leave untouched
        })
        .trim();

    return { machineType, lang, code };
}
