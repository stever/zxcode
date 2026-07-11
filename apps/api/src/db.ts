// Prisma client plus a string-keyed view of its model delegates. The engine
// dispatches on table names at runtime, which Prisma's generated types cannot
// express, so each delegate is narrowed to the structural subset the engine
// uses.

import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

type Row = Record<string, unknown>;

export interface Delegate {
    findMany(args: object): Promise<Row[]>;
    findFirst(args: object): Promise<Row | null>;
    count(args: { where?: object }): Promise<number>;
    create(args: object): Promise<Row>;
    updateMany(args: object): Promise<{ count: number }>;
    deleteMany(args: object): Promise<{ count: number }>;
    groupBy(args: object): Promise<Row[]>;
}

const asDelegate = (delegate: unknown): Delegate => delegate as Delegate;

export const delegates: Record<string, Delegate> = {
    user: asDelegate(prisma.user),
    project: asDelegate(prisma.project),
    project_file: asDelegate(prisma.project_file),
    project_star: asDelegate(prisma.project_star),
    user_follows: asDelegate(prisma.user_follows),
    session: asDelegate(prisma.session),
    role: asDelegate(prisma.role),
    user_role: asDelegate(prisma.user_role),
    text: asDelegate(prisma.text),
};

export function delegate(prismaModel: string): Delegate {
    const d = delegates[prismaModel];
    if (!d) throw new Error(`unknown prisma model: ${prismaModel}`);
    return d;
}
