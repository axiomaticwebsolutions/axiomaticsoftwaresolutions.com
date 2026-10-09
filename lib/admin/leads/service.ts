/**
 * Admin Leads service (decisions.md Phase 6; leads.view for Owner, Administrator and Support). Server-only.
 * Lists contact and demo requests with search, filters, sort and paging; status changes and notes are one transaction
 * with their audit row ("Changed lead status" / "Added lead note", the note in `reason`), which is also the lead's
 * history. Audit rows name the lead by its reference only, never by the visitor's name or address.
 */
import "server-only";
import type { Lead, Prisma } from "@/generated/prisma/client";
import { ADMIN_EXPORT_MAX_ROWS } from "@/lib/admin/export";
import { pageResult, searchWhere, toPrismaOrderBy, type ListPage } from "@/lib/admin/list-query";
import { audit, type AuditActor } from "@/lib/audit";
import { formatDateIST, formatDateTimeIST, startOfDayIST } from "@/lib/dates";
import { db, type Db } from "@/lib/db";
import { errors } from "@/lib/http";
import { isIsoDate, LEAD_COUNTER_LABELS, LEAD_SLOT_LABELS, LEAD_TOPIC_LABELS } from "@/lib/validation/lead";
import {
  LEAD_ERRORS,
  LEAD_KIND_ENUM,
  LEAD_KIND_LABELS,
  LEAD_STATUS_ENUM,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_VALUES,
  leadStatusesFor,
  leadStatusValue,
  type LeadDetail,
  type LeadDto,
  type LeadHistoryEntry,
  type LeadListQuery,
  type LeadStats,
} from "./model";
import type { LeadUpdateInput } from "./schemas";

export type LeadActorContext = { actor: AuditActor };

function labelOf(map: Readonly<Record<string, string>>, key: string | null): string | null {
  return key !== null && Object.prototype.hasOwnProperty.call(map, key) ? (map[key] ?? null) : key;
}

/** "+91 98200 00000" for ten stored digits; anything else as stored. */
export function formatLeadPhone(phone: string | null): string | null {
  if (!phone) return null;
  return /^\d{10}$/.test(phone) ? `+91 ${phone.slice(0, 5)} ${phone.slice(5)}` : phone;
}

function preferredLabel(lead: Pick<Lead, "preferredDate" | "preferredSlot">): string | null {
  const date = lead.preferredDate && isIsoDate(lead.preferredDate) ? formatDateIST(startOfDayIST(lead.preferredDate)) : null;
  const slot = labelOf(LEAD_SLOT_LABELS, lead.preferredSlot);
  const parts = [date, slot].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(", ") : null;
}

export async function leadProductNames(client: Db = db): Promise<Record<string, string>> {
  const rows = await client.product.findMany({ select: { id: true, shortName: true } });
  return Object.fromEntries(rows.map((p) => [p.id, p.shortName]));
}

export function toLeadDto(lead: Lead, productNames: Readonly<Record<string, string>>): LeadDto {
  return {
    id: lead.id,
    kind: lead.kind,
    kindLabel: LEAD_KIND_LABELS[lead.kind],
    status: leadStatusValue(lead.status),
    name: lead.name,
    businessName: lead.businessName,
    email: lead.email,
    phone: formatLeadPhone(lead.phone),
    productId: lead.productId,
    productName: lead.productId ? (productNames[lead.productId] ?? lead.productId) : lead.kind === "DEMO" ? "Not sure yet" : null,
    // WAITLIST leads always carry the product they wait for.
    countersLabel: labelOf(LEAD_COUNTER_LABELS, lead.countersBand),
    preferredLabel: preferredLabel(lead),
    topicLabel: labelOf(LEAD_TOPIC_LABELS, lead.topic),
    message: lead.message,
    marketingOptIn: lead.marketingOptIn,
    source: lead.source,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  };
}

function leadWhere(query: Pick<LeadListQuery, "q" | "filters">): Prisma.LeadWhereInput {
  const search = searchWhere<Prisma.LeadWhereInput>(query.q, [
    { path: "id", match: "startsWith" },
    "name",
    "email",
    "businessName",
  ]);
  return {
    ...(query.filters.kind ? { kind: LEAD_KIND_ENUM[query.filters.kind] } : {}),
    ...(query.filters.status ? { status: LEAD_STATUS_ENUM[query.filters.status] } : {}),
    ...(search ?? {}),
  };
}

function leadOrderBy(sort: LeadListQuery["sort"]): Prisma.LeadOrderByWithRelationInput[] {
  // Status sorts in workflow order (the enum's declaration order in Postgres).
  return toPrismaOrderBy<Prisma.LeadOrderByWithRelationInput>(sort, { received: "createdAt", name: "name", status: "status" });
}

