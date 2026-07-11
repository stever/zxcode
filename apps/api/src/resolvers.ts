// Root resolvers: Hasura-style list/by_pk/aggregate queries, insert/update/
// delete mutations, and the compile actions. Every path applies the role
// rules from tables.ts both as Prisma filters and column checks.

import { GraphQLError, type GraphQLResolveInfo, type SelectionSetNode } from "graphql";
import { Prisma } from "@prisma/client";
import { delegate, type Delegate } from "./db.js";
import {
    tableConfig,
    selectRule,
    type DbCheck,
    type InsertRule,
    type Session,
    type TableConfig,
    type UpdateRule,
} from "./tables.js";
import { andWhere, translateBoolExp } from "./where.js";
import { translateOrderBy, type AggregateMaxOrder } from "./order.js";
import { buildSelection, type WalkContext } from "./select.js";
import { publishProjectChange } from "./pubsub.js";
import { runAction } from "./actions.js";

export interface Context {
    session: Session;
    headers: Record<string, string | string[] | undefined>;
}

type Row = Record<string, unknown>;

interface ListArgs {
    where?: Row;
    order_by?: Row | Row[];
    limit?: number;
    offset?: number;
}

const dbCheck: DbCheck = {
    async projectOwner(projectId: string): Promise<string | null> {
        const row = await delegate("project").findFirst({
            where: { project_id: projectId },
            select: { owner_user_id: true },
        });
        return row ? ((row.owner_user_id as string | null) ?? null) : null;
    },
};

function walkContext(ctx: Context, info: GraphQLResolveInfo): WalkContext {
    return {
        session: ctx.session,
        variables: (info.variableValues ?? {}) as Record<string, unknown>,
        fragments: info.fragments ?? {},
    };
}

function selectionOf(info: GraphQLResolveInfo): SelectionSetNode {
    const selectionSet = info.fieldNodes[0]?.selectionSet;
    if (!selectionSet) throw new GraphQLError("selection set required");
    return selectionSet;
}

// Prisma rejects an empty select; fall back to the primary key.
function ensureSelect(config: TableConfig, select: Row): Row {
    if (Object.keys(select).length === 0) {
        const fallback: Row = {};
        for (const column of config.pk) fallback[column] = true;
        return fallback;
    }
    return select;
}

function emptyToUndefined(where: Row): Row | undefined {
    return Object.keys(where).length > 0 ? where : undefined;
}

// ------------------------------------------------------------------ queries

async function listWithAggregateMaxOrder(
    table: string,
    config: TableConfig,
    d: Delegate,
    where: Row,
    select: Row,
    shape: (row: Row) => Row,
    args: ListArgs,
    order: AggregateMaxOrder,
    session: Session,
): Promise<Row[]> {
    const pk = config.pk[0];
    if (!pk || config.pk.length !== 1) {
        throw new GraphQLError(`aggregate max ordering unsupported on ${table}`);
    }
    const relation = config.relations[order.relation];
    if (!relation?.fk) {
        throw new GraphQLError(`unknown aggregate relation: ${order.relation}`);
    }
    const targetConfig = tableConfig(relation.table);
    const targetRule = selectRule(relation.table, session);

    const parents = await d.findMany({
        where: emptyToUndefined(where),
        select: { [pk]: true },
    });
    const ids = parents.map((row) => String(row[pk]));
    if (ids.length === 0) return [];

    const grouped = await delegate(targetConfig.prismaModel).groupBy({
        by: [relation.fk],
        where: andWhere({ [relation.fk]: { in: ids } }, targetRule.filter(session)),
        _max: { [order.column]: true },
    });
    const maxValues = new Map<string, unknown>();
    for (const group of grouped) {
        maxValues.set(
            String(group[relation.fk]),
            (group._max as Row | undefined)?.[order.column] ?? null,
        );
    }

    const rank = (id: string): number | null => {
        const value = maxValues.get(id);
        if (value === null || value === undefined) return null;
        return value instanceof Date ? value.getTime() : Number(value);
    };
    const sorted = [...ids].sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra === null && rb === null) return 0;
        if (ra === null) return order.nullsLast ? 1 : -1;
        if (rb === null) return order.nullsLast ? -1 : 1;
        return order.descending ? rb - ra : ra - rb;
    });

    const offset = args.offset ?? 0;
    const page = sorted.slice(
        offset,
        args.limit !== undefined && args.limit !== null ? offset + args.limit : undefined,
    );
    if (page.length === 0) return [];

    const fullSelect = { ...ensureSelect(config, select), [pk]: true };
    const rows = await d.findMany({
        where: { [pk]: { in: page } },
        select: fullSelect,
    });
    const byId = new Map(rows.map((row) => [String(row[pk]), row]));
    const ordered: Row[] = [];
    for (const id of page) {
        const row = byId.get(id);
        if (row) ordered.push(shape(row));
    }
    return ordered;
}

