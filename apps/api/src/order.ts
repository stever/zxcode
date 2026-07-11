// Hasura order_by → Prisma orderBy translation.
//
// Prisma can express column ordering (with nulls placement) and relation
// _count ordering natively. Ordering by a relation aggregate MAX (the public
// profiles "recently active" sort) has no Prisma equivalent, so it is
// reported back to the resolver, which runs a groupBy-and-sort fallback.

import { tableConfig } from "./tables.js";

type OrderByEntry = Record<string, unknown>;
export type PrismaOrderBy = Record<string, unknown>;

export interface AggregateMaxOrder {
    relation: string; // GraphQL relation name on the parent table
    column: string;
    descending: boolean;
    nullsLast: boolean;
}

export interface TranslatedOrderBy {
    native: PrismaOrderBy[];
    aggregateMax: AggregateMaxOrder | null;
}

interface Direction {
    sort: "asc" | "desc";
    nulls?: "first" | "last";
}

const DIRECTIONS: Record<string, Direction> = {
    asc: { sort: "asc" },
    asc_nulls_first: { sort: "asc", nulls: "first" },
    asc_nulls_last: { sort: "asc", nulls: "last" },
    desc: { sort: "desc" },
    desc_nulls_first: { sort: "desc", nulls: "first" },
    desc_nulls_last: { sort: "desc", nulls: "last" },
};

function direction(value: unknown): Direction {
    const dir = DIRECTIONS[String(value)];
    if (!dir) throw new Error(`unsupported order_by direction: ${String(value)}`);
    return dir;
}

export function translateOrderBy(
    table: string,
    orderBy: OrderByEntry | OrderByEntry[] | null | undefined,
): TranslatedOrderBy {
    if (!orderBy) return { native: [], aggregateMax: null };
    const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
    const config = tableConfig(table);
    const native: PrismaOrderBy[] = [];
    let aggregateMax: AggregateMaxOrder | null = null;

    for (const entry of entries) {
        for (const [key, value] of Object.entries(entry)) {
            if (value === undefined || value === null) continue;

            const aggregateOf = key.endsWith("_aggregate")
                ? key.slice(0, -"_aggregate".length)
                : null;
            if (aggregateOf && config.relations[aggregateOf]) {
                const relation = config.relations[aggregateOf]!;
                const agg = value as Record<string, unknown>;
                if (agg.count !== undefined && agg.count !== null) {
                    native.push({
                        [relation.prismaField]: { _count: direction(agg.count).sort },
                    });
                }
                if (agg.max !== undefined && agg.max !== null) {
                    const maxEntries = Object.entries(agg.max as Record<string, unknown>)
                        .filter(([, dir]) => dir !== undefined && dir !== null);
                    for (const [column, dir] of maxEntries) {
                        if (aggregateMax) {
                            throw new Error("only one aggregate max ordering is supported");
                        }
                        const d = direction(dir);
                        aggregateMax = {
                            relation: aggregateOf,
                            column,
                            descending: d.sort === "desc",
                            nullsLast: d.nulls !== "first",
                        };
                    }
                }
                continue;
            }

            if (config.columns.includes(key)) {
                const d = direction(value);
                // Prisma rejects the nulls option on non-nullable columns.
                native.push({
                    [key]:
                        d.nulls && config.nullableColumns.includes(key)
                            ? { sort: d.sort, nulls: d.nulls }
                            : d.sort,
                });
                continue;
            }

            throw new Error(`field '${key}' not found in type: '${table}_order_by'`);
        }
    }

    return { native, aggregateMax };
}
