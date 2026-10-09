/**
 * Cart line validation before pricing (docs/decisions.md Phase 1 "Licensing rules" and Phase 3 "Checkout and orders").
 * Each line either passes or yields an issue { planId, code, message }; the quote drops failing lines and reports
 * them, order creation refuses the cart while any line fails. Rules:
 * - the plan exists and is purchasable (pricing rules from lib/pricing: no trials, kind vs plan type, archived plans
 *   only for renewals, quantities, a target for renewals/upgrades/add-ons/maintenance);
 * - NEW lines need a PUBLISHED product; lines for existing licenses only need a product that is not a DRAFT;
 * - guests, staff and signed-in users without an account buy NEW items only;
 * - target licenses belong to the buyer's active account, which must hold the `purchases` team permission; same
 *   product as the plan; not REVOKED;
 * - trials become paid through UPGRADE only (no RENEWAL or ADDON on a TRIAL license); renewals and upgrades must be
 *   possible under lib/licensing/terms (the same functions fulfilment uses), so a paid order never lands in REVIEW
 *   for a rule we could have checked up front;
 * - one line per license and kind, and an upgrade must be the only line for its license;
 * - a per-unit renewal or upgrade sets the device limit to the quantity, so it may not go below the license's active
 *   devices (`below_active_devices`; fulfilment would deactivate the extra computers, lib/licensing/device-limit.ts).
 */
import { ItemKind, LicenseStatus, PlanType, PublishStatus } from "@/generated/prisma/enums";
import { servesExistingLicenses } from "@/lib/catalog/status";
import type { Db } from "@/lib/db";
import { countActiveDevices } from "@/lib/licensing/device-limit";
import { LicenseTermsError, renewalTerms, upgradeTerms } from "@/lib/licensing/terms";
import { DEFAULT_MAX_QTY, normalizeQuantity, PricingError, quote, type CartLine } from "@/lib/pricing";
import { teamCan } from "@/lib/rbac";
import type { CheckoutItem } from "@/lib/validation/checkout";
import { NO_ACCOUNT_MESSAGE, PURCHASE_FORBIDDEN_MESSAGE, STAFF_CHECKOUT_MESSAGE, type PricingBuyer } from "./buyer";
import type { CheckoutPlan, PricingContext } from "./pricing-context";

export const LINE_MESSAGES = {
  unknownPlan: "This plan doesn’t exist.",
  unavailable: "This product isn’t available to buy right now.",
  signInRequired: "Sign in to renew, upgrade or add computers to a license you own.",
  notAllowed: PURCHASE_FORBIDDEN_MESSAGE,
  noAccount: NO_ACCOUNT_MESSAGE,
  staff: STAFF_CHECKOUT_MESSAGE,
  targetNotFound: "We couldn’t find this license in your account.",
  targetWrongProduct: "This plan is for a different product than the license.",
  targetRevoked: "This license was revoked, so it can’t be renewed or changed.",
  trialRenewal: "Trials become paid licenses through an upgrade. Choose a plan to upgrade to.",
  trialAddon: "Add computers after you upgrade the trial.",
  maintenanceNeedsPerpetual: "Maintenance renews updates for one-time licenses only.",
  perpetualNeedsMaintenance: "One-time licenses renew through a maintenance plan.",
  notRenewable: "This license can’t be renewed with this plan.",
  unsupportedUpgrade: "This license can’t be upgraded to this plan.",
  duplicateTarget: "This license is already in your cart.",
} as const;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * "This license has 3 active computers. Choose at least 3 terminals, or deactivate computers first." When the plan
 * cannot sell that many (`maxQty`; add-ons can take a license past it), only deactivating or support helps.
 */
export function belowActiveDevicesMessage(activeDevices: number, unit: string, maxQty: number = DEFAULT_MAX_QTY): string {
  const has = `This license has ${plural(activeDevices, "active computer")}`;
  if (activeDevices > maxQty) {
    return `${has}, more than the ${plural(maxQty, unit)} this plan allows. Deactivate computers first, or contact support.`;
  }
  return `${has}. Choose at least ${plural(activeDevices, unit)}, or deactivate computers first.`;
}

