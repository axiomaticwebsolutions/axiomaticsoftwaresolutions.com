/**
 * Locations of the active business account (Devices > "Manage locations"; decisions.md Phase 5): list (every role),
 * add, rename and delete (team permission `devices.manage`, enforced by the routes). Names are unique per account
 * (case-insensitive) and an account holds at most MAX_LOCATIONS. Deleting a location moves its devices to
 * "Unassigned" in the same transaction. New activations are unassigned. Writes lock the account row so the uniqueness
 * and count checks hold under concurrent requests. No activity entries (the prototype logs none for locations).
 */
import "server-only";
import type { Db, Tx } from "@/lib/db";
import { db as defaultDb } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { locationExistsMessage, locationLimitMessage, MAX_LOCATIONS } from "@/lib/validation/portal";

export const LOCATION_NOT_FOUND = "Location";

export type LocationView = {
  id: string;
  name: string;
  /** Active devices at this location. */
  activeDevices: number;
};

export type LocationList = {
  locations: LocationView[];
  /** Active devices of the account without a location ("Unassigned"). */
  unassignedDevices: number;
};

export async function listLocations(client: Db, accountId: string): Promise<LocationList> {
  const locations = await client.location.findMany({
    where: { accountId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
  const counts = locations.length
    ? await client.deviceActivation.groupBy({
        by: ["locationId"],
        where: { locationId: { in: locations.map((l) => l.id) }, deactivatedAt: null, license: { accountId } },
        _count: { _all: true },
      })
    : [];
  const byLocation = new Map(counts.map((c) => [c.locationId, c._count._all]));
  const unassignedDevices = await client.deviceActivation.count({
    where: { locationId: null, deactivatedAt: null, license: { accountId } },
  });
  return {
    locations: locations.map((l) => ({ id: l.id, name: l.name, activeDevices: byLocation.get(l.id) ?? 0 })),
    unassignedDevices,
  };
}

async function lockAccount(tx: Tx, accountId: string): Promise<void> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "BusinessAccount" WHERE "id" = ${accountId} FOR UPDATE`;
  if (locked.length === 0) throw errors.notFound("Account");
}

async function assertNameFree(tx: Tx, accountId: string, name: string, exceptId?: string): Promise<void> {
  const clash = await tx.location.findFirst({
    where: { accountId, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw errors.validation({ name: locationExistsMessage(name) });
}

/** POST /api/account/locations. 422 fieldErrors.name for a duplicate name, 409 `location_limit` past the cap. */
export async function createLocation(accountId: string, name: string, client: typeof defaultDb = defaultDb): Promise<LocationView> {
  return client.$transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const count = await tx.location.count({ where: { accountId } });
    if (count >= MAX_LOCATIONS) throw new ApiError(409, "location_limit", locationLimitMessage());
    await assertNameFree(tx, accountId, name);
    const created = await tx.location.create({ data: { accountId, name }, select: { id: true, name: true } });
    return { ...created, activeDevices: 0 };
  });
}

async function activeDevicesAt(client: Db, accountId: string, locationId: string): Promise<number> {
  return client.deviceActivation.count({ where: { locationId, deactivatedAt: null, license: { accountId } } });
}

/** PATCH /api/account/locations/:id. 404 for locations of other accounts. */
export async function renameLocation(
  accountId: string,
  locationId: string,
  name: string,
  client: typeof defaultDb = defaultDb,
): Promise<LocationView> {
  return client.$transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const location = await tx.location.findFirst({ where: { id: locationId, accountId }, select: { id: true } });
    if (!location) throw errors.notFound(LOCATION_NOT_FOUND);
    await assertNameFree(tx, accountId, name, location.id);
    const updated = await tx.location.update({ where: { id: location.id }, data: { name }, select: { id: true, name: true } });
    return { ...updated, activeDevices: await activeDevicesAt(tx, accountId, location.id) };
  });
}

/**
 * DELETE /api/account/locations/:id: moves every device of the location (active or not) to "Unassigned", then deletes
 * it. 404 for locations of other accounts. Returns how many active devices moved.
 */
export async function deleteLocation(
  accountId: string,
  locationId: string,
  client: typeof defaultDb = defaultDb,
): Promise<{ id: string; devicesMoved: number }> {
  return client.$transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const location = await tx.location.findFirst({ where: { id: locationId, accountId }, select: { id: true } });
    if (!location) throw errors.notFound(LOCATION_NOT_FOUND);
    const devicesMoved = await activeDevicesAt(tx, accountId, location.id);
    await tx.deviceActivation.updateMany({ where: { locationId: location.id }, data: { locationId: null } });
    await tx.location.delete({ where: { id: location.id } });
    return { id: location.id, devicesMoved };
  });
}
