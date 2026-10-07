/**
 * Maintenance job against Postgres (lib/jobs/maintenance.ts): closing resolved tickets and deleting abandoned uploads
 * (boundaries, idempotency, storage failures and missing files, concurrent runs, and races with the portal).
 * Every run uses a clock in 2001 and rows dated around it, so the job only ever matches this file's rows even though
 * DB test files share one schema per run.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TicketStatus, UploadStatus } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { runMaintenance } from "@/lib/jobs/maintenance";
import { setLogSink } from "@/lib/log";
import { deriveTicketStatus } from "@/lib/portal/tickets";
import { attachUploads } from "@/lib/portal/uploads";
import type { StorageDriver } from "@/lib/storage";
import { LocalStorageDriver } from "@/lib/storage/local";

const NOW = new Date("2001-06-15T06:30:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const tag = randomBytes(4).toString("hex");

let userId: string;
let accountId: string;
let dir: string;
let storage: LocalStorageDriver;
const ticketIds: string[] = [];
let previousSink: ReturnType<typeof setLogSink>;

beforeAll(async () => {
  previousSink = setLogSink(() => {});
  const user = await db.user.create({ data: { email: `jobs.${tag}@example.test`, name: "Jobs Test", kind: "CUSTOMER" } });
  const account = await db.businessAccount.create({ data: { legalName: `Jobs Test ${tag}` } });
  userId = user.id;
  accountId = account.id;
  dir = await mkdtemp(path.join(tmpdir(), "axs-jobs-"));
  storage = new LocalStorageDriver({ dir, appUrl: getEnv().APP_URL, secret: getEnv().SESSION_SECRET });
});

afterAll(async () => {
  setLogSink(previousSink);
  await db.supportTicket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.upload.deleteMany({ where: { accountId } });
  await db.accountActivity.deleteMany({ where: { accountId } });
  await db.businessAccount.deleteMany({ where: { id: accountId } });
  await db.user.deleteMany({ where: { id: userId } });
  await rm(dir, { recursive: true, force: true });
});

// ---------- Tickets ----------

async function ticket(name: string, data: { status: TicketStatus; resolvedAt?: Date | null; closedAt?: Date | null }) {
  const id = `T-JOBS-${tag}-${name}`;
  ticketIds.push(id);
  return db.supportTicket.create({ data: { id, accountId, subject: `Printer ${name}`, createdAt: ago(60 * DAY), ...data } });
}

describe("tickets", () => {
  it("stores CLOSED for tickets resolved 14+ days ago, with closedAt = resolvedAt + 14 days, and nothing else", async () => {
    const old = await ticket("old", { status: "RESOLVED", resolvedAt: ago(20 * DAY + 5 * HOUR) });
    const edge = await ticket("edge", { status: "RESOLVED", resolvedAt: ago(14 * DAY) });
    const young = await ticket("young", { status: "RESOLVED", resolvedAt: new Date(ago(14 * DAY).getTime() + 1) });
    const undated = await ticket("undated", { status: "RESOLVED", resolvedAt: null });
    const open = await ticket("open", { status: "OPEN" });
    const awaiting = await ticket("awaiting", { status: "AWAITING_CUSTOMER" });
    const closed = await ticket("closed", { status: "CLOSED", resolvedAt: ago(40 * DAY), closedAt: ago(35 * DAY) });
    const outboxBefore = await db.outboxEmail.count();

    const result = await runMaintenance({ now: NOW, tasks: ["tickets"] });
    expect(result).toMatchObject({ ticketsClosed: 2 });
    expect(result.failed).toBeUndefined();

    const after = new Map((await db.supportTicket.findMany({ where: { id: { in: ticketIds } } })).map((t) => [t.id, t]));
    for (const t of [old, edge]) {
      const row = after.get(t.id);
      expect(row?.status).toBe("CLOSED");
      expect(row?.closedAt).toEqual(new Date((t.resolvedAt as Date).getTime() + 14 * DAY));
      expect(row?.resolvedAt).toEqual(t.resolvedAt);
      // Nothing visible changed (it already read as closed), so the ticket keeps its place in "recently updated".
      expect(row?.updatedAt).toEqual(t.updatedAt);
      expect(deriveTicketStatus(row as { status: TicketStatus; resolvedAt: Date | null }, NOW)).toBe("closed");
      expect(deriveTicketStatus(t, NOW)).toBe("closed");
    }
    for (const t of [young, undated, open, awaiting, closed]) expect(after.get(t.id)).toEqual(t);
    // No email and no activity entry.
    expect(await db.outboxEmail.count()).toBe(outboxBefore);
    expect(await db.accountActivity.count({ where: { accountId } })).toBe(0);

    // Idempotent: a second run finds nothing.
    expect((await runMaintenance({ now: NOW, tasks: ["tickets"] })).ticketsClosed).toBe(0);
  });

  it("leaves a ticket alone while the app is changing it (a staff reply reopening it)", async () => {
    const busy = await ticket("busy", { status: "RESOLVED", resolvedAt: ago(30 * DAY) });
    const idle = await ticket("idle", { status: "RESOLVED", resolvedAt: ago(30 * DAY) });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const reply = db.$transaction(
      async (tx) => {
        await tx.supportTicket.update({ where: { id: busy.id }, data: { status: "AWAITING_CUSTOMER", resolvedAt: null } });
        locked();
        await released;
      },
      { timeout: 30_000 },
    );
    await isLocked;
    const result = await runMaintenance({ now: NOW, tasks: ["tickets"] });
    release();
    await reply;
    expect(result.ticketsClosed).toBe(1);
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: busy.id } })).toMatchObject({ status: "AWAITING_CUSTOMER", closedAt: null });
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: idle.id } })).toMatchObject({ status: "CLOSED" });
  });
});

// ---------- Uploads ----------

async function upload(name: string, opts: { createdAt: Date; status?: UploadStatus; file?: boolean }) {
  const storageKey = `uploads/${accountId}/${randomUUID()}/${name}.txt`;
  if (opts.file !== false) await storage.putObject(storageKey, Buffer.from(`file ${name}`), "text/plain");
  const status = opts.status ?? "PENDING";
  return db.upload.create({
    data: {
      accountId,
      uploadedById: userId,
      storageKey,
      fileName: `${name}.txt`,
      contentType: "text/plain",
      sizeBytes: 6,
      status,
      createdAt: opts.createdAt,
      attachedAt: status === "ATTACHED" ? opts.createdAt : null,
    },
  });
}

/** Wraps the local driver: records deletes, can fail chosen keys, and can hold every delete until `open()`. */
function spyStorage(opts: { fail?: (key: string) => boolean; delayMs?: number } = {}) {
  const deleted: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let gated = false;
  let started!: () => void;
  const firstDelete = new Promise<void>((resolve) => (started = resolve));
  const driver: StorageDriver = {
    kind: "local",
    presignGet: (key, o) => storage.presignGet(key, o),
    presignPut: (key, o) => storage.presignPut(key, o),
    head: (key) => storage.head(key),
    putObject: (key, body, type) => storage.putObject(key, body, type),
    delete: async (key) => {
      started();
      if (gated) await gate;
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      if (opts.fail?.(key)) throw Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
      await storage.delete(key);
      deleted.push(key);
    },
  };
  return { driver, deleted, hold: () => (gated = true), open: () => open(), firstDelete };
}

