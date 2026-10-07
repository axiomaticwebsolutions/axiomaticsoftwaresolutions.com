/**
 * Device changes from the customer portal and the admin console (decisions.md Phase 4 "Account license actions").
 *
 * - selfServiceDeactivate: a member with `devices.manage` frees a slot. At most `selfServiceResetsPerYear` (default 3)
 *   per license per IST calendar year; the 4th answers 429 `reset_limit` with the portal copy. The license row is
 *   locked (SELECT ... FOR UPDATE) for the whole check-and-write, so concurrent requests can never take more slots
 *   than the limit or double-count a device.
 * - renameOrMoveDevice: device name (1-80 characters) and location (a Location of the same account, or none).
 * - adminResetDevices: staff "Reset devices" deactivates every active device, zeroes the yearly counter and writes
 *   exactly one audit row, all inside the caller's transaction (admin UI in Phase 6).
 * Device-initiated deactivation (/api/v1/licenses/deactivate) never counts toward the limit and lives elsewhere.
 */
import "server-only";
import { type PrismaClient, type TeamRole } from "@/generated/prisma/client";
import { audit, requireReason, type AuditActor } from "@/lib/audit";
import { fromIstParts, istCalendarYear } from "@/lib/dates";
import { db as defaultDb, type Tx } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import { can, DESTRUCTIVE_ACTIONS, isStaffRole } from "@/lib/rbac";
import type { UpdateDeviceInput } from "@/lib/validation/license-actions";
import {
  ACCOUNT_DEVICE_SELECT,
  licenseAllowsDeviceChanges,
  toAccountDevice,
  UNASSIGNED_LOCATION,
  type AccountDevice,
} from "./account";
import { redactLicenseKeys } from "./keys";
import { consumeSelfServiceReset, selfServiceLimitMessage, selfServiceResetsLeft, SELF_SERVICE_RESETS_PER_YEAR } from "./status";

export const DEVICE_ALREADY_DEACTIVATED_MESSAGE = "This device is already deactivated.";
export const DEVICE_INACTIVE_MESSAGE = "This device is deactivated, so it can\u2019t be renamed or moved.";
export const LICENSE_NOT_USABLE_MESSAGE =
  "This license isn\u2019t active, so its devices can\u2019t be deactivated here. Contact support if you need help.";
export const FOREIGN_LOCATION_MESSAGE = "Choose one of your locations.";

/** Actor for self-service changes: the signed-in member (LicenseEvent.actor and AccountActivity.actorName). */
export type MemberActor = { id: string; name: string };

/** Locks the license row until commit; null when it does not exist (or is outside `accountId` when given). */
async function lockLicense(tx: Tx, licenseId: string, accountId?: string): Promise<boolean> {
  const rows =
    accountId === undefined
      ? await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "License" WHERE "id" = ${licenseId} FOR UPDATE`
      : await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "License" WHERE "id" = ${licenseId} AND "accountId" = ${accountId} FOR UPDATE`;
  return rows.length === 1;
}

