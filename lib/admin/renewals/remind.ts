/**
 * "Send reminder now" (Renewals bulk bar and the license drawer; renewals.remind). For each license in the Renewals
 * row set it queues the reminder that fits the end date (renewal_30, renewal_7 within the last week, license_expired
 * once lapsed) through the outbox to the account's active Owners and Billing admins who keep renewal emails on (the
 * buyer's email for an unclaimed guest license), and writes one "Sent renewal reminder" audit row per license, in one
 * transaction per license. Dedupe: one reminder per license, template and IST day
 * (`renewal:<licenseId>:<template>:<YYYY-MM-DD>:<recipient tag>`); a second send the same day is skipped.
 */
import "server-only";
import { LicenseStatus, PlanType, type PrismaClient } from "@/generated/prisma/client";
import { audit, type AuditActor } from "@/lib/audit";
import { sha256Hex } from "@/lib/auth/tokens";
import { formatDateIST } from "@/lib/dates";
import { db as defaultDb, type Tx } from "@/lib/db";
import { enqueueEmail, kickEmailDispatch } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/http";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { readStoredEmailPrefs } from "@/lib/portal/preferences";
import {
  inRenewalWindow,
  istDayKey,
  REMIND_MAX_LICENSES,
  reminderTemplateFor,
  renewalReminderDayPrefix,
  RENEWAL_COPY,
  type ReminderTemplateId,
  type RemindResult,
} from "./model";

export type RemindContext = { actor: AuditActor; now?: Date; client?: PrismaClient };

type Recipient = { email: string; name: string | null };

const REASONS = RENEWAL_COPY.skippedReasons;

/** Where a renewal link points: the license's Renew tab in the portal (guests sign in or register first). */
export function renewUrl(licenseId: string, claimed: boolean): string {
  const base = getEnv().APP_URL;
  return claimed ? `${base}/account/licenses/${encodeURIComponent(licenseId)}?tab=renew` : `${base}/account/licenses`;
}

