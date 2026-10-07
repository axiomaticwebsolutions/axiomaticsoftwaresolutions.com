/**
 * Order fulfilment, run by the verified payment webhook (or reconciliation) inside the transaction that holds the
 * order row lock. Dispatches each unfulfilled OrderItem on (kind, plan.type) and marks it with `fulfilledAt`, so a
 * second run finds nothing to do. Term arithmetic lives in terms.ts; the base time is always Order.paidAt. When an item
 * lowers a license's deviceLimit, the devices above the new limit are deactivated (device-limit.ts).
 *
 * Any thrown error (FulfilmentError, LicenseTermsError) rolls back the caller's transaction, including licenses
 * already issued for earlier items. The webhook then marks the order REVIEW in a separate transaction.
 */
import { ItemKind, LicenseStatus, PlanType, type License, type Plan } from "@/generated/prisma/client";
import type { Tx } from "@/lib/db";
import type { LicenseKeySecrets } from "./crypto";
import { trimDevicesToLimit } from "./device-limit";
import { issueLicense } from "./issue";
import { redactLicenseKeys } from "./keys";
import { addonTerms, renewalTerms, upgradeTerms, type LicenseTerms } from "./terms";

export type FulfilAction = "issued" | "renewed" | "maintenance" | "devices_added" | "upgraded";

/** `key` is present only for `issued`; deliver it once and drop it. */
export type FulfilResult = { itemId: string; action: FulfilAction; licenseId: string; key?: string };

export type FulfilOrder = { id: string; accountId: string | null; paidAt: Date };
export type FulfilOptions = { actor?: string; secrets?: LicenseKeySecrets };

export type FulfilmentErrorCode =
  | "missing_target"
  | "target_not_found"
  | "target_wrong_account"
  | "target_wrong_product"
  | "target_revoked"
  | "invalid_item"
  | "concurrent_fulfilment";

/** An item that cannot be fulfilled as ordered. `code` is stable for logs and the REVIEW reason. */
export class FulfilmentError extends Error {
  readonly code: FulfilmentErrorCode;
  readonly itemId: string;

  constructor(code: FulfilmentErrorCode, itemId: string, message: string) {
    super(message);
    this.name = "FulfilmentError";
    this.code = code;
    this.itemId = itemId;
  }
}

export const SYSTEM_EVENT_ACTOR = "System";

type ItemWithPlan = {
  id: string;
  kind: ItemKind;
  quantity: number;
  targetLicenseId: string | null;
  plan: Plan & { product: { id: string; code: string } };
};

type TargetLicense = License & { plan: { type: PlanType } };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function fulfilNew(tx: Tx, order: FulfilOrder, item: ItemWithPlan, actor: string, opts: FulfilOptions): Promise<FulfilResult> {
  if (item.plan.type === PlanType.TRIAL) {
    throw new FulfilmentError("invalid_item", item.id, "Trial plans are not sold through orders");
  }
  // DEVICE_ADDON and MAINTENANCE plans make newLicenseTerms throw LicenseTermsError("needs_target_license").
  const { license, key } = await issueLicense(tx, {
    accountId: order.accountId,
    product: item.plan.product,
    plan: item.plan,
    qty: item.quantity,
    at: order.paidAt,
    orderId: order.id,
    actor,
    eventType: "issued",
    eventDetail: `Order ${order.id}`,
    secrets: opts.secrets,
  });
  return { itemId: item.id, action: "issued", licenseId: license.id, key };
}

/** Locks and loads the item's target license, enforcing ownership, product and status. */
async function lockTarget(tx: Tx, order: FulfilOrder, item: ItemWithPlan): Promise<TargetLicense> {
  const targetId = item.targetLicenseId;
  if (!targetId) throw new FulfilmentError("missing_target", item.id, `${item.kind} item has no target license`);
  // Guest orders cannot prove ownership of an existing license.
  if (order.accountId === null) {
    throw new FulfilmentError("target_wrong_account", item.id, "Only account orders can change an existing license");
  }
  // Two orders changing the same license must not both extend from the same old dates.
  await tx.$queryRaw`SELECT "id" FROM "License" WHERE "id" = ${targetId} FOR UPDATE`;
  const license = await tx.license.findUnique({ where: { id: targetId }, include: { plan: { select: { type: true } } } });
  if (!license) throw new FulfilmentError("target_not_found", item.id, `Target license ${targetId} not found`);
  if (license.accountId !== order.accountId) {
    throw new FulfilmentError("target_wrong_account", item.id, `Target license ${targetId} belongs to another account`);
  }
  if (license.productId !== item.plan.productId) {
    throw new FulfilmentError("target_wrong_product", item.id, `Target license ${targetId} is for another product`);
  }
  if (license.status === LicenseStatus.REVOKED) {
    throw new FulfilmentError("target_revoked", item.id, `Target license ${targetId} is revoked`);
  }
  return license;
}

