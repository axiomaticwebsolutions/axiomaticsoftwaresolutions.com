/**
 * Maintenance job against Postgres (lib/jobs/maintenance.ts): outbox redaction and the purges of rate-limit buckets,
 * sessions, auth tokens, account activity and webhook deliveries (boundaries, what is kept, idempotency, batching,
 * the time budget and concurrent runs). Every run uses a clock in 2001 and rows dated around it, so the job only
 * matches this file's rows although DB test files share one schema per run.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailStatus } from "@/generated/prisma/client";
import { addCalendarMonths } from "@/lib/dates";
import { db } from "@/lib/db";
import { maskEmail } from "@/lib/email/transport";
import { MAINTENANCE_TASKS, runMaintenance } from "@/lib/jobs/maintenance";
import { setLogSink } from "@/lib/log";

const NOW = new Date("2001-06-15T06:30:00.000Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const at = (d: Date, deltaMs: number) => new Date(d.getTime() + deltaMs);
const tag = randomBytes(4).toString("hex");
const hex = () => randomBytes(16).toString("hex");

let userId: string;
let accountId: string;
let previousSink: ReturnType<typeof setLogSink>;

beforeAll(async () => {
  previousSink = setLogSink(() => {});
  userId = (await db.user.create({ data: { email: `jobs.purge.${tag}@example.test`, name: "Jobs Purge", kind: "CUSTOMER" } })).id;
  accountId = (await db.businessAccount.create({ data: { legalName: `Jobs Purge ${tag}` } })).id;
});

afterAll(async () => {
  setLogSink(previousSink);
  await db.outboxEmail.deleteMany({ where: { dedupeKey: { startsWith: `jobs:${tag}:` } } });
  await db.rateLimitBucket.deleteMany({ where: { key: { startsWith: `jobs:${tag}:` } } });
  await db.webhookDelivery.deleteMany({ where: { provider: `jobs-${tag}` } });
  await db.webhookEvent.deleteMany({ where: { provider: `jobs-${tag}` } });
  await db.session.deleteMany({ where: { userId } });
  await db.authToken.deleteMany({ where: { userId } });
  await db.accountActivity.deleteMany({ where: { accountId } });
  await db.businessAccount.deleteMany({ where: { id: accountId } });
  await db.user.deleteMany({ where: { id: userId } });
});

// ---------- Outbox ----------

let emailSeq = 0;
async function email(status: EmailStatus, opts: { sentAt?: Date | null; createdAt?: Date; to?: string } = {}) {
  emailSeq += 1;
  const createdAt = opts.createdAt ?? ago(60 * DAY);
  return db.outboxEmail.create({
    data: {
      templateId: "order_confirmation",
      to: opts.to ?? `priya.sharma+${emailSeq}@sharma-medicals.in`,
      subject: "Your order AX-10312 is confirmed",
      html: `<p>Hello Priya, <a href="https://example.test/orders/AX-10312?t=o1.secret">view</a></p>`,
      text: "Hello Priya, view your order: https://example.test/orders/AX-10312?t=o1.secret",
      dedupeKey: `jobs:${tag}:${emailSeq}`,
      status,
      attempts: status === "PENDING" ? 0 : 1,
      lastError: status === "FAILED" ? "Error ECONNREFUSED" : null,
      sendAfter: createdAt,
      createdAt,
      sentAt: status === "SENT" ? (opts.sentAt ?? at(createdAt, 1000)) : null,
    },
  });
}

describe("outbox redaction", () => {
  it("empties body and subject of SENT emails sent more than 30 days ago, masks the recipient, keeps the rest", async () => {
    const old = await email("SENT", { sentAt: at(ago(30 * DAY), -1) });
    const edge = await email("SENT", { sentAt: ago(30 * DAY) });
    const recent = await email("SENT", { sentAt: ago(2 * DAY), createdAt: ago(2 * DAY) });
    const failed = await email("FAILED", { createdAt: ago(90 * DAY) });
    const pending = await email("PENDING", { createdAt: ago(90 * DAY) });

    const result = await runMaintenance({ now: NOW, tasks: ["emails"] });
    expect(result).toMatchObject({ emailsRedacted: 1 });

    const row = await db.outboxEmail.findUniqueOrThrow({ where: { id: old.id } });
    expect(row).toEqual({ ...old, html: "", text: "", subject: "", to: maskEmail(old.to) });
    expect(row.to).toBe(`pr***@sharma-medicals.in`);
    for (const kept of [edge, recent, failed, pending]) expect(await db.outboxEmail.findUniqueOrThrow({ where: { id: kept.id } })).toEqual(kept);

    // Idempotent.
    expect((await runMaintenance({ now: NOW, tasks: ["emails"] })).emailsRedacted).toBe(0);
    expect(await db.outboxEmail.findUniqueOrThrow({ where: { id: old.id } })).toEqual(row);
  });

  it("masks exactly like the logs do (maskEmail), whatever the stored address looks like", async () => {
    const addresses = ["a@b.in", "ab@c.in", "first.last@sub.example.co.in", "@nolocal.in", "no-at-sign", "x@y@z.in", "Mixed.Case@Shop.IN"];
    const rows = [];
    for (const to of addresses) rows.push(await email("SENT", { to, sentAt: ago(45 * DAY) }));
    await runMaintenance({ now: NOW, tasks: ["emails"] });
    for (const r of rows) expect((await db.outboxEmail.findUniqueOrThrow({ where: { id: r.id } })).to).toBe(maskEmail(r.to));
  });

  it("keeps the dedupe key working: the same logical email is never queued again", async () => {
    const sent = await email("SENT", { sentAt: ago(45 * DAY) });
    await runMaintenance({ now: NOW, tasks: ["emails"] });
    const again = await db.outboxEmail.createMany({
      data: [{ templateId: sent.templateId, to: "priya@sharma-medicals.in", subject: "s", html: "h", text: "t", dedupeKey: sent.dedupeKey }],
      skipDuplicates: true,
    });
    expect(again.count).toBe(0);
    expect(await db.outboxEmail.count({ where: { dedupeKey: sent.dedupeKey } })).toBe(1);
  });
});

// ---------- Purges ----------

const session = (data: { expiresAt: Date; revokedAt?: Date | null }) =>
  db.session.create({ data: { userId, tokenHash: hex(), createdAt: ago(400 * DAY), lastSeenAt: ago(100 * DAY), ...data } });
const token = (data: { expiresAt: Date; usedAt?: Date | null }) =>
  db.authToken.create({ data: { type: "LOGIN_OTP", userId, email: `jobs.purge.${tag}@example.test`, codeHash: hex(), createdAt: ago(400 * DAY), ...data } });
const activity = (createdAt: Date) =>
  db.accountActivity.create({ data: { accountId, actorName: "Priya Sharma", action: "Signed in", target: "Security", kind: "security", createdAt } });
const delivery = (receivedAt: Date) =>
  db.webhookDelivery.create({ data: { provider: `jobs-${tag}`, eventId: hex(), type: "payment.captured", signatureOk: true, result: "fulfilled", receivedAt } });
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

describe("purges", () => {
  it("deletes rate-limit buckets whose window ended (resetAt <= now) and keeps running ones", async () => {
    const make = (name: string, resetAt: Date) => db.rateLimitBucket.create({ data: { key: `jobs:${tag}:${name}`, count: 3, resetAt } });
    await make("ended", at(NOW, -1));
    await make("ending-now", NOW);
    const running = await make("running", at(NOW, 1));
    expect(await runMaintenance({ now: NOW, tasks: ["rateLimits"] })).toMatchObject({ rateLimitsPurged: 2 });
    expect(await db.rateLimitBucket.findMany({ where: { key: { startsWith: `jobs:${tag}:` } } })).toEqual([running]);
  });

  it("deletes sessions expired or revoked more than 30 days ago", async () => {
    const cutoff = ago(30 * DAY);
    const gone = [await session({ expiresAt: at(cutoff, -1) }), await session({ expiresAt: at(NOW, 10 * DAY), revokedAt: at(cutoff, -1) })];
    const kept = [
      await session({ expiresAt: cutoff }),
      await session({ expiresAt: at(NOW, 10 * DAY), revokedAt: cutoff }),
      await session({ expiresAt: at(NOW, -DAY) }),
      await session({ expiresAt: at(NOW, 20 * DAY) }),
    ];
    expect(await runMaintenance({ now: NOW, tasks: ["sessions"] })).toMatchObject({ sessionsPurged: gone.length });
    expect(ids(await db.session.findMany({ where: { userId }, select: { id: true } }))).toEqual(ids(kept));
    await db.session.deleteMany({ where: { userId } });
  });

  it("deletes auth tokens expired or used more than 30 days ago (open and recent ones stay)", async () => {
    const cutoff = ago(30 * DAY);
    const gone = [await token({ expiresAt: at(cutoff, -1) }), await token({ expiresAt: at(NOW, DAY), usedAt: at(cutoff, -1) })];
    const kept = [
      await token({ expiresAt: cutoff }),
      await token({ expiresAt: at(NOW, -DAY) }),
      await token({ expiresAt: at(NOW, DAY), usedAt: ago(DAY) }),
      await token({ expiresAt: at(NOW, 7 * DAY) }),
    ];
    expect(await runMaintenance({ now: NOW, tasks: ["authTokens"] })).toMatchObject({ verificationsPurged: gone.length });
    expect(ids(await db.authToken.findMany({ where: { userId }, select: { id: true } }))).toEqual(ids(kept));
    await db.authToken.deleteMany({ where: { userId } });
  });

  it("deletes account activity older than 24 calendar months", async () => {
    const cutoff = addCalendarMonths(NOW, -24);
    await activity(at(cutoff, -1));
    await activity(ago(1000 * DAY));
    const kept = [await activity(cutoff), await activity(ago(DAY))];
    expect(await runMaintenance({ now: NOW, tasks: ["activity"] })).toMatchObject({ activityPurged: 2 });
    expect(ids(await db.accountActivity.findMany({ where: { accountId }, select: { id: true } }))).toEqual(ids(kept));
    await db.accountActivity.deleteMany({ where: { accountId } });
  });

  it("deletes webhook deliveries older than 180 days and keeps every WebhookEvent", async () => {
    const cutoff = ago(180 * DAY);
    await delivery(at(cutoff, -1));
    const kept = [await delivery(cutoff), await delivery(ago(DAY))];
    const event = await db.webhookEvent.create({
      data: { provider: `jobs-${tag}`, id: hex(), type: "payment.captured", result: "fulfilled", payload: {}, receivedAt: ago(900 * DAY) },
    });
    expect(await runMaintenance({ now: NOW, tasks: ["webhookDeliveries"] })).toMatchObject({ webhookDeliveriesPurged: 1 });
    expect(ids(await db.webhookDelivery.findMany({ where: { provider: `jobs-${tag}` }, select: { id: true } }))).toEqual(ids(kept));
    expect(await db.webhookEvent.findUnique({ where: { provider_id: { provider: event.provider, id: event.id } } })).toEqual(event);
    await db.webhookDelivery.deleteMany({ where: { provider: `jobs-${tag}` } });
  });
});

// ---------- Batching, budget, concurrency ----------

describe("batching and concurrency", () => {
  it("works in batches, stops at the per-run cap and continues on the next run", async () => {
    for (let i = 0; i < 7; i += 1) await session({ expiresAt: ago(60 * DAY) });
    const first = await runMaintenance({ now: NOW, tasks: ["sessions"], batchSize: 2, maxRowsPerTask: 5 });
    expect(first).toMatchObject({ sessionsPurged: 5, more: ["sessions"] });
    expect(await db.session.count({ where: { userId } })).toBe(2);
    const second = await runMaintenance({ now: NOW, tasks: ["sessions"], batchSize: 2, maxRowsPerTask: 5 });
    expect(second.sessionsPurged).toBe(2);
    expect(second.more).toBeUndefined();
  });

  it("touches nothing when the time budget is already used up", async () => {
    await session({ expiresAt: ago(60 * DAY) });
    const result = await runMaintenance({ now: NOW, budgetMs: 0 });
    expect(result.more).toEqual([...MAINTENANCE_TASKS]);
    expect(result.sessionsPurged).toBe(0);
    expect(await db.session.count({ where: { userId } })).toBe(1);
    await db.session.deleteMany({ where: { userId } });
  });

  it("lets overlapping runs split the rows: every row is handled once and nothing fails", async () => {
    const n = 40;
    for (let i = 0; i < n; i += 1) {
      await session({ expiresAt: ago(60 * DAY) });
      await token({ expiresAt: ago(60 * DAY) });
      await activity(ago(800 * DAY));
      await email("SENT", { sentAt: ago(45 * DAY) });
    }
    const unredacted = { dedupeKey: { startsWith: `jobs:${tag}:` }, status: "SENT" as const, html: { not: "" }, sentAt: { lt: ago(30 * DAY) } };
    const pendingEmails = await db.outboxEmail.count({ where: unredacted });
    expect(pendingEmails).toBeGreaterThanOrEqual(n);
    const tasks = ["emails", "sessions", "authTokens", "activity"] as const;
    const runs = await Promise.all([1, 2, 3].map(() => runMaintenance({ now: NOW, tasks, batchSize: 3 })));
    expect(runs.flatMap((r) => r.failed ?? [])).toEqual([]);
    const sum = (key: "sessionsPurged" | "verificationsPurged" | "activityPurged" | "emailsRedacted") => runs.reduce((s, r) => s + r[key], 0);
    expect(sum("sessionsPurged")).toBe(n);
    expect(sum("verificationsPurged")).toBe(n);
    expect(sum("activityPurged")).toBe(n);
    expect(sum("emailsRedacted")).toBe(pendingEmails);
    expect(await db.session.count({ where: { userId } })).toBe(0);
    expect(await db.authToken.count({ where: { userId } })).toBe(0);
    expect(await db.accountActivity.count({ where: { accountId } })).toBe(0);
    expect(await db.outboxEmail.count({ where: unredacted })).toBe(0);
  });
});
