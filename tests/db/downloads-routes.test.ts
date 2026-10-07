/**
 * Protected downloads end to end (test-plan "Protected downloads", decisions.md Phase 4): POST /api/account/downloads,
 * GET /api/account/software and POST /api/orders/:id/downloads against the test database, with real sessions (the
 * cookie store of next/headers is replaced by a jar), real CSRF tokens and the local storage driver.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LicenseStatus, TeamRole } from "@/generated/prisma/client";
import { csrfBinding, issueCsrfToken } from "@/lib/auth/csrf";
import { clear, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { createSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ENTITLEMENT_MESSAGES } from "@/lib/licensing/entitlement";
import { signOrderToken } from "@/lib/orders/token";
import { MAX_PRESIGN_TTL_SECONDS, setStorage } from "@/lib/storage";
import { LocalStorageDriver, verifyLocalSignature } from "@/lib/storage/local";
import { freshProductCode } from "../support/product-codes";

const jar = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.cookies.has(name) ? { name, value: jar.cookies.get(name) } : undefined),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
}));

const { POST: downloadRoute } = await import("@/app/api/account/downloads/route");
const { GET: softwareRoute } = await import("@/app/api/account/software/route");
const { POST: orderDownloadRoute } = await import("@/app/api/orders/[id]/downloads/route");

const tag = randomBytes(3).toString("hex");
let seq = 0;
const uniq = (prefix: string) => `${prefix}-${tag}-${++seq}`;
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY);

type Member = { userId: string; accountId: string; sessionToken: string; sessionId: string };
type ErrorBody = { error: { code: string; message: string; reason?: string } };
type LinkBody = { url: string; expiresAt: string; ttlSec: number; fileId: string; fileName: string; version: string; licenseId: string };

let dir = "";
let current: Member | null = null;
const f = {} as {
  productId: string;
  shortName: string;
  otherProductId: string;
  annualPlanId: string;
  oneTimePlanId: string;
  otherPlanId: string;
  fileOld: string;
  fileNew: string;
  fileNewMac: string;
  fileDraft: string;
  fileOther: string;
  fileBeta: string;
  newKey: string;
  /** The active account's license with the latest updatesUntil (+365 d), which must entitle its downloads. */
  activeBestLicenseId: string;
  accounts: Record<"active" | "updates" | "expired" | "revoked" | "suspended" | "none", string>;
};
const members = {} as Record<string, Member>;

async function product(categoryId: string) {
  const id = uniq("dlprod");
  await db.product.create({
    data: {
      id,
      code: await freshProductCode(),
      name: `Download test ${id}`,
      shortName: `DL ${seq}`,
      tagline: "Test",
      summary: "Test",
      icon: "receipt_long",
      categoryId,
      platforms: ["windows", "macos"],
      status: "PUBLISHED",
      content: {},
      relatedIds: [],
    },
  });
  return id;
}

async function release(productId: string, version: string, releasedAt: Date, status: "PUBLISHED" | "DRAFT" = "PUBLISHED", channel = "stable") {
  return db.release.create({ data: { productId, version, status, releasedAt, channel, notes: [`What's new in ${version}`] } });
}

async function file(releaseId: string, productId: string, version: string, platform: string) {
  const fileName = `Test-${version}-${platform}.bin`;
  const row = await db.releaseFile.create({
    data: {
      releaseId,
      platform,
      fileName,
      storageKey: `releases/${productId}/${version}/${fileName}`,
      sizeBytes: BigInt(5 * 1024 * 1024),
      sha256: "0".repeat(64),
    },
  });
  return row;
}

async function member(accountId: string, role: TeamRole, opts: { verified?: boolean } = {}): Promise<Member> {
  const user = await db.user.create({
    data: {
      kind: "CUSTOMER",
      email: `${uniq("dl")}@example.test`,
      name: `Member ${role}`,
      emailVerifiedAt: opts.verified === false ? null : new Date(),
    },
  });
  await db.accountMember.create({ data: { accountId, userId: user.id, role, status: "ACTIVE" } });
  const { token, session } = await createSession(db, { userId: user.id, kind: "CUSTOMER", activeAccountId: accountId });
  return { userId: user.id, accountId, sessionToken: token, sessionId: session.id };
}

