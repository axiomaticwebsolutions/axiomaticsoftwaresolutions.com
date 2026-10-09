/**
 * Admin license actions (Admin Console.dc.html `licDetail` + bulk bar; decisions.md Phase 6 "License actions"):
 * suspend, reinstate, extend (days), reset devices, revoke, deactivate one device, manual issue, and the bulk extend /
 * suspend. Each runs in ONE transaction with the license row locked (SELECT ... FOR UPDATE) and writes:
 * - the change, a LicenseEvent (customer-visible history: actor = staff name, never the reason),
 * - an AccountActivity entry for claimed licenses (actor "Axiomatic Support"),
 * - exactly one AuditLog row per license with the staff reason (lib/admin/destructive.ts).
 * Keys never leave the server: manual issue discards the plaintext key that issueLicense() returns and emails the
 * account owner a link to the license in their account (license_issued template, last 4 characters only).
 */
import "server-only";
import { LicenseStatus, PlanType, type PrismaClient, type StaffRole } from "@/generated/prisma/client";
import { DESTRUCTIVE_AUDIT_ACTIONS, runDestructive, validateDestructive, type DestructiveInput } from "@/lib/admin/destructive";
import { audit, type AuditActor } from "@/lib/audit";
import { formatDateIST } from "@/lib/dates";
import { db as defaultDb, type Tx } from "@/lib/db";
import { enqueueEmail, kickEmailDispatch } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { getEnv } from "@/lib/env";
import { ApiError, errors } from "@/lib/http";
import { adminResetDevices, SUPPORT_ACTIVITY_ACTOR } from "@/lib/licensing/devices";
import { issueLicense } from "@/lib/licensing/issue";
import { maskLicenseKey, redactLicenseKeys } from "@/lib/licensing/keys";
import { LicenseTermsError } from "@/lib/licensing/terms";
import { log } from "@/lib/log";
import {
  BULK_MAX_LICENSES,
  EXTEND_DEFAULT_DAYS,
  extendAuditAction,
  extendedTerms,
  MANUAL_ISSUE_PLAN_TYPES,
  type BulkLicenseResult,
  type ManualIssueResult,
} from "./model";

export const LICENSE_ACTION_MESSAGES = {
  revoked: "This license is revoked, so it can\u2019t be changed.",
  alreadySuspended: "This license is already suspended.",
  notSuspended: "Only suspended licenses can be reinstated.",
  deviceInactive: "This device is already deactivated.",
  planNotIssuable: "Choose a trial, one-time, annual or subscription plan that is on sale.",
  accountMissing: "Choose a customer account.",
  quantity: (max: number) => `Enter between 1 and ${max} terminals.`,
  singleQuantity: "This plan is issued one at a time.",
} as const;

/** revokedReason is shown to the customer in the portal; the staff reason stays in the audit log. */
export const STAFF_REVOKED_REASON = "Revoked by Axiomatic Support.";

/** Manual issue: per-unit plans take up to the plan's maxQty terminals (or this many when unset). */
export const MANUAL_ISSUE_MAX_QTY = 100;

export type LicenseActionStaff = { id: string; name: string; role: StaffRole };

export type LicenseActionContext = {
  staff: LicenseActionStaff;
  actor: AuditActor;
  /** The request's reason and typed id. */
  input: DestructiveInput;
  now?: Date;
  client?: PrismaClient;
};

type LockedLicense = {
  id: string;
  accountId: string | null;
  status: LicenseStatus;
  expiresAt: Date | null;
  updatesUntil: Date;
  planType: PlanType;
  productName: string;
};

/** Locks the license row until commit and reads what the actions need; null for an unknown id. */
async function tryLockLicense(tx: Tx, id: string): Promise<LockedLicense | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "License" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) return null;
  const l = await tx.license.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      accountId: true,
      status: true,
      expiresAt: true,
      updatesUntil: true,
      plan: { select: { type: true } },
      product: { select: { name: true } },
    },
  });
  return { id: l.id, accountId: l.accountId, status: l.status, expiresAt: l.expiresAt, updatesUntil: l.updatesUntil, planType: l.plan.type, productName: l.product.name };
}

