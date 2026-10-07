/**
 * Test plan E2E 3: a payment the bank keeps pending is confirmed later and the license is issued; a failed payment
 * keeps the cart, "Try again" pays the same order and only then is the cart cleared.
 */
import {
  cartItems,
  createOrderHttp,
  fillCheckout,
  mockOutcome,
  orderLicenses,
  orderRow,
  PAID_TITLE,
  pay,
  setCart,
  waitForMockCheckout,
  waitForOrderStatus,
} from "./support/checkout";
import { expect, test } from "./support/fixtures";
import { go } from "./support/guard";
import { HttpClient } from "./support/http";

test("pending payment: the bank confirms later and the license is issued", async ({ page, db, created, tag, problems }) => {
  const email = created.email(`e2e-${tag}-pending@example.test`);
  let orderId = "";

  await test.step("the guest pays and the bank keeps the payment pending", async () => {
    const start = await createOrderHttp(new HttpClient(), { email, state: "Karnataka", city: "Bengaluru", pin: "560001" });
    orderId = created.order(start.orderId);
    await go(page, start.checkout.url, problems);
    await waitForMockCheckout(page);
    expect(await mockOutcome(page, "Bank pending")).toBe(orderId);
    await expect(page.getByRole("heading", { level: 1, name: "Payment pending with your bank" })).toBeVisible({ timeout: 60_000 });
    expect((await orderRow(db, orderId))?.status).toBe("PENDING");
    expect(await orderLicenses(db, orderId), "no license while the payment is pending").toHaveLength(0);
  });

  await test.step("the bank confirms: the order is paid and the license issued", async () => {
    await page.getByRole("button", { name: "confirm payment" }).click();
    await expect(page.getByRole("heading", { level: 1, name: PAID_TITLE })).toBeVisible({ timeout: 60_000 });
    expect(await waitForOrderStatus(db, orderId, "PAID")).not.toBeNull();
    const licenses = await orderLicenses(db, orderId);
    expect(licenses).toHaveLength(1);
    expect(licenses[0]?.status).toBe("ACTIVE");
    await expect(page.locator("main h3", { hasText: "Medical Store Billing" })).toBeVisible();
  });
});

test("failed payment: try again keeps the cart and pays the same order", async ({ page, db, created, tag, problems }) => {
  const email = created.email(`e2e-${tag}-retry@example.test`);
  let orderId = "";

  await test.step("the payment fails and the cart is kept", async () => {
    await setCart(page, [{ planId: "med-annual", qty: 1 }]);
    await go(page, "/checkout", problems);
    await fillCheckout(page, { email, state: "Maharashtra", city: "Pune", pin: "411001" });
    await pay(page);
    orderId = created.order(await mockOutcome(page, "Payment fails"));
    await expect(page.getByRole("heading", { level: 1, name: "Payment failed" })).toBeVisible({ timeout: 60_000 });
    expect((await cartItems(page)).map((i) => i.planId), "the cart is kept").toContain("med-annual");
    expect(await waitForOrderStatus(db, orderId, "FAILED")).not.toBeNull();
  });

  await test.step("try again opens the payment for the same order; success issues the license", async () => {
    await page.getByRole("button", { name: "Try again" }).click();
    await page.waitForURL(/\/dev\/mock-checkout/, { timeout: 60_000 });
    await waitForMockCheckout(page);
    expect(await mockOutcome(page, /succeeds/), "the retry pays the same order").toBe(orderId);
    await expect(page.getByRole("heading", { level: 1, name: PAID_TITLE })).toBeVisible({ timeout: 60_000 });
    expect(await waitForOrderStatus(db, orderId, "PAID")).not.toBeNull();
    expect(await orderLicenses(db, orderId)).toHaveLength(1);
    await expect.poll(async () => (await cartItems(page)).length, { message: "the cart is cleared once paid" }).toBe(0);
  });
});
