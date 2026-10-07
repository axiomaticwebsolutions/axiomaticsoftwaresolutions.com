/**
 * Direct PostgreSQL access for the E2E suite: fixture look-ups, checks the UI cannot show (e.g. who owns an order) and
 * the clean-up of records the tests created. Never used to change data the tests did not create, except the shared
 * "unknown"-IP rate-limit buckets (global setup, local servers only) and restoring values a test changed.
 */
import pg from "pg";
import { databaseUrl } from "./env";

export type Row = Record<string, unknown>;

export class Db {
  private readonly pool: pg.Pool;

  constructor(connectionString = databaseUrl()) {
    this.pool = new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });
  }

  async all<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }

  async one<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null;
  }

  async exec(sql: string, params: unknown[] = []): Promise<number> {
    return (await this.pool.query(sql, params)).rowCount ?? 0;
  }

  /** Runs `fn` in one transaction on one connection; rolls back when it throws. */
  async transaction<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn((sql, params = []) => client.query(sql, params));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Polls `fn` until it returns a truthy value or the time is up (then returns the last value). For states the server
 * reaches asynchronously, e.g. the mock provider's webhooks.
 */
export async function poll<T>(fn: () => Promise<T>, { timeoutMs = 30_000, intervalMs = 500 } = {}): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > end) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
