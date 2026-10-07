/**
 * Test plan E2E 1: a guest buys Medical Store Billing (annual) with an intra-state GSTIN, the mock provider confirms
 * the payment, the order page shows the license with its key once, the buyer registers with the same email (code from
 * /dev/mailbox), and after verification the license is in their portal.
 */
import type { Page } from "@playwright/test";
import { throwawayPassword, VERIFICATION_CODE, waitForHydration } from "./support/auth";
import {
  cartItems,
  fillCheckout,
  GSTIN_MH,
  KEY_RE_SRC,
  mockOutcome,
  orderLicenses,
  orderRow,
  orderSummary,
  PAID_TITLE,
  pay,
} from "./support/checkout";
import { expect, test } from "./support/fixtures";
import { go } from "./support/guard";
import { mailIds, waitForCode } from "./support/mailbox";

/** Full license keys in the visible text (innerText skips the masked copy the key strip keeps for printing). */
const fullKeysShown = (page: Page) =>
  page.evaluate((src) => (document.body.innerText.match(new RegExp(src, "g")) ?? []).length, KEY_RE_SRC);

test("guest buys Medical Store Billing annual with a GSTIN, registers with the same email and finds the license in the portal", async ({
  page,
  db,
  created,
  tag,
  problems,
}) => {
  const email = created.email(`e2e-${tag}-guest@example.test`);
  let orderId = "";

  await test.step("the product page adds the annual plan to the cart", async () => {
    await go(page, "/software/medical-billing", problems);
    await waitForHydration(page, "main button");
    await page.getByRole("button", { name: /^Add to cart ?: ?Annual license$/ }).first().click();
    await expect.poll(async () => (await cartItems(page)).map((i) => i.planId)).toContain("med-annual");
  });

  await test.step("the cart lists it and continues to checkout", async () => {
    await go(page, "/cart", problems);
    await expect(page.locator("main").getByRole("link", { name: /Medical Store Billing/ }).first()).toBeVisible();
    await page.getByRole("link", { name: "Continue to checkout" }).click();
    await page.waitForURL(/\/checkout$/);
  });

  await test.step("a Maharashtra GSTIN makes it an intra-state supply (CGST + SGST)", async () => {
    await fillCheckout(page, { email, state: "Maharashtra", city: "Pune", pin: "411001", gstin: GSTIN_MH });
    await expect(page.getByText("Valid format · Maharashtra")).toBeVisible();
    const summary = orderSummary(page);
    await expect(summary).toContainText("CGST 9%");
    await expect(summary).toContainText("SGST 9%");
    await expect(summary).not.toContainText("IGST");
  });

  await test.step("the mock provider confirms the payment", async () => {
    await pay(page);
    orderId = created.order(await mockOutcome(page, /succeeds/));
    await expect(page.getByRole("heading", { level: 1, name: PAID_TITLE })).toBeVisible({ timeout: 60_000 });
  });

  await test.step("the order page shows the license and its full key once", async () => {
    await expect(page.locator("main h3", { hasText: "Medical Store Billing" })).toBeVisible();
    await expect.poll(() => fullKeysShown(page), { message: "the one full key is shown", timeout: 30_000 }).toBe(1);
    await expect(page.getByText("Shown once — save it now.")).toBeVisible();
    await expect.poll(async () => (await cartItems(page)).length, { message: "the paid cart is cleared" }).toBe(0);

    const row = await orderRow(db, orderId);
    expect(row?.status).toBe("PAID");
    expect(row?.accountId, "a guest order").toBeNull();
    expect(row?.cgstPaise).toBeGreaterThan(0);
    expect(row?.igstPaise).toBe(0);
    const licenses = await orderLicenses(db, orderId);
    expect(licenses).toHaveLength(1);
    expect(licenses[0]?.productId).toBe("medical-billing");
  });

  await test.step("after a reload the key stays masked", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: PAID_TITLE })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("For your security, the full key is shown only once.", { exact: false })).toBeVisible({ timeout: 30_000 });
    expect(await fullKeysShown(page), "no full key after a reload").toBe(0);
  });

  await test.step("the buyer registers with the order's email and verifies it with the emailed code", async () => {
    await page.getByRole("link", { name: "Create account" }).click();
    await page.waitForURL(/\/register\?/);
    await waitForHydration(page, "#register-email");
    await expect(page.locator("#register-email"), "register prefills the order email").toHaveValue(email);
    expect(decodeURIComponent(page.url()), "the email is not in the URL").not.toContain(email);
    await page.locator("#register-name").fill("Rahul Verma");
    await page.locator("#register-password").fill(throwawayPassword());
    const before = await mailIds();
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.waitForURL(/\/verify/, { timeout: 60_000 });
    const code = await waitForCode(email, VERIFICATION_CODE, before);
    await waitForHydration(page, "#verify-code");
    await page.locator("#verify-code").fill(code);
    await page.getByRole("button", { name: "Verify email" }).click();
    await page.waitForURL((url) => url.pathname === `/orders/${orderId}`, { timeout: 60_000 });
  });

  await test.step("the order and its license now belong to the new account and show in the portal", async () => {
    const me = await page.evaluate(async () => (await fetch("/api/me", { cache: "no-store" })).json());
    expect(me?.user?.email).toBe(email);
    expect(me?.user?.emailVerified).toBe(true);
    const accountId: string = me?.account?.id;
    expect(accountId).toBeTruthy();
    expect((await orderRow(db, orderId))?.accountId).toBe(accountId);
    const [license] = await orderLicenses(db, orderId);
    expect(license?.accountId).toBe(accountId);

    await go(page, "/account/licenses", problems);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(main).toContainText(license?.id ?? "missing license");
    await expect(main).toContainText("Medical Store Billing");
  });
});
