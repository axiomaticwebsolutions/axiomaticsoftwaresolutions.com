/**
 * GET /api/account/export (Owner only, no secrets), POST /api/account/trials (Owner/Billing/Technical, verified, one
 * per product, no full key) and GET /api/account/search (scoped to the active account; key last 4 and pasted keys).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as exportGET } from "@/app/api/account/export/route";
import { GET as searchGET } from "@/app/api/account/search/route";
import { POST as trialsPOST } from "@/app/api/account/trials/route";
import { db } from "@/lib/db";
import {
  bodyOf,
  call,
  errorOf,
  makeActivity,
  makeCatalog,
  makeDevice,
  makeLicense,
  makeMember,
  makeOrder,
  makeTicket,
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
let viewer: Member;
let billing: Member;
let stranger: Member;
let license: { id: string; key: string; keyHash: string; keyCiphertext: string };
let foreign: { id: string; key: string };
let staffNote: string;

beforeAll(async () => {
  A = await makeCatalog();
  owner = await makeMember({ name: "Priya Sharma" });
  viewer = await makeMember({ accountId: owner.accountId, role: "VIEWER" });
  billing = await makeMember({ accountId: owner.accountId, role: "BILLING", name: "Rohan Sharma" });
  stranger = await makeMember({ name: "Other Owner" });
  const made = await makeLicense(A, { accountId: owner.accountId });
  license = { id: made.license.id, key: made.key, keyHash: made.license.keyHash, keyCiphertext: made.license.keyCiphertext };
  await makeDevice(license.id, { name: "Front Counter PC" });
  const theirs = await makeLicense(A, { accountId: stranger.accountId });
  foreign = { id: theirs.license.id, key: theirs.key };
  await makeDevice(foreign.id, { name: "Front Counter Stranger" });
  await makeOrder({ accountId: owner.accountId, lines: [{ plan: A.annual, taxablePaise: 100_000, taxPaise: 18_000 }], invoiceNumber: `AXS/X${license.id}` });
  const ticket = await makeTicket(owner.accountId, { subject: "Front counter printer offline" });
  staffNote = `Internal staff note ${license.id}`;
  await db.ticketMessage.createMany({
    data: [
      { ticketId: ticket.id, authorId: owner.user.id, isStaff: false, body: "It stopped printing.", attachments: [{ name: "shot.png", sizeBytes: 1000, storageKey: "uploads/secret-key.png" }] },
      { ticketId: ticket.id, authorId: owner.user.id, isStaff: true, internal: true, body: staffNote, attachments: [] },
    ],
  });
  await makeActivity(owner.accountId, { action: "Revealed license key" });
});

describe("GET /api/account/export", () => {
  it("gives the Owner a JSON file without keys, hashes, fingerprints, storage keys or staff notes", async () => {
    await signIn(jar, owner);
    const res = await call(jar, exportGET, "/api/account/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="account-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const data = JSON.parse(text) as Record<string, unknown>;
    expect(data).toMatchObject({ format: "axiomatic-account-export", version: 1, truncated: [] });
    expect((data.licenses as Array<{ id: string; keyMasked: string }>).map((l) => l.id)).toEqual([license.id]);
    expect((data.devices as Array<{ name: string }>).map((d) => d.name)).toEqual(["Front Counter PC"]);
    expect((data.team as Array<{ roleLabel: string }>).map((m) => m.roleLabel).sort()).toEqual(["Billing admin", "Owner", "Viewer"]);
    expect(text).not.toContain(license.key);
    expect(text).not.toContain(license.keyHash);
    expect(text).not.toContain(license.keyCiphertext);
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain(staffNote);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("fingerprint");
    expect(text).not.toContain(foreign.id);
    expect(text).toContain("It stopped printing.");
    expect(text).toContain("Revealed license key");
  });

  it("is Owner only", async () => {
    for (const member of [viewer, billing]) {
      await signIn(jar, member);
      const res = await call(jar, exportGET, "/api/account/export");
      expect(res.status).toBe(403);
    }
  });
});

describe("POST /api/account/trials", () => {
  const start = (productId: string) => call(jar, trialsPOST, "/api/account/trials", { method: "POST", body: { productId } });

  it("starts one trial per product for Owner, Billing admin or Technical contact, never returning the key", async () => {
    const catalog = await makeCatalog();
    await signIn(jar, billing);
    const res = await start(catalog.product.id);
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    const started = body.license as { id: string; status: string; keyMasked: string; deviceLimit: number };
    expect(started).toMatchObject({ status: "trial", deviceLimit: 1, productId: catalog.product.id });
    expect(started.keyMasked).toMatch(new RegExp(`^${catalog.product.code}-\u2022{4}-\u2022{4}-\u2022{4}-[A-Z0-9]{4}$`));
    expect(body.href).toBe(`/account/licenses/${started.id}`);
    expect(JSON.stringify(body)).not.toMatch(/[A-Z]{3}(-[A-HJ-NP-Z2-9]{4}){4}/);
    const row = await db.license.findUniqueOrThrow({ where: { id: started.id } });
    expect(row).toMatchObject({ accountId: owner.accountId, status: "TRIAL" });
    const activity = await db.accountActivity.findFirstOrThrow({ where: { accountId: owner.accountId, action: "Started free trial" } });
    expect(activity).toMatchObject({ actorId: billing.user.id, kind: "license", target: `${started.id} \u00b7 Medical` });

    await signIn(jar, owner);
    const again = await start(catalog.product.id);
    expect(again.status).toBe(409);
    expect(errorOf(await bodyOf(again))).toEqual({ code: "trial_used", message: "You\u2019ve already used the free trial for this product." });
  });

  it("refuses Viewers, unverified emails, unknown products and products without a trial", async () => {
    const catalog = await makeCatalog();
    await signIn(jar, viewer);
    expect((await start(catalog.product.id)).status).toBe(403);
    const unverified = await makeMember({ verified: false });
    await signIn(jar, unverified);
    const res = await start(catalog.product.id);
    expect(res.status).toBe(403);
    expect(errorOf(await bodyOf(res)).code).toBe("email_unverified");
    await signIn(jar, owner);
    expect((await start("no-such-product")).status).toBe(404);
    await db.plan.update({ where: { id: catalog.trial.id }, data: { archived: true } });
    expect(errorOf(await bodyOf(await start(catalog.product.id))).code).toBe("trial_unavailable");
  });
});

describe("GET /api/account/search", () => {
  const search = async (q: string) => {
    const res = await call(jar, searchGET, `/api/account/search?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(200);
    return (await bodyOf(res)).results as Array<{ type: string; id: string; title: string; sub: string; href: string }>;
  };

  it("finds the account's licenses, devices, orders and tickets only", async () => {
    await signIn(jar, viewer);
    expect(await search("f")).toEqual([]);
    const byLast4 = await search(license.key.slice(-4).toLowerCase());
    expect(byLast4.some((r) => r.type === "license" && r.id === license.id)).toBe(true);
    expect(byLast4.map((r) => r.id)).not.toContain(foreign.id);
    const pasted = await search(license.key.toLowerCase().replaceAll("-", " "));
    expect(pasted.filter((r) => r.type === "license").map((r) => r.id)).toEqual([license.id]);
    expect(pasted[0]?.sub).not.toContain(license.key);
    expect(await search(foreign.key)).toEqual([]);
    const front = await search("front counter");
    expect(front.map((r) => [r.type, r.title])).toEqual([
      ["device", "Front Counter PC"],
      ["ticket", expect.stringMatching(/^T-T/)],
    ]);
    expect(front[0]?.href).toBe(`/account/licenses/${license.id}?tab=devices`);
    const byInvoice = await search(`AXS/X${license.id}`);
    expect(byInvoice).toHaveLength(1);
    expect(byInvoice[0]).toMatchObject({ type: "order", sub: expect.stringContaining(`AXS/X${license.id}`) });
    expect(byInvoice[0]?.href).toMatch(/^\/orders\/AX-T/);
  });
});