/** tryLockLicense, 404 for an unknown id. */
async function lockLicense(tx: Tx, id: string): Promise<LockedLicense> {
  const license = await tryLockLicense(tx, id);
  if (!license) throw errors.notFound("License");
  return license;
}

function assertNotRevoked(license: LockedLicense): void {
  if (license.status === LicenseStatus.REVOKED) throw errors.conflict("license_revoked", LICENSE_ACTION_MESSAGES.revoked);
}

const safe = (text: string, max = 200) => redactLicenseKeys(text).slice(0, max);

async function writeEvent(tx: Tx, licenseId: string, type: string, actor: string, detail: string | null, at: Date): Promise<void> {
  await tx.licenseEvent.create({ data: { licenseId, type, actor: safe(actor), detail: detail === null ? null : safe(detail), createdAt: at } });
}

/** "Axiomatic Support" entry in the customer's activity log (claimed licenses only). */
async function writeActivity(tx: Tx, accountId: string | null, action: string, target: string, at: Date): Promise<void> {
  if (!accountId) return;
  await tx.accountActivity.create({
    data: { accountId, actorName: SUPPORT_ACTIVITY_ACTOR, action, target: safe(target), kind: "license", createdAt: at },
  });
}

function destructive(ctx: LicenseActionContext) {
  return { staff: ctx.staff, actor: ctx.actor, input: ctx.input, client: ctx.client ?? defaultDb };
}

export type LicenseActionResult = { id: string; status: string };

// ---------- Suspend / reinstate ----------

async function applySuspend(tx: Tx, license: LockedLicense, staffName: string, now: Date): Promise<void> {
  await tx.license.update({ where: { id: license.id }, data: { status: LicenseStatus.SUSPENDED } });
  await writeEvent(tx, license.id, "suspended", staffName, null, now);
  await writeActivity(tx, license.accountId, "Suspended license", `${license.id} \u00B7 ${license.productName}`, now);
}

/** Suspend: installed copies fail their next validation (within the offline grace period). 409 when revoked or suspended. */
export async function suspendLicense(id: string, ctx: LicenseActionContext): Promise<LicenseActionResult> {
  const now = ctx.now ?? new Date();
  return runDestructive(
    "licenses.suspend",
    { ...destructive(ctx), targetId: id, target: id, targetType: "license" },
    async (tx) => {
      const license = await lockLicense(tx, id);
      assertNotRevoked(license);
      if (license.status === LicenseStatus.SUSPENDED) throw errors.conflict("already_suspended", LICENSE_ACTION_MESSAGES.alreadySuspended);
      await applySuspend(tx, license, ctx.staff.name, now);
      return { id, status: "SUSPENDED" };
    },
  );
}

/** Reinstate a suspended license: back to TRIAL for trial plans, else ACTIVE. 409 unless suspended. */
export async function reinstateLicense(id: string, ctx: LicenseActionContext): Promise<LicenseActionResult> {
  const now = ctx.now ?? new Date();
  return runDestructive(
    "licenses.reinstate",
    { ...destructive(ctx), targetId: id, target: id, targetType: "license" },
    async (tx) => {
      const license = await lockLicense(tx, id);
      assertNotRevoked(license);
      if (license.status !== LicenseStatus.SUSPENDED) throw errors.conflict("not_suspended", LICENSE_ACTION_MESSAGES.notSuspended);
      const status = license.planType === PlanType.TRIAL ? LicenseStatus.TRIAL : LicenseStatus.ACTIVE;
      await tx.license.update({ where: { id }, data: { status } });
      await writeEvent(tx, id, "reinstated", ctx.staff.name, null, now);
      await writeActivity(tx, license.accountId, "Reinstated license", `${id} \u00B7 ${license.productName}`, now);
      return { id, status };
    },
  );
}

// ---------- Extend ----------

export type ExtendResult = LicenseActionResult & { days: number; expiresAt: string | null; updatesUntil: string };

