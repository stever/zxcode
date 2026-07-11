// Integration suite: boots the api against a dedicated Postgres database
// (created here, migrated with the real migrations) and executes the exact
// GraphQL documents the three consumers use — apps/web, apps/auth (admin) and
// apps/gif-service (public) — under each role, plus the compile-action
// envelope and the live-query WebSocket dialect.
//
// Requires a reachable Postgres superuser-ish URL (defaults to the dev
// docker-compose instance) and RUN_INTEGRATION=1.

import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import WebSocket from "ws";

const PG_ADMIN_URL =
    process.env.TEST_PG_URL ??
    "postgresql://zxplay:postgrespassword@localhost:5432/zxplay";
const TEST_DB = "zxplay_api_test";
const TEST_DB_URL = PG_ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);

const ADMIN_SECRET = "test-admin-secret";
const JWT_SECRET = "test-jwt-secret-test-jwt-secret-test";

let baseUrl = "";
let wsUrl = "";
let server: http.Server;
let fakeCompiler: http.Server;
let compilerRequests: Array<{ headers: http.IncomingHttpHeaders; body: unknown }> = [];
let compilerResponse: { status: number; body: unknown } = {
    status: 200,
    body: { base64_encoded: "AAAA", sld: null },
};
let prismaDisconnect: () => Promise<void> = async () => {};

interface GqlResponse {
    data?: Record<string, never> & Record<string, unknown>;
    errors?: Array<{ message: string }>;
}

async function gql(
    query: string,
    variables: Record<string, unknown> = {},
    auth?: { token?: string; admin?: boolean },
): Promise<GqlResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth?.admin) headers["X-Hasura-Admin-Secret"] = ADMIN_SECRET;
    if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
    const res = await fetch(`${baseUrl}/v1/graphql`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as GqlResponse;
}

async function data(
    query: string,
    variables: Record<string, unknown> = {},
    auth?: { token?: string; admin?: boolean },
): Promise<Record<string, unknown>> {
    const res = await gql(query, variables, auth);
    expect(res.errors, JSON.stringify(res.errors)).toBeUndefined();
    return res.data as Record<string, unknown>;
}

async function mintToken(userId: string, expiresIn = "15m"): Promise<string> {
    return new SignJWT({
        "https://hasura.io/jwt/claims": {
            "X-Hasura-Allowed-Roles": ["zxplay-user"],
            "X-Hasura-Default-Role": "zxplay-user",
            "X-Hasura-User-Id": userId,
        },
    })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("zxplay")
        .setAudience("hasura")
        .setExpirationTime(expiresIn)
        .setIssuedAt()
        .sign(new TextEncoder().encode(JWT_SECRET));
}

// Fixture state shared across tests.
let alice = { id: "", token: "" }; // public profile, public + private projects
let bob = { id: "", token: "" }; // private profile
let carol = { id: "", token: "" }; // public profile, no projects
let alicePublicProjectId = "";
let alicePrivateProjectId = "";

beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    process.env.JWT_SECRET = JWT_SECRET;

    // Recreate the test database.
    const { PrismaClient } = await import("@prisma/client");
    const adminClient = new PrismaClient({ datasourceUrl: PG_ADMIN_URL });
    await adminClient.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await adminClient.$executeRawUnsafe(`CREATE DATABASE ${TEST_DB}`);
    await adminClient.$disconnect();

    execFileSync("npx", ["prisma", "migrate", "deploy"], {
        env: { ...process.env, DATABASE_URL: TEST_DB_URL },
        stdio: "pipe",
    });

    // Fake compile handler standing in for the zxbasic service.
    fakeCompiler = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            compilerRequests.push({
                headers: req.headers,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
            res.writeHead(compilerResponse.status, {
                "Content-Type": "application/json",
            });
            res.end(JSON.stringify(compilerResponse.body));
        });
    });
    await new Promise<void>((resolve) => fakeCompiler.listen(0, resolve));
    const compilerPort = (fakeCompiler.address() as AddressInfo).port;
    process.env.ZXBASIC_URL = `http://localhost:${compilerPort}/compile/`;

    // Import after env is set: db.ts and auth.ts read it at module load.
    const { createServer } = await import("../../src/server.js");
    const { attachSubscriptionServer } = await import("../../src/subscription.js");
    const { prisma } = await import("../../src/db.js");
    prismaDisconnect = () => prisma.$disconnect();

    server = createServer();
    attachSubscriptionServer(server, "/v1/graphql");
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
    wsUrl = `ws://localhost:${port}/v1/graphql`;

    // ------------------------------------------------------------ fixtures
    // Users via the auth service's own admin document.
    const createUser = `mutation CreateUser($username: String!, $email_address: String, $slug: String!, $greeting_name: String) {
        insert_user_one(object: {username: $username, email_address: $email_address, slug: $slug, greeting_name: $greeting_name}) {
            user_id
        }
    }`;
    for (const [user, username, slug, name] of [
        [alice, "alice", "alice", "Alice"],
        [bob, "bob", "bob", "Bob"],
        [carol, "carol", "carol", "Carol"],
    ] as Array<[typeof alice, string, string, string]>) {
        const result = await data(
            createUser,
            { username, email_address: `${username}@example.com`, slug, greeting_name: name },
            { admin: true },
        );
        user.id = (result.insert_user_one as { user_id: string }).user_id;
        user.token = await mintToken(user.id);
    }

    // Bob hides his profile (own-row update through the real document).
    await data(
        `mutation ($user_id: uuid!) {
            update_user_by_pk(pk_columns: {user_id: $user_id}, _set: {profile_is_public: false, bio: "secret"}) { user_id }
        }`,
        { user_id: bob.id },
        { token: bob.token },
    );

    // Projects as alice (exercises the owner preset).
    const createProject = `mutation ($title: String!, $lang: String!, $slug: String!, $machine: String!) {
        insert_project_one(object: {title: $title, lang: $lang, slug: $slug, machine: $machine}) { project_id slug }
    }`;
    const pub = await data(
        createProject,
        { title: "Public Demo", lang: "zxbasic", slug: "public-demo", machine: "48" },
        { token: alice.token },
    );
    alicePublicProjectId = (pub.insert_project_one as { project_id: string }).project_id;
    const priv = await data(
        createProject,
        { title: "Secret", lang: "sjasmplus", slug: "secret", machine: "next" },
        { token: alice.token },
    );
    alicePrivateProjectId = (priv.insert_project_one as { project_id: string }).project_id;

    await data(
        `mutation ($project_id: uuid!, $is_public: Boolean!) {
            update_project_by_pk(pk_columns: {project_id: $project_id}, _set: {is_public: $is_public}) { project_id is_public slug user { slug } }
        }`,
        { project_id: alicePublicProjectId, is_public: true },
        { token: alice.token },
    );

    // Files on the public project.
    await data(
        `mutation ($project_id: uuid!, $name: String!, $folder: String!, $content: String!, $is_binary: Boolean!) {
            insert_project_file_one(object: {project_id: $project_id, name: $name, folder: $folder, content: $content, is_binary: $is_binary}) { file_id }
        }`,
        { project_id: alicePublicProjectId, name: "lib.bas", folder: "", content: "REM lib", is_binary: false },
        { token: alice.token },
    );
    await data(
        `mutation ($project_id: uuid!, $name: String!, $folder: String!, $content: String!, $is_binary: Boolean!) {
            insert_project_file_one(object: {project_id: $project_id, name: $name, folder: $folder, content: $content, is_binary: $is_binary}) { file_id }
        }`,
        { project_id: alicePublicProjectId, name: "sprite.bin", folder: "assets", content: "QUJD", is_binary: true },
        { token: alice.token },
    );

    // Bob stars alice's public project; bob follows alice; carol follows alice.
    await data(
        `mutation StarProject($project_id: uuid!) {
            insert_project_star_one(object: {project_id: $project_id}) { project_id }
        }`,
        { project_id: alicePublicProjectId },
        { token: bob.token },
    );
    for (const follower of [bob, carol]) {
        await data(
            `mutation FollowUser($follower_id: uuid!, $following_id: uuid!) {
                insert_user_follows_one(object: {follower_id: $follower_id, following_id: $following_id}) { created_at }
            }`,
            { follower_id: follower.id, following_id: alice.id },
            { token: follower.token },
        );
    }

    // Localised text rows (no mutation exists; direct insert).
    await prisma.text.createMany({
        data: [
            { name: "about", lang: "en", text: "About page" },
            { name: "about", lang: "de", text: "Info" },
        ],
    });
}, 180_000);

afterAll(async () => {
    server?.close();
    fakeCompiler?.close();
    await prismaDisconnect();
});

// --------------------------------------------------------------- documents

