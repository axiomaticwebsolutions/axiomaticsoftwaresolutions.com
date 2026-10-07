/**
 * Every maintenance batch changes at most `limit` rows, whatever plan Postgres picks (lib/jobs/tasks.ts).
 *
 * Regression: the batches used to pick rows with `WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)`. Under a
 * nested-loop semi join Postgres re-runs that subquery for every outer row; its row locks skip the rows the statement
 * already changed, so each re-run returns fresh rows and one statement changed every matching row (a DB test run
 * purged 7 sessions with a cap of 5). The batches now pick rows in a MATERIALIZED CTE, which runs once.
 *
 * Each case runs in a transaction that forces nested-loop plans (hash/merge joins, sorts, hash aggregates and
 * materialisation off) and is rolled back, so nothing is left in the shared schema. The control case shows the old
 * statement shape really overshoots under these settings, so the cases below exercise the hazard.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, Prisma, type Tx } from "@/lib/db";
import { maintenanceCutoffs } from "@/lib/jobs/retention";
import { closeResolvedTicketsBatch, purgeBatch, redactSentEmailsBatch } from "@/lib/jobs/tasks";

const NOW = new Date("2001-03-10T06:30:00.000Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const hex = () => randomBytes(16).toString("hex");
const ROWS = 7;
const LIMIT = 2;

class Rollback extends Error {}

/** Runs `fn` in a transaction with nested-loop plans forced, then rolls it back. Returns what `fn` returned. */
async function inForcedNestedLoop<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await db
    .$transaction(
      async (tx) => {
        for (const setting of ["enable_hashjoin", "enable_mergejoin", "enable_material", "enable_sort", "enable_hashagg"]) {
          await tx.$executeRawUnsafe(`SET LOCAL ${setting} = off`);
        }
        out = await fn(tx);
        throw new Rollback();
      },
      { timeout: 20_000 },
    )
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return out as T;
}

async function userWithSessions(tx: Tx): Promise<string> {
  const user = await tx.user.create({ data: { email: `jobs.limit.${hex()}@example.test`, name: "Jobs Limit", kind: "CUSTOMER" } });
  for (let i = 0; i < ROWS; i += 1) {
    await tx.session.create({
      data: { userId: user.id, tokenHash: hex(), createdAt: ago(400 * DAY), lastSeenAt: ago(100 * DAY), expiresAt: ago(60 * DAY) },
    });
  }
  return user.id;
}

describe("maintenance batches under a nested-loop plan", () => {
  it("control: the old IN (subquery LIMIT n FOR UPDATE SKIP LOCKED) shape deletes more than n rows", async () => {
    const deleted = await inForcedNestedLoop(async (tx) => {
      const userId = await userWithSessions(tx);
      return tx.$executeRaw(Prisma.sql`
        DELETE FROM "Session"
        WHERE "id" IN (
            SELECT "id" FROM "Session" WHERE "userId" = ${userId} AND "expiresAt" < ${NOW}::timestamp(3)
            LIMIT ${LIMIT}::int FOR UPDATE SKIP LOCKED
          )
          AND "userId" = ${userId}`);
    });
    expect(deleted).toBeGreaterThan(LIMIT);
  });

  it("purgeBatch deletes exactly `limit` rows per statement", async () => {
    const counts = await inForcedNestedLoop(async (tx) => {
      const userId = await userWithSessions(tx);
      const cutoffs = maintenanceCutoffs(NOW);
      const first = await purgeBatch(tx, "sessions", cutoffs, LIMIT);
      const left = await tx.session.count({ where: { userId } });
      return { first, left };
    });
    expect(counts).toEqual({ first: LIMIT, left: ROWS - LIMIT });
  });

  it("closeResolvedTicketsBatch closes exactly `limit` tickets per statement", async () => {
    const counts = await inForcedNestedLoop(async (tx) => {
      const account = await tx.businessAccount.create({ data: { legalName: `Jobs Limit ${hex()}` } });
      for (let i = 0; i < ROWS; i += 1) {
        await tx.supportTicket.create({
          data: { id: `T-LIMIT-${hex()}`, accountId: account.id, subject: "Printer", status: "RESOLVED", resolvedAt: ago(30 * DAY), createdAt: ago(60 * DAY) },
        });
      }
      const first = await closeResolvedTicketsBatch(tx, maintenanceCutoffs(NOW), LIMIT);
      const closed = await tx.supportTicket.count({ where: { accountId: account.id, status: "CLOSED" } });
      return { first, closed };
    });
    expect(counts).toEqual({ first: LIMIT, closed: LIMIT });
  });

  it("redactSentEmailsBatch redacts exactly `limit` emails per statement", async () => {
    const tag = hex();
    const counts = await inForcedNestedLoop(async (tx) => {
      for (let i = 0; i < ROWS; i += 1) {
        await tx.outboxEmail.create({
          data: {
            templateId: "order_confirmation",
            to: `priya+${i}@sharma-medicals.in`,
            subject: "Your order is confirmed",
            html: "<p>Hello</p>",
            text: "Hello",
            dedupeKey: `jobs-limit:${tag}:${i}`,
            status: "SENT",
            attempts: 1,
            sendAfter: ago(60 * DAY),
            createdAt: ago(60 * DAY),
            sentAt: ago(45 * DAY),
          },
        });
      }
      const first = await redactSentEmailsBatch(tx, maintenanceCutoffs(NOW), LIMIT);
      const redacted = await tx.outboxEmail.count({ where: { dedupeKey: { startsWith: `jobs-limit:${tag}:` }, html: "" } });
      return { first, redacted };
    });
    expect(counts).toEqual({ first: LIMIT, redacted: LIMIT });
  });
});