/** GET /api/admin/leads */
export async function listLeads(query: LeadListQuery, client: Db = db): Promise<ListPage<LeadDto>> {
  const where = leadWhere(query);
  const [total, rows, names] = await Promise.all([
    client.lead.count({ where }),
    client.lead.findMany({ where, orderBy: leadOrderBy(query.sort), skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    leadProductNames(client),
  ]);
  return pageResult(rows.map((l) => toLeadDto(l, names)), total, query);
}

/** Leads per status (stats row). */
export async function leadStats(client: Db = db): Promise<LeadStats> {
  const groups = await client.lead.groupBy({ by: ["status"], _count: { _all: true } });
  const stats = Object.fromEntries(LEAD_STATUS_VALUES.map((s) => [s, 0])) as LeadStats;
  for (const g of groups) stats[leadStatusValue(g.status)] = g._count._all;
  return stats;
}

/** Status changes and notes of a lead, newest first (its audit rows). */
export async function leadHistory(id: string, client: Db = db): Promise<LeadHistoryEntry[]> {
  const rows = await client.auditLog.findMany({
    where: { targetType: "lead", targetId: id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, createdAt: true, action: true, detail: true, reason: true, actorRole: true, actor: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    action: r.action,
    detail: r.detail,
    note: r.reason,
    actorName: r.actor?.name ?? (r.actorRole === "system" ? "System" : "Staff"),
  }));
}

/** GET /api/admin/leads/:id */
export async function getLeadDetail(id: string, client: Db = db): Promise<LeadDetail> {
  const [lead, names, history] = await Promise.all([client.lead.findUnique({ where: { id } }), leadProductNames(client), leadHistory(id, client)]);
  if (!lead) throw errors.notFound("Request");
  return { lead: toLeadDto(lead, names), history };
}

/**
 * PATCH /api/admin/leads/:id { status?, note? }: a new status (audited "Changed lead status", "New \u2192 Contacted",
 * the note as reason) or a note alone ("Added lead note"). Only demo requests can be "Scheduled".
 */
export async function updateLead(
  id: string,
  input: LeadUpdateInput,
  ctx: LeadActorContext,
  client: typeof db = db,
): Promise<LeadDetail & { changed: boolean }> {
  const note = input.note?.trim() || undefined;
  if (input.status === undefined && note === undefined) throw errors.validation({}, [LEAD_ERRORS.nothingToSave]);
  const changed = await client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "id" = ${id} FOR UPDATE`;
    const lead = await tx.lead.findUnique({ where: { id } });
    if (!lead) throw errors.notFound("Request");
    const from = leadStatusValue(lead.status);
    const to = input.status ?? from;
    if (to !== from && !leadStatusesFor(lead.kind).includes(to)) throw errors.validation({ status: LEAD_ERRORS.scheduledDemoOnly });
    if (to === from && !note) return false;
    if (to !== from) await tx.lead.update({ where: { id }, data: { status: LEAD_STATUS_ENUM[to] } });
    await audit(tx, ctx.actor, {
      action: to !== from ? "Changed lead status" : "Added lead note",
      target: id,
      targetType: "lead",
      targetId: id,
      reason: note ?? null,
      detail: to !== from ? `${LEAD_STATUS_LABELS[from]} \u2192 ${LEAD_STATUS_LABELS[to]}` : null,
    });
    return true;
  });
  return { ...(await getLeadDetail(id, client)), changed };
}

/** Rows for leads.csv: the list's filters and sort, at most ADMIN_EXPORT_MAX_ROWS + 1 (the extra row marks truncation). */
export async function leadExportRows(query: Pick<LeadListQuery, "q" | "filters" | "sort">, client: Db = db): Promise<LeadDto[]> {
  const [rows, names] = await Promise.all([
    client.lead.findMany({ where: leadWhere(query), orderBy: leadOrderBy(query.sort), take: ADMIN_EXPORT_MAX_ROWS + 1 }),
    leadProductNames(client),
  ]);
  return rows.map((l) => toLeadDto(l, names));
}

/** leads.csv columns (labels as on screen, IST times). */
export const LEAD_CSV_COLUMNS = [
  { header: "Reference", value: (l: LeadDto) => l.id },
  { header: "Type", value: (l: LeadDto) => l.kindLabel },
  { header: "Status", value: (l: LeadDto) => LEAD_STATUS_LABELS[l.status] },
  { header: "Received (IST)", value: (l: LeadDto) => formatDateTimeIST(new Date(l.createdAt)) },
  { header: "Name", value: (l: LeadDto) => l.name },
  { header: "Business", value: (l: LeadDto) => l.businessName ?? "" },
  { header: "Email", value: (l: LeadDto) => l.email },
  { header: "Phone", value: (l: LeadDto) => l.phone ?? "" },
  { header: "Product", value: (l: LeadDto) => l.productName ?? "" },
  { header: "Computers", value: (l: LeadDto) => l.countersLabel ?? "" },
  { header: "Preferred time", value: (l: LeadDto) => l.preferredLabel ?? "" },
  { header: "Topic", value: (l: LeadDto) => l.topicLabel ?? "" },
  { header: "Message", value: (l: LeadDto) => l.message ?? "" },
  { header: "Marketing emails", value: (l: LeadDto) => (l.marketingOptIn ? "Yes" : "No") },
  { header: "Source", value: (l: LeadDto) => l.source ?? "" },
] as const;