async function applyExtend(tx: Tx, license: LockedLicense, days: number, staffName: string, now: Date) {
  const next = extendedTerms(license, days, now);
  await tx.license.update({ where: { id: license.id }, data: { expiresAt: next.expiresAt, updatesUntil: next.updatesUntil } });
  const ends = next.expiresAt ? `ends ${formatDateIST(next.expiresAt)}` : `updates until ${formatDateIST(next.updatesUntil)}`;
  await writeEvent(tx, license.id, "extended", staffName, `+${days} ${days === 1 ? "day" : "days"} \u00B7 ${ends}`, now);
  await writeActivity(tx, license.accountId, "Extended license", `${license.id} \u00B7 +${days} ${days === 1 ? "day" : "days"}`, now);
  const before = license.expiresAt ? formatDateIST(license.expiresAt) : "no end date";
  const after = next.expiresAt ? formatDateIST(next.expiresAt) : "no end date";
  return {
    next,
    detail: `Ends ${before} \u2192 ${after}; updates until ${formatDateIST(license.updatesUntil)} \u2192 ${formatDateIST(next.updatesUntil)}`,
  };
}

/** Extend by `days` (default 30) at no charge: end date and updates-until move on from max(now, current). 409 when revoked. */
export async function extendLicense(id: string, days: number, ctx: LicenseActionContext): Promise<ExtendResult> {
  const now = ctx.now ?? new Date();
  let detail = "";
  return runDestructive(
    "licenses.extend",
    { ...destructive(ctx), targetId: id, target: id, targetType: "license", action: extendAuditAction(days), detail: () => detail },
    async (tx) => {
      const license = await lockLicense(tx, id);
      assertNotRevoked(license);
      const applied = await applyExtend(tx, license, days, ctx.staff.name, now);
      detail = applied.detail;
      return {
        id,
        status: license.status,
        days,
        expiresAt: applied.next.expiresAt?.toISOString() ?? null,
        updatesUntil: applied.next.updatesUntil.toISOString(),
      };
    },
  );
}

// ---------- Devices ----------

/** Reset devices (lib/licensing/devices adminResetDevices: deactivates every device, zeroes the yearly counter, one audit row). */
export async function resetLicenseDevices(id: string, ctx: LicenseActionContext): Promise<{ id: string; deactivated: number }> {
  const now = ctx.now ?? new Date();
  return runDestructive(
    "licenses.reset_devices",
    { ...destructive(ctx), targetId: id, target: id, targetType: "license", selfAudited: true },
    async (tx, { reason, actor }) => {
      const license = await lockLicense(tx, id);
      assertNotRevoked(license);
      const deactivated = await adminResetDevices(tx, { licenseId: id, actor, reason, actorName: ctx.staff.name, now });
      return { id, deactivated };
    },
  );
}

/** Deactivates one device (frees a slot; never counts toward the customer's self-service limit). */
export async function deactivateLicenseDevice(
  licenseId: string,
  deviceId: string,
  ctx: LicenseActionContext,
): Promise<{ id: string; deviceId: string; name: string }> {
  const now = ctx.now ?? new Date();
  let detail = "";
  return runDestructive(
    "licenses.deactivate_device",
    { ...destructive(ctx), targetId: licenseId, target: licenseId, targetType: "license", detail: () => detail },
    async (tx) => {
      const license = await lockLicense(tx, licenseId);
      assertNotRevoked(license);
      const device = await tx.deviceActivation.findFirst({
        where: { id: deviceId, licenseId },
        select: { id: true, name: true, os: true, deactivatedAt: true },
      });
      if (!device) throw errors.notFound("Device");
      if (device.deactivatedAt) throw errors.conflict("already_deactivated", LICENSE_ACTION_MESSAGES.deviceInactive);
      const { count } = await tx.deviceActivation.updateMany({
        where: { id: device.id, deactivatedAt: null },
        data: { deactivatedAt: now, deactivatedBy: "staff" },
      });
      if (count !== 1) throw errors.conflict("already_deactivated", LICENSE_ACTION_MESSAGES.deviceInactive);
      await writeEvent(tx, licenseId, "deactivated", ctx.staff.name, device.name, now);
      await writeActivity(tx, license.accountId, "Deactivated device", `${licenseId} \u00B7 ${device.name}`, now);
      detail = safe(`${device.name} \u00B7 ${device.os}`);
      return { id: licenseId, deviceId: device.id, name: device.name };
    },
  );
}

