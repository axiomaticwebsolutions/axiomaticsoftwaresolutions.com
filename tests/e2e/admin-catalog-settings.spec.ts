/**
 * Key admin journeys: the Administrator changes a plan's price and the storefront shows it (then puts it back); the
 * Owner changes a business setting and finds it in the audit log (then puts it back). Both register a fallback that
 * restores the shared record through the admin API if the journey stops early, and the audit rows they wrote are
 * removed afterwards.
 */
import type { Page } from "@playwright/test";
import { signInHttp, signOutHttp } from "./support/auth";
import { formatINR } from "./support/checkout";
import type { Db } from "./support/db";
import { PEOPLE } from "./support/env";
import { expect, test } from "./support/fixtures";
import { go } from "./support/guard";

/** General Store GST Billing, annual: a plan no other check script changes. */
const PLAN = { id: "gst-annual", productId: "general-store-gst" };

const auditIds = async (db: Db, targetId: string) =>
  new Set((await db.all<{ id: string }>(`SELECT id FROM "AuditLog" WHERE "targetId" = $1`, [targetId])).map((r) => r.id));

const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]", { hasText: text }).first();

test("Administrator changes a plan price and the storefront shows it", async ({ session, db, created, problems }) => {
  const plan = await db.one<{ pricePaise: number }>(`SELECT "pricePaise" FROM "Plan" WHERE id = $1`, [PLAN.id]);
  if (!plan) throw new Error(`seed plan ${PLAN.id} is missing (pnpm db:seed)`);
  const oldPaise = plan.pricePaise;
  const newPaise = (Math.floor(oldPaise / 100) + 12) * 100;
  const before = await auditIds(db, PLAN.id);
  created.restore(`price of ${PLAN.id}`, async () => {
    const now = await db.one<{ pricePaise: number }>(`SELECT "pricePaise" FROM "Plan" WHERE id = $1`, [PLAN.id]);
    if (now && now.pricePaise !== oldPaise) {
      const admin = await signInHttp(PEOPLE.admin());
      const res = await admin.api("PATCH", `/api/admin/plans/${PLAN.id}`, { pricePaise: oldPaise });
      await signOutHttp(admin);
      if (res.status !== 200) throw new Error(`PATCH /api/admin/plans/${PLAN.id} answered ${res.status}`);
    }
    for (const id of await auditIds(db, PLAN.id)) if (!before.has(id)) created.auditIds.add(id);
  });

  const admin = await session({ as: PEOPLE.admin() });
  const storefront = await session();
  const priceField = () => admin.page.getByRole("dialog").filter({ visible: true }).last().getByLabel("Price in ₹ (excl. GST)");
  const save = async (paise: number) => {
    await priceField().fill(String(paise / 100));
    await admin.page.getByRole("dialog").filter({ visible: true }).last().getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(toast(admin.page, "Changes saved")).toBeVisible();
    await expect.poll(async () => (await db.one<{ pricePaise: number }>(`SELECT "pricePaise" FROM "Plan" WHERE id = $1`, [PLAN.id]))?.pricePaise).toBe(paise);
  };
  /** The storefront product page (fresh request each time) shows `paise` as the plan's price. */
  const storefrontShows = async (paise: number) => {
    await go(storefront.page, `/software/${PLAN.productId}`, problems);
    return (await storefront.page.locator("main").innerText()).includes(formatINR(paise));
  };

  await test.step("the storefront shows the current price", async () => {
    expect(await storefrontShows(oldPaise)).toBe(true);
  });

  await test.step("the Administrator saves a new price in the plan drawer", async () => {
    await go(admin.page, `/admin/plans?id=${encodeURIComponent(PLAN.id)}`, problems);
    await expect(priceField()).toHaveValue(String(oldPaise / 100));
    await save(newPaise);
    const row = await db.one<{ action: string; detail: string }>(
      `SELECT action, detail FROM "AuditLog" WHERE "targetId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
      [PLAN.id],
    );
    expect(row?.action).toBe("Changed plan price");
    expect(row?.detail).toContain(`${formatINR(oldPaise)} → ${formatINR(newPaise)}`);
  });

  await test.step("the storefront shows the new price", async () => {
    await expect.poll(() => storefrontShows(newPaise), { timeout: 45_000, intervals: [1_000, 2_000, 3_000] }).toBe(true);
  });

  await test.step("the original price is restored and the storefront follows", async () => {
    await save(oldPaise);
    await expect.poll(() => storefrontShows(oldPaise), { timeout: 45_000, intervals: [1_000, 2_000, 3_000] }).toBe(true);
    expect(await storefrontShows(newPaise)).toBe(false);
  });
});

test("Owner changes a business setting and the audit log shows it", async ({ session, db, created, tag, problems }) => {
  const TARGET = "business.hours";
  const stored = await db.one<{ hours: string | null }>(`SELECT value->>'hours' AS hours FROM "SiteSetting" WHERE key = 'business'`);
  const before = await auditIds(db, TARGET);
  let original: string | null = stored?.hours ?? null;
  created.restore("business support hours", async () => {
    const now = await db.one<{ hours: string | null }>(`SELECT value->>'hours' AS hours FROM "SiteSetting" WHERE key = 'business'`);
    if (original !== null && now?.hours !== original) {
      const owner = await signInHttp(PEOPLE.owner());
      const res = await owner.api("PATCH", "/api/admin/settings/business", { hours: original });
      await signOutHttp(owner);
      if (res.status !== 200) throw new Error(`PATCH /api/admin/settings/business answered ${res.status}`);
    }
    for (const id of await auditIds(db, TARGET)) if (!before.has(id)) created.auditIds.add(id);
  });

  const owner = await session({ as: PEOPLE.owner() });
  const { page } = owner;
  const form = page.locator("#settings-business");
  const hours = form.getByLabel("Support hours");
  const changed = `Mon–Sat 9:30 am – 6:30 pm (e2e ${tag})`;

  await test.step("the Owner saves new support hours", async () => {
    await go(page, "/admin/settings", problems);
    await expect(hours).toBeVisible();
    original = await hours.inputValue();
    await hours.fill(changed);
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "saved")).toBeVisible();
    await expect
      .poll(async () => (await db.one<{ hours: string }>(`SELECT value->>'hours' AS hours FROM "SiteSetting" WHERE key = 'business'`))?.hours)
      .toBe(changed);
  });

  await test.step("the audit log lists the change with the old and new value", async () => {
    await go(page, "/admin/audit", problems);
    await page.getByRole("searchbox", { name: "Search the audit log" }).or(page.getByLabel("Search the audit log")).first().fill(tag);
    const row = page.locator("main table tbody tr", { hasText: tag });
    await expect(row.first()).toBeVisible();
    await expect(row.first()).toContainText("Updated settings");
    await expect(row.first()).toContainText("Support hours");
    await expect(row.first()).toContainText(`${original} → ${changed}`);
  });

  await test.step("the original hours are restored", async () => {
    await go(page, "/admin/settings", problems);
    await hours.fill(original ?? "");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "saved")).toBeVisible();
    await expect
      .poll(async () => (await db.one<{ hours: string }>(`SELECT value->>'hours' AS hours FROM "SiteSetting" WHERE key = 'business'`))?.hours)
      .toBe(original);
  });
});
