/**
 * Device-limit helpers shared by fulfilment, checkout and the portal read models (decisions.md Phase 4 fix pass
 * "Device limit"):
 * - countActiveDevices(): active devices of the given licenses only, grouped in SQL through the licenseId prefix of
 *   DeviceActivation_licenseId_fingerprint_idx. Never use Prisma's `_count` of `devices` on a license list: it
 *   aggregates the whole DeviceActivation table before joining (seconds at 25 lakh licenses).
 * - trimDevicesToLimit(): when a license's deviceLimit goes down (a per-unit renewal for fewer terminals, a trial
 *   upgraded to a smaller plan, later an admin edit), the devices above the new limit are deactivated, least recently
 *   seen first. Their next /validate answers 403 `device_deactivated`. The /validate hot path never counts devices.
 * Free of `server-only` so fulfilment (webhooks, reconciliation, scripts) can use it.
 */
import type { Db, Tx } from "@/lib/db";
import { redactLicenseKeys } from "./keys";

/** DeviceActivation.deactivatedBy when the device limit was lowered (the others: customer | device | staff). */
export const DEACTIVATED_BY_SYSTEM = "system";

/** Active devices per license for `licenseIds` (deduplicated); licenses without active devices map to 0. */
export async function countActiveDevices(db: Db, licenseIds: readonly string[]): Promise<Map<string, number>> {
  const ids = [...new Set(licenseIds)];
  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return counts;
  const rows = await db.deviceActivation.groupBy({
    by: ["licenseId"],
    where: { licenseId: { in: ids }, deactivatedAt: null },
    _count: { _all: true },
  });
  for (const row of rows) counts.set(row.licenseId, row._count._all);
  return counts;
}

/**
 * Active devices per license of one business account, without listing the ids (an account may hold thousands of
 * licenses): the relation filter becomes a semi-join on License_accountId_idx, then the same licenseId index.
 */
export async function countActiveDevicesForAccount(db: Db, accountId: string): Promise<Map<string, number>> {
  const rows = await db.deviceActivation.groupBy({
    by: ["licenseId"],
    where: { license: { accountId }, deactivatedAt: null },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.licenseId, row._count._all]));
}

export type TrimDevicesInput = {
  licenseId: string;
  /** License.accountId: the "Deactivated device" activity entry goes to this account (none for guest licenses). */
  accountId: string | null;
  /** The license's new deviceLimit. */
  limit: number;
  at: Date;
  /** LicenseEvent.actor and AccountActivity.actorName, e.g. "System". */
  actor: string;
};

export type TrimmedDevice = { id: string; name: string };

/**
 * Deactivates the active devices above `limit`, least recently seen first (lastSeenAt, then activatedAt, then id), so
 * the computers in daily use keep their slots: deactivatedAt = at, deactivatedBy "system", one `deactivated`
 * LicenseEvent and one "Deactivated device" activity entry per device. Returns the deactivated devices (none when the
 * license is within its limit). Never counts toward the yearly self-service limit.
 *
 * The caller must hold the License row lock (SELECT ... FOR UPDATE) in `tx`, the lock activation takes too, so no
 * device can be activated between the count and the update.
 */
export async function trimDevicesToLimit(tx: Tx, input: TrimDevicesInput): Promise<TrimmedDevice[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 0) throw new RangeError("Device limit must be a non-negative integer");
  if (Number.isNaN(input.at.getTime())) throw new RangeError("Invalid deactivation date");
  const active = await tx.deviceActivation.findMany({
    where: { licenseId: input.licenseId, deactivatedAt: null },
    orderBy: [{ lastSeenAt: "asc" }, { activatedAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
  const excess = active.length - input.limit;
  if (excess <= 0) return [];

  const actor = redactLicenseKeys(input.actor).slice(0, 200);
  const unit = input.limit === 1 ? "device" : "devices";
  const trimmed: TrimmedDevice[] = [];
  for (const device of active.slice(0, excess)) {
    const { count } = await tx.deviceActivation.updateMany({
      where: { id: device.id, deactivatedAt: null },
      data: { deactivatedAt: input.at, deactivatedBy: DEACTIVATED_BY_SYSTEM },
    });
    if (count !== 1) continue;
    trimmed.push(device);
    await tx.licenseEvent.create({
      data: {
        licenseId: input.licenseId,
        type: "deactivated",
        actor,
        detail: redactLicenseKeys(`${device.name} \u00B7 over the new limit of ${input.limit} ${unit}`).slice(0, 200),
        createdAt: input.at,
      },
    });
    if (input.accountId) {
      await tx.accountActivity.create({
        data: {
          accountId: input.accountId,
          actorName: actor,
          action: "Deactivated device",
          target: redactLicenseKeys(`${input.licenseId} \u00B7 ${device.name}`).slice(0, 200),
          kind: "license",
          createdAt: input.at,
        },
      });
    }
  }
  return trimmed;
}
