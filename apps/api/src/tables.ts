// Per-table configuration: how each GraphQL table maps onto Prisma, and the
// role-based permission rules carried over verbatim from
// hasura/metadata/databases/default/tables/*.yaml.
//
// The admin role (X-Hasura-Admin-Secret) bypasses every rule; `public` is the
// unauthenticated role; `zxplay-user` is any request with a valid JWT.

export type Role = "admin" | "zxplay-user" | "public";

export interface Session {
    role: Role;
    userId: string | null;
}

export type PrismaWhere = Record<string, unknown>;

export interface SelectRule {
    columns: readonly string[];
    filter: (s: Session) => PrismaWhere;
    // JS mirror of `filter`, applied to to-one relations (Prisma cannot
    // filter to-one includes) using the columns listed in predicateColumns.
    predicate: (row: Record<string, unknown>, s: Session) => boolean;
    predicateColumns: readonly string[];
}

export interface InsertRule {
    columns: readonly string[];
    presets?: (s: Session) => Record<string, unknown>;
    // Hasura insert check expression; returns null when satisfied, otherwise
    // an error message.
    check?: (
        object: Record<string, unknown>,
        s: Session,
        db: DbCheck,
    ) => Promise<string | null>;
}

// The one check that needs a database lookup (project_file ownership) gets it
// through this narrow interface so rules stay testable without a client.
export interface DbCheck {
    projectOwner(projectId: string): Promise<string | null>;
}

export interface UpdateRule {
    columns: readonly string[];
    filter: (s: Session) => PrismaWhere;
}

export interface DeleteRule {
    filter: (s: Session) => PrismaWhere;
}

export interface Relation {
    table: string;
    prismaField: string;
    kind: "one" | "many";
    // For "many": the FK column on the target table pointing back at this
    // table, needed by the groupBy fallback for aggregate-max ordering.
    fk?: string;
}

export interface TableConfig {
    prismaModel: string;
    pk: readonly string[];
    columns: readonly string[];
    jsonColumns: readonly string[];
    nullableColumns: readonly string[];
    relations: Record<string, Relation>;
    select: Partial<Record<"public" | "zxplay-user", SelectRule>>;
    insert?: Partial<Record<"zxplay-user", InsertRule>>;
    update?: Partial<Record<"zxplay-user", UpdateRule>>;
    delete?: Partial<Record<"zxplay-user", DeleteRule>>;
}

const me = (s: Session): string => {
    if (!s.userId) throw new Error("no session user id");
    return s.userId;
};

const USER_PUBLIC_COLUMNS = [
    "user_id",
    "username",
    "greeting_name",
    "created_at",
    "slug",
    "bio",
    "profile_is_public",
    "avatar_variant",
    "custom_avatar_data",
] as const;

const userSelectPublic: SelectRule = {
    columns: USER_PUBLIC_COLUMNS,
    filter: () => ({ profile_is_public: true }),
    predicate: (row) => row.profile_is_public === true,
    predicateColumns: ["profile_is_public"],
};

const userSelectOwn: SelectRule = {
    columns: [...USER_PUBLIC_COLUMNS, "full_name", "email_address"],
    filter: (s) => ({ OR: [{ user_id: me(s) }, { profile_is_public: true }] }),
    predicate: (row, s) =>
        row.profile_is_public === true || row.user_id === s.userId,
    predicateColumns: ["profile_is_public", "user_id"],
};

const PROJECT_COLUMNS = [
    "project_id",
    "title",
    "code",
    "owner_user_id",
    "updated_at",
    "created_at",
    "lang",
    "is_public",
    "slug",
    "display_order",
    "machine",
] as const;

const projectSelectPublic: SelectRule = {
    columns: PROJECT_COLUMNS,
    filter: () => ({ is_public: true }),
    predicate: (row) => row.is_public === true,
    predicateColumns: ["is_public"],
};

const projectSelectOwn: SelectRule = {
    columns: PROJECT_COLUMNS,
    filter: (s) => ({ OR: [{ owner_user_id: me(s) }, { is_public: true }] }),
    predicate: (row, s) =>
        row.is_public === true || row.owner_user_id === s.userId,
    predicateColumns: ["is_public", "owner_user_id"],
};

const PROJECT_FILE_COLUMNS = [
    "file_id",
    "project_id",
    "name",
    "folder",
    "content",
    "is_binary",
    "created_at",
    "updated_at",
] as const;

