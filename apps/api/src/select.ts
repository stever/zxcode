// Builds a single Prisma `select` tree from a GraphQL selection set, applying
// per-role column allowlists and row filters at every level, and returns a
// shaper that maps the Prisma result back into the GraphQL shape (relation
// aliasing, nested aggregates, to-one permission predicates).

import {
    GraphQLError,
    Kind,
    valueFromASTUntyped,
    type DirectiveNode,
    type FieldNode,
    type FragmentDefinitionNode,
    type SelectionSetNode,
} from "graphql";
import { selectRule, tableConfig, type Session } from "./tables.js";
import { andWhere, translateBoolExp } from "./where.js";
import { translateOrderBy } from "./order.js";

export interface WalkContext {
    session: Session;
    variables: Record<string, unknown>;
    fragments: Record<string, FragmentDefinitionNode>;
}

type Row = Record<string, unknown>;

export interface Shaped {
    select: Record<string, unknown>;
    shape: (row: Row) => Row;
}

interface Shaper {
    out: string;
    apply: (row: Row) => unknown;
}

function directivesInclude(
    directives: readonly DirectiveNode[] | undefined,
    variables: Record<string, unknown>,
): boolean {
    for (const directive of directives ?? []) {
        const name = directive.name.value;
        if (name !== "include" && name !== "skip") continue;
        const ifArg = directive.arguments?.find((a) => a.name.value === "if");
        const value = ifArg
            ? valueFromASTUntyped(ifArg.value, variables)
            : undefined;
        if (name === "include" && value !== true) return false;
        if (name === "skip" && value === true) return false;
    }
    return true;
}

function fieldArgs(field: FieldNode, variables: Record<string, unknown>): Row {
    const args: Row = {};
    for (const arg of field.arguments ?? []) {
        args[arg.name.value] = valueFromASTUntyped(arg.value, variables);
    }
    return args;
}

// Collect the field nodes of a selection set, flattening fragment spreads.
function collectFields(
    selectionSet: SelectionSetNode,
    ctx: WalkContext,
): FieldNode[] {
    const fields: FieldNode[] = [];
    for (const selection of selectionSet.selections) {
        if (!directivesInclude(selection.directives, ctx.variables)) continue;
        switch (selection.kind) {
            case Kind.FIELD:
                fields.push(selection);
                break;
            case Kind.INLINE_FRAGMENT:
                fields.push(...collectFields(selection.selectionSet, ctx));
                break;
            case Kind.FRAGMENT_SPREAD: {
                const fragment = ctx.fragments[selection.name.value];
                if (!fragment) {
                    throw new GraphQLError(`unknown fragment: ${selection.name.value}`);
                }
                fields.push(...collectFields(fragment.selectionSet, ctx));
                break;
            }
        }
    }
    return fields;
}

