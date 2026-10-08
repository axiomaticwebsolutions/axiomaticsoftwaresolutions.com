import { describe, expect, it } from "vitest";
import {
  inspectOrderToken,
  orderEmailTag,
  orderStatusPath,
  orderTokenMatchesEmail,
  ORDER_TOKEN_TTL_MS,
  signOrderPayToken,
  signOrderToken,
  verifyOrderToken,
} from "@/lib/orders/token";

const secret = "test-order-token-secret-0123456789abcdef";
const other = "another-order-token-secret-0123456789abc";
const NOW = new Date("2026-10-07T06:30:00.000Z");
const email = "priya@sharmamedicals.example";

describe("order link tokens", () => {
  it("round-trips for the order and email they were signed for", () => {
    const token = signOrderToken("AX-10312", email, NOW, { secret });
    expect(token).toMatch(/^o1[.][0-9a-z]+[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{43}$/);
    expect(encodeURIComponent(token)).toBe(token);
    const payload = verifyOrderToken(token, "AX-10312", NOW, { secret, email });
    expect(payload).toMatchObject({ orderId: "AX-10312" });
    expect(payload?.expiresAt.getTime()).toBe(Math.floor((NOW.getTime() + ORDER_TOKEN_TTL_MS) / 1000) * 1000);
    expect(payload && orderTokenMatchesEmail(payload, " PRIYA@SharmaMedicals.example ", { secret })).toBe(true);
  });

  it("never contains the email", () => {
    const token = signOrderToken("AX-10312", email, NOW, { secret });
    expect(token.toLowerCase()).not.toContain("priya");
    expect(token).toContain(orderEmailTag(email, { secret }));
  });

  it("rejects other orders, other emails, other secrets and tampering", () => {
    const token = signOrderToken("AX-10312", email, NOW, { secret });
    expect(verifyOrderToken(token, "AX-10313", NOW, { secret })).toBeNull();
    expect(verifyOrderToken(token, "AX-10312", NOW, { secret: other })).toBeNull();
    expect(inspectOrderToken(token, "AX-10312", NOW, { secret, email: "someone@else.example" })).toEqual({ ok: false, reason: "invalid" });
    const [v, exp, tag, sig] = token.split(".") as [string, string, string, string];
    const longer = (parseInt(exp, 36) + 86_400).toString(36);
    expect(inspectOrderToken([v, longer, tag, sig].join("."), "AX-10312", NOW, { secret })).toEqual({ ok: false, reason: "invalid" });
    const otherTag = orderEmailTag("mallory@example.test", { secret });
    expect(inspectOrderToken([v, exp, otherTag, sig].join("."), "AX-10312", NOW, { secret })).toEqual({ ok: false, reason: "invalid" });
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyOrderToken([v, exp, tag, flipped].join("."), "AX-10312", NOW, { secret })).toBeNull();
  });

  it("reports malformed input without throwing", () => {
    for (const bad of [undefined, null, 42, "", "o1", "o1.a.b.c", "x".repeat(300), "o2.abc.AAAAAAAAAAAAAAAA." + "A".repeat(43)]) {
      expect(inspectOrderToken(bad, "AX-1", NOW, { secret })).toEqual({ ok: false, reason: "malformed" });
      expect(verifyOrderToken(bad, "AX-1", NOW, { secret })).toBeNull();
    }
  });

  it("expires after 30 days, and only says so for genuine tokens", () => {
    const token = signOrderToken("AX-10312", email, NOW, { secret });
    const justBefore = new Date(NOW.getTime() + ORDER_TOKEN_TTL_MS - 1000);
    const after = new Date(NOW.getTime() + ORDER_TOKEN_TTL_MS + 1000);
    expect(verifyOrderToken(token, "AX-10312", justBefore, { secret })).not.toBeNull();
    expect(inspectOrderToken(token, "AX-10312", after, { secret })).toEqual({ ok: false, reason: "expired" });
    expect(inspectOrderToken(token, "AX-10312", after, { secret: other })).toEqual({ ok: false, reason: "invalid" });
    const short = signOrderToken("AX-1", email, NOW, { secret, ttlMs: 60_000 });
    expect(verifyOrderToken(short, "AX-1", new Date(NOW.getTime() + 61_000), { secret })).toBeNull();
  });

  it("says which scope a token has: full order links and pay-only links (admin records review fix)", () => {
    const full = signOrderToken("AX-10312", email, NOW, { secret });
    expect(verifyOrderToken(full, "AX-10312", NOW, { secret, email })?.scope).toBe("full");
    const pay = signOrderPayToken("AX-10312", email, NOW, { secret });
    expect(pay).toMatch(/^p1[.][0-9a-z]+[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{43}$/);
    expect(verifyOrderToken(pay, "AX-10312", NOW, { secret, email })).toMatchObject({ orderId: "AX-10312", scope: "pay" });
    expect(signOrderToken("AX-10312", email, NOW, { secret, scope: "pay" })).toBe(pay);
  });

  it("never lets a pay-only link pass as a full one, or the reverse (separate signatures)", () => {
    const full = signOrderToken("AX-10312", email, NOW, { secret });
    const pay = signOrderPayToken("AX-10312", email, NOW, { secret });
    expect(pay.slice(2)).not.toBe(full.slice(2));
    expect(inspectOrderToken(`o1${pay.slice(2)}`, "AX-10312", NOW, { secret })).toEqual({ ok: false, reason: "invalid" });
    expect(inspectOrderToken(`p1${full.slice(2)}`, "AX-10312", NOW, { secret })).toEqual({ ok: false, reason: "invalid" });
    expect(verifyOrderToken(pay, "AX-10313", NOW, { secret })).toBeNull();
    expect(inspectOrderToken(pay, "AX-10312", NOW, { secret, email: "someone@else.example" })).toEqual({ ok: false, reason: "invalid" });
    expect(inspectOrderToken(pay, "AX-10312", new Date(NOW.getTime() + ORDER_TOKEN_TTL_MS + 1000), { secret })).toEqual({ ok: false, reason: "expired" });
  });

  it("builds the order page path", () => {
    expect(orderStatusPath("AX-10312", "o1.abc.def.ghi")).toBe("/orders/AX-10312?t=o1.abc.def.ghi");
  });
});