/** Seconds until the next IST calendar year starts, when the yearly counter frees up again. */
export function secondsUntilNextIstYear(now: Date): number {
  const next = fromIstParts({ year: istCalendarYear(now) + 1, month: 1, day: 1 });
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

export function resetLimitError(limitPerYear: number, now: Date): ApiError {
  const retryAfterSec = secondsUntilNextIstYear(now);
  return new ApiError(429, "reset_limit", selfServiceLimitMessage(limitPerYear), {
    details: { selfServiceResetsLeft: 0, selfServiceResetsPerYear: limitPerYear, retryAfterSec },
    headers: { "Retry-After": String(retryAfterSec) },
  });
}

export type SelfServiceDeactivateInput = {
  /** The caller's server-side active account (requireAccountRole); never from the client. */
  accountId: string;
  role: TeamRole;
  licenseId: string;
  deviceId: string;
  user: MemberActor;
  /** Settings value licensing.selfServiceResetsPerYear. */
  limitPerYear?: number;
  now?: Date;
};

export type SelfServiceDeactivateResult = {
  device: AccountDevice;
  devicesUsed: number;
  deviceLimit: number;
  selfServiceResetsLeft: number;
  selfServiceResetsPerYear: number;
};

/** LicenseEvent/AccountActivity text comes from devices and members; never let a key-shaped string reach a table. */
function safeText(text: string, max = 200): string {
  return redactLicenseKeys(text).slice(0, max);
}

/**
 * Deactivates one device of one license of the caller's account and counts one self-service deactivation.
 * 404 for a license outside the account or a device of another license, 409 `already_deactivated`, 409
 * `license_not_usable` (expired, suspended or revoked), 429 `reset_limit` once the yearly limit is used up.
 * Writes deactivatedAt/deactivatedBy "customer", the counter, a `deactivated` LicenseEvent (actor = member name)
 * and the "Deactivated device" activity entry in one transaction.
 */
export async function selfServiceDeactivate(
  input: SelfServiceDeactivateInput,
  client: PrismaClient = defaultDb,
): Promise<SelfServiceDeactivateResult> {
  const now = input.now ?? new Date();
  const limit = input.limitPerYear ?? SELF_SERVICE_RESETS_PER_YEAR;
  const result = await client.$transaction(async (tx) => {
    if (!(await lockLicense(tx, input.licenseId, input.accountId))) throw errors.notFound("License");
    const license = await tx.license.findUniqueOrThrow({
      where: { id: input.licenseId },
      select: { id: true, status: true, expiresAt: true, deviceLimit: true, selfServiceResets: true, resetsYear: true },
    });
    const device = await tx.deviceActivation.findFirst({
      where: { id: input.deviceId, licenseId: license.id },
      select: { id: true, name: true, deactivatedAt: true },
    });
    if (!device) throw errors.notFound("Device");
    if (device.deactivatedAt) throw errors.conflict("already_deactivated", DEVICE_ALREADY_DEACTIVATED_MESSAGE);
    if (!licenseAllowsDeviceChanges(license, now)) throw errors.conflict("license_not_usable", LICENSE_NOT_USABLE_MESSAGE);
    const next = consumeSelfServiceReset(license, now, limit);
    if (!next) throw resetLimitError(limit, now);

    // Conditional: the device API may have deactivated it in the meantime (it does not count toward the limit).
    const claimed = await tx.deviceActivation.updateMany({
      where: { id: device.id, licenseId: license.id, deactivatedAt: null },
      data: { deactivatedAt: now, deactivatedBy: "customer" },
    });
    if (claimed.count !== 1) throw errors.conflict("already_deactivated", DEVICE_ALREADY_DEACTIVATED_MESSAGE);
    const counted = await tx.license.updateMany({
      where: { id: license.id, selfServiceResets: license.selfServiceResets, resetsYear: license.resetsYear },
      data: next,
    });
    if (counted.count !== 1) throw new Error("Self-service counter changed while the license row was locked");

    await tx.licenseEvent.create({
      data: { licenseId: license.id, type: "deactivated", actor: safeText(input.user.name), detail: safeText(device.name), createdAt: now },
    });
    await tx.accountActivity.create({
      data: {
        accountId: input.accountId,
        actorId: input.user.id,
        actorName: safeText(input.user.name),
        action: "Deactivated device",
        target: safeText(`${license.id} \u00B7 ${device.name}`),
        kind: "license",
        createdAt: now,
      },
    });
    const updated = await tx.deviceActivation.findUniqueOrThrow({ where: { id: device.id }, select: ACCOUNT_DEVICE_SELECT });
    const devicesUsed = await tx.deviceActivation.count({ where: { licenseId: license.id, deactivatedAt: null } });
    return {
      device: toAccountDevice(updated, input.role, now),
      devicesUsed,
      deviceLimit: license.deviceLimit,
      selfServiceResetsLeft: selfServiceResetsLeft(next, now, limit),
      selfServiceResetsPerYear: limit,
    };
  });
  log.info("device_deactivated", {
    licenseId: input.licenseId,
    deviceId: input.deviceId,
    by: "customer",
    userId: input.user.id,
    resetsLeft: result.selfServiceResetsLeft,
  });
  return result;
}

export type RenameOrMoveDeviceInput = {
  accountId: string;
  role: TeamRole;
  deviceId: string;
  changes: UpdateDeviceInput;
  user: MemberActor;
  now?: Date;
};

/**
 * Renames a device and/or moves it to a location of the same account (null = unassigned). 404 for a device outside
 * the account, 409 `device_inactive` for a deactivated device, 422 `validation_failed` (fieldErrors.locationId) for a
 * location that is not the account's. Changes are recorded as "Renamed device" / "Moved device" activity entries.
 */
export async function renameOrMoveDevice(input: RenameOrMoveDeviceInput, client: PrismaClient = defaultDb): Promise<AccountDevice> {
  const now = input.now ?? new Date();
  return client.$transaction(async (tx) => {
    const device = await tx.deviceActivation.findFirst({
      where: { id: input.deviceId, license: { accountId: input.accountId } },
      select: { id: true, name: true, licenseId: true, locationId: true, deactivatedAt: true },
    });
    if (!device) throw errors.notFound("Device");
    if (device.deactivatedAt) throw errors.conflict("device_inactive", DEVICE_INACTIVE_MESSAGE);

    const data: { name?: string; locationId?: string | null } = {};
    const activity: Array<{ action: string; target: string }> = [];
    const { name, locationId } = input.changes;
    if (name !== undefined && name !== device.name) {
      data.name = name;
      activity.push({ action: "Renamed device", target: `${device.licenseId} \u00B7 ${device.name} \u2192 ${name}` });
    }
    if (locationId !== undefined && locationId !== device.locationId) {
      let locationName = UNASSIGNED_LOCATION;
      if (locationId !== null) {
        const location = await tx.location.findFirst({
          where: { id: locationId, accountId: input.accountId },
          select: { name: true },
        });
        if (!location) throw errors.validation({ locationId: FOREIGN_LOCATION_MESSAGE });
        locationName = location.name;
      }
      data.locationId = locationId;
      activity.push({ action: "Moved device", target: `${device.licenseId} \u00B7 ${name ?? device.name} \u2192 ${locationName}` });
    }

    if (activity.length > 0) {
      const updated = await tx.deviceActivation.updateMany({ where: { id: device.id, deactivatedAt: null }, data });
      if (updated.count !== 1) throw errors.conflict("device_inactive", DEVICE_INACTIVE_MESSAGE);
      for (const entry of activity) {
        await tx.accountActivity.create({
          data: {
            accountId: input.accountId,
            actorId: input.user.id,
            actorName: safeText(input.user.name),
            action: entry.action,
            target: safeText(entry.target),
            kind: "license",
            createdAt: now,
          },
        });
      }
    }
    const record = await tx.deviceActivation.findUniqueOrThrow({ where: { id: device.id }, select: ACCOUNT_DEVICE_SELECT });
    return toAccountDevice(record, input.role, now);
  });
}

export type AdminResetDevicesInput = {
  licenseId: string;
  /** Staff actor (actorFromStaff) or SYSTEM_ACTOR. */
  actor: AuditActor;
  /** Required: at least 4 characters (422 reason_required / reason_too_long). */
  reason: unknown;
  /** LicenseEvent.actor; defaults to the staff user's name ("System" for the system actor). */
  actorName?: string;
  now?: Date;
};

/** Activity log name for staff actions on a customer's account (as the seed's "Axiomatic Finance"). */
export const SUPPORT_ACTIVITY_ACTOR = "Axiomatic Support";

/**
 * Admin "Reset devices" (DESTRUCTIVE_ACTIONS["licenses.reset_devices"]), inside the caller's transaction: deactivates
 * every active device (deactivatedBy "staff"), zeroes the yearly self-service counter (bypassing the limit), and
 * writes a `devices_reset` LicenseEvent, exactly one AuditLog row with the reason and, for a claimed license, a
 * "Reset devices" activity entry. Returns the number of devices deactivated. 422 without a reason, 403 when the staff
 * role lacks `licenses.manage`, 404 for an unknown license.
 */
export async function adminResetDevices(tx: Tx, input: AdminResetDevicesInput): Promise<number> {
  const reason = requireReason(input.reason);
  if (input.actor.role !== "system") {
    const staffRole = input.actor.role.toUpperCase();
    if (!isStaffRole(staffRole) || !can(staffRole, DESTRUCTIVE_ACTIONS["licenses.reset_devices"].perm)) throw errors.forbidden();
  }
  const now = input.now ?? new Date();
  if (!(await lockLicense(tx, input.licenseId))) throw errors.notFound("License");
  const license = await tx.license.findUniqueOrThrow({ where: { id: input.licenseId }, select: { id: true, accountId: true } });

  const { count } = await tx.deviceActivation.updateMany({
    where: { licenseId: license.id, deactivatedAt: null },
    data: { deactivatedAt: now, deactivatedBy: "staff" },
  });
  await tx.license.update({ where: { id: license.id }, data: { selfServiceResets: 0, resetsYear: istCalendarYear(now) } });

  let actorName = input.actorName?.trim() || null;
  if (!actorName && input.actor.id) {
    actorName = (await tx.user.findUnique({ where: { id: input.actor.id }, select: { name: true } }))?.name ?? null;
  }
  const detail = `${count} ${count === 1 ? "device" : "devices"} deactivated`;
  await tx.licenseEvent.create({
    data: { licenseId: license.id, type: "devices_reset", actor: safeText(actorName ?? "System"), detail, createdAt: now },
  });
  await audit(tx, input.actor, {
    action: "Reset devices",
    target: license.id,
    targetType: "license",
    targetId: license.id,
    reason,
    detail: `${detail}; self-service deactivations reset`,
  });
  if (license.accountId) {
    await tx.accountActivity.create({
      data: {
        accountId: license.accountId,
        actorName: SUPPORT_ACTIVITY_ACTOR,
        action: "Reset devices",
        target: `${license.id} \u00B7 ${detail}`,
        kind: "license",
        createdAt: now,
      },
    });
  }
  return count;
}
