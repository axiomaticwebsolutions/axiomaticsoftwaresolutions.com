/**
 * Audit log reads (decisions.md Phase 6; audit.view = Owner, Administrator). AuditLog is append-only: this module
 * only lists, reads and exports rows; nothing here (or anywhere) updates or deletes them.
 *
 * Scale: lists are offset-paged on the createdAt index; the Action and Target select options come from the newest
 * FACET_WINDOW rows (plus the known vocabulary), so building them never scans the whole table. Server-only.
 */
import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { DESTRUCTIVE_AUDIT_ACTIONS } from "@/lib/admin/destructive";
import { pageResult, searchWhere, toPrismaOrderBy, type ListPage, type ListQuery } from "@/lib/admin/list-query";
import { endOfDayIST, startOfDayIST } from "@/lib/dates";
import type { Db } from "@/lib/db";
import { errors } from "@/lib/http";
import { BRAND_AUDIT_ACTIONS } from "@/lib/branding/model";
import { INTEGRATION_AUDIT_ACTIONS } from "@/lib/integrations/model";
import { TWO_STEP_OFF_ACTION, TWO_STEP_ON_ACTION } from "@/lib/portal/profile";
import { STAFF_ROLE_LABELS } from "@/lib/rbac";
import type { AUDIT_LIST_SPEC } from "./model";
import {
  actionSlug,
  auditActionLabel,
  FORMER_STAFF_NAME,
  legacyActionsMatching,
  storedAuditActions,
  SYSTEM_ACTOR_NAME,
  SYSTEM_AUDIT_ACTIONS,
  targetTypeLabel,
  type AuditFacets,
  type AuditRow,
  type AuditSort,
} from "./model";

export type AuditListQuery = ListQuery<typeof AUDIT_LIST_SPEC.filters, AuditSort>;

/** Rows the facet queries look at (newest first). */
export const FACET_WINDOW = 5000;

/** Actions written by this area and the foundation, so their filters work before the first row exists. */
const KNOWN_ACTIONS: readonly string[] = [
  ...Object.values(DESTRUCTIVE_AUDIT_ACTIONS),
  "Invited staff",
  "Resent staff invitation",
  "Revoked staff invitation",
  "Accepted staff invitation",
  "Updated settings",
  // Admin > Settings > Branding (upload, replace, remove).
  ...Object.values(BRAND_AUDIT_ACTIONS),
  // Admin > Settings > Integrations (save, clear a secret, remove, test).
  ...Object.values(INTEGRATION_AUDIT_ACTIONS),
  "Exported report",
  "Refunded duplicate payment",
  // A staff member's own two-step change (Admin > My profile).
  TWO_STEP_ON_ACTION,
  TWO_STEP_OFF_ACTION,
  ...Object.values(SYSTEM_AUDIT_ACTIONS),
];

const AUDIT_SELECT = {
  id: true,
  createdAt: true,
  actorId: true,
  actorRole: true,
  action: true,
  target: true,
  targetType: true,
  targetId: true,
  reason: true,
  detail: true,
  ipPrefix: true,
  actor: { select: { name: true, email: true } },
} as const satisfies Prisma.AuditLogSelect;

type AuditRecord = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_SELECT }>;

function toAuditRow(r: AuditRecord): AuditRow {
  const actorName =
    r.actorRole === "system" && !r.actorId
      ? SYSTEM_ACTOR_NAME
      : r.actor
        ? r.actor.name.trim() || r.actor.email
        : FORMER_STAFF_NAME;
  return {
    id: r.id,
    at: r.createdAt.toISOString(),
    actorId: r.actorId,
    actorName,
    actorRole: r.actorRole,
    action: auditActionLabel(r.action),
    target: r.target,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    detail: r.detail,
    ipPrefix: r.ipPrefix,
  };
}

/**
 * Distinct action labels among the newest FACET_WINDOW rows (older machine names under their label, so each action is
 * listed once), merged with the known vocabulary, sorted.
 */
export async function recentAuditActions(client: Db): Promise<string[]> {
  const rows = await client.$queryRaw<Array<{ action: string }>>`
    SELECT DISTINCT "action" FROM (
      SELECT "action" FROM "AuditLog" ORDER BY "createdAt" DESC LIMIT ${FACET_WINDOW}
    ) AS "recent"`;
  return [...new Set([...rows.map((r) => auditActionLabel(r.action)), ...KNOWN_ACTIONS])].sort((a, b) => a.localeCompare(b, "en"));
}

/** The action labels an action filter slug stands for (empty when none matches). */
export function actionsForSlug(slug: string, actions: readonly string[]): string[] {
  return actions.filter((a) => actionSlug(a) === slug);
}

