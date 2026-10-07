import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";

export { Prisma };

/** Interactive transaction client, passed to every helper that must run inside the caller's transaction. */
export type Tx = Prisma.TransactionClient;
/** Either the root client or a transaction client. */
export type Db = PrismaClient | Tx;

const SCHEMA_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Splits a Postgres URL into the pg connection string, the libpq `options` startup string and the schema.
 * The adapter's `schema` option only qualifies Prisma's own model queries; raw SQL (counters, rate limits,
 * SELECT ... FOR UPDATE) is unqualified, so the session `search_path` must point at the same schema.
 */
export function parseDatabaseUrl(url: string): { connectionString: string; options?: string; schema?: string } {
  const parsed = new URL(url);
  const schema = parsed.searchParams.get("schema") || undefined;
  const extraOptions = parsed.searchParams.get("options") || undefined;
  parsed.searchParams.delete("schema");
  parsed.searchParams.delete("options");
  if (schema !== undefined && !SCHEMA_NAME_RE.test(schema)) {
    throw new Error("DATABASE_URL ?schema= must be a plain identifier ([A-Za-z_][A-Za-z0-9_]*).");
  }
  // Quoted so mixed-case schema names keep their case, exactly like the adapter's own quoting.
  const searchPath = schema ? `-c search_path="${schema}"` : undefined;
  const options = [extraOptions, searchPath].filter(Boolean).join(" ") || undefined;
  return { connectionString: parsed.toString(), options, schema };
}

/** node-postgres pool settings (docs/scaling.md "Connection pooling"). */
export type PoolSettings = {
  /** DATABASE_POOL_MAX: connections per process (pg `max`). */
  max: number;
  /** DATABASE_POOL_TIMEOUT_MS: longest wait for a pooled connection, or to open one (pg `connectionTimeoutMillis`). */
  connectionTimeoutMillis: number;
  /** DATABASE_STATEMENT_TIMEOUT_MS: server-side `statement_timeout` per connection; 0 leaves the server setting. */
  statementTimeoutMs: number;
};

export const DEFAULT_POOL_SETTINGS: Readonly<PoolSettings> = Object.freeze({
  max: 10,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMs: 5_000,
});

const POOL_ENV: ReadonlyArray<{ key: keyof PoolSettings; env: string; min: number; max: number }> = [
  { key: "max", env: "DATABASE_POOL_MAX", min: 1, max: 200 },
  { key: "connectionTimeoutMillis", env: "DATABASE_POOL_TIMEOUT_MS", min: 100, max: 60_000 },
  { key: "statementTimeoutMs", env: "DATABASE_STATEMENT_TIMEOUT_MS", min: 0, max: 600_000 },
];

/**
 * Pool settings from the environment (validated again by lib/env.ts at start-up). Read here directly because scripts
 * and tests build clients without the full app environment. Without these bounds a slow or failing-over database makes
 * requests queue for a pool connection forever (pg-pool waits without limit by default); with them they fail after
 * DATABASE_POOL_TIMEOUT_MS and errorResponse() answers 503 `unavailable` with Retry-After (load shedding).
 */
export function poolSettingsFromEnv(source: Record<string, string | undefined> = process.env): PoolSettings {
  const settings: PoolSettings = { ...DEFAULT_POOL_SETTINGS };
  for (const { key, env, min, max } of POOL_ENV) {
    const raw = source[env]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${env} must be a whole number from ${min} to ${max}.`);
    }
    settings[key] = value;
  }
  return settings;
}

/**
 * Builds a Prisma client on the node-postgres adapter, with a bounded pool wait and a server-side statement timeout
 * (poolSettingsFromEnv()). The `?schema=` search parameter is honoured so tests can run in an isolated schema.
 */
export function createPrismaClient(url = process.env.DATABASE_URL, pool: PoolSettings = poolSettingsFromEnv()): PrismaClient {
  if (!url) throw new Error("DATABASE_URL is not set. Run `pnpm secrets` or add it to .env.local.");
  const { connectionString, options, schema } = parseDatabaseUrl(url);
  const adapter = new PrismaPg(
    {
      connectionString,
      ...(options ? { options } : {}),
      max: pool.max,
      connectionTimeoutMillis: pool.connectionTimeoutMillis,
      // Sent as a startup parameter; 0 = off (e.g. behind PgBouncer, which refuses unknown startup parameters: set
      // the timeout on the database role there instead).
      ...(pool.statementTimeoutMs > 0 ? { statement_timeout: pool.statementTimeoutMs } : {}),
    },
    schema ? { schema } : undefined,
  );
  return new PrismaClient({ adapter, log: process.env.PRISMA_LOG_QUERIES === "1" ? ["query", "warn", "error"] : ["warn", "error"] });
}

const globalForPrisma = globalThis as unknown as { __axsPrisma?: PrismaClient };

function getClient(): PrismaClient {
  if (!globalForPrisma.__axsPrisma) globalForPrisma.__axsPrisma = createPrismaClient();
  return globalForPrisma.__axsPrisma;
}

/** Lazily-created singleton (survives dev hot reloads). */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, receiver) as unknown;
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(client) : value;
  },
});

/** Replace the singleton (tests). */
export function setDbClient(client: PrismaClient): void {
  globalForPrisma.__axsPrisma = client;
}