describe("public role reads (apps/web anonymous + gif-service)", () => {
    it("GetProjectBySlug returns only public projects", async () => {
        const doc = `query GetProjectBySlug($projectSlug: String!) {
            project(where: { slug: { _eq: $projectSlug } }, limit: 1) {
                project_id title slug is_public lang code
            }
        }`;
        const found = await data(doc, { projectSlug: "public-demo" });
        expect((found.project as unknown[]).length).toBe(1);
        const hidden = await data(doc, { projectSlug: "secret" });
        expect((hidden.project as unknown[]).length).toBe(0);
    });

    it("project_by_pk hides private projects from the public", async () => {
        const doc = `query ($project_id: uuid!) {
            project_by_pk(project_id: $project_id) { project_id title }
        }`;
        const pub = await data(doc, { project_id: alicePublicProjectId });
        expect(pub.project_by_pk).not.toBeNull();
        const priv = await data(doc, { project_id: alicePrivateProjectId });
        expect(priv.project_by_pk).toBeNull();
    });

    it("gif-service lookup by owner slug with ordered files", async () => {
        const result = await data(
            `query ($userSlug: String!, $projectSlug: String!) {
                project(
                    where: { slug: { _eq: $projectSlug }, owner: { slug: { _eq: $userSlug } } }
                    limit: 1
                ) {
                    lang code title
                    files(order_by: { name: asc }) { name content is_binary }
                }
            }`,
            { userSlug: "alice", projectSlug: "public-demo" },
        );
        const projects = result.project as Array<{
            title: string;
            files: Array<{ name: string }>;
        }>;
        expect(projects[0]?.title).toBe("Public Demo");
        expect(projects[0]?.files.map((f) => f.name)).toEqual(["lib.bas", "sprite.bin"]);
    });

    it("hides private profile columns and rows", async () => {
        const bySlug = await data(
            `query GetUserBySlug($slug: String!) {
                user(where: { slug: { _eq: $slug } }, limit: 1) {
                    user_id greeting_name bio created_at profile_is_public slug avatar_variant custom_avatar_data
                    projects_aggregate(where: { is_public: { _eq: true } }) { aggregate { count } }
                    starred_projects_aggregate { aggregate { count } }
                    followers { follower_id }
                    following { following_id }
                }
            }`,
            { slug: "alice" },
        );
        const users = bySlug.user as Array<Record<string, unknown>>;
        expect(users.length).toBe(1);
        const aggregate = users[0]?.projects_aggregate as {
            aggregate: { count: number };
        };
        expect(aggregate.aggregate.count).toBe(1);
        expect((users[0]?.followers as unknown[]).length).toBe(2);

        // Bob's profile is private: no rows for the public.
        const hidden = await data(
            `query { user(where: { slug: { _eq: "bob" } }) { user_id } }`,
        );
        expect((hidden.user as unknown[]).length).toBe(0);

        // email_address is not even a queryable column for the public role.
        const forbidden = await gql(`query { user { user_id email_address } }`);
        expect(forbidden.errors?.[0]?.message).toMatch(/email_address/);
    });

    it("cannot filter on unreadable columns or reach private rows via relations", async () => {
        // Filtering on email_address (not a public-readable column) must be
        // rejected, so it cannot be used as an email-existence oracle.
        const emailOracle = await gql(
            `query ($email: String!) { user(where: {email_address: {_eq: $email}}) { slug } }`,
            { email: "alice@example.com" },
        );
        expect(emailOracle.errors?.[0]?.message).toMatch(/email_address/);

        // Filtering a visible user through projects must be constrained to
        // public projects: alice owns a private project "secret", but probing
        // for it must not single her out.
        const relationOracle = await data(
            `query { user(where: {profile_is_public: {_eq: true}, projects: {slug: {_eq: "secret"}}}) { slug } }`,
        );
        expect((relationOracle.user as unknown[]).length).toBe(0);

        // The same probe for her *public* project's slug still works (proving
        // the traversal itself is intact, only the private row is hidden).
        const publicProbe = await data(
            `query { user(where: {profile_is_public: {_eq: true}, projects: {slug: {_eq: "public-demo"}}}) { slug } }`,
        );
        expect((publicProbe.user as Array<{ slug: string }>).map((u) => u.slug)).toEqual([
            "alice",
        ]);
    });

    it("GetText filters by name and langs", async () => {
        const result = await data(
            `query GetText($name: String!, $langs: [String!]!) {
                text(where: {name: {_eq: $name}, lang: {_in: $langs}}) { lang text }
            }`,
            { name: "about", langs: ["de", "en"] },
        );
        expect((result.text as unknown[]).length).toBe(2);
    });

    it("public role cannot mutate", async () => {
        const result = await gql(
            `mutation { insert_project_one(object: {title: "x", lang: "zxbasic", slug: "x", machine: "48"}) { project_id } }`,
        );
        expect(result.errors?.[0]?.message).toMatch(/insert_project_one/);
    });

    it("public role cannot read sessions", async () => {
        const result = await gql(`query { session { session_id } }`);
        expect(result.errors?.[0]?.message).toMatch(/session/);
    });
});

