/**
 * Records what a test creates and removes exactly that afterwards (local servers only, unless E2E_KEEP_DATA=1), as
 * scripts/check-admin.mjs does: by recorded id, never by "everything new". Counter values that were used up (order,
 * invoice, credit note and license numbers) are never lowered.
 *
 * - emails: throwaway customers and guest buyers (`e2e-<tag>...@example.test`). Their users, the business accounts
 *   only they belong to, every order placed with those emails or by those users or accounts, the orders' licenses,
 *   devices, events, payments, refunds, invoices (and invoice PDFs in local storage), webhook rows, coupon redemptions
 *   (the coupon's redemption count is lowered by the same number), outbox emails, auth tokens and audit rows about them.
 * - orderIds: orders the test placed (also found through the emails; recorded in case the email differs).
 * - auditIds: audit rows a staff journey wrote about shared records (e.g. a plan price changed and restored).
 * - restores: callbacks that put shared records back (e.g. the plan price through the admin API) if the journey
 *   stopped before restoring them itself. They run first and always, even with E2E_KEEP_DATA.
 */
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db";
import { IS_LOCAL, KEEP_DATA, ROOT, setting } from "./env";

export class Created {
  readonly emails = new Set<string>();
  readonly orderIds = new Set<string>();
  readonly auditIds = new Set<string>();
  readonly restores: { label: string; run: () => Promise<void> }[] = [];

  email(value: string): string {
    this.emails.add(value.toLowerCase());
    return value;
  }

  order(id: string): string {
    this.orderIds.add(id);
    return id;
  }

  restore(label: string, run: () => Promise<void>): void {
    this.restores.push({ label, run });
  }

  get empty(): boolean {
    return this.emails.size === 0 && this.orderIds.size === 0 && this.auditIds.size === 0;
  }
}

const STORAGE_ROOT = path.resolve(ROOT, setting("STORAGE_LOCAL_DIR") || ".storage");

