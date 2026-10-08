/**
 * The maintenance runner (lib/jobs/maintenance.ts) against a fake database: task order, flat counts that the cron
 * script reads as idle, failure isolation, partial progress, the per-task time share, the upload task's storage
 * failures, and the lazily created storage driver. The SQL itself runs against Postgres in tests/db/jobs-*.test.ts.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { Prisma } from "@/lib/db";
import { emptyMaintenanceCounts, MAINTENANCE_COUNT_KEYS, MAINTENANCE_TASKS, runMaintenance } from "@/lib/jobs/maintenance";
import { setIntegrationEnvForTests } from "@/lib/integrations/resolver";
import { setLogSink } from "@/lib/log";
import type { StorageDriver } from "@/lib/storage";

const TABLES = ["SupportTicket", "Upload", "OutboxEmail", "RateLimitBucket", "Session", "AuthToken", "AccountActivity", "WebhookDelivery"] as const;
type Table = (typeof TABLES)[number];

type FakeOptions = {
  /** Rows waiting per table (uploads: use `uploads`). */
  rows?: Partial<Record<Table, number>>;
  uploads?: string[];
  /** Throw on the n-th statement against this table (1-based; default the first). */
  failOn?: { table: Table; at?: number };
  /** Advance this clock by `cost` per statement against `costly` tables (default all). */
  clock?: { t: number; cost: number; costly?: Table[] };
};

function toSql(args: unknown[]): Prisma.Sql {
  const [first, ...rest] = args;
  if (first instanceof Prisma.Sql) return first;
  return Prisma.sql(first as readonly string[], ...(rest as Prisma.Sql[]));
}

function fakeDb(opts: FakeOptions = {}) {
  const left: Partial<Record<Table, number>> = { ...opts.rows };
  let uploads = [...(opts.uploads ?? [])];
  const statements: Table[] = [];
  const hits = new Map<Table, number>();
  const before = (sql: Prisma.Sql): { table: Table; limit: number } => {
    const table = TABLES.find((t) => sql.text.includes(`"${t}"`));
    if (!table) throw new Error(`unexpected SQL: ${sql.text}`);
    statements.push(table);
    hits.set(table, (hits.get(table) ?? 0) + 1);
    if (opts.failOn?.table === table && hits.get(table) === (opts.failOn.at ?? 1)) throw new Error("connection reset");
    if (opts.clock && (!opts.clock.costly || opts.clock.costly.includes(table))) opts.clock.t += opts.clock.cost;
    // The batch size is the value bound right after `LIMIT` (other numbers, such as the ticket close's 14 days, come
    // before or after it depending on the statement's shape).
    const at = sql.strings.findIndex((s, i) => i < sql.values.length && /LIMIT\s*$/.test(s));
    const limit = at >= 0 ? sql.values[at] : undefined;
    return { table, limit: typeof limit === "number" ? limit : 0 };
  };
  const client = {
    $executeRaw: async (...args: unknown[]) => {
      const sql = toSql(args);
      const { table, limit } = before(sql);
      if (table === "Upload") {
        const done = sql.values.find((v): v is string[] => Array.isArray(v)) ?? [];
        uploads = uploads.filter((id) => !done.includes(id));
        return done.length;
      }
      const n = Math.min(limit, left[table] ?? 0);
      left[table] = (left[table] ?? 0) - n;
      return n;
    },
    $queryRaw: async (...args: unknown[]) => {
      const sql = toSql(args);
      const { limit } = before(sql);
      const skip = sql.values.find((v): v is string[] => Array.isArray(v)) ?? [];
      return uploads
        .filter((id) => !skip.includes(id))
        .slice(0, limit)
        .map((id) => ({ id, storageKey: `uploads/acc/${id}/f.png` }));
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { client: client as unknown as PrismaClient, statements, left, uploadsLeft: () => uploads };
}

function memoryStorage(failKeys: (key: string) => boolean = () => false): StorageDriver & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    kind: "local",
    deleted,
    delete: async (key: string) => {
      if (failKeys(key)) throw Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      deleted.push(key);
    },
    presignGet: async () => ({ url: "", expiresAt: new Date() }),
    presignPut: async () => ({ url: "", method: "PUT", headers: {}, expiresAt: new Date() }),
    head: async () => null,
    putObject: async () => undefined,
  };
}

const lines: string[] = [];
const previousSink = setLogSink((_level, line) => lines.push(line));
afterEach(() => {
  lines.length = 0;
});
afterAll(() => {
  setLogSink(previousSink);
});
const ALL_TABLES_IN_ORDER = ["SupportTicket", "Upload", "OutboxEmail", "RateLimitBucket", "Session", "AuthToken", "AccountActivity", "WebhookDelivery"];

