import { loadEnvConfig } from "@next/env";

/**
 * Loads .env / .env.local for DB tests. Next skips .env.local when NODE_ENV=test, but the DB tests need the
 * developer's local secrets plus TEST_DATABASE_URL (each run still gets its own isolated schema).
 */
export function loadTestEnv(): void {
  const env = process.env as Record<string, string | undefined>;
  const mode = env.NODE_ENV;
  env.NODE_ENV = "development";
  try {
    loadEnvConfig(process.cwd(), true, { info: () => {}, error: (...args: unknown[]) => console.error(...args) }, true);
  } finally {
    env.NODE_ENV = mode;
  }
}