async function account(): Promise<string> {
  return (await db.businessAccount.create({ data: { legalName: uniq("Store") } })).id;
}

async function license(data: {
  accountId: string | null;
  productId: string;
  planId: string;
  status?: LicenseStatus;
  expiresAt: Date | null;
  updatesUntil: Date;
  orderId?: string;
}) {
  return db.license.create({
    data: {
      id: uniq("LIC-T"),
      keyHash: randomBytes(32).toString("hex"),
      keyCiphertext: "v1.test.test.test",
      keyLast4: "TEST",
      deviceLimit: 1,
      resetsYear: 2026,
      ...data,
    },
  });
}

async function order(accountId: string | null, email: string) {
  return db.order.create({
    data: {
      id: `AX-T${tag}${++seq}`,
      accountId,
      email,
      billing: { name: "Test Buyer" },
      status: "PAID",
      subtotalPaise: 0,
      taxablePaise: 0,
      totalPaise: 0,
      placeOfSupply: "Maharashtra",
      paidAt: new Date(),
    },
  });
}

const guest = {} as { orderId: string; email: string; licenseId: string; otherOrderId: string; otherEmail: string; accountOrderId: string };

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "axs-dl-"));
  setStorage(new LocalStorageDriver({ dir, appUrl: getEnv().APP_URL, secret: getEnv().SESSION_SECRET }));
  await clear(db, RATE_LIMITS.orderActionIp(null).key);

  const category = await db.category.create({ data: { id: uniq("dlcat"), name: "Test", tone: "sage", icon: "receipt_long" } });
  f.productId = await product(category.id);
  f.shortName = (await db.product.findUniqueOrThrow({ where: { id: f.productId } })).shortName;
  f.otherProductId = await product(category.id);
  const plan = (productId: string, type: "ANNUAL" | "ONE_TIME") =>
    db.plan.create({ data: { id: uniq("dlplan"), productId, type, name: `${type} plan`, pricePaise: 100_000, includes: [], deviceLimit: 1 } });
  f.annualPlanId = (await plan(f.productId, "ANNUAL")).id;
  f.oneTimePlanId = (await plan(f.productId, "ONE_TIME")).id;
  f.otherPlanId = (await plan(f.otherProductId, "ANNUAL")).id;

  const rOld = await release(f.productId, "1.0.0", at(-200));
  const rNew = await release(f.productId, "2.0.0", at(-10));
  const rDraft = await release(f.productId, "3.0.0", at(-1), "DRAFT");
  const rOther = await release(f.otherProductId, "1.0.0", at(-50));
  f.fileOld = (await file(rOld.id, f.productId, "1.0.0", "windows")).id;
  const newFile = await file(rNew.id, f.productId, "2.0.0", "windows");
  f.fileNew = newFile.id;
  f.newKey = newFile.storageKey;
  f.fileNewMac = (await file(rNew.id, f.productId, "2.0.0", "macos")).id;
  f.fileDraft = (await file(rDraft.id, f.productId, "3.0.0", "windows")).id;
  f.fileOther = (await file(rOther.id, f.otherProductId, "1.0.0", "windows")).id;
  // A newer beta on another channel: never "latest", never downloadable by customers.
  const rBeta = await release(f.productId, "3.1.0-beta.1", at(-2), "PUBLISHED", "beta");
  f.fileBeta = (await file(rBeta.id, f.productId, "3.1.0-beta.1", "windows")).id;

  const P = { productId: f.productId, planId: f.annualPlanId };
  f.accounts = {
    active: await account(),
    updates: await account(),
    expired: await account(),
    revoked: await account(),
    suspended: await account(),
    none: await account(),
  };
  await license({ ...P, accountId: f.accounts.active, expiresAt: at(300), updatesUntil: at(300) });
  await license({ productId: f.productId, planId: f.oneTimePlanId, accountId: f.accounts.updates, expiresAt: null, updatesUntil: at(-100) });
  await license({ ...P, accountId: f.accounts.expired, expiresAt: at(-5), updatesUntil: at(-5) });
  await license({ ...P, accountId: f.accounts.revoked, status: "REVOKED", expiresAt: at(300), updatesUntil: at(300) });
  await license({ ...P, accountId: f.accounts.suspended, status: "SUSPENDED", expiresAt: at(300), updatesUntil: at(300) });
  await license({ productId: f.otherProductId, planId: f.otherPlanId, accountId: f.accounts.none, expiresAt: at(300), updatesUntil: at(300) });

  members.owner = await member(f.accounts.active, "OWNER");
  members.technical = await member(f.accounts.active, "TECHNICAL");
  members.viewer = await member(f.accounts.active, "VIEWER");
  members.billing = await member(f.accounts.active, "BILLING");
  members.unverified = await member(f.accounts.active, "OWNER", { verified: false });
  for (const k of ["updates", "expired", "revoked", "suspended", "none"] as const) members[k] = await member(f.accounts[k], "OWNER");

  guest.email = `${uniq("guest")}@example.test`;
  guest.orderId = (await order(null, guest.email)).id;
  guest.licenseId = (await license({ ...P, accountId: null, orderId: guest.orderId, expiresAt: at(365), updatesUntil: at(365) })).id;
  guest.otherEmail = `${uniq("guest")}@example.test`;
  guest.otherOrderId = (await order(null, guest.otherEmail)).id;
  await license({ productId: f.otherProductId, planId: f.otherPlanId, accountId: null, orderId: guest.otherOrderId, expiresAt: at(365), updatesUntil: at(365) });
  guest.accountOrderId = (await order(f.accounts.active, `${uniq("acct")}@example.test`)).id;
  f.activeBestLicenseId = (await license({ ...P, accountId: f.accounts.active, orderId: guest.accountOrderId, expiresAt: at(365), updatesUntil: at(365) })).id;
});