export function makeListResolver(table: string) {
    return async (
        _source: unknown,
        args: ListArgs,
        ctx: Context,
        info: GraphQLResolveInfo,
    ): Promise<Row[]> => {
        const config = tableConfig(table);
        const rule = selectRule(table, ctx.session);
        const { select, shape } = buildSelection(table, selectionOf(info), walkContext(ctx, info));
        const where = andWhere(
            rule.filter(ctx.session),
            translateBoolExp(table, args.where, ctx.session),
        );
        const { native, aggregateMax } = translateOrderBy(table, args.order_by);
        const d = delegate(config.prismaModel);

        if (aggregateMax) {
            return listWithAggregateMaxOrder(
                table, config, d, where, select, shape, args, aggregateMax, ctx.session,
            );
        }

        const rows = await d.findMany({
            where: emptyToUndefined(where),
            orderBy: native.length > 0 ? native : undefined,
            take: args.limit ?? undefined,
            skip: args.offset ?? undefined,
            select: ensureSelect(config, select),
        });
        return rows.map(shape);
    };
}

export function makeByPkResolver(table: string) {
    return async (
        _source: unknown,
        args: Row,
        ctx: Context,
        info: GraphQLResolveInfo,
    ): Promise<Row | null> => {
        const config = tableConfig(table);
        const rule = selectRule(table, ctx.session);
        const { select, shape } = buildSelection(table, selectionOf(info), walkContext(ctx, info));
        const pkWhere: Row = {};
        for (const column of config.pk) pkWhere[column] = args[column];
        const row = await delegate(config.prismaModel).findFirst({
            where: andWhere(pkWhere, rule.filter(ctx.session)),
            select: ensureSelect(config, select),
        });
        return row ? shape(row) : null;
    };
}

export function makeAggregateResolver(table: string) {
    return async (
        _source: unknown,
        args: { where?: Row },
        ctx: Context,
    ): Promise<Row> => {
        const config = tableConfig(table);
        const rule = selectRule(table, ctx.session);
        const count = await delegate(config.prismaModel).count({
            where: emptyToUndefined(
                andWhere(rule.filter(ctx.session), translateBoolExp(table, args.where, ctx.session)),
            ),
        });
        return { aggregate: { count } };
    };
}

// ---------------------------------------------------------------- mutations

function insertRuleFor(table: string, config: TableConfig, session: Session): InsertRule {
    if (session.role === "admin") return { columns: config.columns };
    const rule = session.role === "zxplay-user" ? config.insert?.["zxplay-user"] : undefined;
    if (!rule) {
        throw new GraphQLError(
            `field 'insert_${table}_one' not found in type: 'mutation_root'`,
        );
    }
    return rule;
}

function updateRuleFor(table: string, config: TableConfig, session: Session): UpdateRule {
    if (session.role === "admin") {
        return { columns: config.columns, filter: () => ({}) };
    }
    const rule = session.role === "zxplay-user" ? config.update?.["zxplay-user"] : undefined;
    if (!rule) {
        throw new GraphQLError(
            `field 'update_${table}' not found in type: 'mutation_root'`,
        );
    }
    return rule;
}