export type LineIssueCode =
  | PricingError["code"]
  | "unavailable"
  | "sign_in_required"
  | "not_allowed"
  | "no_account"
  | "target_not_found"
  | "target_wrong_product"
  | "target_revoked"
  | "trial_needs_upgrade"
  | "not_renewable"
  | "unsupported_upgrade"
  | "duplicate_target"
  | "below_active_devices";

/** A refused line. `index` is its position in the request; kind and target identify it among same-plan lines. */
export type LineIssue = {
  planId: string;
  code: LineIssueCode;
  message: string;
  index: number;
  kind: ItemKind;
  targetLicenseId: string | null;
};

/** An accepted line, ready for quote(). */
export type ValidLine = CartLine & { kind: ItemKind; targetLicenseId: string | null; index: number };

type TargetRow = {
  id: string;
  productId: string;
  status: LicenseStatus;
  expiresAt: Date | null;
  updatesUntil: Date;
  deviceLimit: number;
  plan: { type: PlanType };
  /** Active (not deactivated) devices on the license. */
  activeDevices: number;
};

function needsTarget(kind: ItemKind, planType: PlanType): boolean {
  return kind !== ItemKind.NEW || planType === PlanType.DEVICE_ADDON || planType === PlanType.MAINTENANCE;
}

/**
 * Validates every line; see the module comment for the rules. Loads the buyer's target licenses and their active
 * device counts (two queries).
 */
export async function validateCheckoutLines(
  db: Db,
  items: readonly CheckoutItem[],
  buyer: PricingBuyer,
  ctx: PricingContext,
  now: Date,
): Promise<{ lines: ValidLine[]; issues: LineIssue[] }> {
  const membership = buyer.kind === "customer" ? buyer.membership : null;
  const canPurchase = membership !== null && teamCan(membership.role, "purchases");
  const targetIds = [
    ...new Set(items.map((i) => i.targetLicenseId).filter((id): id is string => typeof id === "string" && id !== "")),
  ];
  const licenseRows =
    canPurchase && membership && targetIds.length > 0
      ? await db.license.findMany({
          // Scoped to the buyer's account: another account's license reads exactly like an unknown id.
          where: { id: { in: targetIds }, accountId: membership.accountId },
          select: {
            id: true,
            productId: true,
            status: true,
            expiresAt: true,
            updatesUntil: true,
            deviceLimit: true,
            plan: { select: { type: true } },
          },
        })
      : [];
  const activeCounts = await countActiveDevices(db, licenseRows.map((l) => l.id));
  const targetRows: TargetRow[] = licenseRows.map((l) => ({ ...l, activeDevices: activeCounts.get(l.id) ?? 0 }));
  const targets = new Map(targetRows.map((t) => [t.id, t]));

  const lines: ValidLine[] = [];
  const issues: LineIssue[] = [];
  const kindsByTarget = new Map<string, Set<ItemKind>>();

  items.forEach((item, index) => {
    const kind: ItemKind = item.kind ?? ItemKind.NEW;
    const requestedTarget = item.targetLicenseId ? item.targetLicenseId : null;
    const fail = (code: LineIssueCode, message: string): void => {
      issues.push({ planId: item.planId, code, message, index, kind, targetLicenseId: requestedTarget });
    };

    const plan = ctx.plans.get(item.planId);
    if (!plan) return fail("unknown_plan", LINE_MESSAGES.unknownPlan);
    const productStatus = plan.product.status;
    // New licenses: PUBLISHED only. Renewals, upgrades and add-ons: PUBLISHED or HIDDEN (never DRAFT or COMING_SOON).
    if (!servesExistingLicenses(productStatus) || (kind === ItemKind.NEW && productStatus !== PublishStatus.PUBLISHED)) {
      return fail("unavailable", LINE_MESSAGES.unavailable);
    }

    const line: CartLine = { planId: plan.id, qty: item.qty, kind, targetLicenseId: requestedTarget };
    try {
      // Pricing rules for this line alone (no coupon): trial plans, kind vs plan type, archived plans, quantity, target.
      quote({ lines: [line], plans: ctx.plans, tax: ctx.tax, now });
    } catch (error) {
      if (error instanceof PricingError) return fail(error.code, error.message);
      throw error;
    }

    if (!needsTarget(kind, plan.type)) {
      lines.push({ ...line, kind, targetLicenseId: null, index });
      return;
    }
    const targetId = requestedTarget ?? "";
    if (buyer.kind === "guest") return fail("sign_in_required", LINE_MESSAGES.signInRequired);
    if (buyer.kind === "staff") return fail("not_allowed", LINE_MESSAGES.staff);
    if (!membership) return fail("no_account", LINE_MESSAGES.noAccount);
    if (!canPurchase) return fail("not_allowed", LINE_MESSAGES.notAllowed);
    const license = targets.get(targetId);
    if (!license) return fail("target_not_found", LINE_MESSAGES.targetNotFound);
    if (license.productId !== plan.productId) return fail("target_wrong_product", LINE_MESSAGES.targetWrongProduct);
    if (license.status === LicenseStatus.REVOKED) return fail("target_revoked", LINE_MESSAGES.targetRevoked);

    const issue = termsIssue(kind, plan, license, normalizeQuantity(plan, kind, item.qty), now);
    if (issue) return fail(issue.code, issue.message);

    const kinds = kindsByTarget.get(targetId) ?? new Set<ItemKind>();
    if (kinds.has(kind) || kinds.has(ItemKind.UPGRADE) || (kind === ItemKind.UPGRADE && kinds.size > 0)) {
      return fail("duplicate_target", LINE_MESSAGES.duplicateTarget);
    }
    kinds.add(kind);
    kindsByTarget.set(targetId, kinds);
    lines.push({ ...line, kind, targetLicenseId: targetId, index });
  });

  return { lines, issues };
}

