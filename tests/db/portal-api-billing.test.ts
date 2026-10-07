/**
 * /api/account/billing and /api/account/locations: role checks (Viewer and Technical cannot edit billing; Viewer and
 * Billing cannot manage locations), the GSTIN/state rule, activity with the actor id, no-op saves, CSRF, invoice
 * contacts, payment history scoping, location CRUD with device moves, and IDOR (other accounts' locations are 404).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as billingGET, PATCH as billingPATCH } from "@/app/api/account/billing/route";
import { DELETE as locationDELETE, PATCH as locationPATCH } from "@/app/api/account/locations/[id]/route";
import { GET as locationsGET, POST as locationsPOST } from "@/app/api/account/locations/route";
import { db } from "@/lib/db";
import {
  addPayment,
  bodyOf,
  call,
  errorOf,
  makeCatalog,
  makeDevice,
  makeLicense,
  makeLocation,
  makeMember,
  makeOrder,
  signIn,
  type Catalog,
  type Member,
} from "./portal-api-fixtures";

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

let A: Catalog;
let owner: Member;
let billing: Member;
let technical: Member;
let viewer: Member;
let stranger: Member;

beforeAll(async () => {
  A = await makeCatalog();
  owner = await makeMember({ name: "Priya Sharma" });
  billing = await makeMember({ accountId: owner.accountId, role: "BILLING", name: "Rohan Sharma" });
  technical = await makeMember({ accountId: owner.accountId, role: "TECHNICAL", name: "Kavya Desai" });
  viewer = await makeMember({ accountId: owner.accountId, role: "VIEWER" });
  const invited = await makeMember({ accountId: owner.accountId, role: "BILLING", name: "Invited Accountant" });
  await db.accountMember.updateMany({ where: { userId: invited.user.id }, data: { status: "INVITED" } });
  stranger = await makeMember({ name: "Other Owner" });
  const mine = await makeOrder({ accountId: owner.accountId, lines: [{ plan: A.annual, taxablePaise: 100_000, taxPaise: 18_000 }] });
  await addPayment(mine.id, 118_000, { method: "Card" });
  const theirs = await makeOrder({ accountId: stranger.accountId, lines: [{ plan: A.annual, taxablePaise: 100_000, taxPaise: 18_000 }] });
  await addPayment(theirs.id, 118_000);
});

const patchBilling = async (member: Member, body: unknown, opts: { csrf?: boolean } = {}) => {
  await signIn(jar, member);
  const res = await call(jar, billingPATCH, "/api/account/billing", { method: "PATCH", body, csrf: opts.csrf });
  return { res, body: await bodyOf(res) };
};

const billingActivity = () =>
  db.accountActivity.findMany({ where: { accountId: owner.accountId, kind: "billing" }, orderBy: { createdAt: "asc" } });

describe("/api/account/billing", () => {
  it("shows details, Owner/Billing invoice contacts and the account's payments to every role", async () => {
    await signIn(jar, viewer);
    const res = await call(jar, billingGET, "/api/account/billing");
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.canEdit).toBe(false);
    expect(body.details).toMatchObject({ legalName: expect.stringContaining("Sharma Medicals"), gstin: null, gstinState: null });
    expect((body.invoiceContacts as Array<{ name: string; roleLabel: string }>).map((c) => [c.name, c.roleLabel])).toEqual([
      ["Priya Sharma", "Owner"],
      ["Rohan Sharma", "Billing admin"],
    ]);
    const payments = body.payments as Array<{ method: string; badge: { label: string }; amountPaise: number; reference: string }>;
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ method: "Card", badge: { label: "Paid" }, amountPaise: 118_000 });
    expect(payments[0]?.reference).toMatch(/^pay_/);
  });

  it("never shows the internal attempt id as the payment id (null until the payment partner reports one)", async () => {
    const solo = await makeMember({ name: "Solo Owner" });
    const order = await makeOrder({ accountId: solo.accountId, status: "CANCELED", lines: [{ plan: A.annual, taxablePaise: 100_000, taxPaise: 18_000 }] });
    const attempt = await db.payment.create({
      data: { orderId: order.id, provider: "mock", providerOrderId: `mock_order_${order.id}`, providerPaymentId: null, method: null, amountPaise: 118_000, status: "CANCELED" },
    });
    await signIn(jar, solo);
    const body = await bodyOf(await call(jar, billingGET, "/api/account/billing"));
    const payments = body.payments as Array<{ id: string; reference: string | null; badge: { label: string } }>;
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ id: attempt.id, reference: null, badge: { label: "Canceled" } });
    // The attempt id appears once: as the row id, never as a displayed value.
    expect(JSON.stringify(body).split(attempt.id)).toHaveLength(2);
  });

  it("refuses Viewer and Technical contact edits (403)", async () => {
    for (const member of [viewer, technical]) {
      const { res, body } = await patchBilling(member, { legalName: "Hijack Ltd" });
      expect(res.status).toBe(403);
      expect(errorOf(body).code).toBe("forbidden");
    }
    expect((await db.businessAccount.findUniqueOrThrow({ where: { id: owner.accountId } })).legalName).not.toBe("Hijack Ltd");
  });

  it("needs the CSRF token", async () => {
    const { res, body } = await patchBilling(billing, { legalName: "No Token Ltd" }, { csrf: false });
    expect(res.status).toBe(403);
    expect(errorOf(body).code).toBe("csrf_failed");
  });

  it("checks the GSTIN against the state, saves, and logs the change with the actor", async () => {
    const mismatch = await patchBilling(billing, { gstin: "27abcde1234f1z5", state: "Karnataka" });
    expect(mismatch.res.status).toBe(422);
    expect((errorOf(mismatch.body).fieldErrors as Record<string, string[]>).gstin?.[0]).toContain("registered in Maharashtra");
    const noState = await patchBilling(billing, { gstin: "27ABCDE1234F1Z5" });
    expect(noState.res.status).toBe(422);
    expect(errorOf(noState.body).fieldErrors).toHaveProperty("state");

    const ok = await patchBilling(billing, {
      legalName: "Sharma Medicals Pvt Ltd",
      gstin: "27abcde1234f1z5",
      state: "Maharashtra",
      address: "12 MG Road",
      city: "Pune",
      pin: "411001",
    });
    expect(ok.res.status).toBe(200);
    expect(ok.body).toMatchObject({
      changed: true,
      canEdit: true,
      details: { legalName: "Sharma Medicals Pvt Ltd", gstin: "27ABCDE1234F1Z5", gstinState: "Maharashtra", pin: "411001" },
    });
    let log = await billingActivity();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actorId: billing.user.id, actorName: "Rohan Sharma", action: "Updated billing details", target: "GSTIN 27ABCDE1234F1Z5" });

    const same = await patchBilling(owner, { gstin: "27ABCDE1234F1Z5", city: "Pune" });
    expect(same.body.changed).toBe(false);
    expect(await billingActivity()).toHaveLength(1);

    const cleared = await patchBilling(owner, { gstin: "" });
    expect(cleared.body).toMatchObject({ changed: true, details: { gstin: null, state: "Maharashtra" } });
    log = await billingActivity();
    expect(log[1]).toMatchObject({ actorId: owner.user.id, target: "No GSTIN" });
  });
});

describe("/api/account/locations", () => {
  const post = async (member: Member, name: unknown) => {
    await signIn(jar, member);
    const res = await call(jar, locationsPOST, "/api/account/locations", { method: "POST", body: { name } });
    return { res, body: await bodyOf(res) };
  };

  it("adds, renames and deletes locations; deleting moves devices to Unassigned", async () => {
    const created = await post(technical, "  Andheri  West ");
    expect(created.res.status).toBe(201);
    const location = created.body.location as { id: string; name: string };
    expect(location).toMatchObject({ name: "Andheri West", activeDevices: 0 });
    const dup = await post(owner, "andheri west");
    expect(dup.res.status).toBe(422);
    expect((errorOf(dup.body).fieldErrors as Record<string, string[]>).name).toEqual(["You already have a location called \u201candheri west\u201d."]);

    const { license } = await makeLicense(A, { accountId: owner.accountId });
    const d1 = await makeDevice(license.id, { locationId: location.id });
    await makeDevice(license.id, { locationId: location.id, deactivatedAt: new Date() });
    await makeDevice(license.id);

    await signIn(jar, viewer);
    const listed = await bodyOf(await call(jar, locationsGET, "/api/account/locations"));
    expect(listed).toMatchObject({ canManage: false, unassignedDevices: 1, locations: [{ id: location.id, name: "Andheri West", activeDevices: 1 }] });

    await signIn(jar, technical);
    const renamed = await call(jar, locationPATCH, `/api/account/locations/${location.id}`, {
      method: "PATCH",
      body: { name: "Andheri" },
      params: { id: location.id },
    });
    expect(await bodyOf(renamed)).toMatchObject({ location: { id: location.id, name: "Andheri", activeDevices: 1 } });

    const deleted = await call(jar, locationDELETE, `/api/account/locations/${location.id}`, { method: "DELETE", params: { id: location.id } });
    expect(await bodyOf(deleted)).toEqual({ deleted: true, id: location.id, devicesMoved: 1 });
    expect((await db.deviceActivation.findUniqueOrThrow({ where: { id: d1.id } })).locationId).toBeNull();
    expect(await db.location.findUnique({ where: { id: location.id } })).toBeNull();
  });

  it("refuses Viewer and Billing admin changes and hides other accounts' locations (404)", async () => {
    expect((await post(viewer, "Pune")).res.status).toBe(403);
    expect((await post(billing, "Pune")).res.status).toBe(403);
    const theirs = await makeLocation(stranger.accountId, "Their branch");
    await signIn(jar, owner);
    const rename = await call(jar, locationPATCH, `/api/account/locations/${theirs.id}`, {
      method: "PATCH",
      body: { name: "Mine now" },
      params: { id: theirs.id },
    });
    expect(rename.status).toBe(404);
    const del = await call(jar, locationDELETE, `/api/account/locations/${theirs.id}`, { method: "DELETE", params: { id: theirs.id } });
    expect(del.status).toBe(404);
    expect((await db.location.findUniqueOrThrow({ where: { id: theirs.id } })).name).toBe("Their branch");
    const listed = await bodyOf(await call(jar, locationsGET, "/api/account/locations"));
    expect((listed.locations as Array<{ id: string }>).map((l) => l.id)).not.toContain(theirs.id);
  });
});