describe("profiles listing (PublicProfiles document)", () => {
    const doc = `query GetPublicProfiles($where: user_bool_exp!, $orderBy: [user_order_by!]!, $limit: Int!, $offset: Int!) {
        user_aggregate(where: $where) { aggregate { count } }
        user(where: $where, order_by: $orderBy, limit: $limit, offset: $offset) {
            user_id greeting_name slug bio created_at avatar_variant custom_avatar_data
            followers_aggregate { aggregate { count } }
            following_aggregate { aggregate { count } }
            projects_aggregate(where: { is_public: { _eq: true } }) { aggregate { count } }
        }
    }`;

    it("filters to users with public projects", async () => {
        const result = await data(doc, {
            where: {
                profile_is_public: { _eq: true },
                projects: { is_public: { _eq: true } },
            },
            orderBy: [{ created_at: "desc" }],
            limit: 20,
            offset: 0,
        });
        const users = result.user as Array<{ slug: string }>;
        expect(users.map((u) => u.slug)).toEqual(["alice"]);
    });

    it("sorts by aggregate max updated_at with nulls last", async () => {
        const result = await data(doc, {
            where: { profile_is_public: { _eq: true } },
            orderBy: [{ projects_aggregate: { max: { updated_at: "desc_nulls_last" } } }],
            limit: 20,
            offset: 0,
        });
        const slugs = (result.user as Array<{ slug: string }>).map((u) => u.slug);
        // Alice has the only public project; carol has none (null → last).
        expect(slugs).toEqual(["alice", "carol"]);
        expect(
            (result.user_aggregate as { aggregate: { count: number } }).aggregate.count,
        ).toBe(2);
    });

    it("sorts by follower count", async () => {
        const result = await data(doc, {
            where: { profile_is_public: { _eq: true } },
            orderBy: [{ followers_aggregate: { count: "desc" } }],
            limit: 20,
            offset: 0,
        });
        const users = result.user as Array<{
            slug: string;
            followers_aggregate: { aggregate: { count: number } };
        }>;
        expect(users[0]?.slug).toBe("alice");
        expect(users[0]?.followers_aggregate.aggregate.count).toBe(2);
    });
});

describe("zxplay-user reads", () => {
    it("owner loads a private project with user and ordered files", async () => {
        const result = await data(
            `query ($project_id: uuid!) {
                project_by_pk(project_id: $project_id) {
                    title lang code machine is_public slug owner_user_id
                    user { slug greeting_name profile_is_public }
                    files(order_by: [{folder: asc}, {name: asc}]) { file_id name folder content is_binary }
                }
            }`,
            { project_id: alicePrivateProjectId },
            { token: alice.token },
        );
        const project = result.project_by_pk as Record<string, unknown>;
        expect(project.title).toBe("Secret");
        expect((project.user as { slug: string }).slug).toBe("alice");
        // Bob (not the owner) cannot see it either.
        const denied = await data(
            `query ($project_id: uuid!) { project_by_pk(project_id: $project_id) { title } }`,
            { project_id: alicePrivateProjectId },
            { token: bob.token },
        );
        expect(denied.project_by_pk).toBeNull();
    });

    it("bob can read his own private profile fields", async () => {
        const result = await data(
            `query GetUserProfile($user_id: uuid!) {
                user_by_pk(user_id: $user_id) {
                    user_id greeting_name full_name email_address bio profile_is_public slug
                }
            }`,
            { user_id: bob.id },
            { token: bob.token },
        );
        const user = result.user_by_pk as Record<string, unknown>;
        expect(user.email_address).toBe("bob@example.com");
        expect(user.profile_is_public).toBe(false);
    });

    it("masks other users' email/full_name to null and blocks filtering on them", async () => {
        // bob reads alice's public profile: PII columns come back null even
        // though bob's role nominally lists them.
        const list = await data(
            `query { user(where: {slug: {_eq: "alice"}}) { slug email_address full_name greeting_name } }`,
            {},
            { token: bob.token },
        );
        const alice = (list.user as Array<Record<string, unknown>>)[0];
        expect(alice?.slug).toBe("alice");
        expect(alice?.greeting_name).toBe("Alice"); // non-PII still visible
        expect(alice?.email_address).toBeNull();
        expect(alice?.full_name).toBeNull();

        // bob's own row still exposes his PII.
        const own = await data(
            `query { user(where: {slug: {_eq: "bob"}}) { email_address } }`,
            {},
            { token: bob.token },
        );
        expect((own.user as Array<{ email_address: string }>)[0]?.email_address).toBe(
            "bob@example.com",
        );

        // And a zxplay-user cannot filter on email_address (no cross-row oracle).
        const oracle = await gql(
            `query { user(where: {email_address: {_eq: "alice@example.com"}}) { slug } }`,
            {},
            { token: bob.token },
        );
        expect(oracle.errors?.[0]?.message).toMatch(/email_address/);
    });

    it("activity feed with _in, owner object and aggregate", async () => {
        const result = await data(
            `query GetActivityFeed($user_ids: [uuid!], $limit: Int!, $offset: Int!) {
                project_aggregate(where: { owner_user_id: {_in: $user_ids}, is_public: {_eq: true} }) {
                    aggregate { count }
                }
                project(
                    where: { owner_user_id: {_in: $user_ids}, is_public: {_eq: true} },
                    order_by: {updated_at: desc}, limit: $limit, offset: $offset
                ) {
                    project_id title slug lang machine is_public created_at updated_at
                    owner { user_id slug greeting_name }
                }
            }`,
            { user_ids: [alice.id, carol.id], limit: 10, offset: 0 },
            { token: bob.token },
        );
        expect(
            (result.project_aggregate as { aggregate: { count: number } }).aggregate.count,
        ).toBe(1);
        const projects = result.project as Array<{ owner: { slug: string } }>;
        expect(projects[0]?.owner.slug).toBe("alice");
    });

    it("star state document with alias and @include", async () => {
        const doc = `query GetProjectStarState($project_id: uuid!, $user_id: uuid!, $includeMine: Boolean!) {
            project_star_aggregate(where: { project_id: { _eq: $project_id } }) {
                aggregate { count }
            }
            mine: project_star(
                where: { project_id: { _eq: $project_id }, user_id: { _eq: $user_id } }
            ) @include(if: $includeMine) {
                user_id
            }
        }`;
        const result = await data(
            doc,
            { project_id: alicePublicProjectId, user_id: bob.id, includeMine: true },
            { token: bob.token },
        );
        expect(
            (result.project_star_aggregate as { aggregate: { count: number } }).aggregate
                .count,
        ).toBe(1);
        expect((result.mine as unknown[]).length).toBe(1);

        const without = await data(
            doc,
            { project_id: alicePublicProjectId, user_id: bob.id, includeMine: false },
            { token: bob.token },
        );
        expect(without.mine).toBeUndefined();
    });

    it("follow list document with nested users, aggregates and paging", async () => {
        const result = await data(
            `query GetUserWithFollows($slug: String!, $followersLimit: Int!, $followersOffset: Int!, $followingLimit: Int!, $followingOffset: Int!) {
                user(where: { slug: { _eq: $slug } }, limit: 1) {
                    user_id greeting_name slug
                    followers_aggregate { aggregate { count } }
                    following_aggregate { aggregate { count } }
                    followers(limit: $followersLimit, offset: $followersOffset, order_by: { created_at: desc }) {
                        follower { user_id greeting_name slug bio avatar_variant custom_avatar_data created_at }
                    }
                    following(limit: $followingLimit, offset: $followingOffset, order_by: { created_at: desc }) {
                        following { user_id greeting_name slug bio avatar_variant custom_avatar_data created_at }
                    }
                }
            }`,
            { slug: "alice", followersLimit: 10, followersOffset: 0, followingLimit: 10, followingOffset: 0 },
        );
        const users = result.user as Array<Record<string, unknown>>;
        const followers = users[0]?.followers as Array<{
            follower: { slug: string } | null;
        }>;
        expect(followers.length).toBe(2);
        // Bob's profile is private, so his user object nulls out for the
        // anonymous viewer; carol's is visible.
        const slugs = followers.map((f) => f.follower?.slug ?? null);
        expect(slugs).toContain("carol");
        expect(slugs).toContain(null);
    });

    it("starred projects with nested project and its owner", async () => {
        const result = await data(
            `query GetUserStarredProjects($user_id: uuid!, $limit: Int!, $offset: Int!) {
                project_star_aggregate(where: { user_id: { _eq: $user_id } }) { aggregate { count } }
                project_star(where: { user_id: { _eq: $user_id } }, order_by: { created_at: desc }, limit: $limit, offset: $offset) {
                    created_at
                    project {
                        project_id title slug lang machine updated_at is_public
                        user { slug greeting_name }
                    }
                }
            }`,
            { user_id: bob.id, limit: 10, offset: 0 },
            { token: bob.token },
        );
        const stars = result.project_star as Array<{
            project: { title: string; user: { slug: string } };
        }>;
        expect(stars[0]?.project.title).toBe("Public Demo");
        expect(stars[0]?.project.user.slug).toBe("alice");
    });
});