// ---------- Revoke ----------

/** Revoke permanently (licenses.revoke; reason + typed license id). Every device fails its next check. */
export async function revokeLicense(id: string, ctx: LicenseActionContext): Promise<LicenseActionResult> {
  const now = ctx.now ?? new Date();
  return runDestructive(
    "licenses.revoke",
    { ...destructive(ctx), targetId: id, target: id, targetType: "license" },
    async (tx) => {
      const license = await lockLicense(tx, id);
      assertNotRevoked(license);
      await tx.license.update({
        where: { id },
        data: { status: LicenseStatus.REVOKED, revokedAt: now, revokedReason: STAFF_REVOKED_REASON },
      });
      await writeEvent(tx, id, "revoked", ctx.staff.name, null, now);
      await writeActivity(tx, license.accountId, "Revoked license", `${id} \u00B7 ${license.productName}`, now);
      return { id, status: "REVOKED" };
    },
  );
}

// ---------- Manual issue ----------

export type ManualIssueInput = { accountId: string; planId: string; quantity?: number };

/** Portal page of a license (the key is revealed there with the account password). */
export function portalLicenseUrl(licenseId: string): string {
  return `${getEnv().APP_URL}/account/licenses/${encodeURIComponent(licenseId)}`;
}

/**
 * Issues a license to a business account (licenses.issue_manual: reason required) through issueLicense(), like trials
 * and paid orders. The plaintext key is dropped here: the account's first active Owner gets the license_issued email
 * (outbox, dedupe `license_issued:<id>`) linking to the license in their account, where the key can be revealed with
 * their password. 422 for an unknown account, a plan that cannot be issued (add-ons, maintenance, archived) or a bad
 * quantity.
 */
export async function issueManualLicense(input: ManualIssueInput, ctx: LicenseActionContext): Promise<ManualIssueResult> {
  const now = ctx.now ?? new Date();
  const result = await runDestructive(
    "licenses.issue_manual",
    { ...destructive(ctx), targetId: input.accountId, target: input.accountId, targetType: "license", selfAudited: true },
    async (tx, { reason, actor }) => {
      const account = await tx.businessAccount.findUnique({
        where: { id: input.accountId },
        select: {
          id: true,
          legalName: true,
          members: {
            where: { role: "OWNER", status: "ACTIVE" },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 1,
            select: { user: { select: { name: true, email: true } } },
          },
        },
      });
      if (!account) throw errors.validation({ accountId: LICENSE_ACTION_MESSAGES.accountMissing });
      const plan = await tx.plan.findUnique({ where: { id: input.planId }, include: { product: { select: { id: true, code: true, name: true, status: true } } } });
      // A COMING_SOON product is not on sale: no licenses until it is published (decisions.md 2026-10-09).
      if (!plan || plan.archived || plan.product.status === "COMING_SOON" || !(MANUAL_ISSUE_PLAN_TYPES as readonly PlanType[]).includes(plan.type)) {
        throw errors.validation({ planId: LICENSE_ACTION_MESSAGES.planNotIssuable });
      }
      const maxQty = Math.min(plan.maxQty ?? MANUAL_ISSUE_MAX_QTY, MANUAL_ISSUE_MAX_QTY);
      const qty = input.quantity ?? 1;
      if (plan.perUnit ? qty < 1 || qty > maxQty : qty !== 1) {
        throw errors.validation({ quantity: plan.perUnit ? LICENSE_ACTION_MESSAGES.quantity(maxQty) : LICENSE_ACTION_MESSAGES.singleQuantity });
      }

      let license;
      try {
        // The returned plaintext key is deliberately not kept: staff never see full keys.
        ({ license } = await issueLicense(tx, {
          accountId: account.id,
          product: plan.product,
          plan,
          qty,
          at: now,
          orderId: null,
          actor: ctx.staff.name,
          eventDetail: "Issued by staff",
        }));
      } catch (error) {
        if (error instanceof LicenseTermsError) throw errors.validation({ planId: LICENSE_ACTION_MESSAGES.planNotIssuable });
        throw error;
      }

      await audit(tx, actor, {
        action: DESTRUCTIVE_AUDIT_ACTIONS["licenses.issue_manual"],
        target: license.id,
        targetType: "license",
        targetId: license.id,
        reason,
        detail: `${plan.product.name} \u00B7 ${plan.name}${plan.perUnit ? ` \u00D7 ${qty}` : ""} \u00B7 ${account.legalName}`,
      });
      await writeActivity(tx, account.id, "License issued", `${license.id} \u00B7 ${plan.product.name}`, now);

      const owner = account.members[0]?.user ?? null;
      if (owner) {
        await enqueueEmail(tx, {
          to: owner.email,
          templateId: "license_issued",
          vars: {
            customer_name: greetingName(owner.name),
            product_name: plan.product.name,
            // The template names an order; a manual license has none, so it carries the license id.
            order_id: license.id,
            order_url: portalLicenseUrl(license.id),
            key_last4: license.keyLast4,
          },
          dedupeKey: `license_issued:${license.id}`,
        });
      }
      return {
        id: license.id,
        keyMasked: maskLicenseKey(plan.product.code, license.keyLast4),
        productName: plan.product.name,
        planName: plan.name,
        emailedTo: owner?.email ?? null,
      } satisfies ManualIssueResult;
    },
  );
  if (result.emailedTo) kickEmailDispatch();
  log.info("license_issued_manually", { licenseId: result.id, staffId: ctx.staff.id });
  return result;
}

