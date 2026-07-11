import { defineConfig } from "vitest/config";

// Unit tests run with the dev-mode config defaults. Integration tests need
// the dev api reachable on localhost:4000; opt in with RUN_INTEGRATION=1.
export default defineConfig({
    test: {
        env: { AUTH_DEV_MODE: "true" },
        exclude: [
            "**/node_modules/**",
            ...(process.env.RUN_INTEGRATION ? [] : ["test/integration/**"]),
        ],
        testTimeout: 30_000,
        hookTimeout: 60_000,
    },
});