/**
 * Trial vs paid rules and the term functions fulfilment will run, applied now to the license as it stands. On per-unit
 * plans the quantity becomes the device limit, which must cover the computers already active.
 */
function termsIssue(
  kind: ItemKind,
  plan: CheckoutPlan,
  license: TargetRow,
  qty: number,
  now: Date,
): { code: LineIssueCode; message: string } | null {
  const terms = { expiresAt: license.expiresAt, updatesUntil: license.updatesUntil, deviceLimit: license.deviceLimit };
  const isTrial = license.status === LicenseStatus.TRIAL;
  try {
    switch (kind) {
      case ItemKind.RENEWAL:
        if (isTrial) return { code: "trial_needs_upgrade", message: LINE_MESSAGES.trialRenewal };
        return deviceLimitIssue(plan, license, renewalTerms(terms, plan, qty, now).deviceLimit);
      case ItemKind.ADDON:
        return isTrial ? { code: "trial_needs_upgrade", message: LINE_MESSAGES.trialAddon } : null;
      case ItemKind.UPGRADE:
        return deviceLimitIssue(plan, license, upgradeTerms({ ...terms, status: license.status, planType: license.plan.type }, plan, qty, now).deviceLimit);
      case ItemKind.NEW:
        return null;
    }
  } catch (error) {
    if (!(error instanceof LicenseTermsError)) throw error;
    if (error.code === "unsupported_upgrade") return { code: "unsupported_upgrade", message: LINE_MESSAGES.unsupportedUpgrade };
    if (plan.type === PlanType.MAINTENANCE) return { code: "not_renewable", message: LINE_MESSAGES.maintenanceNeedsPerpetual };
    if (license.expiresAt === null) return { code: "not_renewable", message: LINE_MESSAGES.perpetualNeedsMaintenance };
    return { code: "not_renewable", message: LINE_MESSAGES.notRenewable };
  }
}

/** A per-unit line whose quantity (the new device limit) is below the license's active devices. */
function deviceLimitIssue(plan: CheckoutPlan, license: TargetRow, newLimit: number): { code: LineIssueCode; message: string } | null {
  if (!plan.perUnit || newLimit >= license.activeDevices) return null;
  const maxQty = Math.max(1, plan.maxQty ?? DEFAULT_MAX_QTY);
  return { code: "below_active_devices", message: belowActiveDevicesMessage(license.activeDevices, plan.perUnit, maxQty) };
}
