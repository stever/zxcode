import { describe, expect, it } from "vitest";
import { Kind, parse, type OperationDefinitionNode } from "graphql";
import { buildSelection } from "../src/select.js";
import type { Session } from "../src/tables.js";

const PUBLIC: Session = { role: "public", userId: null };
const USER: Session = { role: "zxplay-user", userId: "me-id" };

function selectionOf(query: string) {
    const doc = parse(query);
    const op = doc.definitions.find(
        (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
    );
    const root = op?.selectionSet.selections[0];
    if (!root || root.kind !== Kind.FIELD || !root.selectionSet) {
        throw new Error("bad test query");
    }
    return root.selectionSet;
}

function build(
    table: string,
    query: string,
    session: Session,
    variables: Record<string, unknown> = {},
) {
    return buildSelection(table, selectionOf(query), {
        session,
        variables,
        fragments: {},
    });
}

describe("buildSelection", () => {
    it("selects plain columns", () => {
        const { select, shape } = build(
            "project",
            "{ project { project_id title slug } }",
            PUBLIC,
        );
        expect(select).toEqual({ project_id: true, title: true, slug: true });
        expect(
            shape({ project_id: "p1", title: "T", slug: "t", extra: "hidden" }),
        ).toEqual({ project_id: "p1", title: "T", slug: "t" });
    });

    it("rejects columns hidden from the role", () => {
        expect(() =>
            build("user", "{ user { user_id email_address } }", PUBLIC),
        ).toThrow(/email_address/);
        expect(() =>
            build("user", "{ user { user_id email_address } }", USER),
        ).not.toThrow();
    });

    it("nulls out a to-one relation the role may not see", () => {
        const { select, shape } = build(
            "project",
            "{ project { title user { slug } } }",
            PUBLIC,
        );
        // The predicate column rides along even though it was not requested.
        expect(select).toEqual({
            title: true,
            owner: { select: { slug: true, profile_is_public: true } },
        });
        expect(
            shape({
                title: "T",
                owner: { slug: "steve", profile_is_public: true },
            }),
        ).toEqual({ title: "T", user: { slug: "steve" } });
        expect(
            shape({
                title: "T",
                owner: { slug: "steve", profile_is_public: false },
            }),
        ).toEqual({ title: "T", user: null });
    });

    it("lets an owner see their own private profile through a relation", () => {
        const { shape } = build(
            "project",
            "{ project { user { slug } } }",
            USER,
        );
        expect(
            shape({
                owner: { slug: "steve", profile_is_public: false, user_id: "me-id" },
            }),
        ).toEqual({ user: { slug: "steve" } });
    });

    it("merges user and owner selections over the one Prisma relation", () => {
        const { select, shape } = build(
            "project",
            "{ project { user { slug } owner { greeting_name } } }",
            USER,
        );
        const owner = (select.owner as { select: Record<string, boolean> }).select;
        expect(owner.slug).toBe(true);
        expect(owner.greeting_name).toBe(true);
        const row = {
            owner: {
                slug: "s",
                greeting_name: "G",
                profile_is_public: true,
                user_id: "u",
            },
        };
        expect(shape(row)).toEqual({
            user: { slug: "s" },
            owner: { greeting_name: "G" },
        });
    });

    it("applies role filters and args to to-many relations", () => {
        const { select } = build(
            "project",
            `{ project { files(order_by: [{folder: asc}, {name: asc}], limit: 5) { name } } }`,
            PUBLIC,
        );
        expect(select).toEqual({
            files: {
                select: { name: true },
                where: { project: { is: { is_public: true } } },
                orderBy: [{ folder: "asc" }, { name: "asc" }],
                take: 5,
            },
        });
    });

    it("builds filtered nested aggregates via _count", () => {
        const { select, shape } = build(
            "user",
            `{ user {
                slug
                projects_aggregate(where: { is_public: { _eq: true } }) { aggregate { count } }
                followers_aggregate { aggregate { count } }
            } }`,
            PUBLIC,
        );
        expect(select).toEqual({
            slug: true,
            _count: {
                select: {
                    projects: {
                        where: {
                            AND: [
                                { is_public: true },
                                { is_public: { equals: true } },
                            ],
                        },
                    },
                    followers: true,
                },
            },
        });
        expect(
            shape({ slug: "s", _count: { projects: 3, followers: 7 } }),
        ).toEqual({
            slug: "s",
            projects_aggregate: { aggregate: { count: 3 } },
            followers_aggregate: { aggregate: { count: 7 } },
        });
    });

    it("honours @include(if:) with variables", () => {
        const query = `query ($withTitle: Boolean!) {
            project { project_id title @include(if: $withTitle) }
        }`;
        expect(build("project", query, PUBLIC, { withTitle: false }).select).toEqual(
            { project_id: true },
        );
        expect(build("project", query, PUBLIC, { withTitle: true }).select).toEqual(
            { project_id: true, title: true },
        );
    });

    it("rejects relations whose table the role cannot read", () => {
        expect(() =>
            build("user", "{ user { user_roles { role { name } } } }", PUBLIC),
        ).toThrow(/user_role/);
    });

    it("rejects unknown fields", () => {
        expect(() => build("user", "{ user { email } }", PUBLIC)).toThrow(/email/);
    });
});