export type AuditListOptions = {
  /** Action labels to resolve the action slug against (default: recentAuditActions). */
  actions?: readonly string[];
};

async function listWhere(client: Db, query: Pick<AuditListQuery, "q" | "filters">, opts: AuditListOptions): Promise<Prisma.AuditLogWhereInput> {
  const and: Prisma.AuditLogWhereInput[] = [];
  const f = query.filters;
  if (f.role) and.push({ actorRole: f.role });
  if (f.actor) and.push({ actorId: f.actor });
  if (f.action) {
    // An unknown slug (a stale link) is ignored, like other invalid filter values.
    const labels = actionsForSlug(f.action, opts.actions ?? (await recentAuditActions(client)));
    if (labels.length > 0) and.push({ action: { in: storedAuditActions(labels) } });
  }
  if (f.targetType) and.push({ targetType: f.targetType });
  if (f.from) and.push({ createdAt: { gte: startOfDayIST(f.from) } });
  if (f.to) and.push({ createdAt: { lte: endOfDayIST(f.to) } });
  const search = searchWhere<Prisma.AuditLogWhereInput>(query.q, ["actor.name", "action", "target", "targetId", "detail", "reason"]);
  if (search) {
    const legacy = legacyActionsMatching(query.q);
    and.push(legacy.length > 0 ? { OR: [...(search.OR ?? []), { action: { in: legacy } }] } : search);
  }
  return and.length > 0 ? { AND: and } : {};
}

function orderBy(query: Pick<AuditListQuery, "sort">): Prisma.AuditLogOrderByWithRelationInput[] {
  return toPrismaOrderBy<Prisma.AuditLogOrderByWithRelationInput>(query.sort, {
    createdAt: "createdAt",
    actor: (dir) => [{ actor: { name: dir } }, { actorRole: dir }, { createdAt: "desc" }],
    action: (dir) => [{ action: dir }, { createdAt: "desc" }],
  });
}

/** GET /api/admin/audit and the Audit log page. */
export async function listAudit(client: Db, query: AuditListQuery, opts: AuditListOptions = {}): Promise<ListPage<AuditRow>> {
  const where = await listWhere(client, query, opts);
  const [rows, total] = await Promise.all([
    client.auditLog.findMany({ where, orderBy: orderBy(query), skip: query.skip, take: query.take, select: AUDIT_SELECT }),
    client.auditLog.count({ where }),
  ]);
  return pageResult(rows.map(toAuditRow), total, query);
}

/** Every row matching the list filters, newest first by default (CSV; at most `limit`). */
export async function exportAudit(client: Db, query: AuditListQuery, limit: number, opts: AuditListOptions = {}): Promise<AuditRow[]> {
  const where = await listWhere(client, query, opts);
  const rows = await client.auditLog.findMany({ where, orderBy: orderBy(query), take: limit, select: AUDIT_SELECT });
  return rows.map(toAuditRow);
}

/** GET /api/admin/audit/:id (404 when missing). */
export async function getAuditEvent(client: Db, id: string): Promise<AuditRow> {
  const row = await client.auditLog.findUnique({ where: { id }, select: AUDIT_SELECT });
  if (!row) throw errors.notFound("Audit event");
  return toAuditRow(row);
}

/** Options for the Person (staff, any status), Action and Target selects. */
export async function auditFacets(client: Db, actions?: readonly string[]): Promise<AuditFacets> {
  const [staff, actionLabels, types] = await Promise.all([
    client.user.findMany({
      where: { kind: "STAFF", staffRole: { not: null }, passwordHash: { not: null } },
      orderBy: [{ name: "asc" }, { email: "asc" }],
      select: { id: true, name: true, email: true, staffRole: true },
      take: 500,
    }),
    actions ? Promise.resolve([...actions]) : recentAuditActions(client),
    client.$queryRaw<Array<{ targetType: string }>>`
      SELECT DISTINCT "targetType" FROM (
        SELECT "targetType" FROM "AuditLog" ORDER BY "createdAt" DESC LIMIT ${FACET_WINDOW}
      ) AS "recent" WHERE "targetType" IS NOT NULL`,
  ]);
  const bySlug = new Map<string, string>();
  for (const label of actionLabels) {
    const slug = actionSlug(label);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, label);
  }
  return {
    actors: staff.map((s) => ({
      value: s.id,
      label: `${s.name.trim() || s.email}${s.staffRole ? ` \u00B7 ${STAFF_ROLE_LABELS[s.staffRole]}` : ""}`,
    })),
    actions: [...bySlug].map(([value, label]) => ({ value, label })),
    targetTypes: types
      .map((t) => ({ value: t.targetType, label: targetTypeLabel(t.targetType) }))
      .sort((a, b) => a.label.localeCompare(b.label, "en")),
  };
}
