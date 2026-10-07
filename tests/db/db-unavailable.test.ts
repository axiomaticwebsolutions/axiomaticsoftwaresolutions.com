/**
 * Load shedding on a saturated database (decisions.md Phase 4 fix pass "Database pool"): the node-postgres pool waits at
 * most DATABASE_POOL_TIMEOUT_MS for a connection and the server cancels statements after
 * DATABASE_STATEMENT_TIMEOUT_MS; both errors, in the exact shapes Prisma 7 + adapter-pg produce, become 503
 * `unavailable` with Retry-After instead of requests that queue without limit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createPrismaClient, db } from "@/lib/db";
import { databaseUnavailableReason } from "@/lib/db-errors";
import { errorResponse } from "@/lib/http";
import { setLogSink } from "@/lib/log";

const url = process.env.DATABASE_URL;

afterEach(() => setLogSink(null));

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

describe("database pool bounds", () => {
  it("fails a request fast when every pooled connection is busy, and answers 503 unavailable", async () => {
    setLogSink(() => undefined);
    const client = createPrismaClient(url, { max: 1, connectionTimeoutMillis: 500, statementTimeoutMs: 0 });
    try {
      await client.$queryRaw`SELECT 1`;
      // Prisma queries are lazy: .then() starts this one now, holding the only pooled connection for 2 s.
      const busy = client.$queryRaw`SELECT 1 AS slept FROM pg_sleep(2)`.then((rows) => rows);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const started = Date.now();
      const error = await rejectionOf(client.license.count());
      const waited = Date.now() - started;
      await busy;

      expect(databaseUnavailableReason(error)).toBe("pool_timeout");
      expect(waited).toBeLessThan(1_800); // the busy statement still had about 1.8 s to run
      const res = errorResponse(error, { method: "POST", path: "/api/v1/licenses/validate" });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unavailable");
    } finally {
      await client.$disconnect();
    }
  });

  it("lets the server cancel a statement over the statement timeout (503), and the connection stays usable", async () => {
    setLogSink(() => undefined);
    const client = createPrismaClient(url, { max: 1, connectionTimeoutMillis: 5_000, statementTimeoutMs: 300 });
    try {
      const error = await rejectionOf(client.$queryRaw`SELECT 1 AS slept FROM pg_sleep(2)`);
      expect(databaseUnavailableReason(error)).toBe("statement_timeout");
      expect(errorResponse(error).status).toBe(503);
      expect(await client.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`).toEqual([{ ok: 1 }]);
    } finally {
      await client.$disconnect();
    }
  });

  it("applies the default statement timeout to the app client", async () => {
    expect(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? "").toBe("");
    expect(await db.$queryRaw<Array<{ statement_timeout: string }>>`SHOW statement_timeout`).toEqual([{ statement_timeout: "5s" }]);
  });
});
