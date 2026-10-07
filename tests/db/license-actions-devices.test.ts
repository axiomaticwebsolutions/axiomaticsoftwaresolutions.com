/**
 * Self-service device deactivation (3 per license per IST calendar year), the admin device reset that bypasses it,
 * and device rename/move: services with a fixed clock plus the route handlers (roles, IDOR, CSRF).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMITS } from "@/lib/auth/rate-limit";
import { POST as deactivatePOST } from "@/app/api/account/licenses/[id]/devices/[deviceId]/deactivate/route";
import { PATCH as devicePATCH } from "@/app/api/account/devices/[id]/route";
import { ApiError } from "@/lib/http";
import { SYSTEM_ACTOR, type AuditActor } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  adminResetDevices,
  DEVICE_INACTIVE_MESSAGE,
  FOREIGN_LOCATION_MESSAGE,
  LICENSE_NOT_USABLE_MESSAGE,
  selfServiceDeactivate,
} from "@/lib/licensing/devices";
import { selfServiceLimitMessage } from "@/lib/licensing/status";
import {
  bodyOf,
  call,
  DAY,
  errorOf,
  makeCatalog,
  makeDevice,
  makeLicense,
  makeLocation,
  makeMember,
  signIn,
  type Catalog,
  type Member,
} from "./license-actions-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string, options: { maxAge?: number } = {}) => {
      if (options.maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
  headers: async () => new Headers(),
}));

const PORTAL_COPY = "You\u2019ve used all 3 self-service deactivations this year. Contact support to reset devices.";
// 2026-12-31 23:00 IST and 2027-01-01 00:30 IST.
const LATE_2026 = new Date("2026-12-31T17:30:00.000Z");
const EARLY_2027 = new Date("2026-12-31T19:00:00.000Z");

let catalog: Catalog;
let owner: Member;
beforeAll(async () => {
  catalog = await makeCatalog();
});
beforeEach(async () => {
  owner = await makeMember();
  await signIn(jar, owner);
});

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
  expect((error as ApiError).code).toBe(code);
  return error as ApiError;
}

const deactivate = (member: Member, licenseId: string, deviceId: string, now: Date) =>
  selfServiceDeactivate({
    accountId: member.accountId,
    role: "OWNER",
    licenseId,
    deviceId,
    user: { id: member.user.id, name: member.user.name },
    limitPerYear: 3,
    now,
  });

async function devicesFor(licenseId: string, n: number) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await makeDevice(licenseId, { name: `PC ${i + 1}` }));
  return out;
}

const staffActor = async (role: "SUPPORT" | "FINANCE" | "ADMIN"): Promise<AuditActor> => {
  const staff = await db.user.create({
    data: { email: `staff.${Date.now()}.${Math.random()}@example.test`, name: "Sneha Patil", kind: "STAFF", staffRole: role, staffStatus: "ACTIVE" },
  });
  return { id: staff.id, role: role.toLowerCase() as AuditActor["role"], ipPrefix: "103.21.44.x" };
};

describe("self-service deactivation limit", () => {
  it("allows 3 per IST calendar year, refuses the 4th with the portal copy, and starts over on 1 January IST", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, deviceLimit: 6, resetsYear: 2026 });
    const devices = await devicesFor(license.id, 6);
    const left: number[] = [];
    for (const d of devices.slice(0, 3)) left.push((await deactivate(owner, license.id, d.id, LATE_2026)).selfServiceResetsLeft);
    expect(left).toEqual([2, 1, 0]);

    const fourth = devices[3]!;
    const err = await expectApiError(deactivate(owner, license.id, fourth.id, LATE_2026), 429, "reset_limit");
    expect(err.message).toBe(PORTAL_COPY);
    expect(err.message).toBe(selfServiceLimitMessage(3));
    expect(Number(err.headers?.["Retry-After"])).toBe(3600); // 23:00 IST -> 2027-01-01 00:00 IST
    expect((await db.deviceActivation.findUniqueOrThrow({ where: { id: fourth.id } })).deactivatedAt).toBeNull();
    // 23:59 IST on 31 December (18:29 UTC) is still 2026.
    await expectApiError(deactivate(owner, license.id, fourth.id, new Date("2026-12-31T18:29:00.000Z")), 429, "reset_limit");

    // 00:30 IST on 1 January 2027 (still 31 December in UTC): a fresh yearly allowance.
    const result = await deactivate(owner, license.id, fourth.id, EARLY_2027);
    expect(result.selfServiceResetsLeft).toBe(2);
    expect(await db.license.findUniqueOrThrow({ where: { id: license.id }, select: { selfServiceResets: true, resetsYear: true } })).toEqual({
      selfServiceResets: 1,
      resetsYear: 2027,
    });
  });

  it("ignores a stale counter from an earlier year", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, selfServiceResets: 3, resetsYear: 2025 });
    const [device] = await devicesFor(license.id, 1);
    const result = await deactivate(owner, license.id, device!.id, LATE_2026);
    expect(result).toMatchObject({ selfServiceResetsLeft: 2, devicesUsed: 0, deviceLimit: 3 });
  });

  it("writes the device change, the counter, one LicenseEvent and one activity entry", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const [device, other] = await devicesFor(license.id, 2);
    const now = new Date();
    const result = await deactivate(owner, license.id, device!.id, now);
    expect(result.device).toMatchObject({ id: device!.id, active: false, deactivatedBy: "customer", canDeactivate: false });
    expect(result.devicesUsed).toBe(1);
    const row = await db.deviceActivation.findUniqueOrThrow({ where: { id: device!.id } });
    expect(row).toMatchObject({ deactivatedAt: now, deactivatedBy: "customer" });
    expect((await db.deviceActivation.findUniqueOrThrow({ where: { id: other!.id } })).deactivatedAt).toBeNull();
    expect(await db.licenseEvent.findMany({ where: { licenseId: license.id } })).toEqual([
      expect.objectContaining({ type: "deactivated", actor: "Priya Sharma", detail: "PC 1" }),
    ]);
    expect(await db.accountActivity.findMany({ where: { accountId: owner.accountId } })).toEqual([
      expect.objectContaining({ action: "Deactivated device", target: `${license.id} \u00B7 PC 1`, kind: "license", actorId: owner.user.id, actorName: "Priya Sharma" }),
    ]);
  });

  it("holds under concurrency: the last slot goes to exactly one of two parallel requests", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, selfServiceResets: 2 });
    const [a, b] = await devicesFor(license.id, 2);
    const now = new Date();
    const results = await Promise.allSettled([deactivate(owner, license.id, a!.id, now), deactivate(owner, license.id, b!.id, now)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected?.reason as ApiError).code).toBe("reset_limit");
    expect(await db.deviceActivation.count({ where: { licenseId: license.id, deactivatedAt: { not: null } } })).toBe(1);
    expect((await db.license.findUniqueOrThrow({ where: { id: license.id } })).selfServiceResets).toBe(3);
  });

  it("refuses devices of another license, deactivated devices and licenses that are not usable", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const second = await makeLicense(catalog, { accountId: owner.accountId });
    const [foreignDevice] = await devicesFor(second.license.id, 1);
    await expectApiError(deactivate(owner, license.id, foreignDevice!.id, new Date()), 404, "not_found");
    const gone = await makeDevice(license.id, { deactivatedAt: new Date(Date.now() - DAY) });
    await expectApiError(deactivate(owner, license.id, gone.id, new Date()), 409, "already_deactivated");
    const expired = await makeLicense(catalog, { accountId: owner.accountId, expiresAt: new Date(Date.now() - DAY) });
    const [old] = await devicesFor(expired.license.id, 1);
    const err = await expectApiError(deactivate(owner, expired.license.id, old!.id, new Date()), 409, "license_not_usable");
    expect(err.message).toBe(LICENSE_NOT_USABLE_MESSAGE);
    expect((await db.license.findUniqueOrThrow({ where: { id: license.id } })).selfServiceResets).toBe(0);
  });
});

describe("admin device reset", () => {
  it("bypasses the limit: deactivates every active device, zeroes the counter and audits exactly once", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, deviceLimit: 5 });
    const devices = await devicesFor(license.id, 5);
    for (const d of devices.slice(0, 3)) await deactivate(owner, license.id, d.id, new Date());
    await expectApiError(deactivate(owner, license.id, devices[3]!.id, new Date()), 429, "reset_limit");

    const actor = await staffActor("SUPPORT");
    const count = await db.$transaction((tx) =>
      adminResetDevices(tx, { licenseId: license.id, actor, reason: "Hardware failed at the counter" }),
    );
    expect(count).toBe(2);
    const rows = await db.deviceActivation.findMany({ where: { licenseId: license.id } });
    expect(rows.every((r) => r.deactivatedAt !== null)).toBe(true);
    expect(rows.filter((r) => r.deactivatedBy === "staff").map((r) => r.id).sort()).toEqual([devices[3]!.id, devices[4]!.id].sort());
    expect(await db.license.findUniqueOrThrow({ where: { id: license.id }, select: { selfServiceResets: true } })).toEqual({ selfServiceResets: 0 });

    const audits = await db.auditLog.findMany({ where: { targetType: "license", targetId: license.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: actor.id,
      actorRole: "support",
      action: "Reset devices",
      target: license.id,
      reason: "Hardware failed at the counter",
      detail: "2 devices deactivated; self-service deactivations reset",
      ipPrefix: "103.21.44.x",
    });
    const event = await db.licenseEvent.findFirstOrThrow({ where: { licenseId: license.id, type: "devices_reset" } });
    expect(event).toMatchObject({ actor: "Sneha Patil", detail: "2 devices deactivated" });
    expect(await db.accountActivity.count({ where: { accountId: owner.accountId, action: "Reset devices" } })).toBe(1);

    // The customer has a fresh allowance again.
    const fresh = await makeDevice(license.id, { name: "New counter PC" });
    expect((await deactivate(owner, license.id, fresh.id, new Date())).selfServiceResetsLeft).toBe(2);
  });

  it("needs a reason and the licenses.manage permission; nothing changes and nothing is audited otherwise", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, selfServiceResets: 3 });
    await devicesFor(license.id, 2);
    const support = await staffActor("SUPPORT");
    for (const reason of [undefined, "", "  ok ", 42]) {
      await expectApiError(
        db.$transaction((tx) => adminResetDevices(tx, { licenseId: license.id, actor: support, reason })),
        422,
        "reason_required",
      );
    }
    const finance = await staffActor("FINANCE");
    await expectApiError(
      db.$transaction((tx) => adminResetDevices(tx, { licenseId: license.id, actor: finance, reason: "Customer asked" })),
      403,
      "forbidden",
    );
    await expectApiError(
      db.$transaction((tx) => adminResetDevices(tx, { licenseId: "LIC-T00000000", actor: support, reason: "Customer asked" })),
      404,
      "not_found",
    );
    expect(await db.auditLog.count({ where: { targetId: license.id } })).toBe(0);
    expect(await db.deviceActivation.count({ where: { licenseId: license.id, deactivatedAt: null } })).toBe(2);
    expect((await db.license.findUniqueOrThrow({ where: { id: license.id } })).selfServiceResets).toBe(3);
  });

  it("works for the system actor and for unclaimed guest licenses (no activity entry)", async () => {
    const { license } = await makeLicense(catalog, { accountId: null });
    await devicesFor(license.id, 1);
    const count = await db.$transaction((tx) =>
      adminResetDevices(tx, { licenseId: license.id, actor: SYSTEM_ACTOR, reason: "Automated cleanup" }),
    );
    expect(count).toBe(1);
    expect(await db.auditLog.count({ where: { targetId: license.id, actorRole: "system" } })).toBe(1);
    expect((await db.licenseEvent.findFirstOrThrow({ where: { licenseId: license.id, type: "devices_reset" } })).actor).toBe("System");
  });

  it("rolls back with the caller's transaction (the audit row goes with it)", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    await devicesFor(license.id, 1);
    const actor = await staffActor("ADMIN");
    await expect(
      db.$transaction(async (tx) => {
        await adminResetDevices(tx, { licenseId: license.id, actor, reason: "Testing rollback" });
        throw new Error("later step failed");
      }),
    ).rejects.toThrow("later step failed");
    expect(await db.auditLog.count({ where: { targetId: license.id } })).toBe(0);
    expect(await db.deviceActivation.count({ where: { licenseId: license.id, deactivatedAt: null } })).toBe(1);
  });
});

const deactivateRoute = (licenseId: string, deviceId: string, opts: { csrf?: boolean; body?: unknown } = {}) =>
  call(jar, deactivatePOST, `/api/account/licenses/${licenseId}/devices/${deviceId}/deactivate`, {
    method: "POST",
    params: { id: licenseId, deviceId },
    ...opts,
  });

describe("POST /api/account/licenses/:id/devices/:deviceId/deactivate", () => {
  it("deactivates for an owner and reports the remaining allowance", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const [device] = await devicesFor(license.id, 2);
    const res = await deactivateRoute(license.id, device!.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(res)).toMatchObject({
      status: "deactivated",
      device: { id: device!.id, active: false, deactivatedBy: "customer" },
      devicesUsed: 1,
      deviceLimit: 3,
      selfServiceResetsLeft: 2,
      selfServiceResetsPerYear: 3,
    });
  });

  it("answers the 4th deactivation of the year with 429 reset_limit and the portal copy", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, deviceLimit: 4 });
    const devices = await devicesFor(license.id, 4);
    for (const d of devices.slice(0, 3)) expect((await deactivateRoute(license.id, d.id)).status).toBe(200);
    const res = await deactivateRoute(license.id, devices[3]!.id);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(errorOf(await bodyOf(res))).toMatchObject({ code: "reset_limit", message: PORTAL_COPY, selfServiceResetsLeft: 0 });
  });

  it("lets Technical contacts deactivate; Viewer and Billing get 403", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const [a, b] = await devicesFor(license.id, 2);
    for (const role of ["VIEWER", "BILLING"] as const) {
      await signIn(jar, await makeMember({ accountId: owner.accountId, role }));
      const res = await deactivateRoute(license.id, a!.id);
      expect(res.status, role).toBe(403);
      expect(errorOf(await bodyOf(res)).code).toBe("forbidden");
    }
    await signIn(jar, await makeMember({ accountId: owner.accountId, role: "TECHNICAL" }));
    expect((await deactivateRoute(license.id, b!.id)).status).toBe(200);
    expect(await db.deviceActivation.count({ where: { licenseId: license.id, deactivatedAt: null } })).toBe(1);
  });

  it("answers 404 for another account's license or device (IDOR) and changes nothing", async () => {
    const stranger = await makeMember({ name: "Other Owner" });
    const theirs = await makeLicense(catalog, { accountId: stranger.accountId });
    const [theirDevice] = await devicesFor(theirs.license.id, 1);
    const mine = await makeLicense(catalog, { accountId: owner.accountId });
    await devicesFor(mine.license.id, 1);
    expect((await deactivateRoute(theirs.license.id, theirDevice!.id)).status).toBe(404);
    expect((await deactivateRoute(mine.license.id, theirDevice!.id)).status).toBe(404);
    expect((await deactivateRoute("bad id", theirDevice!.id)).status).toBe(404);
    expect((await db.deviceActivation.findUniqueOrThrow({ where: { id: theirDevice!.id } })).deactivatedAt).toBeNull();
    expect((await db.license.findUniqueOrThrow({ where: { id: theirs.license.id } })).selfServiceResets).toBe(0);
  });

  it("requires CSRF and accepts only an empty body", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const [device] = await devicesFor(license.id, 1);
    expect(errorOf(await bodyOf(await deactivateRoute(license.id, device!.id, { csrf: false }))).code).toBe("csrf_failed");
    expect((await deactivateRoute(license.id, device!.id, { body: { force: true } })).status).toBe(422);
    expect((await deactivateRoute(license.id, device!.id, { body: {} })).status).toBe(200);
  });
});

const patchRoute = (deviceId: string, body: unknown, opts: { csrf?: boolean } = {}) =>
  call(jar, devicePATCH, `/api/account/devices/${deviceId}`, { method: "PATCH", body, params: { id: deviceId }, ...opts });

describe("PATCH /api/account/devices/:id", () => {
  it("renames a device and records the change", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const device = await makeDevice(license.id, { name: "Old name" });
    const res = await patchRoute(device.id, { name: "  Billing   counter PC " });
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).device).toMatchObject({ id: device.id, name: "Billing counter PC", licenseId: license.id });
    expect((await db.deviceActivation.findUniqueOrThrow({ where: { id: device.id } })).name).toBe("Billing counter PC");
    expect(await db.accountActivity.findMany({ where: { accountId: owner.accountId } })).toEqual([
      expect.objectContaining({ action: "Renamed device", target: `${license.id} \u00B7 Old name \u2192 Billing counter PC`, kind: "license" }),
    ]);
  });

  it("moves a device to one of the account's locations or unassigns it; foreign locations are refused", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const device = await makeDevice(license.id, { name: "Counter" });
    const branch = await makeLocation(owner.accountId, "Kothrud branch");
    const stranger = await makeMember({ name: "Other Owner" });
    const foreign = await makeLocation(stranger.accountId, "Their shop");

    const moved = await patchRoute(device.id, { locationId: branch.id });
    expect((await bodyOf(moved)).device).toMatchObject({ locationId: branch.id, locationName: "Kothrud branch" });

    const refused = await patchRoute(device.id, { locationId: foreign.id });
    expect(refused.status).toBe(422);
    expect(errorOf(await bodyOf(refused)).fieldErrors).toEqual({ locationId: [FOREIGN_LOCATION_MESSAGE] });
    expect((await db.deviceActivation.findUniqueOrThrow({ where: { id: device.id } })).locationId).toBe(branch.id);

    const unassigned = await patchRoute(device.id, { locationId: null });
    expect((await bodyOf(unassigned)).device).toMatchObject({ locationId: null, locationName: "Unassigned" });
    expect(await db.accountActivity.count({ where: { accountId: owner.accountId, action: "Moved device" } })).toBe(2);
  });

  it("refuses deactivated devices, other accounts' devices, Viewers and bad bodies", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const gone = await makeDevice(license.id, { deactivatedAt: new Date(Date.now() - DAY) });
    const inactive = await patchRoute(gone.id, { name: "Back again" });
    expect(inactive.status).toBe(409);
    expect(errorOf(await bodyOf(inactive))).toMatchObject({ code: "device_inactive", message: DEVICE_INACTIVE_MESSAGE });

    const stranger = await makeMember({ name: "Other Owner" });
    const theirs = await makeLicense(catalog, { accountId: stranger.accountId });
    const theirDevice = await makeDevice(theirs.license.id, { name: "Their PC" });
    expect((await patchRoute(theirDevice.id, { name: "Mine now" })).status).toBe(404);
    expect((await db.deviceActivation.findUniqueOrThrow({ where: { id: theirDevice.id } })).name).toBe("Their PC");

    const device = await makeDevice(license.id, { name: "Counter" });
    expect((await patchRoute(device.id, { name: "x".repeat(81) })).status).toBe(422);
    expect((await patchRoute(device.id, {})).status).toBe(422);
    expect((await patchRoute(device.id, { name: "PC", licenseId: theirs.license.id })).status).toBe(422);
    expect(errorOf(await bodyOf(await patchRoute(device.id, { name: "PC" }, { csrf: false }))).code).toBe("csrf_failed");

    await signIn(jar, await makeMember({ accountId: owner.accountId, role: "VIEWER" }));
    expect((await patchRoute(device.id, { name: "Viewer rename" })).status).toBe(403);
    expect((await db.deviceActivation.findUniqueOrThrow({ where: { id: device.id } })).name).toBe("Counter");
  });

  it("limits device actions to 60 per 10 minutes per user", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const device = await makeDevice(license.id, { name: "Counter" });
    const rule = RATE_LIMITS.accountDevices(owner.user.id);
    await db.rateLimitBucket.create({ data: { key: rule.key, count: rule.limit, resetAt: new Date(Date.now() + 60_000) } });
    const res = await patchRoute(device.id, { name: "One more" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    await db.rateLimitBucket.deleteMany({ where: { key: rule.key } });
  });
});
