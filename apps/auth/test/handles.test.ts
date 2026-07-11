import { describe, expect, it } from "vitest";
import { generateHandle, generateSlug } from "../src/handles.js";

describe("generateSlug", () => {
    it("lowercases and hyphenates", () => {
        expect(generateSlug("Steve Robertson")).toBe("steve-robertson");
    });

    it("collapses runs and trims edges", () => {
        expect(generateSlug("--Hello,,World!!")).toBe("hello-world");
        expect(generateSlug("a  b")).toBe("a-b");
    });

    it("handles opaque provider ids", () => {
        expect(generateSlug("auth0|12ab34cd")).toBe("auth0-12ab34cd");
    });
});

describe("generateHandle", () => {
    it("produces word-word-number slugs with matching display names", () => {
        for (let i = 0; i < 50; i++) {
            const { slug, displayName } = generateHandle();
            const match = /^([a-z]+)-([a-z]+)-(\d{2,4})$/.exec(slug);
            expect(match, slug).not.toBeNull();
            const n = parseInt(match![3] as string, 10);
            expect(n).toBeGreaterThanOrEqual(10);
            expect(n).toBeLessThan(10000);
            const [a, b] = [match![1] as string, match![2] as string];
            expect(displayName).toBe(
                `${a.charAt(0).toUpperCase()}${a.slice(1)} ${b.charAt(0).toUpperCase()}${b.slice(1)}`,
            );
        }
    });
});