afterAll(async () => {
  await clear(db, RATE_LIMITS.orderActionIp(null).key);
  setStorage(null);
  await rm(dir, { recursive: true, force: true });
});

function as(m: Member | null): void {
  current = m;
  jar.cookies.clear();
  if (m) jar.cookies.set("axs_session", m.sessionToken);
}

function post(pathname: string, body: unknown, opts: { csrf?: boolean } = {}): NextRequest {
  const headers: Record<string, string> = { origin: getEnv().APP_URL, "content-type": "application/json" };
  if (opts.csrf !== false) {
    const token = issueCsrfToken(csrfBinding(current?.sessionId), getEnv().CSRF_SECRET);
    headers["x-csrf-token"] = token;
    headers.cookie = `axs_csrf=${token}`;
  }
  return new NextRequest(`${getEnv().APP_URL}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const download = (releaseFileId: string, opts: { csrf?: boolean } = {}) =>
  downloadRoute(post("/api/account/downloads", { releaseFileId }, opts), undefined);

const orderDownload = (orderId: string, body: Record<string, unknown>, opts: { csrf?: boolean } = {}) =>
  orderDownloadRoute(post(`/api/orders/${orderId}/downloads`, body, opts), { params: Promise.resolve({ id: orderId }) });

async function errorOf(res: Response): Promise<[number, string, string | undefined]> {
  const body = (await res.json()) as ErrorBody;
  return [res.status, body.error.code, body.error.reason];
}

describe("POST /api/account/downloads", () => {
  it("answers 401 without a session", async () => {
    as(null);
    expect(await errorOf(await download(f.fileNew))).toEqual([401, "unauthorized", undefined]);
  });

  it("returns a presigned link (<= 600 s) to the private object and records DownloadEvent + activity", async () => {
    as(members.owner!);
    const before = Date.now();
    const res = await download(f.fileNew);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as LinkBody;
    expect(body).toMatchObject({ fileId: f.fileNew, version: "2.0.0", fileName: "Test-2.0.0-windows.bin" });
    expect(body.ttlSec).toBeLessThanOrEqual(MAX_PRESIGN_TTL_SECONDS);

    const url = new URL(body.url);
    expect(url.pathname).toBe(`/api/dev/storage/${f.newKey}`);
    const exp = url.searchParams.get("exp") ?? "";
    const sig = url.searchParams.get("sig") ?? "";
    const expMs = Number(exp) * 1000;
    expect(expMs - before).toBeLessThanOrEqual(MAX_PRESIGN_TTL_SECONDS * 1000 + 1000);
    expect(new Date(body.expiresAt).getTime()).toBe(expMs);
    expect(verifyLocalSignature("GET", f.newKey, exp, sig, new Date())).toBe(true);
    const tampered = `${sig.slice(0, -1)}${sig.endsWith("a") ? "b" : "a"}`;
    expect(verifyLocalSignature("GET", f.newKey, exp, tampered, new Date())).toBe(false);
    expect(verifyLocalSignature("GET", `${f.newKey}x`, exp, sig, new Date())).toBe(false);
    expect(verifyLocalSignature("GET", f.newKey, exp, sig, new Date(expMs))).toBe(false);

    const event = await db.downloadEvent.findFirstOrThrow({ where: { userId: members.owner!.userId, fileId: f.fileNew } });
    expect(event.licenseId).toBe(body.licenseId);
    // Of the account's two entitled licenses (+300 d and +365 d), the one covering updates longest is recorded.
    expect(body.licenseId).toBe(f.activeBestLicenseId);
    expect(event.expiresAt.getTime()).toBe(expMs);
    const lic = await db.license.findUniqueOrThrow({ where: { id: event.licenseId } });
    expect(lic.accountId).toBe(f.accounts.active);
    const activity = await db.accountActivity.findFirstOrThrow({ where: { accountId: f.accounts.active, kind: "download" } });
    expect(activity).toMatchObject({ action: "Downloaded installer", actorId: members.owner!.userId, actorName: "Member OWNER", target: `${f.shortName} v2.0.0` });
  });

  it("lets Technical members download; Viewer and Billing get 403", async () => {
    as(members.technical!);
    expect((await download(f.fileNewMac)).status).toBe(200);
    as(members.viewer!);
    expect(await errorOf(await download(f.fileNew))).toEqual([403, "forbidden", undefined]);
    as(members.billing!);
    expect(await errorOf(await download(f.fileNew))).toEqual([403, "forbidden", undefined]);
    expect(await db.downloadEvent.count({ where: { userId: { in: [members.viewer!.userId, members.billing!.userId] } } })).toBe(0);
  });

  it("requires a verified email", async () => {
    as(members.unverified!);
    expect(await errorOf(await download(f.fileNew))).toEqual([403, "email_unverified", undefined]);
  });

  it("answers not_entitled with the reason for expired, revoked and suspended licenses", async () => {
    for (const [who, reason] of [["expired", "expired"], ["revoked", "revoked"], ["suspended", "suspended"]] as const) {
      as(members[who]!);
      const res = await download(f.fileNew);
      const body = (await res.json()) as ErrorBody;
      expect([res.status, body.error.code, body.error.reason, body.error.message]).toEqual([403, "not_entitled", reason, ENTITLEMENT_MESSAGES[reason]]);
    }
  });

  it("refuses a release after updatesUntil (updates_ended) but serves the older eligible release", async () => {
    as(members.updates!);
    expect(await errorOf(await download(f.fileNew))).toEqual([403, "not_entitled", "updates_ended"]);
    const res = await download(f.fileOld);
    expect(res.status).toBe(200);
    expect(((await res.json()) as LinkBody).version).toBe("1.0.0");
  });

  it("never uses another account's or an unclaimed guest license (IDOR): no_license", async () => {
    as(members.none!);
    expect(await errorOf(await download(f.fileNew))).toEqual([403, "not_entitled", "no_license"]);
    expect((await download(f.fileOther)).status).toBe(200);
  });

  it("picks the entitled license among expired and updates-ended ones, and explains the best failure otherwise", async () => {
    const P = { productId: f.productId, planId: f.annualPlanId };
    const mixed = await account();
    await license({ ...P, accountId: mixed, expiresAt: at(-5), updatesUntil: at(-5) });
    await license({ productId: f.productId, planId: f.oneTimePlanId, accountId: mixed, expiresAt: null, updatesUntil: at(-20) });
    const active = await license({ ...P, accountId: mixed, expiresAt: at(200), updatesUntil: at(200) });
    as(await member(mixed, "OWNER"));
    const res = await download(f.fileNew);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LinkBody;
    expect(body.licenseId).toBe(active.id);
    expect((await db.downloadEvent.findFirstOrThrow({ where: { fileId: f.fileNew, licenseId: active.id } })).licenseId).toBe(active.id);

    // Without the active license: updates ended (renewable maintenance) is reported before expired.
    const ended = await account();
    await license({ ...P, accountId: ended, expiresAt: at(-5), updatesUntil: at(-5) });
    await license({ productId: f.productId, planId: f.oneTimePlanId, accountId: ended, expiresAt: null, updatesUntil: at(-20) });
    as(await member(ended, "OWNER"));
    expect(await errorOf(await download(f.fileNew))).toEqual([403, "not_entitled", "updates_ended"]);
  });

  it("never serves releases outside the stable channel (403 not_released)", async () => {
    as(members.owner!);
    expect(await errorOf(await download(f.fileBeta))).toEqual([403, "not_entitled", "not_released"]);
    expect(await db.downloadEvent.count({ where: { fileId: f.fileBeta } })).toBe(0);
  });

  it("answers 404 for unknown files and not_released for unpublished releases", async () => {
    as(members.owner!);
    expect(await errorOf(await download("cm0unknownfile000000000000"))).toEqual([404, "not_found", undefined]);
    expect(await errorOf(await download(f.fileDraft))).toEqual([403, "not_entitled", "not_released"]);
  });

  it("checks CSRF and the body", async () => {
    as(members.owner!);
    expect(await errorOf(await download(f.fileNew, { csrf: false }))).toEqual([403, "csrf_failed", undefined]);
    const extra = await downloadRoute(post("/api/account/downloads", { releaseFileId: f.fileNew, licenseId: "x" }), undefined);
    expect(extra.status).toBe(422);
    expect((await downloadRoute(post("/api/account/downloads", { releaseFileId: "../x" }), undefined)).status).toBe(422);
  });

  it("limits links per user (429 with Retry-After)", async () => {
    as(members.technical!);
    const rule = RATE_LIMITS.downloads(members.technical!.userId);
    for (let i = 0; i < rule.limit; i += 1) await hit(db, rule);
    const res = await download(f.fileNew);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    await clear(db, rule.key);
  });
});

type SoftwareBody = {
  canDownload: boolean;
  downloadLinkMinutes: number;
  products: {
    productId: string;
    canDownload: boolean;
    latestRelease: { version: string } | null;
    eligibleRelease: { version: string } | null;
    reason: string | null;
    releases: { version: string; accessLabel: string; notes: string[]; files: { id: string; platform: string; fileName: string; sizeLabel: string }[] }[];
  }[];
};

const software = async () => softwareRoute(new NextRequest(`${getEnv().APP_URL}/api/account/software`), undefined);

describe("GET /api/account/software", () => {
  it("answers 401 without a session and 403 for an unverified email", async () => {
    as(null);
    expect((await software()).status).toBe(401);
    as(members.unverified!);
    expect(await errorOf(await software())).toEqual([403, "email_unverified", undefined]);
  });

  it("lists each licensed product with latest and eligible releases, files and access", async () => {
    as(members.owner!);
    const res = await software();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as SoftwareBody;
    expect(body.canDownload).toBe(true);
    expect(body.downloadLinkMinutes).toBe(10);
    expect(body.products.map((p) => p.productId)).toEqual([f.productId]);
    const [p] = body.products;
    expect([p?.latestRelease?.version, p?.eligibleRelease?.version, p?.canDownload, p?.reason]).toEqual(["2.0.0", "2.0.0", true, null]);
    // The newer beta (3.1.0-beta.1, beta channel) is neither "latest" nor listed.
    expect(p?.releases.map((r) => [r.version, r.accessLabel])).toEqual([
      ["2.0.0", "Included"],
      ["1.0.0", "Included"],
    ]);
    expect(JSON.stringify(body)).not.toContain("beta");
    expect(p?.releases[0]?.notes).toEqual(["What's new in 2.0.0"]);
    expect(p?.releases[0]?.files.map((x) => [x.id, x.platform, x.fileName, x.sizeLabel])).toEqual([
      [f.fileNew, "windows", "Test-2.0.0-windows.bin", "5 MB"],
      [f.fileNewMac, "macos", "Test-2.0.0-macos.bin", "5 MB"],
    ]);
    expect(JSON.stringify(body)).not.toContain("releases/"); // storage keys never leave the server
  });

  it("lets a Viewer see the list without download rights", async () => {
    as(members.viewer!);
    const body = (await (await software()).json()) as SoftwareBody;
    expect(body.canDownload).toBe(false);
    expect(body.products[0]).toMatchObject({ canDownload: false, eligibleRelease: { version: "2.0.0" } });
  });

  it("marks newer releases 'Needs renewal' after updates end, and gives a reason when nothing is downloadable", async () => {
    as(members.updates!);
    const [p] = ((await (await software()).json()) as SoftwareBody).products;
    expect([p?.latestRelease?.version, p?.eligibleRelease?.version]).toEqual(["2.0.0", "1.0.0"]);
    expect(p?.releases.map((r) => r.accessLabel)).toEqual(["Needs renewal", "Included"]);
    as(members.revoked!);
    const [r] = ((await (await software()).json()) as SoftwareBody).products;
    expect([r?.eligibleRelease, r?.reason, r?.canDownload]).toEqual([null, "revoked", false]);
  });
});

describe("POST /api/orders/:id/downloads", () => {
  const tokenFor = (orderId: string, email: string, now = new Date(), ttlMs?: number) => signOrderToken(orderId, email, now, ttlMs ? { ttlMs } : {});

  it("serves a guest with the order link, using only that order's licenses (DownloadEvent.userId guest:<order>)", async () => {
    as(null);
    const res = await orderDownload(guest.orderId, { releaseFileId: f.fileNew, t: tokenFor(guest.orderId, guest.email) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LinkBody;
    expect(body.licenseId).toBe(guest.licenseId);
    const event = await db.downloadEvent.findFirstOrThrow({ where: { licenseId: guest.licenseId } });
    expect(event.userId).toBe(`guest:${guest.orderId}`);
    expect(verifyLocalSignature("GET", f.newKey, new URL(body.url).searchParams.get("exp") ?? "", new URL(body.url).searchParams.get("sig") ?? "", new Date())).toBe(true);
  });

  it("refuses products the order did not license, and foreign or expired tokens", async () => {
    as(null);
    const t = tokenFor(guest.orderId, guest.email);
    expect(await errorOf(await orderDownload(guest.orderId, { releaseFileId: f.fileOther, t }))).toEqual([403, "not_entitled", "no_license"]);
    // Another order's token never opens this order (404: order ids cannot be probed, decisions.md Phase 3).
    const foreign = tokenFor(guest.otherOrderId, guest.otherEmail);
    expect(await errorOf(await orderDownload(guest.orderId, { releaseFileId: f.fileNew, t: foreign }))).toEqual([404, "not_found", undefined]);
    const expired = tokenFor(guest.orderId, guest.email, new Date(Date.now() - 2 * DAY), DAY);
    expect(await errorOf(await orderDownload(guest.orderId, { releaseFileId: f.fileNew, t: expired }))).toEqual([403, "order_link_expired", undefined]);
    expect(await errorOf(await orderDownload(guest.orderId, { releaseFileId: f.fileNew }))).toEqual([401, "unauthorized", undefined]);
    expect(await errorOf(await orderDownload(guest.orderId, { releaseFileId: f.fileNew, t }, { csrf: false }))).toEqual([403, "csrf_failed", undefined]);
  });

  it("uses only the order's own licenses for a claimed order, even when the account holds an active one", async () => {
    as(null);
    const email = `${uniq("claimed")}@example.test`;
    const claimed = await order(f.accounts.active, email);
    await license({ productId: f.productId, planId: f.annualPlanId, accountId: f.accounts.active, orderId: claimed.id, expiresAt: at(-3), updatesUntil: at(-3) });
    const res = await orderDownload(claimed.id, { releaseFileId: f.fileNew, t: tokenFor(claimed.id, email) });
    expect(await errorOf(res)).toEqual([403, "not_entitled", "expired"]);
  });

  it("needs the downloads permission for members who open the order through their session", async () => {
    as(members.viewer!);
    expect(await errorOf(await orderDownload(guest.accountOrderId, { releaseFileId: f.fileNew }))).toEqual([403, "forbidden", undefined]);
    as(members.owner!);
    const res = await orderDownload(guest.accountOrderId, { releaseFileId: f.fileNew });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LinkBody;
    const event = await db.downloadEvent.findFirstOrThrow({ where: { licenseId: body.licenseId, userId: members.owner!.userId } });
    expect(event.fileId).toBe(f.fileNew);
    as(members.none!);
    expect((await orderDownload(guest.accountOrderId, { releaseFileId: f.fileNew })).status).toBe(404);
  });
});
