import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Run native SQLite tests in one worker. Parallel worker teardown can trip
    // better-sqlite3 cleanup assertions on newer Node releases.
    pool: "threads",
    maxWorkers: 1,
    minWorkers: 1,
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.spec.ts",
      "apps/**/*.test.ts",
      "e2e/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/index.ts"]
    }
  }
});
