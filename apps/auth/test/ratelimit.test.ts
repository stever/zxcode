import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allow, resetForTests } from "../src/ratelimit.js";

const WINDOW_MS = 15 * 60_000;

beforeEach(() => {
    vi.useFakeTimers();
    resetForTests();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("allow", () => {
    it("allows up to the limit and blocks beyond it", () => {
        expect(allow("k", 3, WINDOW_MS)).toBe(true);
        expect(allow("k", 3, WINDOW_MS)).toBe(true);
        expect(allow("k", 3, WINDOW_MS)).toBe(true);
        expect(allow("k", 3, WINDOW_MS)).toBe(false);
    });

    it("tracks keys independently", () => {
        expect(allow("a", 1, WINDOW_MS)).toBe(true);
        expect(allow("a", 1, WINDOW_MS)).toBe(false);
        expect(allow("b", 1, WINDOW_MS)).toBe(true);
    });

    it("slides the window", () => {
        expect(allow("k", 2, WINDOW_MS)).toBe(true);
        vi.advanceTimersByTime(WINDOW_MS / 2);
        expect(allow("k", 2, WINDOW_MS)).toBe(true);
        expect(allow("k", 2, WINDOW_MS)).toBe(false);

        // The first hit ages out; one slot frees up.
        vi.advanceTimersByTime(WINDOW_MS / 2 + 1);
        expect(allow("k", 2, WINDOW_MS)).toBe(false);
        vi.advanceTimersByTime(WINDOW_MS / 2);
        expect(allow("k", 2, WINDOW_MS)).toBe(true);
    });
});