const exists = async (key: string) => (await storage.head(key)) !== null;

describe("uploads", () => {
  it("deletes PENDING uploads older than 24 hours, file first, and tolerates files that are already gone", async () => {
    const stale = await upload("stale", { createdAt: ago(25 * HOUR) });
    const gone = await upload("gone", { createdAt: ago(3 * DAY), file: false });
    const edge = await upload("edge", { createdAt: ago(24 * HOUR) });
    const fresh = await upload("fresh", { createdAt: ago(HOUR) });
    const attached = await upload("attached", { createdAt: ago(30 * DAY), status: "ATTACHED" });
    const spy = spyStorage();

    const result = await runMaintenance({ now: NOW, tasks: ["uploads"], storage: spy.driver });
    expect(result).toMatchObject({ uploadsDeleted: 2 });
    expect(result.failed).toBeUndefined();
    expect(spy.deleted.sort()).toEqual([stale.storageKey, gone.storageKey].sort());
    expect(await exists(stale.storageKey)).toBe(false);
    const left = await db.upload.findMany({ where: { accountId }, select: { id: true } });
    expect(left.map((u) => u.id).sort()).toEqual([edge.id, fresh.id, attached.id].sort());
    for (const kept of [edge, fresh, attached]) expect(await exists(kept.storageKey)).toBe(true);

    expect((await runMaintenance({ now: NOW, tasks: ["uploads"], storage: spy.driver })).uploadsDeleted).toBe(0);
    await db.upload.deleteMany({ where: { id: { in: [edge.id, fresh.id, attached.id] } } });
  });

  it("keeps the row (and fails the run) when the file cannot be deleted; the next run finishes the job", async () => {
    const stuck = await upload("stuck", { createdAt: ago(2 * DAY) });
    const fine = await upload("fine", { createdAt: ago(2 * DAY) });
    const failing = spyStorage({ fail: (key) => key === stuck.storageKey });

    const first = await runMaintenance({ now: NOW, tasks: ["uploads"], storage: failing.driver });
    expect(first).toMatchObject({ uploadsDeleted: 1, uploadsFailed: 1, failed: ["uploads"] });
    expect(await db.upload.findUnique({ where: { id: stuck.id } })).not.toBeNull();
    expect(await db.upload.findUnique({ where: { id: fine.id } })).toBeNull();
    expect(await exists(stuck.storageKey)).toBe(true);

    const second = await runMaintenance({ now: NOW, tasks: ["uploads"], storage: spyStorage().driver });
    expect(second).toMatchObject({ uploadsDeleted: 1 });
    expect(second.failed).toBeUndefined();
    expect(await exists(stuck.storageKey)).toBe(false);
  });

  it("splits the work between concurrent runs: every file is deleted exactly once", async () => {
    const rows = await Promise.all(Array.from({ length: 12 }, (_, i) => upload(`many-${i}`, { createdAt: ago(2 * DAY) })));
    const spy = spyStorage({ delayMs: 15 });
    const runs = await Promise.all([1, 2].map(() => runMaintenance({ now: NOW, tasks: ["uploads"], storage: spy.driver, uploadBatchSize: 3 })));
    expect(runs.map((r) => r.failed)).toEqual([undefined, undefined]);
    expect(runs[0]!.uploadsDeleted + runs[1]!.uploadsDeleted).toBe(12);
    expect(spy.deleted.sort()).toEqual(rows.map((r) => r.storageKey).sort());
    expect(await db.upload.count({ where: { accountId } })).toBe(0);
  });
});

