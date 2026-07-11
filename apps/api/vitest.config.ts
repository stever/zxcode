import { defineConfig } from "vitest/config";

// Integration tests need a reachable Postgres (they create their own database
// and run the migrations); opt in with RUN_INTEGRATION=1 (npm run
// test:integration).
export default defineConfig({
    test: {
        exclude: [
            "**/node_modules/**",
            ...(process.env.RUN_INTEGRATION ? [] : ["test/integration/**"]),
        ],
        testTimeout: 30_000,
        hookTimeout: 180_000,
    },
});
