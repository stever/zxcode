// Builds the executable schema: SDL from sdl.ts, custom scalar behaviour, and
// the root resolvers from resolvers.ts.

import {
    GraphQLError,
    GraphQLObjectType,
    GraphQLScalarType,
    Kind,
    buildSchema,
    valueFromASTUntyped,
    type ValueNode,
} from "graphql";
import { sdl } from "./sdl.js";
import {
    makeActionResolver,
    makeAggregateResolver,
    makeByPkResolver,
    makeDeleteByPkResolver,
    makeDeleteManyResolver,
    makeInsertOneResolver,
    makeListResolver,
    makeUpdateByPkResolver,
    makeUpdateManyResolver,
} from "./resolvers.js";

export const schema = buildSchema(sdl);

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function scalar(name: string): GraphQLScalarType {
    return schema.getType(name) as GraphQLScalarType;
}

function parseUuid(value: unknown): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        throw new GraphQLError(`invalid input syntax for type uuid: ${String(value)}`);
    }
    return value;
}

const uuidScalar = scalar("uuid");
uuidScalar.serialize = (value) => String(value);
uuidScalar.parseValue = parseUuid;
uuidScalar.parseLiteral = (ast: ValueNode) => {
    if (ast.kind !== Kind.STRING) {
        throw new GraphQLError("uuid values must be strings");
    }
    return parseUuid(ast.value);
};

const timestamptzScalar = scalar("timestamptz");
timestamptzScalar.serialize = (value) =>
    value instanceof Date ? value.toISOString() : String(value);
timestamptzScalar.parseValue = (value) => {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        throw new GraphQLError(
            `invalid input syntax for type timestamptz: ${String(value)}`,
        );
    }
    return value;
};
timestamptzScalar.parseLiteral = (ast: ValueNode) => {
    if (ast.kind !== Kind.STRING) {
        throw new GraphQLError("timestamptz values must be strings");
    }
    return timestamptzScalar.parseValue(ast.value);
};

const jsonbScalar = scalar("jsonb");
jsonbScalar.serialize = (value) => value;
jsonbScalar.parseValue = (value) => value;
jsonbScalar.parseLiteral = (ast: ValueNode) => valueFromASTUntyped(ast);

type Resolver = (
    source: unknown,
    args: never,
    ctx: never,
    info: never,
) => unknown;

function attach(typeName: string, resolvers: Record<string, Resolver>): void {
    const type = schema.getType(typeName) as GraphQLObjectType;
    const fields = type.getFields();
    for (const [fieldName, resolve] of Object.entries(resolvers)) {
        const field = fields[fieldName];
        if (!field) throw new Error(`schema is missing ${typeName}.${fieldName}`);
        field.resolve = resolve as never;
    }
}

attach("Query", {
    user: makeListResolver("user") as Resolver,
    user_by_pk: makeByPkResolver("user") as Resolver,
    user_aggregate: makeAggregateResolver("user") as Resolver,
    project: makeListResolver("project") as Resolver,
    project_by_pk: makeByPkResolver("project") as Resolver,
    project_aggregate: makeAggregateResolver("project") as Resolver,
    project_folder: makeListResolver("project_folder") as Resolver,
    project_folder_by_pk: makeByPkResolver("project_folder") as Resolver,
    project_file: makeListResolver("project_file") as Resolver,
    project_file_by_pk: makeByPkResolver("project_file") as Resolver,
    project_star: makeListResolver("project_star") as Resolver,
    project_star_aggregate: makeAggregateResolver("project_star") as Resolver,
    user_follows: makeListResolver("user_follows") as Resolver,
    user_follows_aggregate: makeAggregateResolver("user_follows") as Resolver,
    session: makeListResolver("session") as Resolver,
    login_token: makeListResolver("login_token") as Resolver,
    user_otp: makeListResolver("user_otp") as Resolver,
    otp_recovery_code: makeListResolver("otp_recovery_code") as Resolver,
    text: makeListResolver("text") as Resolver,
});

attach("Mutation", {
    insert_user_one: makeInsertOneResolver("user") as Resolver,
    update_user_by_pk: makeUpdateByPkResolver("user") as Resolver,
    update_user: makeUpdateManyResolver("user") as Resolver,

    insert_project_one: makeInsertOneResolver("project") as Resolver,
    update_project_by_pk: makeUpdateByPkResolver("project") as Resolver,
    delete_project_by_pk: makeDeleteByPkResolver("project") as Resolver,

    insert_project_folder_one: makeInsertOneResolver("project_folder") as Resolver,
    update_project_folder_by_pk: makeUpdateByPkResolver("project_folder") as Resolver,
    delete_project_folder_by_pk: makeDeleteByPkResolver("project_folder") as Resolver,

    insert_project_file_one: makeInsertOneResolver("project_file") as Resolver,
    update_project_file_by_pk: makeUpdateByPkResolver("project_file") as Resolver,
    delete_project_file_by_pk: makeDeleteByPkResolver("project_file") as Resolver,

    insert_project_star_one: makeInsertOneResolver("project_star") as Resolver,
    delete_project_star: makeDeleteManyResolver("project_star") as Resolver,

    insert_user_follows_one: makeInsertOneResolver("user_follows") as Resolver,
    delete_user_follows: makeDeleteManyResolver("user_follows") as Resolver,

    insert_session_one: makeInsertOneResolver("session") as Resolver,
    update_session_by_pk: makeUpdateByPkResolver("session") as Resolver,
    delete_session: makeDeleteManyResolver("session") as Resolver,

    insert_login_token_one: makeInsertOneResolver("login_token") as Resolver,
    update_login_token: makeUpdateManyResolver("login_token") as Resolver,
    delete_login_token: makeDeleteManyResolver("login_token") as Resolver,

    insert_user_otp_one: makeInsertOneResolver("user_otp") as Resolver,
    update_user_otp: makeUpdateManyResolver("user_otp") as Resolver,
    delete_user_otp: makeDeleteManyResolver("user_otp") as Resolver,

    insert_otp_recovery_code_one: makeInsertOneResolver("otp_recovery_code") as Resolver,
    update_otp_recovery_code: makeUpdateManyResolver("otp_recovery_code") as Resolver,
    delete_otp_recovery_code: makeDeleteManyResolver("otp_recovery_code") as Resolver,

    compile: makeActionResolver("compile") as Resolver,
    compileC: makeActionResolver("compileC") as Resolver,
    compileSjasmplus: makeActionResolver("compileSjasmplus") as Resolver,
    compilePascal: makeActionResolver("compilePascal") as Resolver,
});

attach("Subscription", {
    // Executed like a query on every matching pubsub event (see
    // subscription.ts); the resolver itself is the plain list resolver.
    project: makeListResolver("project") as Resolver,
    project_folder: makeListResolver("project_folder") as Resolver,
});