function mergeSelect(existing: unknown, incoming: Row): Row {
    if (!existing || typeof existing !== "object") return incoming;
    const merged: Row = { ...(existing as Row) };
    for (const [key, value] of Object.entries(incoming)) {
        if (key === "select") {
            merged.select = {
                ...((merged.select as Row) ?? {}),
                ...((value as Row) ?? {}),
            };
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

export function buildSelection(
    table: string,
    selectionSet: SelectionSetNode,
    ctx: WalkContext,
): Shaped {
    const config = tableConfig(table);
    const rule = selectRule(table, ctx.session);
    const select: Row = {};
    const shapers: Shaper[] = [];

    const addColumn = (column: string): void => {
        select[column] = true;
    };

    for (const field of collectFields(selectionSet, ctx)) {
        const name = field.name.value;
        if (name === "__typename") continue; // handled by the executor

        // Plain column.
        if (config.columns.includes(name)) {
            if (!rule.columns.includes(name)) {
                throw new GraphQLError(`field '${name}' not found in type: '${table}'`);
            }
            addColumn(name);
            // Own-row-only columns (PII) read as null on any row that is not
            // the caller's own; the columns needed to decide that ride along.
            if (rule.ownOnlyColumns?.includes(name)) {
                for (const column of rule.ownRowColumns ?? []) addColumn(column);
                const isOwnRow = rule.ownRow ?? (() => false);
                shapers.push({
                    out: name,
                    apply: (row) => (isOwnRow(row, ctx.session) ? row[name] : null),
                });
            } else {
                shapers.push({ out: name, apply: (row) => row[name] });
            }
            continue;
        }

        // Nested aggregate: <relation>_aggregate { aggregate { count } }.
        const aggregateOf = name.endsWith("_aggregate")
            ? name.slice(0, -"_aggregate".length)
            : null;
        if (aggregateOf && config.relations[aggregateOf]) {
            const relation = config.relations[aggregateOf]!;
            if (relation.kind !== "many") {
                throw new GraphQLError(`field '${name}' not found in type: '${table}'`);
            }
            const targetRule = selectRule(relation.table, ctx.session);
            const args = fieldArgs(field, ctx.variables);
            const where = andWhere(
                targetRule.filter(ctx.session),
                translateBoolExp(relation.table, args.where as Row | undefined, ctx.session),
            );
            const countSelect = ((select._count as Row | undefined)?.select ?? {}) as Row;
            countSelect[relation.prismaField] =
                Object.keys(where).length > 0 ? { where } : true;
            select._count = { select: countSelect };
            shapers.push({
                out: name,
                apply: (row) => ({
                    aggregate: {
                        count: (row._count as Row | undefined)?.[relation.prismaField] ?? 0,
                    },
                }),
            });
            continue;
        }

        // Relation.
        const relation = config.relations[name];
        if (relation) {
            if (!field.selectionSet) {
                throw new GraphQLError(`field '${name}' requires a selection set`);
            }
            const targetRule = selectRule(relation.table, ctx.session);
            const nested = buildSelection(relation.table, field.selectionSet, ctx);

            if (relation.kind === "one") {
                // Prisma cannot filter to-one includes; fetch the predicate
                // columns and null the object out in the shaper when the row
                // is not visible to this role.
                for (const column of targetRule.predicateColumns) {
                    (nested.select as Row)[column] = true;
                }
                select[relation.prismaField] = mergeSelect(select[relation.prismaField], {
                    select: nested.select,
                });
                shapers.push({
                    out: name,
                    apply: (row) => {
                        const value = row[relation.prismaField] as Row | null | undefined;
                        if (value === null || value === undefined) return null;
                        if (!targetRule.predicate(value, ctx.session)) return null;
                        return nested.shape(value);
                    },
                });
            } else {
                const args = fieldArgs(field, ctx.variables);
                const where = andWhere(
                    targetRule.filter(ctx.session),
                    translateBoolExp(relation.table, args.where as Row | undefined, ctx.session),
                );
                const { native, aggregateMax } = translateOrderBy(
                    relation.table,
                    args.order_by as Row | Row[] | undefined,
                );
                if (aggregateMax) {
                    throw new GraphQLError(
                        "aggregate max ordering is not supported on nested relations",
                    );
                }
                const nestedQuery: Row = { select: nested.select };
                if (Object.keys(where).length > 0) nestedQuery.where = where;
                if (native.length > 0) nestedQuery.orderBy = native;
                if (typeof args.limit === "number") nestedQuery.take = args.limit;
                if (typeof args.offset === "number") nestedQuery.skip = args.offset;
                select[relation.prismaField] = mergeSelect(
                    select[relation.prismaField],
                    nestedQuery,
                );
                shapers.push({
                    out: name,
                    apply: (row) => {
                        const value = (row[relation.prismaField] as Row[] | undefined) ?? [];
                        return value.map((item) => nested.shape(item));
                    },
                });
            }
            continue;
        }

        throw new GraphQLError(`field '${name}' not found in type: '${table}'`);
    }

    return {
        select,
        shape: (row: Row): Row => {
            const out: Row = {};
            for (const shaper of shapers) out[shaper.out] = shaper.apply(row);
            return out;
        },
    };
}
