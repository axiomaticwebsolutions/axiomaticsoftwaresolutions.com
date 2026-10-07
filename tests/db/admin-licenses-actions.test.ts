/**
 * Admin license actions through their routes (decisions.md Phase 6 "License actions"; test-plan "Permissions"):
 * suspend / reinstate / extend / reset devices / revoke / deactivate device / manual issue / bulk. Each success
 * changes the license, writes a customer-visible LicenseEvent without the reason, an "Axiomatic Support" activity entry
 * and exactly one AuditLog row with the reason; refusals (no reason, wrong typed id, wrong role, wrong state) change
 * nothing. Manual issue never returns the key and emails the owner the last 4 only.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

import * as bulkRoute from "@/app/api/admin/licenses/bulk/route";
import * as deactivateRoute from "@/app/api/admin/licenses/[id]/devices/[deviceId]/deactivate/route";
import * as extendRoute from "@/app/api/admin/licenses/[id]/extend/route";
import * as reinstateRoute from "@/app/api/admin/licenses/[id]/reinstate/route";
import * as resetRoute from "@/app/api/admin/licenses/[id]/reset-devices/route";
import * as revokeRoute from "@/app/api/admin/licenses/[id]/revoke/route";
import * as suspendRoute from "@/app/api/admin/licenses/[id]/suspend/route";
import * as licensesRoute from "@/app/api/admin/licenses/route";
import { STAFF_REVOKED_REASON } from "@/lib/admin/licenses/actions";
import { db } from "@/lib/db";
import { LICENSE_KEY_RE } from "@/lib/licensing/keys";
import { SUPPORT_ACTIVITY_ACTOR } from "@/lib/licensing/devices";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers, type TestSession } from "../support/admin-fixtures";
import { DAY, makeCatalog, makeDevice, makeLicense, makeMember, type Catalog, type Member } from "./license-actions-fixtures";

let callers: AdminCallers;
let catalog: Catalog;
let member: Member;

beforeAll(async () => {
  [callers, catalog] = await Promise.all([makeAdminCallers(), makeCatalog()]);
  member = await makeMember();
});

const REASON = "Customer asked by phone";

function post(handler: unknown, path: string, params: Record<string, string>, session: TestSession | null, body: unknown) {
  return callRoute(jar, handler, { method: "POST", path, params, session, body });
}
const action = (handler: { POST: unknown }, id: string, verb: string, session: TestSession | null, body: unknown = { reason: REASON }) =>
  post(handler.POST, `/api/admin/licenses/${id}/${verb}`, { id }, session, body);

const audits = (id: string) => db.auditLog.findMany({ where: { targetType: "license", targetId: id }, orderBy: { createdAt: "asc" } });
const events = (id: string) => db.licenseEvent.findMany({ where: { licenseId: id }, orderBy: { createdAt: "asc" } });
const activity = (accountId: string) => db.accountActivity.findMany({ where: { accountId }, orderBy: { createdAt: "asc" } });
const fresh = async (opts: Parameters<typeof makeLicense>[1] = { accountId: member.accountId }) => (await makeLicense(catalog, opts)).license;

describe("suspend and reinstate", () => {
  it("suspends with one audit row, an event without the reason and a support activity entry", async () => {
    const license = await fresh();
    const res = await action(suspendRoute, license.id, "suspend", callers.SUPPORT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: license.id, status: "SUSPENDED" });
    expect((await db.license.findUniqueOrThrow({ where: { id: license.id } })).status).toBe("SUSPENDED");
    const rows = await audits(license.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "Suspended license", reason: REASON, actorId: callers.SUPPORT.user.id, actorRole: "support" });
    const evs = await events(license.id);
    expect(evs.at(-1)).toMatchObject({ type: "suspended", actor: callers.SUPPORT.user.name, detail: null });
    const acts = await activity(member.accountId);
    expect(acts.some((a) => a.action === "Suspended license" && a.actorName === SUPPORT_ACTIVITY_ACTOR && a.target.startsWith(license.id))).toBe(true);
  });

  it("refuses a missing reason (422) and a second suspend (409) without writing anything", async () => {
    const license = await fresh();
    const res = await action(suspendRoute, license.id, "suspend", callers.ADMIN, {});
    expect(res.status).toBe(422);
    expect(await errorCodeOf(res)).toBe("reason_required");
    expect(await audits(license.id)).toHaveLength(0);
    expect((await db.license.findUniqueOrThrow({ where: { id: license.id } })).status).toBe("ACTIVE");

    expect((await action(suspendRoute, license.id, "suspend", callers.ADMIN)).status).toBe(200);
    const again = await action(suspendRoute, license.id, "suspend", callers.ADMIN);
    expect(again.status).toBe(409);
    expect(await errorCodeOf(again)).toBe("already_suspended");
    expect(await audits(license.id)).toHaveLength(1);
  });

  it("reinstates to ACTIVE, or to TRIAL for a trial plan; 409 unless suspended", async () => {
    const paid = await fresh({ accountId: member.accountId, status: "SUSPENDED" });
    const trial = await fresh({ accountId: member.accountId, status: "SUSPENDED", plan: catalog.trial, expiresAt: new Date(Date.now() + 10 * DAY) });
    expect(await (await action(reinstateRoute, paid.id, "reinstate", callers.OWNER)).json()).toEqual({ id: paid.id, status: "ACTIVE" });
    expect(await (await action(reinstateRoute, trial.id, "reinstate", callers.OWNER)).json()).toEqual({ id: trial.id, status: "TRIAL" });
    const notSuspended = await action(reinstateRoute, paid.id, "reinstate", callers.OWNER);
    expect(notSuspended.status).toBe(409);
    expect(await errorCodeOf(notSuspended)).toBe("not_suspended");
    expect((await audits(paid.id)).map((a) => a.action)).toEqual(["Reinstated license"]);
  });

  it("is refused for Finance (403) and signed-out callers (401)", async () => {
    const license = await fresh();
    expect((await action(suspendRoute, license.id, "suspend", callers.FINANCE)).status).toBe(403);
    expect((await action(suspendRoute, license.id, "suspend", null)).status).toBe(401);
    expect((await action(suspendRoute, license.id, "suspend", callers.customer)).status).toBe(403);
    expect(await audits(license.id)).toHaveLength(0);
  });

  it("answers 404 for an unknown license (after the reason check)", async () => {
    const res = await action(suspendRoute, "LIC-NOPE0000", "suspend", callers.ADMIN);
    expect(res.status).toBe(404);
  });
});

describe("extend", () => {
  it("moves the end and updates-until dates 30 days on from the later of now and their value", async () => {
    const expiresAt = new Date(Date.now() + 200 * DAY);
    const license = await fresh({ accountId: member.accountId, expiresAt, updatesUntil: expiresAt });
    const res = await action(extendRoute, license.id, "extend", callers.SUPPORT);
    expect(res.status).toBe(200);
    const after = await db.license.findUniqueOrThrow({ where: { id: license.id } });
    expect(after.expiresAt?.getTime()).toBe(expiresAt.getTime() + 30 * DAY);
    expect(after.updatesUntil.getTime()).toBe(expiresAt.getTime() + 30 * DAY);
    const rows = await audits(license.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("Extended license +30 days");
    expect(rows[0]?.detail).toMatch(/^Ends .+ \u2192 .+; updates until .+ \u2192 .+$/);
  });

  it("starts from now for an expired license, keeps a perpetual one perpetual and takes other day counts", async () => {
    const expired = await fresh({ accountId: member.accountId, expiresAt: new Date(Date.now() - 20 * DAY) });
    const before = Date.now();
    await action(extendRoute, expired.id, "extend", callers.ADMIN, { reason: REASON, days: 7 });
    const e = await db.license.findUniqueOrThrow({ where: { id: expired.id } });
    expect(e.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(e.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY);
    expect((await audits(expired.id))[0]?.action).toBe("Extended license +7 days");

    const perpetual = await fresh({ accountId: member.accountId, plan: catalog.oneTime, expiresAt: null, updatesUntil: new Date(Date.now() + 100 * DAY) });
    await action(extendRoute, perpetual.id, "extend", callers.ADMIN);
    const p = await db.license.findUniqueOrThrow({ where: { id: perpetual.id } });
    expect(p.expiresAt).toBeNull();
    expect(p.updatesUntil.getTime()).toBe(perpetual.updatesUntil.getTime() + 30 * DAY);
  });

  it("validates days (422) and refuses revoked licenses (409)", async () => {
    const license = await fresh();
    const bad = await action(extendRoute, license.id, "extend", callers.ADMIN, { reason: REASON, days: 0 });
    expect(bad.status).toBe(422);
    const revoked = await fresh({ accountId: member.accountId, status: "REVOKED" });
    const res = await action(extendRoute, revoked.id, "extend", callers.ADMIN);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe("license_revoked");
    expect(await audits(revoked.id)).toHaveLength(0);
  });
});

describe("devices", () => {
  it("reset devices deactivates every device, zeroes the yearly counter and writes one audit row", async () => {
    const license = await fresh({ accountId: member.accountId, selfServiceResets: 2 });
    await makeDevice(license.id);
    await makeDevice(license.id);
    const res = await action(resetRoute, license.id, "reset-devices", callers.SUPPORT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: license.id, deactivated: 2 });
    expect(await db.deviceActivation.count({ where: { licenseId: license.id, deactivatedAt: null } })).toBe(0);
    expect((await db.license.findUniqueOrThrow({ where: { id: license.id } })).selfServiceResets).toBe(0);
    expect((await audits(license.id)).map((a) => a.action)).toEqual(["Reset devices"]);
  });

  it("deactivates one device as staff without touching the self-service counter", async () => {
    const license = await fresh({ accountId: member.accountId, selfServiceResets: 1 });
    const device = await makeDevice(license.id, { name: "Front desk" });
    const other = await makeDevice(license.id);
    const path = `/api/admin/licenses/${license.id}/devices/${device.id}/deactivate`;
    const res = await post(deactivateRoute.POST, path, { id: license.id, deviceId: device.id }, callers.SUPPORT, { reason: REASON });
    expect(res.status).toBe(200);
    const d = await db.deviceActivation.findUniqueOrThrow({ where: { id: device.id } });
    expect(d.deactivatedAt).not.toBeNull();
    expect(d.deactivatedBy).toBe("staff");
    expect((await db.deviceActivation.findUniqueOrThrow({ where: { id: other.id } })).deactivatedAt).toBeNull();
    expect((await db.license.findUniqueOrThrow({ where: { id: license.id } })).selfServiceResets).toBe(1);
    const rows = await audits(license.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "Deactivated device", reason: REASON });
    expect(rows[0]?.detail).toContain("Front desk");

    const again = await post(deactivateRoute.POST, path, { id: license.id, deviceId: device.id }, callers.SUPPORT, { reason: REASON });
    expect(again.status).toBe(409);
    const foreign = await makeDevice((await fresh()).id);
    const wrong = await post(deactivateRoute.POST, path, { id: license.id, deviceId: foreign.id }, callers.SUPPORT, { reason: REASON });
    expect(wrong.status).toBe(404);
    expect(await audits(license.id)).toHaveLength(1);
  });
});

describe("revoke", () => {
  it("needs licenses.revoke, a reason and the typed license id", async () => {
    const license = await fresh();
    expect((await action(revokeRoute, license.id, "revoke", callers.SUPPORT, { reason: REASON, confirmId: license.id })).status).toBe(403);
    expect((await action(revokeRoute, license.id, "revoke", callers.FINANCE, { reason: REASON, confirmId: license.id })).status).toBe(403);
    const missing = await action(revokeRoute, license.id, "revoke", callers.ADMIN, { reason: REASON });
    expect(missing.status).toBe(422);
    expect(await errorCodeOf(missing)).toBe("confirm_mismatch");
    const wrong = await action(revokeRoute, license.id, "revoke", callers.ADMIN, { reason: REASON, confirmId: "LIC-0" });
    expect(await errorCodeOf(wrong)).toBe("confirm_mismatch");
    expect(await audits(license.id)).toHaveLength(0);

    const res = await action(revokeRoute, license.id, "revoke", callers.ADMIN, { reason: REASON, confirmId: license.id });
    expect(res.status).toBe(200);
    const after = await db.license.findUniqueOrThrow({ where: { id: license.id } });
    expect(after.status).toBe("REVOKED");
    expect(after.revokedReason).toBe(STAFF_REVOKED_REASON);
    expect(after.revokedAt).not.toBeNull();
    expect((await audits(license.id)).map((a) => [a.action, a.reason])).toEqual([["Revoked license", REASON]]);
    // The staff reason never reaches the customer-visible history.
    expect((await events(license.id)).some((e) => (e.detail ?? "").includes(REASON))).toBe(false);

    for (const [handler, verb] of [[suspendRoute, "suspend"], [extendRoute, "extend"], [resetRoute, "reset-devices"]] as const) {
      const refused = await action(handler, license.id, verb, callers.ADMIN);
      expect(refused.status).toBe(409);
      expect(await errorCodeOf(refused)).toBe("license_revoked");
    }
    expect(await audits(license.id)).toHaveLength(1);
  });
});

describe("manual issue", () => {
  const issue = (session: TestSession | null, body: unknown) => post(licensesRoute.POST, "/api/admin/licenses", {}, session, body);

  it("issues a license to the account, never returns the key and emails the owner the last 4 only", async () => {
    const owner = await makeMember();
    const res = await issue(callers.SUPPORT, { accountId: owner.accountId, planId: catalog.annual.id, reason: "Replacement for a lost key" });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toMatch(new RegExp(LICENSE_KEY_RE.source.slice(1, -1)));
    const { license } = JSON.parse(text) as { license: { id: string; keyMasked: string; emailedTo: string | null } };
    expect(Object.keys(license).sort()).toEqual(["emailedTo", "id", "keyMasked", "planName", "productName"]);
    expect(license.emailedTo).toBe(owner.user.email);

    const row = await db.license.findUniqueOrThrow({ where: { id: license.id } });
    expect(row).toMatchObject({ accountId: owner.accountId, orderId: null, planId: catalog.annual.id, status: "ACTIVE", deviceLimit: 3 });
    expect(license.keyMasked.endsWith(row.keyLast4)).toBe(true);
    expect(license.keyMasked).toContain("\u2022\u2022\u2022\u2022");

    const mail = await db.outboxEmail.findUniqueOrThrow({ where: { dedupeKey: `license_issued:${license.id}` } });
    expect(mail.to).toBe(owner.user.email);
    expect(mail.text).toContain(row.keyLast4);
    expect(mail.text).toContain(`/account/licenses/${license.id}`);
    expect(`${mail.html}${mail.text}`).not.toMatch(new RegExp(LICENSE_KEY_RE.source.slice(1, -1)));

    const rows = await audits(license.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "Issued license", reason: "Replacement for a lost key" });
    expect((await events(license.id))[0]).toMatchObject({ type: "issued", actor: callers.SUPPORT.user.name, detail: "Issued by staff" });
  });

  it("refuses a missing reason, unknown accounts, add-on plans and Finance without creating anything", async () => {
    const owner = await makeMember();
    const count = () => db.license.count({ where: { accountId: owner.accountId } });
    const noReason = await issue(callers.ADMIN, { accountId: owner.accountId, planId: catalog.annual.id });
    expect(noReason.status).toBe(422);
    expect(await errorCodeOf(noReason)).toBe("reason_required");
    const unknown = await issue(callers.ADMIN, { accountId: "acct-missing-0000", planId: catalog.annual.id, reason: REASON });
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as { error: { fieldErrors: Record<string, string[]> } }).error.fieldErrors.accountId).toBeDefined();
    const addon = await issue(callers.ADMIN, { accountId: owner.accountId, planId: catalog.addon.id, reason: REASON });
    expect(addon.status).toBe(422);
    expect(((await addon.json()) as { error: { fieldErrors: Record<string, string[]> } }).error.fieldErrors.planId).toBeDefined();
    expect((await issue(callers.FINANCE, { accountId: owner.accountId, planId: catalog.annual.id, reason: REASON })).status).toBe(403);
    expect(await count()).toBe(0);
  });
});

describe("bulk", () => {
  const bulk = (session: TestSession | null, body: unknown) => post(bulkRoute.POST, "/api/admin/licenses/bulk", {}, session, body);

  it("extends every license but the revoked ones, one audit row each", async () => {
    const a = await fresh();
    const b = await fresh();
    const revoked = await fresh({ accountId: member.accountId, status: "REVOKED" });
    const res = await bulk(callers.SUPPORT, { action: "extend", ids: [a.id, b.id, revoked.id, "LIC-MISSING0"], reason: REASON });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { updated: string[]; skipped: { id: string; reason: string }[] };
    expect(result.updated.sort()).toEqual([a.id, b.id].sort());
    expect(result.skipped).toEqual(expect.arrayContaining([{ id: revoked.id, reason: "Revoked" }, { id: "LIC-MISSING0", reason: "Not found" }]));
    for (const id of [a.id, b.id]) expect((await audits(id)).map((r) => r.action)).toEqual(["Extended license +30 days"]);
    expect(await audits(revoked.id)).toHaveLength(0);
  });

  it("suspends, skipping suspended licenses; needs a reason and licenses.manage", async () => {
    const a = await fresh();
    const suspended = await fresh({ accountId: member.accountId, status: "SUSPENDED" });
    expect((await bulk(callers.ADMIN, { action: "suspend", ids: [a.id] })).status).toBe(422);
    expect((await bulk(callers.FINANCE, { action: "suspend", ids: [a.id], reason: REASON })).status).toBe(403);
    const res = await bulk(callers.ADMIN, { action: "suspend", ids: [a.id, suspended.id], reason: REASON });
    const result = (await res.json()) as { updated: string[]; skipped: { id: string; reason: string }[] };
    expect(result).toEqual({ updated: [a.id], skipped: [{ id: suspended.id, reason: "Already suspended" }] });
    expect((await db.license.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("SUSPENDED");
    expect((await audits(a.id)).map((r) => r.action)).toEqual(["Suspended license"]);
  });
});
