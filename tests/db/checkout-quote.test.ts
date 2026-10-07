import { beforeAll, describe, expect, it } from "vitest";
import { createSession } from "@/lib/auth/sessions";
import { priceCart, toQuoteDto, type QuoteDto } from "@/lib/checkout/quote";
import { belowActiveDevicesMessage, LINE_MESSAGES } from "@/lib/checkout/lines";
import { db } from "@/lib/db";
import { COUPON_MESSAGES } from "@/lib/pricing";
import type { CheckoutItem } from "@/lib/validation/checkout";
import {
  buyerOf,
  existingLicense,
  makeCoupon,
  makeCustomer,
  makeStaff,
  seedCatalog,
  type CatalogFixture,
  type CustomerFixture,
  uniq,
} from "./checkout-fixtures";

let cat: CatalogFixture;
let owner: CustomerFixture;

beforeAll(async () => {
  cat = await seedCatalog();
  owner = await makeCustomer({ role: "OWNER" });
});

async function quoteFor(
  who: { user: CustomerFixture["user"]; session: CustomerFixture["session"] } | null,
  items: CheckoutItem[],
  extra: { couponCode?: string | null; billingState?: string | null } = {},
): Promise<QuoteDto> {
  const buyer = await buyerOf(who);
  return toQuoteDto(await priceCart(db, { items, ...extra }, buyer, new Date()));
}

describe("quote: pricing from server data", () => {
  it("prices NEW lines for a guest with intra-state GST when no state is chosen", async () => {
    const q = await quoteFor(null, [
      { planId: cat.plans.annual.id, qty: 1 },
      { planId: cat.plans.perUnit.id, qty: 3 },
    ]);
    expect(q.issues).toEqual([]);
    expect(q.lines.map((l) => [l.planId, l.qty, l.amountPaise, l.label])).toEqual([
      [cat.plans.annual.id, 1, 499_900, "Annual license"],
      [cat.plans.perUnit.id, 3, 899_700, "Per-terminal license × 3"],
    ]);
    expect(q.subtotalPaise).toBe(1_399_600);
    expect(q.taxablePaise).toBe(1_399_600);
    const gst = Math.round(1_399_600 * 0.18);
    expect(q.cgstPaise + q.sgstPaise).toBe(gst);
    expect(q.igstPaise).toBe(0);
    expect(q.totalPaise).toBe(1_399_600 + gst);
    expect(q.intraState).toBe(true);
    expect(q.companyState).toBe("Maharashtra");
    expect(q.gstRatePct).toBe(18);
    expect(q.coupon).toBeNull();
    expect(q.lines.reduce((s, l) => s + l.taxPaise, 0)).toBe(gst);
    expect(q.lines[0]).toMatchObject({ productId: cat.productId, planName: "Annual license", planType: "ANNUAL", kind: "NEW" });
  });

  it("charges IGST for another billing state", async () => {
    const q = await quoteFor(null, [{ planId: cat.plans.annual.id, qty: 1 }], { billingState: "Karnataka" });
    expect(q.intraState).toBe(false);
    expect(q.cgstPaise).toBe(0);
    expect(q.sgstPaise).toBe(0);
    expect(q.igstPaise).toBe(Math.round(499_900 * 0.18));
  });

  it("ignores client quantities above the plan maximum and single-seat quantities", async () => {
    const q = await quoteFor(null, [
      { planId: cat.plans.annual.id, qty: 5 },
      { planId: cat.plans.perUnit.id, qty: 50 },
    ]);
    expect(q.lines.map((l) => l.qty)).toEqual([1, 10]);
  });

  it("applies a valid coupon and allocates the discount to lines", async () => {
    const code = await makeCoupon({ type: "PERCENT", value: 10, minSubtotal: 200_000 });
    const q = await quoteFor(null, [{ planId: cat.plans.annual.id, qty: 1 }, { planId: cat.plans.oneTime.id, qty: 1 }], { couponCode: code.toLowerCase() });
    expect(q.coupon).toMatchObject({ ok: true, code, discountPaise: Math.round(1_799_800 * 0.1) });
    expect(q.discountPaise).toBe(Math.round(1_799_800 * 0.1));
    expect(q.lines.reduce((s, l) => s + l.discountPaise, 0)).toBe(q.discountPaise);
    expect(q.taxablePaise).toBe(q.subtotalPaise - q.discountPaise);
  });

  it("reports unknown, paused and expired coupons without a discount or a failure reason", async () => {
    const paused = await makeCoupon({ type: "FLAT", value: 50_000, active: false });
    const expired = await makeCoupon({ type: "FLAT", value: 50_000, startsAt: new Date("2026-01-01"), endsAt: new Date("2026-08-31T18:29:59Z") });
    const line = [{ planId: cat.plans.annual.id, qty: 1 }];
    const unknown = await quoteFor(null, line, { couponCode: "NOPE-NOT-A-CODE" });
    expect(unknown.coupon).toEqual({ ok: false, code: "NOPE-NOT-A-CODE", message: COUPON_MESSAGES.invalid });
    const p = await quoteFor(null, line, { couponCode: paused });
    expect(p.coupon).toEqual({ ok: false, code: paused, message: COUPON_MESSAGES.invalid });
    const e = await quoteFor(null, line, { couponCode: expired });
    expect(e.coupon).toMatchObject({ ok: false, message: "This code expired on 31 Aug 2026." });
    expect(e.discountPaise).toBe(0);
  });
});

