/**
 * Order link tokens (docs/decisions.md 1 and Phase 3 "Order access"): a stateless HMAC with ORDER_TOKEN_SECRET over
 * the order id, the order email and an expiry (30 days). Guests reach their order page, invoice and one-time key
 * delivery with it (`?t=`); it is included in the payment return URL and in order emails.
 *
 * Format: "o1.<exp>.<emailTag>.<sig>", URL-safe without encoding.
 * - exp: expiry in Unix seconds, base 36.
 * - emailTag: 16 characters of HMAC(secret, "order-email:" + email). The email never appears in the URL, yet the
 *   token is bound to it: verifiers that know the order email check the tag as well.
 * - sig: base64url HMAC-SHA256(secret, "order-link:o1:<orderId>:<emailTag>:<exp>").
 * Comparisons are constant-time. Tokens are never logged (the logger strips query strings and "token" fields).
 *
 * Pay-only links (admin records, staff-shared payment links): "p1.<exp>.<emailTag>.<sig>" with
 * sig = HMAC(secret, "order-pay:p1:<orderId>:<emailTag>:<exp>"). They open the order page, its invoice and "Pay now"
 * like an order link, but never deliver the one-time license key (lib/orders/access.ts: not the purchaser), so a staff
 * member who copied the link cannot see the key after the customer pays. The customer gets the key from the
 * order_confirmation email (a full link signed at payment time) or reveals it in their account.
 */
import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/auth/tokens";
import { DAY_MS } from "@/lib/dates";
import { getEnv } from "@/lib/env";

export const ORDER_TOKEN_TTL_MS = 30 * DAY_MS;
export const ORDER_TOKEN_VERSION = "o1";
/** Prefix of pay-only links (staff-shared payment links; never deliver the license key). */
export const ORDER_PAY_TOKEN_VERSION = "p1";

/** "full": the order link (guests, emails, checkout). "pay": a staff-shared payment link (no key delivery). */
export type OrderTokenScope = "full" | "pay";

const MAX_TOKEN_LENGTH = 256;
const TOKEN_RE = /^(o1|p1)[.]([0-9a-z]{1,12})[.]([A-Za-z0-9_-]{16})[.]([A-Za-z0-9_-]{43})$/;

export type OrderTokenOptions = {
  /** Defaults to ORDER_TOKEN_SECRET from the env. */
  secret?: string;
};

function secretOf(opts?: OrderTokenOptions): string {
  return opts?.secret ?? getEnv().ORDER_TOKEN_SECRET;
}

function mac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}

function signature(secret: string, orderId: string, emailTag: string, expPart: string, scope: OrderTokenScope): string {
  return scope === "pay"
    ? mac(secret, `order-pay:${ORDER_PAY_TOKEN_VERSION}:${orderId}:${emailTag}:${expPart}`)
    : mac(secret, `order-link:${ORDER_TOKEN_VERSION}:${orderId}:${emailTag}:${expPart}`);
}

/** The email binding carried in a token (16 base64url characters). */
export function orderEmailTag(email: string, opts?: OrderTokenOptions): string {
  return mac(secretOf(opts), `order-email:${email.trim().toLowerCase()}`).slice(0, 16);
}

/**
 * A link token for `orderId`, valid for 30 days from `now` (`ttlMs` overrides it, for tests). `scope: "pay"` signs a
 * pay-only link (signOrderPayToken).
 */
export function signOrderToken(
  orderId: string,
  email: string,
  now: Date = new Date(),
  opts: OrderTokenOptions & { ttlMs?: number; scope?: OrderTokenScope } = {},
): string {
  if (typeof orderId !== "string" || orderId.length === 0) throw new RangeError("An order id is required.");
  const secret = secretOf(opts);
  const scope = opts.scope ?? "full";
  const exp = Math.floor((now.getTime() + (opts.ttlMs ?? ORDER_TOKEN_TTL_MS)) / 1000);
  if (!Number.isSafeInteger(exp) || exp <= 0) throw new RangeError("Invalid order token expiry.");
  const expPart = exp.toString(36);
  const emailTag = orderEmailTag(email, { secret });
  const version = scope === "pay" ? ORDER_PAY_TOKEN_VERSION : ORDER_TOKEN_VERSION;
  return `${version}.${expPart}.${emailTag}.${signature(secret, orderId, emailTag, expPart, scope)}`;
}

/** A pay-only link token (staff-shared payment links): order page and "Pay now", never the one-time key view. */
export function signOrderPayToken(orderId: string, email: string, now: Date = new Date(), opts: OrderTokenOptions & { ttlMs?: number } = {}): string {
  return signOrderToken(orderId, email, now, { ...opts, scope: "pay" });
}

export type OrderTokenPayload = { orderId: string; expiresAt: Date; emailTag: string; scope: OrderTokenScope };

export type OrderTokenInspection =
  | { ok: true; payload: OrderTokenPayload }
  | { ok: false; reason: "malformed" | "invalid" | "expired" };

/**
 * Checks a token for `orderId` and says why it fails. `expired` is only reported for a genuine token (the
 * signature is checked first), so it never confirms anything about forged input. With `email`, the email binding
 * must match too ("invalid" otherwise).
 */
export function inspectOrderToken(
  token: unknown,
  orderId: string,
  now: Date = new Date(),
  opts: OrderTokenOptions & { email?: string } = {},
): OrderTokenInspection {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const m = TOKEN_RE.exec(token.trim());
  if (!m) return { ok: false, reason: "malformed" };
  const [, version = "", expPart = "", emailTag = "", sig = ""] = m;
  const scope: OrderTokenScope = version === ORDER_PAY_TOKEN_VERSION ? "pay" : "full";
  const secret = secretOf(opts);
  if (!safeEqual(sig, signature(secret, orderId, emailTag, expPart, scope))) return { ok: false, reason: "invalid" };
  if (opts.email !== undefined && !safeEqual(emailTag, orderEmailTag(opts.email, { secret }))) {
    return { ok: false, reason: "invalid" };
  }
  const exp = parseInt(expPart, 36);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: "malformed" };
  const expiresAt = new Date(exp * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, payload: { orderId, expiresAt, emailTag, scope } };
}

/**
 * The payload of a valid, unexpired token for `orderId`, or null. Pass `email` (the order's email) to check the
 * email binding as well. Returns null rather than a result object so `if (!verifyOrderToken(...))` is always safe.
 */
export function verifyOrderToken(
  token: unknown,
  orderId: string,
  now: Date = new Date(),
  opts: OrderTokenOptions & { email?: string } = {},
): OrderTokenPayload | null {
  const result = inspectOrderToken(token, orderId, now, opts);
  return result.ok ? result.payload : null;
}

/** Whether a verified token is bound to `email` (constant time). */
export function orderTokenMatchesEmail(payload: OrderTokenPayload, email: string, opts?: OrderTokenOptions): boolean {
  return safeEqual(payload.emailTag, orderEmailTag(email, opts));
}

/** The customer-facing order page for an order, with its link token: "/orders/AX-10312?t=...". */
export function orderStatusPath(orderId: string, token: string): string {
  return `/orders/${encodeURIComponent(orderId)}?t=${encodeURIComponent(token)}`;
}
