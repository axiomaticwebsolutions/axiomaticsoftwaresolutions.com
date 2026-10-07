/**
 * The business account's activity log (portal "Activity log"; docs/decisions.md Phase 5 "Activity log"): one writer
 * for portal actions, and the Owner-only list (10 per page, filter by kind, search) and CSV export.
 *
 * Entries record the actor (AccountActivity.actorId + the name at the time). Text written here never carries a full
 * license key (masked to its last four). Reads only show the retention window (ACTIVITY_RETENTION_MONTHS).
 * Server-only; routes authorize (`activity.view`) before calling.
 */
import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { toCsv, type CsvColumn } from "@/lib/csv";
import { addCalendarMonths } from "@/lib/dates";
import type { Db } from "@/lib/db";
import { redactLicenseKeys } from "@/lib/licensing/keys";
import {
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_RETENTION_MONTHS,
  type ActivityKind,
  type ActivityQuery,
} from "@/lib/validation/team";

const TEXT_MAX = 200;
/** Rows in one CSV export (24 months of a busy account fits; anything beyond is cut with a final note row). */
export const ACTIVITY_EXPORT_LIMIT = 20_000;
export const ACTIVITY_CSV_FILE_NAME = "activity-log.csv";

export type ActivityActor = { id: string | null; name: string };

export type ActivityEntryInput = {
  accountId: string;
  actor: ActivityActor;
  action: string;
  target: string;
  kind: ActivityKind;
  at?: Date;
};

function safeText(text: string): string {
  return redactLicenseKeys(text.replace(/[\p{Cc}\u2028\u2029]+/gu, " ")).trim().slice(0, TEXT_MAX);
}

/** Display name of a person in the log (an invited user may have no name yet). */
export function actorLabel(user: { name: string; email?: string | null }): string {
  return user.name.trim() || user.email || "Team member";
}

/** Appends one entry, inside the caller's transaction (the change and its log line commit together). */
export async function recordAccountActivity(client: Db, entry: ActivityEntryInput): Promise<void> {
  await client.accountActivity.create({
    data: {
      accountId: entry.accountId,
      actorId: entry.actor.id,
      actorName: safeText(entry.actor.name) || "Team member",
      action: safeText(entry.action),
      target: safeText(entry.target),
      kind: entry.kind,
      createdAt: entry.at ?? new Date(),
    },
  });
}

export type ActivityEvent = {
  id: string;
  /** ISO time. */
  at: string;
  actorName: string;
  /** The member who did it, when a person did (null for System and Axiomatic staff). */
  actorId: string | null;
  action: string;
  target: string;
  kind: string;
};

export type ActivityPage = {
  events: ActivityEvent[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  retentionMonths: number;
};

/** Oldest entry still shown. */
export function retentionCutoff(now: Date): Date {
  return addCalendarMonths(now, -ACTIVITY_RETENTION_MONTHS);
}

function whereFor(accountId: string, query: Pick<ActivityQuery, "kind" | "q">, now: Date): Prisma.AccountActivityWhereInput {
  const where: Prisma.AccountActivityWhereInput = { accountId, createdAt: { gte: retentionCutoff(now) } };
  if (query.kind !== "all") where.kind = query.kind;
  const q = query.q.trim();
  if (q) {
    where.OR = [
      { actorName: { contains: q, mode: "insensitive" } },
      { action: { contains: q, mode: "insensitive" } },
      { target: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

const EVENT_SELECT = { id: true, createdAt: true, actorName: true, actorId: true, action: true, target: true, kind: true } as const;

function toEvent(row: { id: string; createdAt: Date; actorName: string; actorId: string | null; action: string; target: string; kind: string }): ActivityEvent {
  return { id: row.id, at: row.createdAt.toISOString(), actorName: row.actorName, actorId: row.actorId, action: row.action, target: row.target, kind: row.kind };
}

/**
 * One page, newest first. A page past the end returns the last page's number with no events, so the client can step
 * back (the total is always exact).
 */
export async function listAccountActivity(client: Db, accountId: string, query: ActivityQuery, now: Date = new Date()): Promise<ActivityPage> {
  const where = whereFor(accountId, query, now);
  const total = await client.accountActivity.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
  const rows = await client.accountActivity.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (query.page - 1) * ACTIVITY_PAGE_SIZE,
    take: ACTIVITY_PAGE_SIZE,
    select: EVENT_SELECT,
  });
  return {
    events: rows.map(toEvent),
    total,
    page: query.page,
    pageSize: ACTIVITY_PAGE_SIZE,
    pageCount,
    retentionMonths: ACTIVITY_RETENTION_MONTHS,
  };
}

// ---------- CSV ----------

type ExportRow = { createdAt: Date; actorName: string; action: string; target: string; kind: string };

/** activity-log.csv columns (prototype: When (ISO), Who, Action, Item, Type). */
export const ACTIVITY_CSV_COLUMNS: readonly CsvColumn<ExportRow>[] = [
  { header: "When", value: (r) => r.createdAt },
  { header: "Who", value: (r) => r.actorName },
  { header: "Action", value: (r) => r.action },
  { header: "Item", value: (r) => r.target },
  { header: "Type", value: (r) => r.kind },
];

/**
 * activity-log.csv for the current filters: all matching rows, newest first, through lib/csv.ts (quoted cells, BOM,
 * CRLF, spreadsheet formulas defused, so a target typed by someone else never runs in the owner's spreadsheet).
 */
export async function exportAccountActivityCsv(
  client: Db,
  accountId: string,
  query: Pick<ActivityQuery, "kind" | "q">,
  now: Date = new Date(),
): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const rows = await client.accountActivity.findMany({
    where: whereFor(accountId, query, now),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ACTIVITY_EXPORT_LIMIT + 1,
    select: EVENT_SELECT,
  });
  const truncated = rows.length > ACTIVITY_EXPORT_LIMIT;
  const kept = truncated ? rows.slice(0, ACTIVITY_EXPORT_LIMIT) : rows;
  return { csv: toCsv(kept, ACTIVITY_CSV_COLUMNS), rows: kept.length, truncated };
}
