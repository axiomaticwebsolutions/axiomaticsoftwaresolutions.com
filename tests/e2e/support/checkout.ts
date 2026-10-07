/**
 * Cart, checkout, mock payment and order helpers (techniques of scripts/check-purchase.mjs and check-admin.mjs).
 * The dev server runs PAYMENT_PROVIDER=mock: /dev/mock-checkout stands in for the provider's hosted page and its
 * buttons simulate the outcome; signed webhooks follow ~0.6-1.5 s later (lib/payments/mock-delivery.ts).
 */
import { expect, type Page } from "@playwright/test";
import { waitForHydration } from "./auth";
import type { Db } from "./db";
import { poll } from "./db";
import { go, type Problems } from "./guard";
import { errorCode, type HttpClient } from "./http";

export const CART_KEY = "axiomatic.cart";
export const PAID_TITLE = "Payment confirmed — your software is ready";
export const GSTIN_MH = "27ABCDE1234F1Z5";
/** License keys (lib/licensing/key.ts): product code + four groups without ambiguous characters. */
export const KEY_RE_SRC = /\b[A-Z]{3}(?:-[A-HJ-NP-Z2-9]{4}){4}\b/.source;

export type CartItem = { planId: string; qty: number; kind?: string; targetLicenseId?: string | null; maxQty?: number };

