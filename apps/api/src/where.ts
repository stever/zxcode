// Hasura boolean-expression → Prisma where translation. Covers the operator
// subset the client documents use (_and/_or/_not, _eq/_neq/_in/_is_null,
// ordered comparisons, and relation traversal).
//
// Security: a `where` is attacker-controlled, so it is held to the same
// permissions as a selection. A caller may only filter on columns its role
// can read, and filtering through a relationship is constrained by the
// related table's own row filter — otherwise a visible parent row becomes a
// boolean oracle over hidden child rows (and filtering on an unreadable
// column leaks it by equality testing).

import { selectRule, tableConfig, type PrismaWhere, type Session } from "./tables.js";

type BoolExp = Record<string, unknown>;

const COMPARISON_OPS: Record<string, string> = {
    _eq: "equals",
    _neq: "not",
    _in: "in",
    _gt: "gt",
    _gte: "gte",
    _lt: "lt",
    _lte: "lte",
};

function translateComparison(exp: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [op, value] of Object.entries(exp)) {
        if (value === undefined) continue;
        if (op === "_is_null") {
            if (value === true) out.equals = null;
            else out.not = null;
            continue;
        }
        const prismaOp = COMPARISON_OPS[op];
        if (!prismaOp) throw new Error(`unsupported comparison operator: ${op}`);
        out[prismaOp] = value;
    }
    return out;
}

export function translateBoolExp(
    table: string,
    exp: BoolExp | null | undefined,
    session: Session,
): PrismaWhere {
    if (!exp) return {};
    const config = tableConfig(table);
    // The role's readable columns; also throws if the role cannot read this
    // table at all, so an unreadable table cannot be filtered.
    const rule = selectRule(table, session);
    const where: PrismaWhere = {};
    const and: PrismaWhere[] = [];

    for (const [key, value] of Object.entries(exp)) {
        if (value === undefined || value === null) continue;
        if (key === "_and") {
            for (const sub of value as BoolExp[]) and.push(translateBoolExp(table, sub, session));
            continue;
        }
        if (key === "_or") {
            and.push({
                OR: (value as BoolExp[]).map((sub) => translateBoolExp(table, sub, session)),
            });
            continue;
        }
        if (key === "_not") {
            and.push({ NOT: translateBoolExp(table, value as BoolExp, session) });
            continue;
        }
        const relation = config.relations[key];
        if (relation) {
            // Constrain the traversal by the related table's row filter, so a
            // relation filter can only reach rows the role may read.
            const targetRule = selectRule(relation.table, session);
            const nested = andWhere(
                targetRule.filter(session),
                translateBoolExp(relation.table, value as BoolExp, session),
            );
            where[relation.prismaField] =
                relation.kind === "many" ? { some: nested } : { is: nested };
            continue;
        }
        if (config.columns.includes(key)) {
            // Filtering is limited to columns the role can read on every row it
            // matches; own-row-only columns (PII) are excluded so they cannot
            // become an equality oracle over other users' rows.
            if (!rule.columns.includes(key) || rule.ownOnlyColumns?.includes(key)) {
                throw new Error(`field '${key}' not found in type: '${table}_bool_exp'`);
            }
            where[key] = translateComparison(value as Record<string, unknown>);
            continue;
        }
        throw new Error(`field '${key}' not found in type: '${table}_bool_exp'`);
    }

    if (and.length > 0) where.AND = and;
    return where;
}

export function andWhere(...parts: PrismaWhere[]): PrismaWhere {
    const nonEmpty = parts.filter((p) => Object.keys(p).length > 0);
    if (nonEmpty.length === 0) return {};
    if (nonEmpty.length === 1) return nonEmpty[0] as PrismaWhere;
    return { AND: nonEmpty };
}