describe("zxplay-user mutations", () => {
    it("updates own profile and rejects duplicate slug", async () => {
        const doc = `mutation UpdateUserProfile($user_id: uuid!, $greeting_name: String, $full_name: String, $email_address: String, $bio: String, $profile_is_public: Boolean!, $slug: String!) {
            update_user_by_pk(pk_columns: { user_id: $user_id }, _set: {
                greeting_name: $greeting_name, full_name: $full_name, email_address: $email_address,
                bio: $bio, profile_is_public: $profile_is_public, slug: $slug
            }) { user_id slug }
        }`;
        const ok = await data(
            doc,
            {
                user_id: carol.id, greeting_name: "Carol!", full_name: "Carol C",
                email_address: "carol@example.com", bio: "hi", profile_is_public: true, slug: "carol",
            },
            { token: carol.token },
        );
        expect((ok.update_user_by_pk as { slug: string }).slug).toBe("carol");

        const dup = await gql(
            doc,
            {
                user_id: carol.id, greeting_name: "Carol!", full_name: null,
                email_address: null, bio: null, profile_is_public: true, slug: "alice",
            },
            { token: carol.token },
        );
        expect(dup.errors?.[0]?.message).toMatch(/Uniqueness violation/);
    });

    it("cannot update someone else's profile (null result)", async () => {
        const result = await data(
            `mutation ($user_id: uuid!) {
                update_user_by_pk(pk_columns: {user_id: $user_id}, _set: {bio: "hax"}) { user_id }
            }`,
            { user_id: alice.id },
            { token: bob.token },
        );
        expect(result.update_user_by_pk).toBeNull();
    });

    it("sets and clears a jsonb avatar", async () => {
        const doc = `mutation UpdateUserAvatar($user_id: uuid!, $avatar_variant: Int, $custom_avatar_data: jsonb) {
            update_user_by_pk(pk_columns: { user_id: $user_id }, _set: {
                avatar_variant: $avatar_variant, custom_avatar_data: $custom_avatar_data
            }) { user_id avatar_variant custom_avatar_data }
        }`;
        const grid = [[1, 2], [3, 4]];
        const set = await data(
            doc,
            { user_id: alice.id, avatar_variant: 5, custom_avatar_data: grid },
            { token: alice.token },
        );
        expect(
            (set.update_user_by_pk as { custom_avatar_data: unknown }).custom_avatar_data,
        ).toEqual(grid);
        const cleared = await data(
            doc,
            { user_id: alice.id, avatar_variant: 3, custom_avatar_data: null },
            { token: alice.token },
        );
        expect(
            (cleared.update_user_by_pk as { custom_avatar_data: unknown }).custom_avatar_data,
        ).toBeNull();
    });

    it("copies a project with nested files", async () => {
        const source = await data(
            `query ($project_id: uuid!) {
                project_by_pk(project_id: $project_id) {
                    lang code machine
                    files { name folder content is_binary }
                }
            }`,
            { project_id: alicePublicProjectId },
            { token: bob.token },
        );
        const src = source.project_by_pk as {
            lang: string; code: string; machine: string;
            files: Array<Record<string, unknown>>;
        };
        const copy = await data(
            `mutation ($title: String!, $lang: String!, $code: String!, $slug: String!, $machine: String!, $files: [project_file_insert_input!]!) {
                insert_project_one(object: {title: $title, lang: $lang, code: $code, slug: $slug, machine: $machine, files: {data: $files}}) {
                    project_id
                }
            }`,
            {
                title: "Copy of Public Demo", lang: src.lang, code: src.code,
                slug: "copy-of-public-demo", machine: src.machine, files: src.files,
            },
            { token: bob.token },
        );
        const copyId = (copy.insert_project_one as { project_id: string }).project_id;

        const check = await data(
            `query ($project_id: uuid!) {
                project_by_pk(project_id: $project_id) {
                    owner_user_id
                    files(order_by: [{folder: asc}, {name: asc}]) { name folder }
                }
            }`,
            { project_id: copyId },
            { token: bob.token },
        );
        const copied = check.project_by_pk as {
            owner_user_id: string;
            files: Array<{ name: string }>;
        };
        expect(copied.owner_user_id).toBe(bob.id); // preset, not inherited
        expect(copied.files.length).toBe(2);

        await data(
            `mutation ($project_id: uuid!) { delete_project_by_pk(project_id: $project_id) { project_id } }`,
            { project_id: copyId },
            { token: bob.token },
        );
    });

    it("cannot update or delete someone else's project", async () => {
        const update = await data(
            `mutation ($project_id: uuid!, $code: String!) {
                update_project_by_pk(pk_columns: {project_id: $project_id}, _set: {code: $code}) { project_id }
            }`,
            { project_id: alicePublicProjectId, code: "REM hax" },
            { token: bob.token },
        );
        expect(update.update_project_by_pk).toBeNull();
        const del = await data(
            `mutation ($project_id: uuid!) { delete_project_by_pk(project_id: $project_id) { project_id } }`,
            { project_id: alicePublicProjectId },
            { token: bob.token },
        );
        expect(del.delete_project_by_pk).toBeNull();
    });

    it("cannot add files to someone else's project", async () => {
        const result = await gql(
            `mutation ($project_id: uuid!, $name: String!, $folder: String!, $content: String!, $is_binary: Boolean!) {
                insert_project_file_one(object: {project_id: $project_id, name: $name, folder: $folder, content: $content, is_binary: $is_binary}) { file_id }
            }`,
            { project_id: alicePublicProjectId, name: "evil.bas", folder: "", content: "", is_binary: false },
            { token: bob.token },
        );
        expect(result.errors?.[0]?.message).toMatch(/check constraint/);
    });

    it("star and unstar with affected_rows", async () => {
        await data(
            `mutation StarProject($project_id: uuid!) {
                insert_project_star_one(object: {project_id: $project_id}) { project_id }
            }`,
            { project_id: alicePublicProjectId },
            { token: carol.token },
        );
        // Unstarring someone else's star deletes nothing.
        const foreign = await data(
            `mutation UnstarProject($user_id: uuid!, $project_id: uuid!) {
                delete_project_star(where: { user_id: {_eq: $user_id}, project_id: {_eq: $project_id} }) { affected_rows }
            }`,
            { user_id: carol.id, project_id: alicePublicProjectId },
            { token: bob.token },
        );
        expect((foreign.delete_project_star as { affected_rows: number }).affected_rows).toBe(0);
        const own = await data(
            `mutation UnstarProject($user_id: uuid!, $project_id: uuid!) {
                delete_project_star(where: { user_id: {_eq: $user_id}, project_id: {_eq: $project_id} }) { affected_rows }
            }`,
            { user_id: carol.id, project_id: alicePublicProjectId },
            { token: carol.token },
        );
        expect((own.delete_project_star as { affected_rows: number }).affected_rows).toBe(1);
    });

    it("rejects following as someone else", async () => {
        const result = await gql(
            `mutation FollowUser($follower_id: uuid!, $following_id: uuid!) {
                insert_user_follows_one(object: {follower_id: $follower_id, following_id: $following_id}) { created_at }
            }`,
            { follower_id: alice.id, following_id: carol.id },
            { token: bob.token },
        );
        expect(result.errors?.[0]?.message).toMatch(/check constraint/);
    });

    it("enforces the 32-file cap via the DB trigger", async () => {
        const create = await data(
            `mutation ($title: String!, $lang: String!, $slug: String!, $machine: String!) {
                insert_project_one(object: {title: $title, lang: $lang, slug: $slug, machine: $machine}) { project_id }
            }`,
            { title: "Cap", lang: "zxbasic", slug: "cap", machine: "48" },
            { token: carol.token },
        );
        const projectId = (create.insert_project_one as { project_id: string }).project_id;
        const insertFile = `mutation ($project_id: uuid!, $name: String!, $folder: String!, $content: String!, $is_binary: Boolean!) {
            insert_project_file_one(object: {project_id: $project_id, name: $name, folder: $folder, content: $content, is_binary: $is_binary}) { file_id }
        }`;
        for (let i = 0; i < 32; i++) {
            await data(
                insertFile,
                { project_id: projectId, name: `f${i}.bas`, folder: "", content: "", is_binary: false },
                { token: carol.token },
            );
        }
        const overflow = await gql(
            insertFile,
            { project_id: projectId, name: "f32.bas", folder: "", content: "", is_binary: false },
            { token: carol.token },
        );
        expect(overflow.errors?.[0]?.message).toMatch(/at most 32/);
        await data(
            `mutation ($project_id: uuid!) { delete_project_by_pk(project_id: $project_id) { project_id } }`,
            { project_id: projectId },
            { token: carol.token },
        );
    });
});