// ---------- Bulk ----------

export type BulkLicenseInput = { action: "extend" | "suspend"; ids: readonly string[]; days?: number };

/**
 * Bulk "Extend 30 days" / "Suspend" (prototype bulk bar): one reason for all, one transaction, licenses locked in id
 * order; revoked licenses (and, for suspend, suspended ones) and unknown ids are skipped. One audit row per license
 * changed.
 */
export async function bulkLicenseAction(input: BulkLicenseInput, ctx: LicenseActionContext): Promise<BulkLicenseResult> {
  const now = ctx.now ?? new Date();
  const key = input.action === "extend" ? "licenses.extend" : "licenses.suspend";
  const { reason } = validateDestructive(key, { staff: ctx.staff, input: ctx.input, confirmValue: "" });
  const ids = [...new Set(input.ids)].sort();
  if (ids.length === 0 || ids.length > BULK_MAX_LICENSES) {
    throw new ApiError(422, "validation_failed", `Select between 1 and ${BULK_MAX_LICENSES} licenses.`);
  }
  const days = input.days ?? EXTEND_DEFAULT_DAYS;
  const client = ctx.client ?? defaultDb;
  return client.$transaction(
    async (tx) => {
      const result: BulkLicenseResult = { updated: [], skipped: [] };
      for (const id of ids) {
        const license = await tryLockLicense(tx, id);
        if (!license) {
          result.skipped.push({ id, reason: "Not found" });
          continue;
        }
        if (license.status === LicenseStatus.REVOKED) {
          result.skipped.push({ id, reason: "Revoked" });
          continue;
        }
        if (input.action === "suspend") {
          if (license.status === LicenseStatus.SUSPENDED) {
            result.skipped.push({ id, reason: "Already suspended" });
            continue;
          }
          await applySuspend(tx, license, ctx.staff.name, now);
          await audit(tx, ctx.actor, { action: DESTRUCTIVE_AUDIT_ACTIONS["licenses.suspend"], target: id, targetType: "license", targetId: id, reason, detail: "Bulk action" });
        } else {
          const applied = await applyExtend(tx, license, days, ctx.staff.name, now);
          await audit(tx, ctx.actor, { action: extendAuditAction(days), target: id, targetType: "license", targetId: id, reason, detail: `Bulk action \u00B7 ${applied.detail}` });
        }
        result.updated.push(id);
      }
      return result;
    },
    { timeout: 30_000 },
  );
}