function deleteFilterFor(table: string, config: TableConfig, session: Session): Row {
    if (session.role === "admin") return {};
    const rule = session.role === "zxplay-user" ? config.delete?.["zxplay-user"] : undefined;
    if (!rule) {
        throw new GraphQLError(
            `field 'delete_${table}' not found in type: 'mutation_root'`,
        );
    }
    return rule.filter(session);
}

function mapColumnValue(config: TableConfig, column: string, value: unknown): unknown {
    if (value === null && config.jsonColumns.includes(column)) return Prisma.DbNull;
    return value;
}

function mapSetData(
    table: string,
    config: TableConfig,
    allowedColumns: readonly string[],
    set: Row | undefined | null,
): Row {
    if (!set || Object.keys(set).filter((k) => set[k] !== undefined).length === 0) {
        throw new GraphQLError(
            `at least any one of _set is expected in update_${table}`,
        );
    }
    const data: Row = {};
    for (const [column, value] of Object.entries(set)) {
        if (value === undefined) continue;
        if (!allowedColumns.includes(column)) {
            throw new GraphQLError(
                `field '${column}' not found in type: '${table}_set_input'`,
            );
        }
        data[column] = mapColumnValue(config, column, value);
    }
    return data;
}

async function projectOwnerOfFile(fileId: string): Promise<string | null> {
    const row = await delegate("project_file").findFirst({
        where: { file_id: fileId },
        select: { project: { select: { owner_user_id: true } } },
    });
    const project = row?.project as Row | null | undefined;
    return project ? ((project.owner_user_id as string | null) ?? null) : null;
}

async function publishFor(table: string, ownerUserId: string | null): Promise<void> {
    if (table === "project" || table === "project_file") {
        publishProjectChange(ownerUserId);
    }
}

const PROJECT_FILE_NESTED_COLUMNS = ["name", "folder", "content", "is_binary"] as const;

export function makeInsertOneResolver(table: string) {
    return async (
        _source: unknown,
        args: { object: Row },
        ctx: Context,
        info: GraphQLResolveInfo,
    ): Promise<Row> => {
        const config = tableConfig(table);
        const session = ctx.session;
        const rule = insertRuleFor(table, config, session);

        const data: Row = {};
        for (const [key, value] of Object.entries(args.object)) {
            if (value === undefined) continue;
            if (key === "files" && table === "project") {
                if (session.role !== "admin" && !rule.columns.includes("files")) {
                    throw new GraphQLError(
                        `field 'files' not found in type: '${table}_insert_input'`,
                    );
                }
                const fileRows = ((value as Row).data as Row[] | undefined) ?? [];
                data.files = {
                    create: fileRows.map((file) => {
                        const nested: Row = {};
                        for (const [column, columnValue] of Object.entries(file)) {
                            if (columnValue === undefined) continue;
                            if (!PROJECT_FILE_NESTED_COLUMNS.includes(
                                column as (typeof PROJECT_FILE_NESTED_COLUMNS)[number],
                            )) {
                                throw new GraphQLError(
                                    `field '${column}' not found in nested project_file insert`,
                                );
                            }
                            nested[column] = columnValue;
                        }
                        return nested;
                    }),
                };
                continue;
            }
            if (!rule.columns.includes(key)) {
                throw new GraphQLError(
                    `field '${key}' not found in type: '${table}_insert_input'`,
                );
            }
            data[key] = mapColumnValue(config, key, value);
        }

        if (rule.presets) Object.assign(data, rule.presets(session));
        if (rule.check) {
            const error = await rule.check(data, session, dbCheck);
            if (error) throw new GraphQLError(error);
        }

        const { select, shape } = buildSelection(table, selectionOf(info), walkContext(ctx, info));
        const row = await delegate(config.prismaModel).create({
            data,
            select: ensureSelect(config, select),
        });

        if (table === "project") {
            await publishFor(table, (data.owner_user_id as string | undefined) ?? null);
        } else if (table === "project_file") {
            await publishFor(table, await dbCheck.projectOwner(String(data.project_id)));
        }
        return shape(row);
    };
}