describe("quote: line rules", () => {
  it("drops and reports lines that cannot be bought, and still prices the rest", async () => {
    const q = await quoteFor(null, [
      { planId: "no-such-plan", qty: 1 },
      { planId: cat.plans.trial.id, qty: 1 },
      { planId: cat.plans.archived.id, qty: 1 },
      { planId: cat.plans.hiddenAnnual.id, qty: 1 },
      { planId: cat.plans.addon.id, qty: 1 },
      { planId: cat.plans.annual.id, qty: 1 },
    ]);
    expect(q.issues.map((i) => [i.index, i.code])).toEqual([
      [0, "unknown_plan"],
      [1, "trial_not_purchasable"],
      [2, "archived_plan"],
      [3, "unavailable"],
      [4, "invalid_item_kind"],
    ]);
    expect(q.lines.map((l) => l.planId)).toEqual([cat.plans.annual.id]);
    expect(q.subtotalPaise).toBe(499_900);
  });

  it("lets guests and staff buy NEW items only", async () => {
    const license = await existingLicense(cat.plans.annual, owner.accountId);
    const items: CheckoutItem[] = [{ planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: license.id }];
    const guest = await quoteFor(null, items);
    expect(guest.issues).toMatchObject([{ code: "sign_in_required", message: LINE_MESSAGES.signInRequired }]);
    const staff = await makeStaff();
    expect((await quoteFor(staff, items)).issues[0]).toMatchObject({ code: "not_allowed", message: LINE_MESSAGES.staff });
    expect(guest.lines).toEqual([]);
    const loner = await db.user.create({ data: { kind: "CUSTOMER", email: `${uniq("loner")}@example.test`, name: "Loner" } });
    const { session } = await createSession(db, { userId: loner.id, kind: "CUSTOMER" });
    expect((await quoteFor({ user: loner, session }, items)).issues[0]).toMatchObject({ code: "no_account", message: LINE_MESSAGES.noAccount });
  });

  it("accepts a renewal of the member's own license, also on an archived plan", async () => {
    const license = await existingLicense(cat.plans.annual, owner.accountId);
    const archivedLicense = await existingLicense(cat.plans.archived, owner.accountId);
    const q = await quoteFor(owner, [
      { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: license.id },
      { planId: cat.plans.archived.id, qty: 1, kind: "RENEWAL", targetLicenseId: archivedLicense.id },
    ]);
    expect(q.issues).toEqual([]);
    expect(q.lines.map((l) => [l.kind, l.targetLicenseId, l.label])).toEqual([
      ["RENEWAL", license.id, `Renewal of ${license.id}`],
      ["RENEWAL", archivedLicense.id, `Renewal of ${archivedLicense.id}`],
    ]);
  });

  it("never prices another account's license (IDOR) and checks product and status", async () => {
    const stranger = await makeCustomer({ role: "OWNER" });
    const theirs = await existingLicense(cat.plans.annual, stranger.accountId);
    const guestLicense = await existingLicense(cat.plans.annual, null);
    const mine = await existingLicense(cat.plans.annual, owner.accountId);
    const revoked = await existingLicense(cat.plans.annual, owner.accountId);
    await db.license.update({ where: { id: revoked.id }, data: { status: "REVOKED", revokedAt: new Date() } });
    const q = await quoteFor(owner, [
      { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: theirs.id },
      { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: guestLicense.id },
      { planId: cat.plans.otherAnnual.id, qty: 1, kind: "RENEWAL", targetLicenseId: mine.id },
      { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: revoked.id },
      { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: "LIC-0" },
    ]);
    expect(q.issues.map((i) => i.code)).toEqual([
      "target_not_found",
      "target_not_found",
      "target_wrong_product",
      "target_revoked",
      "target_not_found",
    ]);
    expect(q.lines).toEqual([]);
  });

  it("applies trial vs paid rules", async () => {
    const trial = await existingLicense(cat.plans.trial, owner.accountId, { status: "TRIAL" });
    const annual = await existingLicense(cat.plans.annual, owner.accountId);
    const perpetual = await existingLicense(cat.plans.oneTime, owner.accountId);
    const q = await quoteFor(owner, [
      { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: trial.id },
      { planId: cat.plans.addon.id, qty: 2, kind: "ADDON", targetLicenseId: trial.id },
      { planId: cat.plans.amc.id, qty: 1, kind: "RENEWAL", targetLicenseId: annual.id },
      { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: perpetual.id },
      { planId: cat.plans.annual.id, qty: 1, kind: "UPGRADE", targetLicenseId: annual.id },
    ]);
    expect(q.issues.map((i) => [i.code, i.message])).toEqual([
      ["trial_needs_upgrade", LINE_MESSAGES.trialRenewal],
      ["trial_needs_upgrade", LINE_MESSAGES.trialAddon],
      ["not_renewable", LINE_MESSAGES.maintenanceNeedsPerpetual],
      ["not_renewable", LINE_MESSAGES.perpetualNeedsMaintenance],
      ["unsupported_upgrade", LINE_MESSAGES.unsupportedUpgrade],
    ]);

    const ok = await quoteFor(owner, [
      { planId: cat.plans.annual.id, qty: 1, kind: "UPGRADE", targetLicenseId: trial.id },
      { planId: cat.plans.oneTime.id, qty: 1, kind: "UPGRADE", targetLicenseId: annual.id },
      { planId: cat.plans.amc.id, qty: 1, kind: "RENEWAL", targetLicenseId: perpetual.id },
      { planId: cat.plans.addon.id, qty: 2, kind: "ADDON", targetLicenseId: perpetual.id },
    ]);
    expect(ok.issues).toEqual([]);
    expect(ok.lines.map((l) => l.label)).toEqual([
      `Upgrade of ${trial.id}`,
      `Upgrade of ${annual.id}`,
      `Renewal of ${perpetual.id}`,
      `Add-on for ${perpetual.id}`,
    ]);
  });

  it("refuses a per-unit renewal for fewer terminals than the license has active computers", async () => {
    const license = await existingLicense(cat.plans.perUnit, owner.accountId);
    await db.license.update({ where: { id: license.id }, data: { deviceLimit: 3 } });
    for (const name of ["Counter 1", "Counter 2", "Counter 3"]) {
      await db.deviceActivation.create({ data: { licenseId: license.id, fingerprint: uniq("fp"), name, os: "Windows 11" } });
    }
    const renew = (qty: number): CheckoutItem[] => [{ planId: cat.plans.perUnit.id, qty, kind: "RENEWAL", targetLicenseId: license.id }];

    const below = await quoteFor(owner, renew(2));
    expect(below.issues).toEqual([
      expect.objectContaining({
        index: 0,
        code: "below_active_devices",
        message: "This license has 3 active computers. Choose at least 3 terminals, or deactivate computers first.",
      }),
    ]);
    expect(below.issues[0]?.message).toBe(belowActiveDevicesMessage(3, "terminal"));
    // More active computers than the plan can sell (maxQty 10, e.g. after add-ons): only deactivating helps.
    expect(belowActiveDevicesMessage(12, "terminal", 10)).toBe(
      "This license has 12 active computers, more than the 10 terminals this plan allows. Deactivate computers first, or contact support.",
    );
    expect(below.lines).toEqual([]);
    expect((await quoteFor(owner, renew(3))).issues).toEqual([]);

    // Deactivated computers do not count.
    const one = await db.deviceActivation.findFirstOrThrow({ where: { licenseId: license.id, name: "Counter 3" } });
    await db.deviceActivation.update({ where: { id: one.id }, data: { deactivatedAt: new Date(), deactivatedBy: "customer" } });
    expect((await quoteFor(owner, renew(2))).issues).toEqual([]);

    // Plans that are not per-unit keep their own limit, so the quantity never lowers it.
    const annual = await existingLicense(cat.plans.annual, owner.accountId);
    for (const name of ["PC 1", "PC 2"]) {
      await db.deviceActivation.create({ data: { licenseId: annual.id, fingerprint: uniq("fp"), name, os: "Windows 11" } });
    }
    expect((await quoteFor(owner, [{ planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: annual.id }])).issues).toEqual([]);
  });

  it("refuses a second line for the same license and kind, and anything next to an upgrade", async () => {
    const trial = await existingLicense(cat.plans.trial, owner.accountId, { status: "TRIAL" });
    const annual = await existingLicense(cat.plans.annual, owner.accountId);
    const q = await quoteFor(owner, [
      { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: annual.id },
      { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: annual.id },
      { planId: cat.plans.addon.id, qty: 1, kind: "ADDON", targetLicenseId: annual.id },
      { planId: cat.plans.annual.id, qty: 1, kind: "UPGRADE", targetLicenseId: trial.id },
      { planId: cat.plans.oneTime.id, qty: 1, kind: "UPGRADE", targetLicenseId: trial.id },
    ]);
    expect(q.issues.map((i) => [i.index, i.code])).toEqual([
      [1, "duplicate_target"],
      [4, "duplicate_target"],
    ]);
    expect(q.lines).toHaveLength(3);
  });

  it("needs the purchases team permission for lines on existing licenses", async () => {
    const technical = await makeCustomer({ role: "TECHNICAL", accountId: owner.accountId });
    const billing = await makeCustomer({ role: "BILLING", accountId: owner.accountId });
    const license = await existingLicense(cat.plans.annual, owner.accountId);
    const items: CheckoutItem[] = [
      { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: license.id },
      { planId: cat.plans.annual.id, qty: 1 },
    ];
    const t = await quoteFor(technical, items);
    expect(t.issues).toMatchObject([{ index: 0, code: "not_allowed", message: LINE_MESSAGES.notAllowed }]);
    expect(t.lines).toHaveLength(1);
    expect((await quoteFor(billing, items)).issues).toEqual([]);
  });

  it("lets existing licenses on a hidden product renew, but not new purchases", async () => {
    const license = await existingLicense(cat.plans.hiddenAnnual, owner.accountId);
    const q = await quoteFor(owner, [
      { planId: cat.plans.hiddenAnnual.id, qty: 1, kind: "RENEWAL", targetLicenseId: license.id },
      { planId: cat.plans.hiddenAnnual.id, qty: 1 },
    ]);
    expect(q.issues.map((i) => [i.index, i.code])).toEqual([[1, "unavailable"]]);
    expect(q.lines).toHaveLength(1);
  });
});