/** Removes a local-storage object (STORAGE_DRIVER=local) and the folders it leaves empty. */
function removeStored(key: unknown): void {
  if (typeof key !== "string" || !key) return;
  const full = path.resolve(STORAGE_ROOT, ...key.split("/"));
  if (!full.startsWith(STORAGE_ROOT + path.sep)) return;
  fs.rmSync(full, { force: true });
  for (let dir = path.dirname(full); dir.startsWith(STORAGE_ROOT + path.sep); dir = path.dirname(dir)) {
    try {
      if (fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
    } catch {
      break;
    }
  }
}

export type CleanupReport = { restored: string[]; restoreErrors: string[]; removed: Record<string, number>; skipped?: string };

/** Runs the restores, then deletes the recorded records in one transaction. */
export async function cleanUp(db: Db, created: Created): Promise<CleanupReport> {
  const report: CleanupReport = { restored: [], restoreErrors: [], removed: {} };
  for (const r of created.restores) {
    try {
      await r.run();
      report.restored.push(r.label);
    } catch (error) {
      report.restoreErrors.push(`${r.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (created.empty) return report;
  if (KEEP_DATA || !IS_LOCAL) {
    report.skipped = KEEP_DATA ? "E2E_KEEP_DATA=1" : "remote server";
    return report;
  }

  const emails = [...created.emails];
  const users = (await db.all<{ id: string }>(`SELECT id FROM "User" WHERE lower(email) = ANY($1) AND kind = 'CUSTOMER'`, [emails])).map((r) => r.id);
  // Business accounts whose every member is one of our users (never an account a seeded person belongs to).
  const accounts = (
    await db.all<{ id: string }>(
      `SELECT m."accountId" AS id FROM "AccountMember" m GROUP BY m."accountId" HAVING bool_and(m."userId" = ANY($1))`,
      [users],
    )
  ).map((r) => r.id);
  const orders = (
    await db.all<{ id: string }>(
      `SELECT id FROM "Order" WHERE id = ANY($1) OR lower(email) = ANY($2) OR "placedByUserId" = ANY($3) OR "accountId" = ANY($4)`,
      [[...created.orderIds], emails, users, accounts],
    )
  ).map((r) => r.id);
  const licenses = (
    await db.all<{ id: string }>(`SELECT id FROM "License" WHERE "orderId" = ANY($1) OR "accountId" = ANY($2)`, [orders, accounts])
  ).map((r) => r.id);
  const targets = [...orders, ...licenses, ...users, ...accounts];
  const patterns = orders.map((id) => `%${id}%`);
  const files: unknown[] = [];

  const removed = await db.transaction(async (q) => {
    const counts: Record<string, number> = {};
    const del = async (table: string, where: string, params: unknown[]) => {
      const n = (await q(`DELETE FROM "${table}" WHERE ${where}`, params)).rowCount ?? 0;
      if (n) counts[table] = (counts[table] ?? 0) + n;
    };
    await del("AuditLog", `id = ANY($1) OR "targetId" = ANY($2) OR "actorId" = ANY($3)`, [[...created.auditIds], targets, users]);
    await del("Notification", `"userId" = ANY($1) OR href LIKE ANY($2)`, [users, patterns]);
    await del("OutboxEmail", `lower("to") = ANY($1) OR "dedupeKey" LIKE ANY($2)`, [emails, patterns]);
    await del("AuthToken", `lower(email) = ANY($1) OR "userId" = ANY($2)`, [emails, users]);
    await del("DownloadEvent", `"licenseId" = ANY($1)`, [licenses]);
    await del("DeviceActivation", `"licenseId" = ANY($1)`, [licenses]);
    await del("LicenseEvent", `"licenseId" = ANY($1)`, [licenses]);
    await del("OrderItem", `"orderId" = ANY($1)`, [orders]);
    await del("Refund", `"paymentId" IN (SELECT id FROM "Payment" WHERE "orderId" = ANY($1))`, [orders]);
    for (const row of (await q(`SELECT "pdfKey" FROM "Invoice" WHERE "orderId" = ANY($1)`, [orders])).rows) files.push(row.pdfKey);
    await del("Invoice", `"orderId" = ANY($1)`, [orders]);
    await del("WebhookDelivery", `"orderId" = ANY($1)`, [orders]);
    await del("WebhookEvent", `"orderId" = ANY($1)`, [orders]);
    const redeemed = (await q(`DELETE FROM "CouponRedemption" WHERE "orderId" = ANY($1) RETURNING "couponCode"`, [orders])).rows;
    const perCode = new Map<string, number>();
    for (const r of redeemed as { couponCode: string }[]) perCode.set(r.couponCode, (perCode.get(r.couponCode) ?? 0) + 1);
    for (const [code, n] of perCode) await q(`UPDATE "Coupon" SET redemptions = GREATEST(redemptions - $2, 0) WHERE code = $1`, [code, n]);
    if (redeemed.length) counts.CouponRedemption = redeemed.length;
    await del("License", `id = ANY($1)`, [licenses]);
    await del("Payment", `"orderId" = ANY($1)`, [orders]);
    await del("Order", `id = ANY($1)`, [orders]);
    // Tickets and uploads of our accounts (none expected; they would block the account delete).
    for (const row of (await q(`SELECT "storageKey" FROM "Upload" WHERE "accountId" = ANY($1)`, [accounts])).rows) files.push(row.storageKey);
    await del("Upload", `"accountId" = ANY($1)`, [accounts]);
    await del("SupportTicket", `"accountId" = ANY($1)`, [accounts]);
    // Members, locations and activity cascade with the account; sessions and memberships with the user.
    await del("BusinessAccount", `id = ANY($1)`, [accounts]);
    await del("User", `id = ANY($1) AND kind = 'CUSTOMER'`, [users]);
    return counts;
  });
  for (const key of files) removeStored(key);
  report.removed = removed;
  return report;
}