describe("runMaintenance (fake database): order, counts and failures", () => {
  it("runs every task once in the documented order and reports flat zero counts (an idle run for cron-job.sh)", async () => {
    const fake = fakeDb();
    const result = await runMaintenance({ client: fake.client, storage: memoryStorage() });
    expect(result).toEqual(emptyMaintenanceCounts());
    expect(Object.keys(result)).toEqual(MAINTENANCE_TASKS.map((t) => MAINTENANCE_COUNT_KEYS[t]));
    expect(fake.statements).toEqual(ALL_TABLES_IN_ORDER);
    // deploy/cron-job.sh treats a 200 body as idle (no log line) unless it matches grep -E ':[1-9]|"more"'.
    expect(JSON.stringify(result)).not.toMatch(/:[1-9]|"more"/);
    expect(lines).toEqual([]);
  });

  it("counts every task's rows across batches and logs one summary line", async () => {
    const fake = fakeDb({ rows: { SupportTicket: 3, OutboxEmail: 5, Session: 7, WebhookDelivery: 2 }, uploads: ["u1", "u2", "u3"] });
    const storage = memoryStorage();
    const result = await runMaintenance({ client: fake.client, storage, batchSize: 2, uploadBatchSize: 2 });
    expect(result).toMatchObject({ ticketsClosed: 3, uploadsDeleted: 3, emailsRedacted: 5, sessionsPurged: 7, webhookDeliveriesPurged: 2 });
    expect(result.verificationsPurged).toBe(0);
    expect(JSON.stringify(result)).toMatch(/:[1-9]|"more"/); // logged by deploy/cron-job.sh
    expect(result.more).toBeUndefined();
    expect(result.failed).toBeUndefined();
    expect(storage.deleted).toHaveLength(3);
    expect(fake.statements.filter((t) => t === "Session")).toHaveLength(4);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ event: "maintenance_run", sessionsPurged: 7 });
  });

  it("logs every count readably (no count key looks like a secret to the logger)", async () => {
    const rows = Object.fromEntries(TABLES.map((t) => [t, 1])) as Record<Table, number>;
    const result = await runMaintenance({ client: fakeDb({ rows, uploads: ["u1"] }).client, storage: memoryStorage() });
    expect(Object.values(result).every((n) => n === 1)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("[redacted]");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ ...result, event: "maintenance_run" });
  });

  it("keeps going after a failing task, reports it and keeps its partial progress", async () => {
    const fake = fakeDb({ rows: { Session: 10, AuthToken: 4 }, failOn: { table: "Session", at: 3 } });
    const result = await runMaintenance({ client: fake.client, storage: memoryStorage(), batchSize: 3 });
    expect(result.failed).toEqual(["sessions"]);
    expect(result.sessionsPurged).toBe(6);
    expect(result.verificationsPurged).toBe(4);
    expect(fake.statements).toContain("WebhookDelivery");
    const failure = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === "maintenance_task_failed");
    expect(failure).toMatchObject({ level: "error", task: "sessions" });
  });

  it("runs a subset in the canonical order", async () => {
    const fake = fakeDb();
    await runMaintenance({ client: fake.client, tasks: ["webhookDeliveries", "tickets", "tickets"] });
    expect(fake.statements).toEqual(["SupportTicket", "WebhookDelivery"]);
  });

  it("creates the storage driver only when there is a file to delete", async () => {
    // No `storage` option: getStorage() would need the storage environment, so it must not be called here.
    const fake = fakeDb({ rows: { Session: 1 } });
    const result = await runMaintenance({ client: fake.client });
    expect(result.failed).toBeUndefined();
    expect(result.sessionsPurged).toBe(1);
  });
});

