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

describe("project folders", () => {
    let examplesFolderId = ""; // alice, public
    let wipFolderId = ""; // alice, private

    const CREATE_FOLDER = `mutation CreateFolder($name: String!, $is_public: Boolean!) {
        insert_project_folder_one(object: {name: $name, is_public: $is_public}) {
            folder_id owner_user_id name is_public
        }
    }`;
    const SET_PROJECT_FOLDER = `mutation MoveProjectToFolder($project_id: uuid!, $folder_id: uuid) {
        update_project_by_pk(pk_columns: {project_id: $project_id}, _set: {folder_id: $folder_id}) {
            project_id folder_id folder { name }
        }
    }`;

    it("creates folders with the owner preset and per-owner unique names", async () => {
        const pub = await data(
            CREATE_FOLDER,
            { name: "Examples", is_public: true },
            { token: alice.token },
        );
        const created = pub.insert_project_folder_one as {
            folder_id: string; owner_user_id: string; is_public: boolean;
        };
        examplesFolderId = created.folder_id;
        expect(created.owner_user_id).toBe(alice.id); // preset, not client-supplied
        expect(created.is_public).toBe(true);

        const priv = await data(
            CREATE_FOLDER,
            { name: "WIP", is_public: false },
            { token: alice.token },
        );
        wipFolderId = (priv.insert_project_folder_one as { folder_id: string }).folder_id;

        const dup = await gql(
            CREATE_FOLDER,
            { name: "Examples", is_public: false },
            { token: alice.token },
        );
        expect(dup.errors?.[0]?.message).toMatch(/Uniqueness violation/);

        // The name is only unique per owner: bob may reuse it.
        const bobs = await data(
            CREATE_FOLDER,
            { name: "Examples", is_public: false },
            { token: bob.token },
        );
        const bobsId = (bobs.insert_project_folder_one as { folder_id: string }).folder_id;
        await data(
            `mutation ($folder_id: uuid!) { delete_project_folder_by_pk(folder_id: $folder_id) { folder_id } }`,
            { folder_id: bobsId },
            { token: bob.token },
        );
    });

    it("shows only public folders to other users and anonymous", async () => {
        const doc = `query GetUserFolders($user_id: uuid!) {
            project_folder(where: {owner_user_id: {_eq: $user_id}}, order_by: [{display_order: asc}, {name: asc}]) {
                folder_id name is_public
            }
        }`;
        const anon = await data(doc, { user_id: alice.id });
        expect((anon.project_folder as Array<{ name: string }>).map((f) => f.name)).toEqual(["Examples"]);
        const asBob = await data(doc, { user_id: alice.id }, { token: bob.token });
        expect((asBob.project_folder as Array<{ name: string }>).map((f) => f.name)).toEqual(["Examples"]);
        const asAlice = await data(doc, { user_id: alice.id }, { token: alice.token });
        expect((asAlice.project_folder as unknown[]).length).toBe(2);
    });

    it("cannot rename or delete someone else's folder", async () => {
        const rename = await data(
            `mutation ($folder_id: uuid!, $name: String!) {
                update_project_folder_by_pk(pk_columns: {folder_id: $folder_id}, _set: {name: $name}) { folder_id }
            }`,
            { folder_id: examplesFolderId, name: "hax" },
            { token: bob.token },
        );
        expect(rename.update_project_folder_by_pk).toBeNull();
        const del = await data(
            `mutation ($folder_id: uuid!) { delete_project_folder_by_pk(folder_id: $folder_id) { folder_id } }`,
            { folder_id: examplesFolderId },
            { token: bob.token },
        );
        expect(del.delete_project_folder_by_pk).toBeNull();
    });

    it("files projects only into the owner's folders", async () => {
        const moved = await data(
            SET_PROJECT_FOLDER,
            { project_id: alicePublicProjectId, folder_id: examplesFolderId },
            { token: alice.token },
        );
        const project = moved.update_project_by_pk as {
            folder_id: string; folder: { name: string };
        };
        expect(project.folder_id).toBe(examplesFolderId);
        expect(project.folder.name).toBe("Examples");

        // The composite FK rejects another user's folder on insert...
        const foreign = await gql(
            `mutation ($title: String!, $lang: String!, $slug: String!, $machine: String!, $folder_id: uuid) {
                insert_project_one(object: {title: $title, lang: $lang, slug: $slug, machine: $machine, folder_id: $folder_id}) { project_id }
            }`,
            { title: "Sneak", lang: "zxbasic", slug: "sneak", machine: "48", folder_id: examplesFolderId },
            { token: bob.token },
        );
        expect(foreign.errors?.[0]?.message).toMatch(/Foreign key violation/);

        // ...and a dangling folder_id on update.
        const dangling = await gql(
            SET_PROJECT_FOLDER,
            { project_id: alicePublicProjectId, folder_id: "00000000-0000-0000-0000-000000000000" },
            { token: alice.token },
        );
        expect(dangling.errors?.[0]?.message).toMatch(/Foreign key violation/);
    });

    it("keeps a public project visible when its private folder is hidden", async () => {
        await data(
            SET_PROJECT_FOLDER,
            { project_id: alicePublicProjectId, folder_id: wipFolderId },
            { token: alice.token },
        );
        const anon = await data(
            `query ($project_id: uuid!) {
                project_by_pk(project_id: $project_id) { project_id folder_id folder { name is_public } }
            }`,
            { project_id: alicePublicProjectId },
        );
        const row = anon.project_by_pk as { folder_id: string; folder: unknown };
        expect(row.folder_id).toBe(wipFolderId);
        expect(row.folder).toBeNull(); // private folder masked from the public role
        // Unfile again so later tests see the original shape.
        await data(
            SET_PROJECT_FOLDER,
            { project_id: alicePublicProjectId, folder_id: null },
            { token: alice.token },
        );
    });

    it("unfiles projects when their folder is deleted", async () => {
        const temp = await data(
            CREATE_FOLDER,
            { name: "Temp", is_public: false },
            { token: alice.token },
        );
        const tempId = (temp.insert_project_folder_one as { folder_id: string }).folder_id;
        await data(
            SET_PROJECT_FOLDER,
            { project_id: alicePrivateProjectId, folder_id: tempId },
            { token: alice.token },
        );
        await data(
            `mutation ($folder_id: uuid!) { delete_project_folder_by_pk(folder_id: $folder_id) { folder_id name } }`,
            { folder_id: tempId },
            { token: alice.token },
        );
        const after = await data(
            `query ($project_id: uuid!) {
                project_by_pk(project_id: $project_id) { project_id owner_user_id folder_id }
            }`,
            { project_id: alicePrivateProjectId },
            { token: alice.token },
        );
        const row = after.project_by_pk as { owner_user_id: string; folder_id: string | null };
        expect(row.folder_id).toBeNull();
        expect(row.owner_user_id).toBe(alice.id); // SET NULL must not touch the owner
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

    it("DeleteSession / DeleteOtherSessions (logout and OTP-enable revocation)", async () => {
        const now = new Date();
        const createDoc = `mutation CreateSession($user_id: uuid!, $auth_token: String!, $created: timestamptz!, $expires: timestamptz!) {
            insert_session_one(object: {user_id: $user_id, auth_token: $auth_token, created: $created, expires: $expires}) {
                session_id
            }
        }`;
        for (const token of ["revoke-me", "keep-me", "other-1", "other-2"]) {
            await data(
                createDoc,
                {
                    user_id: bob.id,
                    auth_token: token,
                    created: now.toISOString(),
                    expires: new Date(now.getTime() + 3600_000).toISOString(),
                },
                { admin: true },
            );
        }

        const deleted = await data(
            `mutation DeleteSession($auth_token: String!) {
                delete_session(where: {auth_token: {_eq: $auth_token}}) { affected_rows }
            }`,
            { auth_token: "revoke-me" },
            { admin: true },
        );
        expect((deleted.delete_session as { affected_rows: number }).affected_rows).toBe(1);

        const others = await data(
            `mutation DeleteOtherSessions($user_id: uuid!, $auth_token: String!) {
                delete_session(where: {user_id: {_eq: $user_id}, auth_token: {_neq: $auth_token}}) { affected_rows }
            }`,
            { user_id: bob.id, auth_token: "keep-me" },
            { admin: true },
        );
        // other-1, other-2 and the earlier test's session-token-1 go;
        // keep-me survives.
        expect((others.delete_session as { affected_rows: number }).affected_rows).toBe(3);

        const remaining = await data(
            `query GetSession($auth_token: String!) {
                session(where: {auth_token: {_eq: $auth_token}}) { session_id }
            }`,
            { auth_token: "keep-me" },
            { admin: true },
        );
        expect((remaining.session as unknown[]).length).toBe(1);
    });

    it("delete_session is admin-only", async () => {
        const asUser = await gql(
            `mutation { delete_session(where: {auth_token: {_eq: "keep-me"}}) { affected_rows } }`,
            {},
            { token: bob.token },
        );
        expect(asUser.errors?.[0]?.message).toMatch(/session/);
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

    it("CreateLoginToken / GetLoginToken / ConsumeLoginToken / InvalidatePendingLoginTokens", async () => {
        const now = new Date();
        const hash = "a".repeat(64);
        const staleHash = "b".repeat(64);

        // Issuing first invalidates any pending tokens for the email.
        await data(
            `mutation CreateLoginToken($email: String!, $token_hash: String!, $redirect_url: String, $created: timestamptz!, $expires: timestamptz!) {
                insert_login_token_one(object: {email: $email, token_hash: $token_hash, redirect_url: $redirect_url, created: $created, expires: $expires}) {
                    login_token_id
                }
            }`,
            {
                email: "magic@example.com",
                token_hash: staleHash,
                redirect_url: null,
                created: now.toISOString(),
                expires: new Date(now.getTime() + 15 * 60_000).toISOString(),
            },
            { admin: true },
        );
        const invalidated = await data(
            `mutation InvalidatePendingLoginTokens($email: String!, $now: timestamptz!) {
                update_login_token(where: {email: {_eq: $email}, consumed: {_is_null: true}}, _set: {consumed: $now}) {
                    affected_rows
                }
            }`,
            { email: "magic@example.com", now: now.toISOString() },
            { admin: true },
        );
        expect((invalidated.update_login_token as { affected_rows: number }).affected_rows).toBe(1);

        await data(
            `mutation CreateLoginToken($email: String!, $token_hash: String!, $redirect_url: String, $created: timestamptz!, $expires: timestamptz!) {
                insert_login_token_one(object: {email: $email, token_hash: $token_hash, redirect_url: $redirect_url, created: $created, expires: $expires}) {
                    login_token_id
                }
            }`,
            {
                email: "magic@example.com",
                token_hash: hash,
                redirect_url: "http://localhost:8080/",
                created: now.toISOString(),
                expires: new Date(now.getTime() + 15 * 60_000).toISOString(),
            },
            { admin: true },
        );

        // Consumption is the atomic single-use gate: affected_rows 1 then 0.
        const consumeDoc = `mutation ConsumeLoginToken($token_hash: String!, $now: timestamptz!) {
            update_login_token(where: {token_hash: {_eq: $token_hash}, consumed: {_is_null: true}, expires: {_gt: $now}}, _set: {consumed: $now}) {
                affected_rows
            }
        }`;
        const consumed = await data(
            consumeDoc,
            { token_hash: hash, now: now.toISOString() },
            { admin: true },
        );
        expect((consumed.update_login_token as { affected_rows: number }).affected_rows).toBe(1);

        const fetched = await data(
            `query GetLoginToken($token_hash: String!) {
                login_token(where: {token_hash: {_eq: $token_hash}}) { email redirect_url }
            }`,
            { token_hash: hash },
            { admin: true },
        );
        const tokens = fetched.login_token as Array<{ email: string; redirect_url: string | null }>;
        expect(tokens[0]?.email).toBe("magic@example.com");
        expect(tokens[0]?.redirect_url).toBe("http://localhost:8080/");

        const again = await data(
            consumeDoc,
            { token_hash: hash, now: now.toISOString() },
            { admin: true },
        );
        expect((again.update_login_token as { affected_rows: number }).affected_rows).toBe(0);

        // The stale (invalidated) token cannot be consumed either.
        const stale = await data(
            consumeDoc,
            { token_hash: staleHash, now: now.toISOString() },
            { admin: true },
        );
        expect((stale.update_login_token as { affected_rows: number }).affected_rows).toBe(0);

        const deleted = await data(
            `mutation DeleteLoginTokens($email: String!) {
                delete_login_token(where: {email: {_eq: $email}}) { affected_rows }
            }`,
            { email: "magic@example.com" },
            { admin: true },
        );
        expect((deleted.delete_login_token as { affected_rows: number }).affected_rows).toBe(2);
    });

    it("user_otp / otp_recovery_code documents (OTP enrolment and consumption)", async () => {
        const now = new Date().toISOString();

        await data(
            `mutation CreateUserOtp($user_id: uuid!, $secret: String!, $created: timestamptz!) {
                insert_user_otp_one(object: {user_id: $user_id, secret: $secret, created: $created}) { user_id }
            }`,
            { user_id: bob.id, secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", created: now },
            { admin: true },
        );

        const pending = await data(
            `query GetUserOtp($user_id: uuid!) {
                user_otp(where: {user_id: {_eq: $user_id}}) { secret enabled last_used_step }
            }`,
            { user_id: bob.id },
            { admin: true },
        );
        const rows = pending.user_otp as Array<{
            secret: string;
            enabled: string | null;
            last_used_step: number | null;
        }>;
        expect(rows[0]?.secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        expect(rows[0]?.enabled).toBeNull();
        expect(rows[0]?.last_used_step).toBeNull();

        // TOTP one-time use: a step claims once, replays and older steps
        // are rejected, a newer step claims again.
        const stepDoc = `mutation ConsumeTotpStep($user_id: uuid!, $step: Int!) {
            update_user_otp(where: {user_id: {_eq: $user_id}, _or: [{last_used_step: {_is_null: true}}, {last_used_step: {_lt: $step}}]}, _set: {last_used_step: $step}) {
                affected_rows
            }
        }`;
        const claim = async (step: number): Promise<number> => {
            const result = await data(stepDoc, { user_id: bob.id, step }, { admin: true });
            return (result.update_user_otp as { affected_rows: number }).affected_rows;
        };
        expect(await claim(59_000_000)).toBe(1);
        expect(await claim(59_000_000)).toBe(0);
        expect(await claim(58_999_999)).toBe(0);
        expect(await claim(59_000_001)).toBe(1);

        const enabled = await data(
            `mutation EnableUserOtp($user_id: uuid!, $now: timestamptz!) {
                update_user_otp(where: {user_id: {_eq: $user_id}, enabled: {_is_null: true}}, _set: {enabled: $now}) {
                    affected_rows
                }
            }`,
            { user_id: bob.id, now },
            { admin: true },
        );
        expect((enabled.update_user_otp as { affected_rows: number }).affected_rows).toBe(1);

        const codeHash = "d".repeat(64);
        await data(
            `mutation CreateOtpRecoveryCode($user_id: uuid!, $code_hash: String!, $created: timestamptz!) {
                insert_otp_recovery_code_one(object: {user_id: $user_id, code_hash: $code_hash, created: $created}) {
                    recovery_code_id
                }
            }`,
            { user_id: bob.id, code_hash: codeHash, created: now },
            { admin: true },
        );

        // Single-use consumption: affected_rows 1, then 0.
        const consumeDoc = `mutation ConsumeOtpRecoveryCode($user_id: uuid!, $code_hash: String!, $now: timestamptz!) {
            update_otp_recovery_code(where: {user_id: {_eq: $user_id}, code_hash: {_eq: $code_hash}, used: {_is_null: true}}, _set: {used: $now}) {
                affected_rows
            }
        }`;
        const consumed = await data(
            consumeDoc,
            { user_id: bob.id, code_hash: codeHash, now },
            { admin: true },
        );
        expect((consumed.update_otp_recovery_code as { affected_rows: number }).affected_rows).toBe(1);
        const again = await data(
            consumeDoc,
            { user_id: bob.id, code_hash: codeHash, now },
            { admin: true },
        );
        expect((again.update_otp_recovery_code as { affected_rows: number }).affected_rows).toBe(0);

        const unused = await data(
            `query GetUnusedRecoveryCodes($user_id: uuid!) {
                otp_recovery_code(where: {user_id: {_eq: $user_id}, used: {_is_null: true}}) { recovery_code_id }
            }`,
            { user_id: bob.id },
            { admin: true },
        );
        expect((unused.otp_recovery_code as unknown[]).length).toBe(0);

        const deletedCodes = await data(
            `mutation DeleteOtpRecoveryCodes($user_id: uuid!) {
                delete_otp_recovery_code(where: {user_id: {_eq: $user_id}}) { affected_rows }
            }`,
            { user_id: bob.id },
            { admin: true },
        );
        expect((deletedCodes.delete_otp_recovery_code as { affected_rows: number }).affected_rows).toBe(1);

        const deletedOtp = await data(
            `mutation DeleteUserOtp($user_id: uuid!) {
                delete_user_otp(where: {user_id: {_eq: $user_id}}) { affected_rows }
            }`,
            { user_id: bob.id },
            { admin: true },
        );
        expect((deletedOtp.delete_user_otp as { affected_rows: number }).affected_rows).toBe(1);
    });

    it("OTP tables are admin-only", async () => {
        const asPublic = await gql(`query { user_otp { user_id } }`);
        expect(asPublic.errors?.[0]?.message).toMatch(/user_otp/);

        const asUser = await gql(
            `query { otp_recovery_code { recovery_code_id } }`,
            {},
            { token: bob.token },
        );
        expect(asUser.errors?.[0]?.message).toMatch(/otp_recovery_code/);
    });

    it("login tokens are admin-only", async () => {
        const asPublic = await gql(`query { login_token { login_token_id } }`);
        expect(asPublic.errors?.[0]?.message).toMatch(/login_token/);

        const asUser = await gql(
            `query { login_token { login_token_id } }`,
            {},
            { token: bob.token },
        );
        expect(asUser.errors?.[0]?.message).toMatch(/login_token/);

        const userInsert = await gql(
            `mutation { insert_login_token_one(object: {email: "x@example.com", token_hash: "${"c".repeat(64)}", created: "2026-01-01T00:00:00Z", expires: "2026-01-01T00:15:00Z"}) { login_token_id } }`,
            {},
            { token: bob.token },
        );
        expect(userInsert.errors?.[0]?.message).toMatch(/insert_login_token_one/);
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

    it("pushes the folder list on folder changes", async () => {
        const FOLDER_SUBSCRIPTION = `subscription($user_id: uuid!) {
            project_folder(
                where: {owner_user_id: {_eq: $user_id}},
                order_by: [{display_order: asc}, {name: asc}]
            ) {
                folder_id name is_public display_order
            }
        }`;
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
        ws.send(JSON.stringify({
            type: "connection_init",
            payload: { headers: { Authorization: `Bearer ${alice.token}` } },
        }));
        await waitFor(() => frames.some((f) => f.type === "connection_ack"));

        ws.send(JSON.stringify({
            type: "start",
            id: "1",
            payload: { query: FOLDER_SUBSCRIPTION, variables: { user_id: alice.id }, operationName: null },
        }));
        await waitFor(() => frames.some((f) => f.type === "data"));

        // Folder mutations publish the same owner-scoped event as projects,
        // so a rename must push a fresh folder list.
        const folders = await data(
            `query ($user_id: uuid!) {
                project_folder(where: {owner_user_id: {_eq: $user_id}, name: {_eq: "Examples"}}) { folder_id }
            }`,
            { user_id: alice.id },
            { token: alice.token },
        );
        const folderRows = folders.project_folder as Array<{ folder_id: string }>;
        expect(folderRows.length).toBe(1);
        const folderId = folderRows[0]!.folder_id;
        await data(
            `mutation ($folder_id: uuid!, $name: String!) {
                update_project_folder_by_pk(pk_columns: {folder_id: $folder_id}, _set: {name: $name}) { folder_id name }
            }`,
            { folder_id: folderId, name: "Examples v2" },
            { token: alice.token },
        );
        await waitFor(() =>
            frames.some(
                (f) => f.type === "data" && JSON.stringify(f).includes("Examples v2"),
            ),
        );

        ws.send(JSON.stringify({ type: "stop", id: "1" }));
        await waitFor(() => frames.some((f) => f.type === "complete"));
        ws.close(1000);
    });
});
