import { describe, expect, it } from "vitest";
import { andWhere, translateBoolExp } from "../src/where.js";

describe("translateBoolExp", () => {
    it("translates column comparisons", () => {
        expect(
            translateBoolExp("project", {
                slug: { _eq: "demo" },
                project_id: { _neq: "x" },
            }),
        ).toEqual({
            slug: { equals: "demo" },
            project_id: { not: "x" },
        });
    });

    it("translates _in", () => {
        expect(
            translateBoolExp("project", { owner_user_id: { _in: ["a", "b"] } }),
        ).toEqual({ owner_user_id: { in: ["a", "b"] } });
    });

    it("translates _is_null", () => {
        expect(translateBoolExp("project", { owner_user_id: { _is_null: true } }))
            .toEqual({ owner_user_id: { equals: null } });
        expect(translateBoolExp("project", { owner_user_id: { _is_null: false } }))
            .toEqual({ owner_user_id: { not: null } });
    });

    it("translates to-one relation traversal", () => {
        expect(
            translateBoolExp("project", { owner: { slug: { _eq: "steve" } } }),
        ).toEqual({ owner: { is: { slug: { equals: "steve" } } } });
    });

    it("maps the aliased user relation onto the owner FK", () => {
        expect(
            translateBoolExp("project", { user: { slug: { _eq: "steve" } } }),
        ).toEqual({ owner: { is: { slug: { equals: "steve" } } } });
    });

    it("translates to-many relation existence", () => {
        expect(
            translateBoolExp("user", { projects: { is_public: { _eq: true } } }),
        ).toEqual({ projects: { some: { is_public: { equals: true } } } });
    });

    it("translates _or / _and / _not", () => {
        expect(
            translateBoolExp("project", {
                _or: [
                    { owner_user_id: { _eq: "u1" } },
                    { is_public: { _eq: true } },
                ],
            }),
        ).toEqual({
            AND: [
                {
                    OR: [
                        { owner_user_id: { equals: "u1" } },
                        { is_public: { equals: true } },
                    ],
                },
            ],
        });
        expect(
            translateBoolExp("project", { _not: { is_public: { _eq: true } } }),
        ).toEqual({ AND: [{ NOT: { is_public: { equals: true } } }] });
    });

    it("rejects unknown fields", () => {
        expect(() => translateBoolExp("user", { email: { _eq: "x" } })).toThrow(
            /not found/,
        );
    });
});

describe("andWhere", () => {
    it("drops empty parts", () => {
        expect(andWhere({}, { a: 1 })).toEqual({ a: 1 });
        expect(andWhere({}, {})).toEqual({});
    });

    it("combines non-empty parts", () => {
        expect(andWhere({ a: 1 }, { b: 2 })).toEqual({ AND: [{ a: 1 }, { b: 2 }] });
    });
});
