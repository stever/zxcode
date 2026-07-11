// Slug and handle generation, ported verbatim from the .NET
// UserRepository.GenerateSlug and HandleGenerator.

const WORDS1 = [
    "beeper", "raster", "attr", "pixel", "sprite", "scanline", "border", "ink", "paper",
    "bright", "flash", "loader", "tape", "micro", "turbo", "retro", "neon", "vector",
    "scroll", "blitz", "basic", "rom", "beam", "clash",
] as const;

const WORDS2 = [
    "wizard", "runner", "hacker", "clash", "byte", "loop", "coder", "ghost", "droid",
    "knight", "racer", "pilot", "ranger", "goblin", "comet", "falcon", "glitch", "demon",
    "crawler", "smith", "phantom", "jumper", "blaster", "rebel",
] as const;

export function generateSlug(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-+/g, "-");
}

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

function pick<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)] as T;
}

// Friendly, speccy-themed handle for accounts whose username is an opaque
// provider identifier (e.g. "auth0|..."). Uniqueness is the caller's problem.
export function generateHandle(): { slug: string; displayName: string } {
    const a = pick(WORDS1);
    const b = pick(WORDS2);
    const n = 10 + Math.floor(Math.random() * 9990); // 2 to 4 digits
    return {
        slug: `${a}-${b}-${n}`,
        displayName: `${capitalize(a)} ${capitalize(b)}`,
    };
}
