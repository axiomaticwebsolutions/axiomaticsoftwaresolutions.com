/**
 * Test plan E2E 5: role-based access in the admin console. Support opens Settings and gets the permission-denied
 * panel (the API refuses too). Finance refunds a customer's paid order with a reason and the typed order id: the
 * license is revoked and the customer's portal shows it as Revoked.
 */
import { registerCustomerHttp, throwawayPassword } from "./support/auth";
import { buyAsCustomer, waitForOrderStatus } from "./support/checkout";
import { poll } from "./support/db";
import { PEOPLE } from "./support/env";
import { expect, test } from "./support/fixtures";
import { go } from "./support/guard";

const DENIED = "You don’t have access to";

test("Support opens Settings and sees the permission-denied panel", async ({ session, problems }) => {
  const support = await session({ as: PEOPLE.support() });
  const { page } = support;

  await test.step("the Settings page shows the permission-denied panel", async () => {
    const res = await go(page, "/admin/settings", problems);
    expect(res?.status()).toBe(200);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(main).toContainText(DENIED);
    await expect(page.locator("#settings-business")).toHaveCount(0);
  });

  await test.step("the sidebar marks Settings as restricted", async () => {
    const settingsLink = page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: /^Settings/ });
    await expect(settingsLink).toContainText(", restricted");
  });

  await test.step("the settings API refuses Support (403)", async () => {
    if (!support.http) throw new Error("the Support session has no HTTP client");
    const res = await support.http.api("PATCH", "/api/admin/settings/business", { hours: "Never" });
    expect(res.status).toBe(403);
  });
});

test("Finance refunds a paid order and the customer's license shows Revoked in the portal", async ({
  page,
  context,
  session,
  db,
  created,
  tag,
  problems,
}) => {
  const email = created.email(`e2e-${tag}-refund@example.test`);
  const reason = `E2E ${tag}: customer cancelled within 7 days`;
  let orderId = "";
  let licenseId = "";

  await test.step("a customer buys a license", async () => {
    const client = await registerCustomerHttp({ email, name: "Meera Iyer", password: throwawayPassword(), businessName: "Iyer Medicals" });
    await client.exportTo(context);
    const bought = await buyAsCustomer(page, client, db, { email, problems });
    orderId = created.order(bought.orderId);
    licenseId = bought.licenseId;
    await go(page, `/account/licenses/${licenseId}`, problems);
    await expect(page.locator("main")).toContainText("Active");
  });

  const finance = await session({ as: PEOPLE.finance() });

  await test.step("Finance issues the refund with a reason and the typed order id", async () => {
    const fp = finance.page;
    await go(fp, `/admin/orders?id=${encodeURIComponent(orderId)}`, problems);
    const drawer = fp.getByRole("dialog").filter({ visible: true }).last();
    await drawer.getByRole("button", { name: "Issue refund", exact: true }).click();
    const confirm = fp.getByRole("alertdialog").filter({ visible: true }).last();
    await confirm.getByLabel("Reason (saved to the audit log)").fill(reason);
    await confirm.getByLabel(/^Type .+ to confirm$/).fill(orderId);
    await confirm.getByRole("button", { name: "Issue refund", exact: true }).click();
    await expect(fp.locator("[data-sonner-toast]", { hasText: "Refund issued" }).first()).toBeVisible();
    await expect(confirm).toBeHidden();
  });

  await test.step("the license is revoked and the order refunded", async () => {
    const revoked = await poll(async () => (await db.one<{ status: string }>(`SELECT status FROM "License" WHERE id = $1`, [licenseId]))?.status === "REVOKED");
    expect(revoked, "the refund revokes the license").toBe(true);
    expect(await waitForOrderStatus(db, orderId, "REFUNDED"), "refund.processed marks the order REFUNDED").not.toBeNull();
    const audit = await db.one<{ reason: string | null }>(
      `SELECT a.reason FROM "AuditLog" a JOIN "User" u ON u.id = a."actorId" WHERE a."targetId" = $1 AND u.email = $2 ORDER BY a."createdAt" DESC LIMIT 1`,
      [orderId, PEOPLE.finance().email],
    );
    expect(audit?.reason, "the audit row keeps the reason").toBe(reason);
  });

  await test.step("the customer's portal shows the license as Revoked", async () => {
    await go(page, `/account/licenses/${licenseId}`, problems);
    await expect(page.locator("main")).toContainText("Revoked");
    await go(page, "/account/licenses", problems);
    await expect(page.locator("main").getByText("Revoked").filter({ visible: true }).first()).toBeVisible();
  });
});