async function recipientsFor(tx: Tx, license: { accountId: string | null; orderId: string | null }): Promise<Recipient[]> {
  if (license.accountId) {
    const members = await tx.accountMember.findMany({
      where: { accountId: license.accountId, status: "ACTIVE", role: { in: ["OWNER", "BILLING"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { user: { select: { email: true, name: true, kind: true, notificationPrefs: true } } },
    });
    return members
      .filter((m) => m.user.kind === "CUSTOMER" && readStoredEmailPrefs(m.user.notificationPrefs).renewals)
      .map((m) => ({ email: m.user.email, name: m.user.name }));
  }
  if (!license.orderId) return [];
  const order = await tx.order.findUnique({ where: { id: license.orderId }, select: { email: true, billing: true } });
  return order ? [{ email: order.email, name: readBillingSnapshot(order.billing).name || null }] : [];
}

type Outcome = { skip: string } | { templateId: ReminderTemplateId; recipients: number };

/** Queues reminders for `ids` (1-100). Returns what was queued and what was skipped, with the reason. */
export async function sendRenewalReminders(ids: readonly string[], ctx: RemindContext): Promise<RemindResult> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0 || unique.length > REMIND_MAX_LICENSES) {
    throw new ApiError(422, "validation_failed", `Select between 1 and ${REMIND_MAX_LICENSES} licenses.`);
  }
  const client = ctx.client ?? defaultDb;
  const now = ctx.now ?? new Date();
  const result: RemindResult = { queued: [], skipped: [] };

  for (const id of unique) {
    const outcome = await client.$transaction(async (tx): Promise<Outcome> => {
      const license = await tx.license.findUnique({
        where: { id },
        select: {
          id: true,
          accountId: true,
          orderId: true,
          status: true,
          expiresAt: true,
          plan: { select: { type: true } },
          product: { select: { name: true } },
        },
      });
      if (!license) return { skip: REASONS.notFound };
      if (license.status === LicenseStatus.REVOKED) return { skip: REASONS.revoked };
      if (license.status === LicenseStatus.TRIAL || license.plan.type === PlanType.TRIAL) return { skip: REASONS.trial };
      if (!license.expiresAt) return { skip: REASONS.noEndDate };
      if (!inRenewalWindow(license.expiresAt, now)) return { skip: REASONS.outsideWindow };

      const templateId = reminderTemplateFor(license.expiresAt, now);
      const prefix = renewalReminderDayPrefix(id, templateId, now);
      const sentToday = await tx.outboxEmail.findFirst({ where: { dedupeKey: { startsWith: prefix } }, select: { id: true } });
      if (sentToday) return { skip: REASONS.alreadySent };
      const recipients = await recipientsFor(tx, license);
      if (recipients.length === 0) return { skip: REASONS.noRecipient };

      const expiry = formatDateIST(license.expiresAt);
      const url = renewUrl(id, license.accountId !== null);
      for (const r of recipients) {
        await enqueueEmail(tx, {
          to: r.email,
          templateId,
          vars: { customer_name: greetingName(r.name), product_name: license.product.name, expiry_date: expiry, renew_url: url },
          dedupeKey: `${prefix}${sha256Hex(r.email.toLowerCase()).slice(0, 16)}`,
        });
      }
      await audit(tx, ctx.actor, {
        action: "Sent renewal reminder",
        target: id,
        targetType: "license",
        targetId: id,
        detail: `${templateId} \u00B7 ${recipients.map((r) => r.email).join(", ")}`,
      });
      return { templateId, recipients: recipients.length };
    });
    if ("skip" in outcome) result.skipped.push({ id, reason: outcome.skip });
    else result.queued.push({ id, templateId: outcome.templateId, recipients: outcome.recipients });
  }
  if (result.queued.length > 0) kickEmailDispatch();
  return result;
}

// ---------- Automatic reminders (for a daily scheduler) ----------

/** Automatic reminder windows: renewal_30 while 23-30 days are left, renewal_7 within the last 7 days. */
export const SCHEDULED_REMINDERS = [
  { templateId: "renewal_30", fromDays: 23, toDays: 30 },
  { templateId: "renewal_7", fromDays: 0, toDays: 7 },
] as const satisfies readonly { templateId: ReminderTemplateId; fromDays: number; toDays: number }[];

const SCHEDULE_BATCH = 200;

/**
 * The automatic 30- and 7-day reminders the Renewals page promises, run daily by GET /api/cron/renewals:
 * active, non-trial licenses whose end date falls in a window get the template once per term
 * (`renewal:<licenseId>:<template>:exp-<end date>:<recipient tag>`), so reruns and overlapping windows never send twice.
 * Recipients follow "Send reminder now". No audit rows (system emails, not staff actions). Walks the licenses in id
 * order in batches.
 */
export async function sendScheduledRenewalReminders(
  opts: { now?: Date; client?: PrismaClient; batchSize?: number } = {},
): Promise<{ queued: number; skipped: number }> {
  const client = opts.client ?? defaultDb;
  const now = opts.now ?? new Date();
  const take = Math.max(1, opts.batchSize ?? SCHEDULE_BATCH);
  let queued = 0;
  let skipped = 0;
  for (const window of SCHEDULED_REMINDERS) {
    const from = new Date(now.getTime() + window.fromDays * 86_400_000);
    const to = new Date(now.getTime() + window.toDays * 86_400_000);
    let cursor: string | undefined;
    for (;;) {
      const batch = await client.license.findMany({
        where: {
          status: LicenseStatus.ACTIVE,
          plan: { type: { not: PlanType.TRIAL } },
          expiresAt: { gt: from, lte: to },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take,
        select: { id: true, accountId: true, orderId: true, expiresAt: true, product: { select: { name: true } } },
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]?.id;
      for (const license of batch) {
        const expiresAt = license.expiresAt as Date;
        const prefix = `renewal:${license.id}:${window.templateId}:exp-${istDayKey(expiresAt)}:`;
        const sent = await client.$transaction(async (tx) => {
          if (await tx.outboxEmail.findFirst({ where: { dedupeKey: { startsWith: prefix } }, select: { id: true } })) return false;
          const recipients = await recipientsFor(tx, license);
          if (recipients.length === 0) return false;
          const vars = { product_name: license.product.name, expiry_date: formatDateIST(expiresAt), renew_url: renewUrl(license.id, license.accountId !== null) };
          for (const r of recipients) {
            await enqueueEmail(tx, {
              to: r.email,
              templateId: window.templateId,
              vars: { ...vars, customer_name: greetingName(r.name) },
              dedupeKey: `${prefix}${sha256Hex(r.email.toLowerCase()).slice(0, 16)}`,
            });
          }
          return true;
        });
        if (sent) queued += 1;
        else skipped += 1;
      }
      if (batch.length < take) break;
    }
  }
  if (queued > 0) kickEmailDispatch();
  return { queued, skipped };
}
