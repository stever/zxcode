import { describe, expect, it } from "vitest";
import { andWhere, translateBoolExp } from "../src/where.js";
import type { Session } from "../src/tables.js";

// Admin sees all columns with no row filter, so it isolates the pure
// translation shape; public/user sessions exercise the permission checks.
const ADMIN: Session = { role: "admin", userId: null };
const PUBLIC: Session = { role: "public", userId: null };
const USER: Session = { role: "zxplay-user", userId: "me-id" };

describe("translateBoolExp", () => {
    it("translates column comparisons", () => {
        expect(
            translateBoolExp("project", {
                slug: { _eq: "demo" },
                project_id: { _neq: "x" },
            }, ADMIN),
        ).toEqual({
            slug: { equals: "demo" },
            project_id: { not: "x" },
        });
    });

    it("translates _in", () => {
        expect(
            translateBoolExp("project", { owner_user_id: { _in: ["a", "b"] } }, ADMIN),
        ).toEqual({ owner_user_id: { in: ["a", "b"] } });
    });

    it("translates _is_null", () => {
        expect(translateBoolExp("project", { owner_user_id: { _is_null: true } }, ADMIN))
            .toEqual({ owner_user_id: { equals: null } });
        expect(translateBoolExp("project", { owner_user_id: { _is_null: false } }, ADMIN))
            .toEqual({ owner_user_id: { not: null } });
    });

    it("translates to-one relation traversal", () => {
        expect(
            translateBoolExp("project", { owner: { slug: { _eq: "steve" } } }, ADMIN),
        ).toEqual({ owner: { is: { slug: { equals: "steve" } } } });
    });

    it("maps the aliased user relation onto the owner FK", () => {
        expect(
            translateBoolExp("project", { user: { slug: { _eq: "steve" } } }, ADMIN),
        ).toEqual({ owner: { is: { slug: { equals: "steve" } } } });
    });

    it("translates to-many relation existence", () => {
        expect(
            translateBoolExp("user", { projects: { is_public: { _eq: true } } }, ADMIN),
        ).toEqual({ projects: { some: { is_public: { equals: true } } } });
    });

    it("translates _or / _and / _not", () => {
        expect(
            translateBoolExp("project", {
                _or: [
                    { owner_user_id: { _eq: "u1" } },
                    { is_public: { _eq: true } },
                ],
            }, ADMIN),
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
            translateBoolExp("project", { _not: { is_public: { _eq: true } } }, ADMIN),
        ).toEqual({ AND: [{ NOT: { is_public: { equals: true } } }] });
    });

    it("rejects unknown fields", () => {
        expect(() => translateBoolExp("user", { email: { _eq: "x" } }, ADMIN)).toThrow(
            /not found/,
        );
    });

    // Security: a where must not filter on columns the role cannot read, nor
    // reach rows the role cannot read through a relation.
    it("rejects filtering on a column the role cannot read", () => {
        // public and zxplay-user (for other users) cannot read email_address;
        // filtering on it would turn a readable row into an email oracle.
        expect(() =>
            translateBoolExp("user", { email_address: { _eq: "x@y.z" } }, PUBLIC),
        ).toThrow(/not found/);
        // admin may (the auth service looks users up by email).
        expect(
            translateBoolExp("user", { email_address: { _eq: "x@y.z" } }, ADMIN),
        ).toEqual({ email_address: { equals: "x@y.z" } });
    });

    it("constrains relation traversal by the related table's row filter", () => {
        // public filtering user→projects must only reach public projects, so
        // it cannot probe the existence/content of private ones.
        expect(
            translateBoolExp("user", { projects: { slug: { _eq: "secret" } } }, PUBLIC),
        ).toEqual({
            projects: {
                some: { AND: [{ is_public: true }, { slug: { equals: "secret" } }] },
            },
        });
        // zxplay-user reaches their own projects OR public ones.
        expect(
            translateBoolExp("user", { projects: { slug: { _eq: "secret" } } }, USER),
        ).toEqual({
            projects: {
                some: {
                    AND: [
                        { OR: [{ owner_user_id: "me-id" }, { is_public: true }] },
                        { slug: { equals: "secret" } },
                    ],
                },
            },
        });
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
