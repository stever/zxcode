// GraphQL error shaping. Every response keeps the Hasura envelope — HTTP 200
// with { data, errors: [{ message }] } — because the frontend's axios wrapper
// treats non-2xx as a transport exception. Prisma errors are rewritten into
// the messages callers historically saw from Hasura/Postgres.

import { GraphQLError } from "graphql";
import { Prisma } from "@prisma/client";

export interface WireError {
    message: string;
}

// Trigger RAISEs and other database errors reach Prisma wrapped in engine
// noise; pull out the underlying Postgres message when it is recognisable.
const DB_MESSAGE_PATTERN = /message: "([^"]+)"/;

export function formatError(err: unknown): WireError {
    const original =
        err instanceof GraphQLError && err.originalError ? err.originalError : err;

    if (original instanceof Prisma.PrismaClientKnownRequestError) {
        if (original.code === "P2002") {
            const target = Array.isArray(original.meta?.target)
                ? (original.meta?.target as string[]).join(", ")
                : String(original.meta?.target ?? "");
            return {
                message: `Uniqueness violation. duplicate key value violates unique constraint "${target}"`,
            };
        }
        if (original.code === "P2003") {
            return {
                message: "Foreign key violation. insert or update violates foreign key constraint",
            };
        }
        const match = DB_MESSAGE_PATTERN.exec(original.message);
        if (match?.[1]) return { message: match[1] };
        return { message: original.message.split("\n").pop() ?? original.message };
    }

    if (original instanceof Prisma.PrismaClientUnknownRequestError) {
        const match = DB_MESSAGE_PATTERN.exec(original.message);
        if (match?.[1]) return { message: match[1] };
    }

    if (err instanceof GraphQLError) return { message: err.message };
    return { message: original instanceof Error ? original.message : String(err) };
}