describe("admin role (apps/auth documents)", () => {
    let sessionId = "";

    it("GetUser / GetUserByEmail / GetUserBySlug / GetUserRoles", async () => {
        const byName = await data(
            `query GetUser($username: String!) {
                user(where: {username: {_eq: $username}}) { user_id username }
            }`,
            { username: "bob" },
            { admin: true },
        );
        expect((byName.user as unknown[]).length).toBe(1);

        const byEmail = await data(
            `query GetUserByEmail($email_address: String!) {
                user(where: {email_address: {_eq: $email_address}}) { user_id username }
            }`,
            { email_address: "bob@example.com" },
            { admin: true },
        );
        expect((byEmail.user as unknown[]).length).toBe(1);

        const roles = await data(
            `query GetUserRoles($user_id: uuid!) {
                user(where: {user_id: {_eq: $user_id}}) {
                    user_roles { role { name } }
                }
            }`,
            { user_id: bob.id },
            { admin: true },
        );
        const users = roles.user as Array<{ user_roles: unknown[] }>;
        expect(users[0]?.user_roles).toEqual([]);
    });

    it("CreateSession / GetSession / UpdateSessionTimestamp", async () => {
        const now = new Date();
        const created = await data(
            `mutation CreateSession($user_id: uuid!, $auth_token: String!, $created: timestamptz!, $expires: timestamptz!) {
                insert_session_one(object: {user_id: $user_id, auth_token: $auth_token, created: $created, expires: $expires}) {
                    session_id
                }
            }`,
            {
                user_id: bob.id,
                auth_token: "session-token-1",
                created: now.toISOString(),
                expires: new Date(now.getTime() + 8 * 3600_000).toISOString(),
            },
            { admin: true },
        );
        sessionId = (created.insert_session_one as { session_id: string }).session_id;

        const fetched = await data(
            `query GetSession($auth_token: String!) {
                session(where: {auth_token: {_eq: $auth_token}}) {
                    session_id expires
                    user { user_id user_roles { role { name } } }
                }
            }`,
            { auth_token: "session-token-1" },
            { admin: true },
        );
        const sessions = fetched.session as Array<{
            session_id: string;
            user: { user_id: string };
        }>;
        expect(sessions[0]?.session_id).toBe(sessionId);
        expect(sessions[0]?.user.user_id).toBe(bob.id);

        const touched = await data(
            `mutation UpdateSessionTimestamp($session_id: uuid!, $updated: timestamptz!) {
                update_session_by_pk(pk_columns: {session_id: $session_id}, _set: {updated: $updated}) { updated }
            }`,
            { session_id: sessionId, updated: now.toISOString() },
            { admin: true },
        );
        expect(touched.update_session_by_pk).not.toBeNull();
    });

    it("UpdateUserEmail returns affected_rows", async () => {
        const result = await data(
            `mutation UpdateUserEmail($username: String!, $email_address: String) {
                update_user(where: {username: {_eq: $username}}, _set: {email_address: $email_address}) { affected_rows }
            }`,
            { username: "bob", email_address: "bob2@example.com" },
            { admin: true },
        );
        expect((result.update_user as { affected_rows: number }).affected_rows).toBe(1);
    });

    it("rejects a wrong admin secret", async () => {
        const res = await fetch(`${baseUrl}/v1/graphql`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Hasura-Admin-Secret": "wrong",
            },
            body: JSON.stringify({ query: "query { user { user_id } }" }),
        });
        const body = (await res.json()) as GqlResponse;
        expect(body.errors?.[0]?.message).toMatch(/admin-secret/);
    });
});