/** Indian-format rupees as lib/money.ts formatINR prints them (whole rupees without decimals). */
export function formatINR(paise: number): string {
  const abs = Math.abs(paise);
  const digits = abs % 100 === 0 ? 0 : 2;
  const body = (abs / 100).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${paise < 0 ? "-" : ""}₹${body}`;
}

/** Replaces the cart in localStorage (as the cart store writes it). */
export async function setCart(page: Page, items: CartItem[]): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ([key, list]) =>
      localStorage.setItem(key, JSON.stringify({ v: 1, items: list.map((i) => ({ maxQty: 1, kind: "NEW", targetLicenseId: null, ...i })) })),
    [CART_KEY, items] as const,
  );
}

export async function cartItems(page: Page): Promise<CartItem[]> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), CART_KEY);
  try {
    return (JSON.parse(raw ?? "null") as { items?: CartItem[] } | null)?.items ?? [];
  } catch {
    return [];
  }
}

export type BillingInput = { name?: string; email: string; state: string; city: string; pin: string; gstin?: string };

/** Fills the guest checkout form (after React hydrated it). */
export async function fillCheckout(page: Page, billing: BillingInput): Promise<void> {
  await waitForHydration(page, "#checkout-name");
  await page.locator("#checkout-name").fill(billing.name ?? "Rahul Verma");
  await page.locator("#checkout-email").fill(billing.email);
  await page.locator("#checkout-phone").fill("9820012345");
  await page.locator("#checkout-business").fill("Verma Medicals");
  await page.locator("#checkout-address").fill("12 MG Road");
  await page.locator("#checkout-city").fill(billing.city);
  await page.locator("#checkout-pin").fill(billing.pin);
  await page.locator("#checkout-state").selectOption(billing.state);
  if (billing.gstin) {
    await page.locator("#checkout-has-gstin").click();
    await page.locator("#checkout-gstin").fill(billing.gstin);
  }
}

export type Quote = {
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  gstRatePct: number;
  coupon: { code: string } | null;
};

/** Types a coupon and presses Apply; resolves to the quote response (status and body). */
export async function applyCoupon(page: Page, code: string): Promise<{ status: number; body: unknown }> {
  await page.locator("#checkout-coupon").fill(code);
  const quote = page.waitForResponse((r) => r.url().endsWith("/api/checkout/quote") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const res = await quote;
  return { status: res.status(), body: await res.json().catch(() => null) };
}

export const orderSummary = (page: Page) => page.locator("aside[aria-label='Order summary']");

/** Agrees to the terms and presses Pay; resolves on the mock checkout page. */
export async function pay(page: Page): Promise<void> {
  await page.locator("#checkout-agree").click();
  await page.getByRole("button", { name: /^Pay / }).click();
  await page.waitForURL(/\/dev\/mock-checkout/, { timeout: 60_000 });
  await waitForMockCheckout(page);
}

/** The mock checkout page is open with its outcome buttons ready. */
export async function waitForMockCheckout(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /succeeds/ })).toBeVisible({ timeout: 60_000 });
  await waitForHydration(page, "main button");
}

/** Picks an outcome on the mock checkout page; resolves to the order id once the order page opened. */
export async function mockOutcome(page: Page, name: string | RegExp): Promise<string> {
  await page.getByRole("button", { name }).click();
  await page.waitForURL(/\/orders\/AX-/, { timeout: 60_000 });
  return decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
}

export type OrderStart = { orderId: string; orderToken: string; statusUrl: string; checkout: { kind: string; url: string } };

/**
 * Places an order through POST /api/checkout/orders as `client` (guest or signed in): one Medical Store Billing
 * annual license by default. Throws with the API's error code when refused.
 */
export async function createOrderHttp(
  client: HttpClient,
  {
    email,
    planId = "med-annual",
    state = "Maharashtra",
    city = "Pune",
    pin = "411001",
    name = "Rahul Verma",
    business = "Verma Medicals",
  }: { email: string; planId?: string; state?: string; city?: string; pin?: string; name?: string; business?: string },
): Promise<OrderStart> {
  const res = await client.api<OrderStart>("POST", "/api/checkout/orders", {
    items: [{ planId, qty: 1 }],
    billing: { name, email, phone: "9820012345", business, address: "12 MG Road", city, state, pin },
    acceptTerms: true,
  });
  if (res.status !== 201 || !res.body?.orderId) throw new Error(`order creation answered ${res.status} ${errorCode(res.body)}`);
  return res.body;
}

export type OrderRow = { id: string; status: string; accountId: string | null; couponCode: string | null; igstPaise: number; cgstPaise: number };

export const orderRow = (db: Db, id: string) =>
  db.one<OrderRow>(`SELECT id, status, "accountId", "couponCode", "igstPaise", "cgstPaise" FROM "Order" WHERE id = $1`, [id]);

/** Waits until the order reaches `status` (webhooks are asynchronous). */
export async function waitForOrderStatus(db: Db, id: string, status: string, timeoutMs = 60_000): Promise<OrderRow | null> {
  return poll(async () => {
    const row = await orderRow(db, id);
    return row?.status === status ? row : null;
  }, { timeoutMs });
}

export type LicenseRow = { id: string; status: string; accountId: string | null; productId: string; deviceLimit: number };

export const orderLicenses = (db: Db, orderId: string) =>
  db.all<LicenseRow>(`SELECT id, status, "accountId", "productId", "deviceLimit" FROM "License" WHERE "orderId" = $1 ORDER BY id`, [orderId]);

/**
 * A signed-in customer buys one license: the order through the API, the payment on the mock checkout page in
 * `page` (which carries the customer's session), success. Resolves once the order is PAID and its license exists.
 */
export async function buyAsCustomer(
  page: Page,
  client: HttpClient,
  db: Db,
  opts: { email: string; planId?: string; problems?: Problems },
): Promise<{ orderId: string; licenseId: string }> {
  const start = await createOrderHttp(client, { email: opts.email, planId: opts.planId });
  await go(page, start.checkout.url, opts.problems);
  await waitForMockCheckout(page);
  await mockOutcome(page, /succeeds/);
  const paid = await waitForOrderStatus(db, start.orderId, "PAID");
  if (!paid) throw new Error(`${start.orderId} did not reach PAID (mock webhook)`);
  const license = await poll(async () => (await orderLicenses(db, start.orderId))[0] ?? null, { timeoutMs: 30_000 });
  if (!license) throw new Error(`${start.orderId} issued no license`);
  return { orderId: start.orderId, licenseId: license.id };
}
