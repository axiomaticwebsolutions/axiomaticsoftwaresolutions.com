/**
 * Confirms the automatic renewal reminders of GET /api/cron/renewals (lib/admin/renewals/remind.ts
 * sendScheduledRenewalReminders) over time: a daily run sends renewal_30 once (30 days before the end) and renewal_7
 * once (7 days before) to each active Owner and Billing admin, never twice, also when runs overlap, again for the next
 * term after a renewal, and still not twice after the maintenance job redacted the sent emails. The route's auth and
 * window rules are covered by tests/db/admin-renewals-routes.test.ts. Runs use a clock in 2001, so only this file's
 * licenses fall into the reminder windows.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renewalReminderPrefix } from "@/lib/admin/renewals/model";
import { sendScheduledRenewalReminders } from "@/lib/admin/renewals/remind";
import { db } from "@/lib/db";
import { runMaintenance } from "@/lib/jobs/maintenance";
import { DAY, makeCatalog, makeLicense, makeMember, type Catalog, type Member } from "./license-actions-fixtures";

const NOW = new Date("2001-03-01T04:00:00.000Z"); // 09:30 IST, the suggested cron time
const day = (d: number) => new Date(NOW.getTime() + d * DAY);

let catalog: Catalog;
let owner: Member;
let billing: Member;
let recipients: string[];

beforeAll(async () => {
  catalog = await makeCatalog();
  owner = await makeMember({ name: "Priya Sharma" });
  billing = await makeMember({ accountId: owner.accountId, role: "BILLING", name: "Rohan Mehta" });
  await makeMember({ accountId: owner.accountId, role: "TECHNICAL", name: "Kavya Iyer" });
  recipients = [owner.user.email, billing.user.email].sort();
});

const mails = (licenseId: string) =>
  db.outboxEmail.findMany({
    where: { dedupeKey: { startsWith: renewalReminderPrefix(licenseId) } },
    select: { id: true, templateId: true, to: true, dedupeKey: true, html: true },
    orderBy: { dedupeKey: "asc" },
  });
const recipientsOf = (rows: Array<{ templateId: string; to: string }>, templateId: string) =>
  rows.filter((r) => r.templateId === templateId).map((r) => r.to).sort();

describe("automatic renewal reminders", () => {
  it("a daily run sends renewal_30 at 30 days and renewal_7 at 7 days left, once each per recipient", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, expiresAt: day(35) });
    const firstSeen: Record<string, number> = {};
    for (let d = 0; d <= 36; d += 1) {
      await sendScheduledRenewalReminders({ now: day(d) });
      for (const m of await mails(license.id)) firstSeen[m.templateId] ??= d;
    }
    expect(firstSeen).toEqual({ renewal_30: 5, renewal_7: 28 });
    const rows = await mails(license.id);
    expect(rows).toHaveLength(4);
    expect(recipientsOf(rows, "renewal_30")).toEqual(recipients);
    expect(recipientsOf(rows, "renewal_7")).toEqual(recipients);
  });

  it("skips revoked, suspended, trial and perpetual licenses", async () => {
    const skipped = [
      await makeLicense(catalog, { accountId: owner.accountId, expiresAt: day(26), status: "REVOKED" }),
      await makeLicense(catalog, { accountId: owner.accountId, expiresAt: day(26), status: "SUSPENDED" }),
      await makeLicense(catalog, { accountId: owner.accountId, expiresAt: day(26), status: "TRIAL", plan: catalog.trial }),
      await makeLicense(catalog, { accountId: owner.accountId, expiresAt: null, plan: catalog.oneTime, updatesUntil: day(26) }),
    ];
    await sendScheduledRenewalReminders({ now: NOW });
    for (const { license } of skipped) expect(await mails(license.id)).toEqual([]);
  });

  it("overlapping runs never send twice", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, expiresAt: day(26) });
    await Promise.all([1, 2, 3].map(() => sendScheduledRenewalReminders({ now: NOW })));
    const rows = await mails(license.id);
    expect(rows).toHaveLength(2);
    expect(recipientsOf(rows, "renewal_30")).toEqual(recipients);
  });

  it("reminds again for the next term after a renewal", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, expiresAt: day(26) });
    await sendScheduledRenewalReminders({ now: NOW });
    expect(await mails(license.id)).toHaveLength(2);
    await db.license.update({ where: { id: license.id }, data: { expiresAt: day(26 + 365) } });
    await sendScheduledRenewalReminders({ now: day(365) });
    const rows = await mails(license.id);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.dedupeKey?.split(":")[3])).size).toBe(2); // exp-<old end>, exp-<new end>
  });

  it("does not send again after the maintenance job redacted the sent reminders", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, expiresAt: day(29) });
    await sendScheduledRenewalReminders({ now: NOW });
    const sent = await mails(license.id);
    expect(sent).toHaveLength(2);
    // Pretend they went out long ago, so the 30-day redaction applies at NOW.
    await db.outboxEmail.updateMany({ where: { id: { in: sent.map((m) => m.id) } }, data: { status: "SENT", sentAt: day(-31) } });
    const redaction = await runMaintenance({ now: NOW, tasks: ["emails"] });
    expect(redaction.emailsRedacted).toBeGreaterThanOrEqual(2);
    for (const m of await mails(license.id)) expect(m.html).toBe("");

    await sendScheduledRenewalReminders({ now: day(1) });
    const after = await mails(license.id);
    expect(after.map((m) => m.dedupeKey)).toEqual(sent.map((m) => m.dedupeKey));
  });
});