describe("compile actions", () => {
    it("forwards the Hasura action envelope and headers", async () => {
        compilerRequests = [];
        compilerResponse = {
            status: 200,
            body: { base64_encoded: "VEFQRA==", sld: '{"kind":"zxbasic"}' },
        };
        const result = await data(
            `mutation ($basic: String!, $files: [ProjectFileInput!]) {
                compile(basic: $basic, files: $files) { base64_encoded sld }
            }`,
            { basic: '10 PRINT "HI"', files: [{ name: "lib.bas", content: "REM", is_binary: false }] },
            { token: alice.token },
        );
        expect(result.compile).toEqual({
            base64_encoded: "VEFQRA==",
            sld: '{"kind":"zxbasic"}',
        });

        const request = compilerRequests[0];
        expect(request).toBeDefined();
        const body = request?.body as {
            action: { name: string };
            input: Record<string, unknown>;
            session_variables: Record<string, string>;
        };
        expect(body.action.name).toBe("compile");
        expect(body.input.basic).toBe('10 PRINT "HI"');
        expect(body.session_variables["x-hasura-role"]).toBe("zxplay-user");
        expect(body.session_variables["x-hasura-user-id"]).toBe(alice.id);
        expect(request?.headers.authorization).toMatch(/^Bearer /);
    });

    it("surfaces handler errors as errors[].message", async () => {
        compilerResponse = {
            status: 400,
            body: { message: "line 10: syntax error" },
        };
        const result = await gql(
            `mutation ($basic: String!) { compile(basic: $basic) { base64_encoded } }`,
            { basic: "oops" },
        );
        expect(result.errors?.[0]?.message).toBe("line 10: syntax error");
        compilerResponse = { status: 200, body: { base64_encoded: "AAAA", sld: null } };
    });
});