const STAR_COLUMNS = ["user_id", "project_id", "created_at"] as const;
const FOLLOWS_COLUMNS = ["follower_id", "following_id", "created_at"] as const;

const unrestricted = (columns: readonly string[]): SelectRule => ({
    columns,
    filter: () => ({}),
    predicate: () => true,
    predicateColumns: [],
});

export const tables: Record<string, TableConfig> = {
    user: {
        prismaModel: "user",
        pk: ["user_id"],
        columns: [
            "user_id",
            "username",
            "greeting_name",
            "full_name",
            "email_address",
            "created_at",
            "slug",
            "profile_is_public",
            "bio",
            "avatar_variant",
            "custom_avatar_data",
        ],
        jsonColumns: ["custom_avatar_data"],
        nullableColumns: [
            "greeting_name",
            "full_name",
            "email_address",
            "created_at",
            "bio",
            "avatar_variant",
            "custom_avatar_data",
        ],
        relations: {
            projects: {
                table: "project",
                prismaField: "projects",
                kind: "many",
                fk: "owner_user_id",
            },
            starred_projects: {
                table: "project_star",
                prismaField: "starred_projects",
                kind: "many",
                fk: "user_id",
            },
            followers: {
                table: "user_follows",
                prismaField: "followers",
                kind: "many",
                fk: "following_id",
            },
            following: {
                table: "user_follows",
                prismaField: "following",
                kind: "many",
                fk: "follower_id",
            },
            user_roles: {
                table: "user_role",
                prismaField: "user_roles",
                kind: "many",
                fk: "user_id",
            },
        },
        select: { public: userSelectPublic, "zxplay-user": userSelectOwn },
        update: {
            "zxplay-user": {
                columns: [
                    "greeting_name",
                    "full_name",
                    "email_address",
                    "bio",
                    "profile_is_public",
                    "slug",
                    "avatar_variant",
                    "custom_avatar_data",
                ],
                filter: (s) => ({ user_id: me(s) }),
            },
        },
    },

    project: {
        prismaModel: "project",
        pk: ["project_id"],
        columns: PROJECT_COLUMNS,
        jsonColumns: [],
        nullableColumns: [
            "owner_user_id",
            "updated_at",
            "created_at",
            "display_order",
        ],
        relations: {
            // Hasura exposed the owner FK twice; both names map onto the one
            // Prisma relation.
            owner: { table: "user", prismaField: "owner", kind: "one" },
            user: { table: "user", prismaField: "owner", kind: "one" },
            files: {
                table: "project_file",
                prismaField: "files",
                kind: "many",
                fk: "project_id",
            },
            stars: {
                table: "project_star",
                prismaField: "stars",
                kind: "many",
                fk: "project_id",
            },
        },
        select: { public: projectSelectPublic, "zxplay-user": projectSelectOwn },
        insert: {
            "zxplay-user": {
                columns: ["code", "lang", "machine", "title", "slug", "is_public", "files"],
                presets: (s) => ({ owner_user_id: me(s) }),
            },
        },
        update: {
            "zxplay-user": {
                columns: ["code", "display_order", "machine", "title", "is_public", "slug"],
                filter: (s) => ({ owner_user_id: me(s) }),
            },
        },
        delete: {
            "zxplay-user": { filter: (s) => ({ owner_user_id: me(s) }) },
        },
    },

    project_file: {
        prismaModel: "project_file",
        pk: ["file_id"],
        columns: PROJECT_FILE_COLUMNS,
        jsonColumns: [],
        nullableColumns: [],
        relations: {
            project: { table: "project", prismaField: "project", kind: "one" },
        },
        select: {
            public: {
                columns: PROJECT_FILE_COLUMNS,
                filter: () => ({ project: { is: { is_public: true } } }),
                // The nested project is fetched through the relation, so the
                // predicate never sees it; row-level access is fully decided
                // by the Prisma filter. To-one traversal into project applies
                // that table's own predicate.
                predicate: () => true,
                predicateColumns: [],
            },
            "zxplay-user": {
                columns: PROJECT_FILE_COLUMNS,
                filter: (s) => ({
                    OR: [
                        { project: { is: { owner_user_id: me(s) } } },
                        { project: { is: { is_public: true } } },
                    ],
                }),
                predicate: () => true,
                predicateColumns: [],
            },
        },
        insert: {
            "zxplay-user": {
                columns: ["project_id", "name", "folder", "content", "is_binary"],
                check: async (object, s, db) => {
                    const owner = await db.projectOwner(String(object.project_id));
                    return owner !== null && owner === s.userId
                        ? null
                        : 'check constraint of an insert/update permission has failed';
                },
            },
        },
        update: {
            "zxplay-user": {
                columns: ["name", "folder", "content", "is_binary"],
                filter: (s) => ({ project: { is: { owner_user_id: me(s) } } }),
            },
        },
        delete: {
            "zxplay-user": {
                filter: (s) => ({ project: { is: { owner_user_id: me(s) } } }),
            },
        },
    },

    project_star: {
        prismaModel: "project_star",
        pk: ["user_id", "project_id"],
        columns: STAR_COLUMNS,
        jsonColumns: [],
        nullableColumns: ["created_at"],
        relations: {
            user: { table: "user", prismaField: "user", kind: "one" },
            project: { table: "project", prismaField: "project", kind: "one" },
        },
        select: {
            public: {
                columns: STAR_COLUMNS,
                filter: () => ({ project: { is: { is_public: true } } }),
                predicate: () => true,
                predicateColumns: [],
            },
            "zxplay-user": {
                columns: STAR_COLUMNS,
                filter: (s) => ({
                    OR: [
                        { project: { is: { is_public: true } } },
                        { project: { is: { owner_user_id: me(s) } } },
                    ],
                }),
                predicate: () => true,
                predicateColumns: [],
            },
        },
        insert: {
            "zxplay-user": {
                columns: ["project_id"],
                presets: (s) => ({ user_id: me(s) }),
            },
        },
        delete: {
            "zxplay-user": { filter: (s) => ({ user_id: me(s) }) },
        },
    },

    user_follows: {
        prismaModel: "user_follows",
        pk: ["follower_id", "following_id"],
        columns: FOLLOWS_COLUMNS,
        jsonColumns: [],
        nullableColumns: ["created_at"],
        relations: {
            follower: { table: "user", prismaField: "follower", kind: "one" },
            following: { table: "user", prismaField: "following", kind: "one" },
        },
        select: {
            public: unrestricted(FOLLOWS_COLUMNS),
            "zxplay-user": unrestricted(FOLLOWS_COLUMNS),
        },
        insert: {
            "zxplay-user": {
                columns: ["follower_id", "following_id"],
                check: async (object, s) =>
                    object.follower_id === s.userId
                        ? null
                        : 'check constraint of an insert/update permission has failed',
            },
        },
        delete: {
            "zxplay-user": { filter: (s) => ({ follower_id: me(s) }) },
        },
    },

    session: {
        prismaModel: "session",
        pk: ["session_id"],
        columns: ["session_id", "user_id", "auth_token", "created", "updated", "expires"],
        jsonColumns: [],
        nullableColumns: ["updated"],
        relations: {
            user: { table: "user", prismaField: "user", kind: "one" },
        },
        select: {},
    },

    role: {
        prismaModel: "role",
        pk: ["role_id"],
        columns: ["role_id", "name", "created_at"],
        jsonColumns: [],
        nullableColumns: ["created_at"],
        relations: {},
        select: {},
    },

    user_role: {
        prismaModel: "user_role",
        pk: ["user_id", "role_id"],
        columns: ["user_id", "role_id", "created_at"],
        jsonColumns: [],
        nullableColumns: ["created_at"],
        relations: {
            user: { table: "user", prismaField: "user", kind: "one" },
            role: { table: "role", prismaField: "role", kind: "one" },
        },
        select: {},
    },

    text: {
        prismaModel: "text",
        pk: ["text_id"],
        columns: ["text_id", "name", "lang", "text", "created_at", "updated_at"],
        jsonColumns: [],
        nullableColumns: [],
        relations: {},
        select: {
            public: unrestricted(["lang", "name", "text"]),
            "zxplay-user": unrestricted(["lang", "name", "text"]),
        },
    },
};

export function tableConfig(name: string): TableConfig {
    const config = tables[name];
    if (!config) throw new Error(`unknown table: ${name}`);
    return config;
}

// Admin sees every column with no row filter.
export function selectRule(table: string, s: Session): SelectRule {
    const config = tableConfig(table);
    if (s.role === "admin") return unrestricted(config.columns);
    const rule = config.select[s.role];
    if (!rule) {
        throw new Error(`field '${table}' not found in type: 'query_root'`);
    }
    return rule;
}
