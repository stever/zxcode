import { describe, expect, it } from "vitest";
import { translateOrderBy } from "../src/order.js";

describe("translateOrderBy", () => {
    it("translates plain directions", () => {
        expect(translateOrderBy("project", { updated_at: "desc" })).toEqual({
            native: [{ updated_at: "desc" }],
            aggregateMax: null,
        });
    });

    it("accepts arrays and preserves order", () => {
        const { native } = translateOrderBy("project", [
            { display_order: "asc" },
            { updated_at: "desc" },
        ]);
        expect(native).toEqual([{ display_order: "asc" }, { updated_at: "desc" }]);
    });

    it("uses nulls placement on nullable columns", () => {
        const { native } = translateOrderBy("project", {
            updated_at: "desc_nulls_last",
        });
        expect(native).toEqual([{ updated_at: { sort: "desc", nulls: "last" } }]);
    });

    it("drops nulls placement on non-nullable columns", () => {
        const { native } = translateOrderBy("project", { slug: "asc_nulls_last" });
        expect(native).toEqual([{ slug: "asc" }]);
    });

    it("translates relation count ordering", () => {
        const { native } = translateOrderBy("user", {
            followers_aggregate: { count: "desc" },
        });
        expect(native).toEqual([{ followers: { _count: "desc" } }]);
    });

    it("reports aggregate max ordering for the resolver fallback", () => {
        const { native, aggregateMax } = translateOrderBy("user", {
            projects_aggregate: { max: { updated_at: "desc_nulls_last" } },
        });
        expect(native).toEqual([]);
        expect(aggregateMax).toEqual({
            relation: "projects",
            column: "updated_at",
            descending: true,
            nullsLast: true,
        });
    });

    it("rejects unknown columns", () => {
        expect(() => translateOrderBy("project", { nope: "asc" })).toThrow(/not found/);
    });
});