/** Stored on OrderItem.termsBefore/termsAfter so a refund can restore the previous terms (docs/decisions.md 11). */
export type TermsSnapshot = { planId: string; status: LicenseStatus; expiresAt: string | null; updatesUntil: string; deviceLimit: number };

export function termsSnapshot(license: Pick<License, "planId" | "status" | "expiresAt" | "updatesUntil" | "deviceLimit">): TermsSnapshot {
  return {
    planId: license.planId,
    status: license.status,
    expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
    updatesUntil: license.updatesUntil.toISOString(),
    deviceLimit: license.deviceLimit,
  };
}

type TargetFulfilment = { result: FulfilResult; termsBefore: TermsSnapshot; termsAfter: TermsSnapshot };

function currentTerms(license: License): LicenseTerms {
  return { expiresAt: license.expiresAt, updatesUntil: license.updatesUntil, deviceLimit: license.deviceLimit };
}

async function fulfilTarget(tx: Tx, order: FulfilOrder, item: ItemWithPlan, actor: string): Promise<TargetFulfilment> {
  const license = await lockTarget(tx, order, item);
  const plan = item.plan;
  const at = order.paidAt;
  const orderNote = `Order ${order.id}`;

  let action: FulfilAction;
  let data: { planId?: string; status?: LicenseStatus; expiresAt?: Date | null; updatesUntil?: Date; deviceLimit?: number };
  let eventType: string;
  let detail: string;

  switch (item.kind) {
    case ItemKind.RENEWAL: {
      if (license.status === LicenseStatus.TRIAL) {
        throw new FulfilmentError("invalid_item", item.id, "A trial becomes paid through an upgrade, not a renewal");
      }
      const terms = renewalTerms(currentTerms(license), plan, item.quantity, at);
      if (plan.type === PlanType.MAINTENANCE) {
        // Maintenance extends updates only; the license keeps its own (one-time) plan.
        action = "maintenance";
        data = { updatesUntil: terms.updatesUntil };
      } else {
        action = "renewed";
        data = { planId: plan.id, expiresAt: terms.expiresAt, updatesUntil: terms.updatesUntil, deviceLimit: terms.deviceLimit };
      }
      eventType = "renewed";
      detail = `${plan.name} \u00B7 ${orderNote}`;
      break;
    }
    case ItemKind.ADDON: {
      if (plan.type !== PlanType.DEVICE_ADDON) {
        throw new FulfilmentError("invalid_item", item.id, `ADDON items need a device add-on plan, got ${plan.type}`);
      }
      if (license.status === LicenseStatus.TRIAL) {
        // An upgrade resets the device limit from the paid plan, so slots bought for a trial would be lost.
        throw new FulfilmentError("invalid_item", item.id, "Devices are added after the trial is upgraded");
      }
      const terms = addonTerms(currentTerms(license), item.quantity);
      action = "devices_added";
      data = { deviceLimit: terms.deviceLimit };
      eventType = "devices_added";
      detail = `+${plural(item.quantity, "device")} \u00B7 ${orderNote}`;
      break;
    }
    case ItemKind.UPGRADE: {
      const terms = upgradeTerms({ ...currentTerms(license), status: license.status, planType: license.plan.type }, plan, item.quantity, at);
      action = "upgraded";
      data = {
        planId: plan.id,
        status: LicenseStatus.ACTIVE,
        expiresAt: terms.expiresAt,
        updatesUntil: terms.updatesUntil,
        deviceLimit: terms.deviceLimit,
      };
      eventType = "upgraded";
      detail = `${plan.name} \u00B7 ${orderNote}`;
      break;
    }
    case ItemKind.NEW:
      throw new FulfilmentError("invalid_item", item.id, "NEW items do not target a license");
  }

  const updated = await tx.license.update({ where: { id: license.id }, data });
  await tx.licenseEvent.create({ data: { licenseId: license.id, type: eventType, actor, detail: redactLicenseKeys(detail) } });
  // A renewal for fewer terminals (deviceLimit = qty on per-unit plans) or an upgrade to a smaller plan lowers the
  // limit: devices above it lose their slot now (least recently seen first), still under the lockTarget() row lock.
  // /validate never re-counts devices, so without this they would keep validating forever. Stamped with the time the
  // slots are actually released (fulfilment may run after paidAt), like the events written next to it.
  if (data.deviceLimit !== undefined) {
    await trimDevicesToLimit(tx, { licenseId: license.id, accountId: license.accountId, limit: updated.deviceLimit, at: new Date(), actor });
  }
  return { result: { itemId: item.id, action, licenseId: license.id }, termsBefore: termsSnapshot(license), termsAfter: termsSnapshot(updated) };
}