describe("runMaintenance (fake database): limits", () => {
  it("gives each task its share of the time left, so one backlog cannot starve the others", async () => {
    const clock = { t: 0, cost: 10 };
    const endless = 1_000_000;
    const fake = fakeDb({ rows: { SupportTicket: endless, Session: endless, WebhookDelivery: endless }, clock });
    const result = await runMaintenance({ client: fake.client, storage: memoryStorage(), batchSize: 1, budgetMs: 80, clock: () => clock.t });
    // 8 tasks, 80 ms, every statement 10 ms: each task gets one batch; the endless ones stop with `more`.
    expect(fake.statements).toEqual(ALL_TABLES_IN_ORDER);
    expect(result.more).toEqual(["tickets", "sessions", "webhookDeliveries"]);
    expect(result).toMatchObject({ ticketsClosed: 1, sessionsPurged: 1, webhookDeliveriesPurged: 1 });
  });

  it("hands time a task did not need to the tasks after it", async () => {
    const clock = { t: 0, cost: 10, costly: ["WebhookDelivery"] as Table[] };
    const fake = fakeDb({ rows: { WebhookDelivery: 1_000_000 }, clock });
    const result = await runMaintenance({ client: fake.client, storage: memoryStorage(), batchSize: 1, budgetMs: 80, clock: () => clock.t });
    // The seven tasks before it took no time, so the last one gets all 80 ms: eight 10 ms batches.
    expect(result.webhookDeliveriesPurged).toBe(8);
    expect(result.more).toEqual(["webhookDeliveries"]);
  });

  it("with no budget left, starts nothing and lists every task as unfinished", async () => {
    const fake = fakeDb({ rows: { Session: 3 } });
    const result = await runMaintenance({ client: fake.client, storage: memoryStorage(), budgetMs: 0 });
    expect(fake.statements).toEqual([]);
    expect(result.more).toEqual([...MAINTENANCE_TASKS]);
  });

  it("caps the rows of one task per run", async () => {
    const fake = fakeDb({ rows: { AuthToken: 10 } });
    const result = await runMaintenance({ client: fake.client, storage: memoryStorage(), batchSize: 4, maxRowsPerTask: 6 });
    expect(result.verificationsPurged).toBe(6);
    expect(result.more).toEqual(["authTokens"]);
    expect(fake.left.AuthToken).toBe(4);
  });
});

describe("runMaintenance (fake database): uploads and storage", () => {
  it("keeps uploads whose file cannot be deleted, does not retry them in the same run, and fails the run", async () => {
    const fake = fakeDb({ uploads: ["u1", "bad1", "u2", "u3", "bad2"] });
    const storage = memoryStorage((key) => key.includes("/bad"));
    const result = await runMaintenance({ client: fake.client, storage, uploadBatchSize: 2, tasks: ["uploads"] });
    expect(result).toMatchObject({ uploadsDeleted: 3, uploadsFailed: 2, failed: ["uploads"] });
    expect(result.more).toBeUndefined();
    expect(fake.uploadsLeft()).toEqual(["bad1", "bad2"]);
    const warnings = lines.filter((l) => l.includes("maintenance_upload_delete_failed"));
    expect(warnings).toHaveLength(2);
    expect(JSON.parse(warnings[0] ?? "{}")).toMatchObject({ level: "warn", error: { name: "AccessDenied", httpStatus: 403 } });
    // Storage keys and error messages stay out of the log.
    expect(lines.join("\n")).not.toContain("uploads/acc/");
    expect(lines.join("\n")).not.toContain("Access Denied");
  });

  it("stops the upload task when storage refuses a whole batch", async () => {
    const fake = fakeDb({ uploads: ["a", "b", "c", "d", "e"] });
    const result = await runMaintenance({ client: fake.client, storage: memoryStorage(() => true), uploadBatchSize: 2, tasks: ["uploads"] });
    expect(result).toMatchObject({ uploadsDeleted: 0, uploadsFailed: 2, failed: ["uploads"], more: ["uploads"] });
    // One batch: the existence check outside the transaction, then the locked selection.
    expect(fake.statements).toEqual(["Upload", "Upload"]);
  });

  it("skips the upload task (not failed) when storage is not configured, resolving storage only once uploads are due", async () => {
    setIntegrationEnvForTests({ NODE_ENV: "production" });
    try {
      const fake = fakeDb({ uploads: ["a", "b"] });
      const result = await runMaintenance({ client: fake.client, tasks: ["uploads"] });
      expect(result).toEqual(emptyMaintenanceCounts());
      expect(fake.uploadsLeft()).toEqual(["a", "b"]);
      expect(fake.statements).toEqual(["Upload"]); // the existence check only: no transaction, nothing locked
      expect(lines.map((l) => JSON.parse(l) as { event: string; reason?: string })).toEqual([
        expect.objectContaining({ event: "maintenance_uploads_skipped", reason: "not_configured" }),
      ]);
    } finally {
      setIntegrationEnvForTests(null);
    }
  });

  it("treats a missing object as deleted, but not a missing bucket", async () => {
    const gone = fakeDb({ uploads: ["gone"] });
    const storage = memoryStorage();
    storage.delete = async () => {
      throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    };
    expect(await runMaintenance({ client: gone.client, storage, tasks: ["uploads"] })).toMatchObject({ uploadsDeleted: 1 });
    expect(gone.uploadsLeft()).toEqual([]);

    const noBucket = fakeDb({ uploads: ["kept"] });
    storage.delete = async () => {
      throw Object.assign(new Error("The specified bucket does not exist"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } });
    };
    expect(await runMaintenance({ client: noBucket.client, storage, tasks: ["uploads"] })).toMatchObject({ uploadsDeleted: 0, uploadsFailed: 1 });
    expect(noBucket.uploadsLeft()).toEqual(["kept"]);
  });
});
