import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const emptyModule = fileURLToPath(new URL("./tests/support/empty.ts", import.meta.url));

// .mts so Node loads it as ESM without the "typeless package.json" warning (package.json has no "type").
export default defineConfig({
  resolve: {
    // Vite resolves the "@/..." alias from tsconfig.json natively (replaces vite-tsconfig-paths).
    tsconfigPaths: true,
    // `server-only` throws outside the React Server bundle; tests run modules directly.
    alias: { "server-only": emptyModule },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          // The integration resolver reads no database in unit tests (tests/unit/setup.ts).
          setupFiles: ["tests/unit/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          globalSetup: ["tests/db/global-setup.ts"],
          setupFiles: ["tests/db/setup.ts"],
          // One isolated Postgres schema per run; files share it, so run them one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