describe("live project list subscription", () => {
    const SUBSCRIPTION = `subscription($user_id: uuid!) {
        project(
            where: {owner_user_id: {_eq: $user_id}},
            order_by: {updated_at: desc}
        ) {
            project_id title lang machine is_public created_at updated_at slug
        }
    }`;

    it("acks, delivers the initial list, and pushes on change", async () => {
        const ws = new WebSocket(wsUrl, "graphql-ws");
        const frames: Array<Record<string, unknown>> = [];
        const waitFor = (predicate: () => boolean, timeout = 10_000) =>
            new Promise<void>((resolve, reject) => {
                const start = Date.now();
                const poll = setInterval(() => {
                    if (predicate()) {
                        clearInterval(poll);
                        resolve();
                    } else if (Date.now() - start > timeout) {
                        clearInterval(poll);
                        reject(new Error(`timed out; frames: ${JSON.stringify(frames)}`));
                    }
                }, 25);
            });

        ws.on("message", (raw) => {
            frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
        });
        await new Promise<void>((resolve) => ws.on("open", () => resolve()));
        expect(ws.protocol).toBe("graphql-ws");

        ws.send(JSON.stringify({
            type: "connection_init",
            payload: { headers: { Authorization: `Bearer ${alice.token}` } },
        }));
        await waitFor(() => frames.some((f) => f.type === "connection_ack"));

        ws.send(JSON.stringify({
            type: "start",
            id: "1",
            payload: { query: SUBSCRIPTION, variables: { user_id: alice.id }, operationName: null },
        }));
        await waitFor(() => frames.some((f) => f.type === "data"));

        const first = frames.find((f) => f.type === "data") as {
            payload: { data: { project: Array<{ title: string }> } };
        };
        const initialCount = first.payload.data.project.length;
        expect(initialCount).toBeGreaterThanOrEqual(2);

        // A rename must push a fresh result over the socket.
        await data(
            `mutation ($project_id: uuid!, $title: String!) {
                update_project_by_pk(pk_columns: {project_id: $project_id}, _set: {title: $title}) { project_id slug }
            }`,
            { project_id: alicePublicProjectId, title: "Public Demo v2" },
            { token: alice.token },
        );
        await waitFor(() =>
            frames.some(
                (f) =>
                    f.type === "data" &&
                    JSON.stringify(f).includes("Public Demo v2"),
            ),
        );

        ws.send(JSON.stringify({ type: "stop", id: "1" }));
        await waitFor(() => frames.some((f) => f.type === "complete"));
        ws.close(1000);
    });
});
