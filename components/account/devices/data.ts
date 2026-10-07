/**
 * Server loader of the device fleet (/account/devices): every device on the active account's licenses (filtered in
 * the browser), the stat tiles, the account's locations, and per license the self-service deactivations left this
 * year so bulk deactivation can skip what the server would refuse.
 */
import "server-only";
import type { TeamRole } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { listAccountDevices, selfServiceLimit, type AccountDeviceFleet } from "@/lib/licensing/account";
import { isUsableLicense, selfServiceResetsLeft } from "@/lib/licensing/status";
import type { DeviceRow } from "./model";

export type DeviceFleetData = {
  rows: DeviceRow[];
  truncated: boolean;
  stats: AccountDeviceFleet["stats"];
  locations: Array<{ id: string; name: string }>;
  /** Self-service deactivations left this IST calendar year, per license id. */
  resetsLeft: Record<string, number>;
  /** Yearly self-service limit (Admin > Settings, default 3). */
  perYear: number;
  now: string;
};

export async function loadDeviceFleet(scope: { accountId: string; role: TeamRole }, now: Date = new Date()): Promise<DeviceFleetData> {
  const fleet = await listAccountDevices(db, scope, { status: "all", location: "all", q: "" }, now);
  const licenseIds = [...new Set(fleet.devices.map((d) => d.licenseId))];
  const licenses = licenseIds.length
    ? await db.license.findMany({
        where: { accountId: scope.accountId, id: { in: licenseIds } },
        select: { id: true, status: true, expiresAt: true, selfServiceResets: true, resetsYear: true },
      })
    : [];
  const perYear = await selfServiceLimit(db);
  const usable = new Map(licenses.map((l) => [l.id, isUsableLicense(l, now)]));
  return {
    rows: fleet.devices.map((d) => ({ ...d, licenseUsable: usable.get(d.licenseId) ?? false })),
    truncated: fleet.truncated,
    stats: fleet.stats,
    locations: fleet.locations,
    resetsLeft: Object.fromEntries(licenses.map((l) => [l.id, selfServiceResetsLeft(l, now, perYear)])),
    perYear,
    now: now.toISOString(),
  };
}
