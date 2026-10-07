/**
 * GET|POST /api/cron/maintenance (app/api/cron/maintenance/route.ts): cron auth like the other cron routes, the flat
 * count body, and a 500 that names the failed task. These runs use the real clock over the shared test schema (the
 * job is idempotent and only removes rows past retention); storage is replaced by an in-memory driver.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as route from "@/app/api/cron/maintenance/route";
import { db } from "@/lib/db";
import { MAINTENANCE_COUNT_KEYS, MAINTENANCE_TASKS } from "@/lib/jobs/maintenance";
import { setLogSink } from "@/lib/log";
import { setStorage, type StorageDriver } from "@/lib/storage";

const tag = randomBytes(4).toString("hex");
let userId: string;
let accountId: string;
let previousSink: ReturnType<typeof setLogSink>;

function memoryStorage(fail: boolean): StorageDriver {
  return {
    kind: "local",
    delete: async () => {
      if (fail) throw Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
    },
    presignGet: async () => ({ url: "", expiresAt: new Date() }),
    presignPut: async () => ({ url: "", method: "PUT", headers: {}, expiresAt: new Date() }),
    head: async () => null,
    putObject: async () => undefined,
  };
}

beforeAll(async () => {
  previousSink = setLogSink(() => {});
  userId = (await db.user.create({ data: { email: `jobs.route.${tag}@example.test`, name: "Jobs Route", kind: "CUSTOMER" } })).id;
  accountId = (await db.businessAccount.create({ data: { legalName: `Jobs Route ${tag}` } })).id;
});

afterAll(async () => {
  setStorage(null);
  setLogSink(previousSink);
  await db.upload.deleteMany({ where: { accountId } });
  await db.businessAccount.deleteMany({ where: { id: accountId } });
  await db.user.deleteMany({ where: { id: userId } });
});

const call = (method: "GET" | "POST", authorization?: string) => {
  const req = new NextRequest("http://localhost:3000/api/cron/maintenance", { method, headers: authorization ? { authorization } : {} });
  return (method === "GET" ? route.GET : route.POST)(req, undefined);
};
const bearer = () => `Bearer ${process.env.CRON_SECRET}`;

describe("GET|POST /api/cron/maintenance", () => {
  it("is configured like the other cron routes", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(300);
  });

  it("answers 401 without the cron secret", async () => {
    for (const method of ["GET", "POST"] as const) {
      for (const auth of [undefined, "Bearer wrong-secret", `Basic ${process.env.CRON_SECRET}`]) {
        const res = await call(method, auth);
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe('Bearer realm="cron"');
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
      }
    }
  });

  it("answers 500 naming the failed task when a stale upload's file cannot be deleted", async () => {
    const upload = await db.upload.create({
      data: {
        accountId,
        uploadedById: userId,
        storageKey: `uploads/${accountId}/${randomUUID()}/stale.txt`,
        fileName: "stale.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        createdAt: new Date(Date.now() - 25 * 3_600_000),
      },
    });
    setStorage(memoryStorage(true));
    const res = await call("GET", bearer());
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.failed).toEqual(["uploads"]);
    expect(body.uploadsFailed).toEqual(expect.any(Number));
    expect(await db.upload.findUnique({ where: { id: upload.id } })).not.toBeNull();
  });

  it("answers 200 with one flat count per task (GET and POST), no-store", async () => {
    setStorage(memoryStorage(false));
    for (const method of ["GET", "POST"] as const) {
      const res = await call(method, bearer());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.failed).toBeUndefined();
      for (const task of MAINTENANCE_TASKS) expect(body[MAINTENANCE_COUNT_KEYS[task]]).toEqual(expect.any(Number));
    }
    // The stale upload of the previous test is gone now that storage works.
    expect(await db.upload.count({ where: { accountId } })).toBe(0);
    // Idempotent: right after a complete run, nothing of this file is left to do.
    const again = (await (await call("POST", bearer())).json()) as Record<string, unknown>;
    expect(again).toMatchObject({ uploadsDeleted: 0 });
  });
});
