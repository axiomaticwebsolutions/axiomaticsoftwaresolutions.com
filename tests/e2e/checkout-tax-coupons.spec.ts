/**
 * Test plan E2E 2: an inter-state checkout (Karnataka; the business is in Maharashtra) shows IGST only; WELCOME10 is
 * applied (10% off, the summary follows the server's quote); the expired MONSOON25 shows its expiry message.
 * Nothing is paid, so no order is created.
 */
import { applyCoupon, fillCheckout, formatINR, orderSummary, setCart, type Quote } from "./support/checkout";
import { expect, test } from "./support/fixtures";
import { go } from "./support/guard";

test("inter-state checkout shows IGST, applies WELCOME10 and explains that MONSOON25 expired", async ({ page, tag, problems }) => {
  await test.step("an inter-state billing address gets IGST only", async () => {
    await setCart(page, [{ planId: "med-annual", qty: 1 }]);
    await go(page, "/checkout", problems);
    await fillCheckout(page, { email: `e2e-${tag}-quote@example.test`, state: "Karnataka", city: "Bengaluru", pin: "560001" });
    const summary = orderSummary(page);
    await expect(summary).toContainText("IGST 18%");
    await expect(summary).not.toContainText("CGST");
    await expect(summary).not.toContainText("SGST");
    await expect(page.getByText("Inter-state supply to Karnataka: IGST.")).toBeVisible();
  });

  await test.step("WELCOME10 takes 10% off and the summary shows the server's totals", async () => {
    const { status, body } = await applyCoupon(page, "WELCOME10");
    expect(status).toBe(200);
    const quote = body as Quote;
    expect(quote.coupon?.code).toBe("WELCOME10");
    expect(quote.discountPaise).toBe(Math.round(quote.subtotalPaise / 10));
    expect(quote.taxablePaise).toBe(quote.subtotalPaise - quote.discountPaise);
    // The page splits the quote's GST by the billing state (inter-state: all of it is IGST).
    const igst = Math.round((quote.taxablePaise * quote.gstRatePct) / 100);
    expect(quote.cgstPaise + quote.sgstPaise + quote.igstPaise).toBe(igst);

    await expect(page.getByRole("button", { name: "Remove coupon WELCOME10" })).toBeVisible();
    const summary = orderSummary(page);
    await expect(summary).toContainText("Discount");
    await expect(summary).toContainText(formatINR(quote.discountPaise));
    await expect(summary).toContainText(formatINR(igst));
    await expect(page.getByRole("button", { name: `Pay ${formatINR(quote.taxablePaise + igst)}` })).toBeVisible();
  });

  await test.step("the expired MONSOON25 shows when it expired", async () => {
    await page.getByRole("button", { name: "Remove coupon WELCOME10" }).click();
    await expect(page.locator("#checkout-coupon")).toBeVisible();
    await expect(orderSummary(page)).not.toContainText("Discount");
    await applyCoupon(page, "MONSOON25");
    const error = page.locator("#checkout-coupon-error");
    await expect(error).toHaveText(/^This code expired on .+\.$/);
    await expect(orderSummary(page)).not.toContainText("Discount");
  });
});
