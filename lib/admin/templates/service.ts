/**
 * Admin Notification templates service (decisions.md Phase 6 "templates: edit subject/body with variable hints and
 * Send test to the signed-in staff member"; api-contracts section 7 "templates: PATCH, POST /:id/test"). Server-only.
 *
 * - Edits upsert the NotificationTemplate row (built-in templates get their row on the first save) and are audited
 *   "Edited template"; the active switch alone is audited "Changed template status".
 * - Placeholders the template does not know are refused (422), because production would send them blank.
 * - "Send test" renders the template (the editor's unsaved copy when given) with its sample data and sends it straight
 *   to the signed-in staff member's own address: never through the outbox, never to anyone else, 10 per hour.
 */
import "server-only";
import type { NotificationTemplate } from "@/generated/prisma/client";
import { audit, type AuditActor } from "@/lib/audit";
import { attempt, enforce, type RateLimitRule } from "@/lib/auth/rate-limit";
import { sha256Hex } from "@/lib/auth/tokens";
import { db, type Db } from "@/lib/db";
import { composeEmail } from "@/lib/email/compose";
import { EMAIL_TEMPLATE_DEFAULTS, isEmailTemplateId } from "@/lib/email/defaults";
import { getEmailTransport, maskEmail } from "@/lib/email/transport";
import { errors } from "@/lib/http";
import { log } from "@/lib/log";
import { TEMPLATE_ERRORS, templateDto, templateOrder, unknownTemplateVars, type TemplateDto } from "./model";
import type { TemplateTestInput, TemplateUpdateInput } from "./schemas";

export type TemplateActorContext = { actor: AuditActor };

/** Every template: the code catalogue (with or without a row) plus any other stored rows. */
export async function loadTemplates(client: Db = db): Promise<TemplateDto[]> {
  const rows = await client.notificationTemplate.findMany();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return templateOrder(rows.map((r) => r.id)).map((id) => templateDto(id, byId.get(id) ?? null));
}

/** One template, or 404 for an id that is neither in the catalogue nor stored. */
export async function getTemplate(id: string, client: Db = db): Promise<TemplateDto> {
  const row = await client.notificationTemplate.findUnique({ where: { id } });
  if (!row && !isEmailTemplateId(id)) throw errors.notFound("Template");
  return templateDto(id, row);
}

function checkVars(t: TemplateDto, subject: string, body: string): void {
  const unknownSubject = unknownTemplateVars(t, subject, "");
  const unknownBody = unknownTemplateVars(t, "", body);
  if (unknownSubject.length === 0 && unknownBody.length === 0) return;
  throw errors.validation({
    ...(unknownSubject.length > 0 ? { subject: TEMPLATE_ERRORS.unknownVars(unknownSubject) } : {}),
    ...(unknownBody.length > 0 ? { body: TEMPLATE_ERRORS.unknownVars(unknownBody) } : {}),
  });
}

export type TemplateWriteResult = { template: TemplateDto; changed: boolean };

/** PATCH /api/admin/templates/:id */
export async function updateTemplate(
  id: string,
  patch: TemplateUpdateInput,
  ctx: TemplateActorContext,
  client: typeof db = db,
): Promise<TemplateWriteResult> {
  if (patch.subject === undefined && patch.body === undefined && patch.active === undefined) {
    throw errors.validation({}, [TEMPLATE_ERRORS.nothingToSave]);
  }
  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "NotificationTemplate" WHERE "id" = ${id} FOR UPDATE`;
    const row = await tx.notificationTemplate.findUnique({ where: { id } });
    if (!row && !isEmailTemplateId(id)) throw errors.notFound("Template");
    const current = templateDto(id, row);
    const next = {
      subject: patch.subject ?? current.subject,
      body: patch.body ?? current.body,
      active: patch.active ?? current.active,
    };
    if (patch.subject !== undefined || patch.body !== undefined) checkVars(current, next.subject, next.body);

    const changed: string[] = [];
    if (next.subject !== current.subject) changed.push("subject");
    if (next.body !== current.body) changed.push("body");
    const statusChanged = row ? next.active !== row.active : !next.active;
    if (changed.length === 0 && !statusChanged) return { template: current, changed: false };

    const saved: NotificationTemplate = await tx.notificationTemplate.upsert({
      where: { id },
      create: { id, name: current.name, channel: "email", subject: next.subject, body: next.body, active: next.active },
      update: { subject: next.subject, body: next.body, active: next.active },
    });
    const statusText = saved.active ? "Active" : "Draft";
    await audit(tx, ctx.actor, {
      action: changed.length > 0 ? "Edited template" : "Changed template status",
      target: saved.name,
      targetType: "template",
      targetId: id,
      detail: changed.length > 0 ? [...changed, ...(statusChanged ? [`now ${statusText}`] : [])].join(" \u00b7 ") : statusText,
    });
    return { template: templateDto(id, saved), changed: true };
  });
}

export const TEMPLATE_TEST_LIMIT = 10;
export const TEMPLATE_TEST_WINDOW_SEC = 3600;

/** "Send test" per staff member: 10 / hour (same key shape as lib/auth/rate-limit RATE_LIMITS). */
export function templateTestRule(staffId: string): RateLimitRule {
  return { key: `admin-template-test:user:${sha256Hex(staffId).slice(0, 32)}`, limit: TEMPLATE_TEST_LIMIT, windowSec: TEMPLATE_TEST_WINDOW_SEC };
}

/**
 * POST /api/admin/templates/:id/test: renders the template with its sample data and sends it now to the staff
 * member's own address, subject prefixed "[Test]". Audited "Sent test email" (no address in the row).
 */
export async function sendTemplateTest(
  id: string,
  input: TemplateTestInput,
  ctx: TemplateActorContext & { staff: { id: string; email: string } },
  client: typeof db = db,
): Promise<{ sentTo: string }> {
  const template = await getTemplate(id, client);
  const content = { subject: input.subject ?? template.subject, body: input.body ?? template.body };
  checkVars(template, content.subject, content.body);
  enforce(await attempt(client, templateTestRule(ctx.staff.id)));

  const sample = isEmailTemplateId(id) ? EMAIL_TEMPLATE_DEFAULTS[id].sampleVars : {};
  const email = await composeEmail(client, id, sample, { content, unknownVars: "keep" });
  const transport = await getEmailTransport();
  try {
    await transport.send({ to: ctx.staff.email, subject: `[Test] ${email.subject}`, html: email.html, text: email.text, templateId: id });
  } catch (error) {
    log.error("admin_template_test_failed", { template: id, to: maskEmail(ctx.staff.email), error: error instanceof Error ? error.name : typeof error });
    throw errors.conflict("send_failed", "We couldn\u2019t send the test email. Check the email settings and try again.");
  }
  await audit(client, ctx.actor, {
    action: "Sent test email",
    target: template.name,
    targetType: "template",
    targetId: id,
    detail: "To the signed-in staff member",
  });
  return { sentTo: ctx.staff.email };
}

/** templates.csv columns. */
export const TEMPLATE_CSV_COLUMNS = [
  { header: "Template", value: (t: TemplateDto) => t.name },
  { header: "Id", value: (t: TemplateDto) => t.id },
  { header: "Trigger", value: (t: TemplateDto) => t.trigger },
  { header: "Subject", value: (t: TemplateDto) => t.subject },
  { header: "Channel", value: (t: TemplateDto) => t.channel },
  { header: "Status", value: (t: TemplateDto) => (t.status === "active" ? "Active" : t.status === "draft" ? "Draft" : "Built-in") },
  { header: "Updated", value: (t: TemplateDto) => t.updatedAt ?? "" },
] as const;