describe("uploads racing the portal", () => {
  it("skips an upload that is being attached at that moment (its file stays)", async () => {
    const racing = await upload("racing", { createdAt: ago(2 * DAY) });
    const other = await upload("other", { createdAt: ago(2 * DAY) });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const attach = db.$transaction(
      async (tx) => {
        await attachUploads(tx, { accountId, userId, ids: [racing.id], ticketMessageId: `msg-${tag}`, now: NOW });
        locked();
        await released;
      },
      { timeout: 30_000 },
    );
    await isLocked;
    const spy = spyStorage();
    const result = await runMaintenance({ now: NOW, tasks: ["uploads"], storage: spy.driver });
    release();
    await attach;
    expect(result.uploadsDeleted).toBe(1);
    expect(spy.deleted).toEqual([other.storageKey]);
    expect(await db.upload.findUniqueOrThrow({ where: { id: racing.id } })).toMatchObject({ status: "ATTACHED", ticketMessageId: `msg-${tag}` });
    expect(await exists(racing.storageKey)).toBe(true);
    await db.upload.deleteMany({ where: { id: racing.id } });
  });

  it("an attach that arrives while the job deletes the file is refused (409), never attached to a deleted file", async () => {
    const doomed = await upload("doomed", { createdAt: ago(2 * DAY) });
    const spy = spyStorage();
    spy.hold();
    const job = runMaintenance({ now: NOW, tasks: ["uploads"], storage: spy.driver });
    await spy.firstDelete; // the job holds the row lock and is deleting the file
    const attach = db.$transaction(
      (tx) => attachUploads(tx, { accountId, userId, ids: [doomed.id], ticketMessageId: `msg2-${tag}`, now: NOW }),
      { timeout: 30_000 },
    );
    const settled = attach.then(
      () => "attached",
      (error: unknown) => (error as { status?: number }).status,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    spy.open();
    expect((await job).uploadsDeleted).toBe(1);
    expect(await settled).toBe(409);
    expect(await db.upload.findUnique({ where: { id: doomed.id } })).toBeNull();
    expect(await exists(doomed.storageKey)).toBe(false);
  });
});
