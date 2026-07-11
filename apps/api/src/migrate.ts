// One-shot migration runner, executed by the api-migrate compose service on
// every deploy before the api itself starts.
//
// A database created by the old Hasura migrations predates Prisma's history
// table, so applying the baseline migration would fail on the tables it
// already has. Detect that exact shape — application tables present, no
// _prisma_migrations — and mark the baseline as applied before deploying.
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const BASELINE = "20260711000000_baseline";

function prisma(...args: string[]): void {
    execFileSync("npx", ["prisma", ...args], { stdio: "inherit" });
}

async function main(): Promise<void> {
    const client = new PrismaClient();
    try {
        const [{ has_history, has_tables }] = await client.$queryRaw<
            [{ has_history: boolean; has_tables: boolean }]
        >`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS has_history,
                 to_regclass('public.user') IS NOT NULL AS has_tables`;

        if (!has_history && has_tables) {
            console.log(`Hasura-era database detected: baselining ${BASELINE}`);
            prisma("migrate", "resolve", "--applied", BASELINE);
        }
    } finally {
        await client.$disconnect();
    }

    prisma("migrate", "deploy");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