export function makeUpdateByPkResolver(table: string) {
    return async (
        _source: unknown,
        args: { pk_columns: Row; _set?: Row | null },
        ctx: Context,
        info: GraphQLResolveInfo,
    ): Promise<Row | null> => {
        const config = tableConfig(table);
        const rule = updateRuleFor(table, config, ctx.session);
        const data = mapSetData(table, config, rule.columns, args._set);

        const pkWhere: Row = {};
        for (const column of config.pk) pkWhere[column] = args.pk_columns[column];

        // Publish needs the owner; resolve it before the row could vanish.
        let ownerUserId: string | null = null;
        if (table === "project") {
            const row = await delegate("project").findFirst({
                where: pkWhere,
                select: { owner_user_id: true },
            });
            ownerUserId = (row?.owner_user_id as string | null) ?? null;
        } else if (table === "project_file") {
            ownerUserId = await projectOwnerOfFile(String(pkWhere.file_id));
        }

        const result = await delegate(config.prismaModel).updateMany({
            where: andWhere(pkWhere, rule.filter(ctx.session)),
            data,
        });
        if (result.count === 0) return null;

        const { select, shape } = buildSelection(table, selectionOf(info), walkContext(ctx, info));
        const row = await delegate(config.prismaModel).findFirst({
            where: pkWhere,
            select: ensureSelect(config, select),
        });
        await publishFor(table, ownerUserId);
        return row ? shape(row) : null;
    };
}

export function makeUpdateManyResolver(table: string) {
    return async (
        _source: unknown,
        args: { where: Row; _set?: Row | null },
        ctx: Context,
    ): Promise<Row> => {
        const config = tableConfig(table);
        const rule = updateRuleFor(table, config, ctx.session);
        const data = mapSetData(table, config, rule.columns, args._set);
        const result = await delegate(config.prismaModel).updateMany({
            where: andWhere(
                translateBoolExp(table, args.where, ctx.session),
                rule.filter(ctx.session),
            ),
            data,
        });
        return { affected_rows: result.count };
    };
}

export function makeDeleteByPkResolver(table: string) {
    return async (
        _source: unknown,
        args: Row,
        ctx: Context,
        info: GraphQLResolveInfo,
    ): Promise<Row | null> => {
        const config = tableConfig(table);
        const filter = deleteFilterFor(table, config, ctx.session);
        const pkWhere: Row = {};
        for (const column of config.pk) pkWhere[column] = args[column];
        const where = andWhere(pkWhere, filter);

        let ownerUserId: string | null = null;
        if (table === "project") {
            const row = await delegate("project").findFirst({
                where: pkWhere,
                select: { owner_user_id: true },
            });
            ownerUserId = (row?.owner_user_id as string | null) ?? null;
        } else if (table === "project_file") {
            ownerUserId = await projectOwnerOfFile(String(pkWhere.file_id));
        }

        // Fetch the returning selection before the row is gone.
        const { select, shape } = buildSelection(table, selectionOf(info), walkContext(ctx, info));
        const row = await delegate(config.prismaModel).findFirst({
            where,
            select: ensureSelect(config, select),
        });
        if (!row) return null;

        const result = await delegate(config.prismaModel).deleteMany({ where });
        if (result.count === 0) return null;

        await publishFor(table, ownerUserId);
        return shape(row);
    };
}

export function makeDeleteManyResolver(table: string) {
    return async (
        _source: unknown,
        args: { where: Row },
        ctx: Context,
    ): Promise<Row> => {
        const config = tableConfig(table);
        const filter = deleteFilterFor(table, config, ctx.session);
        const result = await delegate(config.prismaModel).deleteMany({
            where: andWhere(translateBoolExp(table, args.where, ctx.session), filter),
        });
        return { affected_rows: result.count };
    };
}

// ----------------------------------------------------------------- actions

export function makeActionResolver(name: string) {
    return async (
        _source: unknown,
        args: Row,
        ctx: Context,
    ): Promise<Row> => {
        const input: Row = {};
        for (const [key, value] of Object.entries(args)) {
            if (value !== undefined) input[key] = value;
        }
        const result = await runAction(name, input, ctx.session, ctx.headers);
        return { base64_encoded: result.base64_encoded, sld: result.sld ?? null };
    };
}