/**
 * Fulfils every item of `order` whose `fulfilledAt` is null and returns what happened per item, in item id order.
 * The caller must hold the order row lock (SELECT ... FOR UPDATE) in `tx`. Running it again returns [].
 */
export async function fulfilOrderItems(tx: Tx, order: FulfilOrder, opts: FulfilOptions = {}): Promise<FulfilResult[]> {
  if (!(order.paidAt instanceof Date) || Number.isNaN(order.paidAt.getTime())) {
    throw new RangeError("Order paidAt must be a valid date before fulfilment");
  }
  const actor = opts.actor ?? SYSTEM_EVENT_ACTOR;
  const items = await tx.orderItem.findMany({
    where: { orderId: order.id, fulfilledAt: null },
    select: {
      id: true,
      kind: true,
      quantity: true,
      targetLicenseId: true,
      plan: { include: { product: { select: { id: true, code: true } } } },
    },
    orderBy: { id: "asc" },
  });

  const results: FulfilResult[] = [];
  for (const item of items) {
    let result: FulfilResult;
    let snapshots: { termsBefore: TermsSnapshot; termsAfter: TermsSnapshot } | null = null;
    if (item.kind === ItemKind.NEW) {
      result = await fulfilNew(tx, order, item, actor, opts);
    } else {
      const target = await fulfilTarget(tx, order, item, actor);
      result = target.result;
      snapshots = { termsBefore: target.termsBefore, termsAfter: target.termsAfter };
    }
    // fulfilledAt uses paidAt like the terms, so retries and reconciliation record the same value.
    const marked = await tx.orderItem.updateMany({
      where: { id: item.id, fulfilledAt: null },
      data: {
        fulfilledAt: order.paidAt,
        ...(result.action === "issued" ? { issuedLicenseId: result.licenseId } : {}),
        ...(snapshots ?? {}),
      },
    });
    if (marked.count !== 1) {
      throw new FulfilmentError("concurrent_fulfilment", item.id, "Item was fulfilled concurrently; is the order row locked?");
    }
    results.push(result);
  }
  return results;
}

export type RevokeOrderLicensesOptions = { reason: string; actor: string; at: Date };

/**
 * Refund reversal for licenses the order issued (NEW items): status REVOKED, revokedAt, revokedReason (shown to the
 * customer) and a `revoked` event. Licenses already revoked are skipped. Returns the ids revoked by this call.
 * Renewals, add-ons, maintenance and upgrades bought in the order are not reversed here: fulfilment records
 * OrderItem.termsBefore/termsAfter for them, and the Phase 3 refund flow restores termsBefore when the license still
 * matches termsAfter (otherwise the order goes to REVIEW).
 */
export async function revokeOrderLicenses(tx: Tx, orderId: string, opts: RevokeOrderLicensesOptions): Promise<string[]> {
  const reason = redactLicenseKeys(opts.reason).trim();
  if (reason.length === 0) throw new RangeError("A revocation reason is required");
  if (Number.isNaN(opts.at.getTime())) throw new RangeError("Invalid revocation date");

  const items = await tx.orderItem.findMany({
    where: { orderId, kind: ItemKind.NEW, issuedLicenseId: { not: null } },
    select: { issuedLicenseId: true },
  });
  // Sorted so concurrent revocations touching the same rows always lock them in the same order.
  const ids = items
    .map((i) => i.issuedLicenseId)
    .filter((id): id is string => id !== null)
    .sort();

  const revoked: string[] = [];
  for (const id of ids) {
    const { count } = await tx.license.updateMany({
      where: { id, status: { not: LicenseStatus.REVOKED } },
      data: { status: LicenseStatus.REVOKED, revokedAt: opts.at, revokedReason: reason },
    });
    if (count === 1) {
      await tx.licenseEvent.create({ data: { licenseId: id, type: "revoked", actor: opts.actor, detail: reason } });
      revoked.push(id);
    }
  }
  return revoked;
}
