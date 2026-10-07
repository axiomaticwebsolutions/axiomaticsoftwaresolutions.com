/**
 * "Update available" fan-out after a release is published (decisions.md Phase 6 "Releases"; prototype: "Eligible
 * customers will see it in My Software and get an update notification").
 *
 * Entitled accounts hold a license for the product that can download the release: ACTIVE or TRIAL, not expired, and
 * updatesUntil on or after the release date (lib/licensing/entitlement.ts rules). Only the customer channel (stable)
 * notifies. Each active member of those accounts gets one in-app Notification (kind "update"), and members with
 * verified emails and update emails switched on (portal preferences) get the "release_available" email through the
 * outbox (dedupe key release_available:<releaseId>:<userId>).
 *
 * Accounts are processed in keyset batches, each in its own transaction, so a large product never holds one long
 * transaction. Re-running is safe: users who already have this release's notification are skipped and the email
 * dedupe key ignores repeats. Runs after the publish response (next/server after()); server-only.
 */
import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { db as defaultDb } from "@/lib/db";
import { enqueueEmail, kickEmailDispatch } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { readStoredEmailPrefs } from "@/lib/portal/preferences";
import { CUSTOMER_CHANNEL } from "./rules";

export const RELEASE_NOTIFY_BATCH = 500;
export const RELEASE_EMAIL_TEMPLATE = "release_available";

export type ReleaseNotifyResult = { accounts: number; notifications: number; emails: number; skipped: null | "not_published" | "not_customer_channel" };

/** The in-app notification's link; also how a re-run recognises users already notified about this release. */
export function releaseNotificationHref(releaseId: string): string {
  return `/account/software?release=${encodeURIComponent(releaseId)}`;
}

export type NotifyOptions = { client?: PrismaClient; now?: Date; batchSize?: number; appUrl?: string };

export async function notifyReleaseAvailable(releaseId: string, opts: NotifyOptions = {}): Promise<ReleaseNotifyResult> {
  const client = opts.client ?? defaultDb;
  const now = opts.now ?? new Date();
  const batchSize = Math.max(1, opts.batchSize ?? RELEASE_NOTIFY_BATCH);
  const result: ReleaseNotifyResult = { accounts: 0, notifications: 0, emails: 0, skipped: null };

  const release = await client.release.findUnique({ where: { id: releaseId }, include: { product: { select: { name: true, shortName: true } } } });
  if (!release || release.status !== "PUBLISHED" || !release.releasedAt) return { ...result, skipped: "not_published" };
  if (release.channel !== CUSTOMER_CHANNEL) return { ...result, skipped: "not_customer_channel" };
  const releasedAt = release.releasedAt;

  const href = releaseNotificationHref(releaseId);
  const softwareUrl = `${(opts.appUrl ?? getEnv().APP_URL).replace(/\/+$/, "")}/account/software`;
  const title = `${release.product.shortName} ${release.version} is available`;
  const body = release.notes[0] ?? "Download the update from Software & downloads.";
  const seen = new Set<string>();
  let cursor: string | null = null;

  for (;;) {
    const rows: { accountId: string }[] = await client.$queryRaw<{ accountId: string }[]>`
      SELECT DISTINCT "accountId" FROM "License"
      WHERE "productId" = ${release.productId}
        AND "accountId" IS NOT NULL
        AND "accountId" > ${cursor ?? ""}
        AND "status" IN ('ACTIVE'::"LicenseStatus", 'TRIAL'::"LicenseStatus")
        AND ("expiresAt" IS NULL OR "expiresAt" > ${now}::timestamp(3))
        AND "updatesUntil" >= ${releasedAt}::timestamp(3)
      ORDER BY "accountId"
      LIMIT ${batchSize}::int`;
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]?.accountId ?? null;
    const accountIds = rows.map((r) => r.accountId);
    result.accounts += accountIds.length;

    const members = await client.accountMember.findMany({
      where: { accountId: { in: accountIds }, status: "ACTIVE", user: { kind: "CUSTOMER" } },
      select: { user: { select: { id: true, email: true, name: true, emailVerifiedAt: true, notificationPrefs: true } } },
    });
    const users = members.map((m) => m.user).filter((u) => !seen.has(u.id) && (seen.add(u.id), true));
    if (users.length === 0) continue;
    const already = await client.notification.findMany({
      where: { userId: { in: users.map((u) => u.id) }, kind: "update", href },
      select: { userId: true },
    });
    const done = new Set(already.map((n) => n.userId));
    const fresh = users.filter((u) => !done.has(u.id));
    if (fresh.length === 0) continue;

    const counts = await client.$transaction(async (tx) => {
      await tx.notification.createMany({ data: fresh.map((u) => ({ userId: u.id, kind: "update", title, body, href, createdAt: now })) });
      let emails = 0;
      for (const user of fresh) {
        if (!user.emailVerifiedAt || !readStoredEmailPrefs(user.notificationPrefs).updates) continue;
        await enqueueEmail(tx, {
          to: user.email,
          templateId: RELEASE_EMAIL_TEMPLATE,
          vars: {
            customer_name: greetingName(user.name),
            product_name: release.product.name,
            version: release.version,
            software_url: softwareUrl,
          },
          dedupeKey: `${RELEASE_EMAIL_TEMPLATE}:${releaseId}:${user.id}`,
        });
        emails += 1;
      }
      return { notifications: fresh.length, emails };
    });
    result.notifications += counts.notifications;
    result.emails += counts.emails;
    if (rows.length < batchSize) break;
  }

  if (result.emails > 0) kickEmailDispatch();
  log.info("release_notified", { releaseId, accounts: result.accounts, notifications: result.notifications, emails: result.emails });
  return result;
}
