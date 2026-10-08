/**
 * Admin > Settings > Branding (app/api/admin/settings/branding/[slot], app/brand/[file]; docs/decisions.md "Branding:
 * logos and favicon"): Owner-only uploads with CSRF, raw bodies checked against the slot's limit before and while
 * reading, the per-Owner rate limit, server-side validation as 422 field errors, upload / replace / remove with audit
 * rows (slot, type, size, SHA-256 prefix; never the bytes) and storefront revalidation; the public file route's headers
 * (type, nosniff, inline, SVG sandbox CSP, caching by version, ETag) and 404s; the PDF and email helpers.
 *
 * Every test removes the BrandAsset rows and this process's file cache.
 */
import type * as NextCache from "next/cache";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as brandGET } from "@/app/brand/[file]/route";
import { DELETE as brandingDELETE, PUT as brandingPUT } from "@/app/api/admin/settings/branding/[slot]/route";
import { hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { brandVersion, type BrandingState } from "@/lib/branding/model";
import { emailLogo, forgetBrandFile, invoiceLogo, loadBrandingState, readBrandFile } from "@/lib/branding/store";
import { SVG_MESSAGES } from "@/lib/branding/svg";
import { db } from "@/lib/db";
import { composeEmail } from "@/lib/email/compose";
import { getEnv } from "@/lib/env";
import { BRAND_ASSET_CSP } from "@/lib/security/csp";
import { callRoute, errorCodeOf, makeCustomer, makeStaff, setJarSession, startSession, type TestSession } from "../support/admin-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof NextCache>()),
  revalidateTag: (tag: string) => {
    revalidated.push(tag);
  },
}));

type WriteBody = { slot: string; changed: boolean; branding: BrandingState };
type Json = { error: { code: string; fieldErrors?: Record<string, string[]> } };

let owner: TestSession;

beforeEach(async () => {
  owner = await startSession(await makeStaff("OWNER"));
  revalidated.length = 0;
});

afterEach(async () => {
  await db.brandAsset.deleteMany({});
  forgetBrandFile();
});

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: { r: 99, g: 85, b: 207, alpha: 0.6 } } }).png().toBuffer();
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 30"><rect width="120" height="30" fill="#6355CF"/></svg>';

/** PUT the bytes as the raw body, the way the Settings card sends a file. */
async function upload(
  slot: string,
  body: Uint8Array | string,
  opts: { session?: TestSession | null; contentType?: string; contentLength?: string; csrf?: boolean } = {},
): Promise<Response> {
  const session = opts.session === undefined ? owner : opts.session;
  setJarSession(jar, session);
  const appUrl = getEnv().APP_URL;
  const headers = new Headers({ origin: new URL(appUrl).origin, "content-type": opts.contentType ?? "application/octet-stream" });
  if (session) {
    headers.set("cookie", `axs_session=${session.token}; axs_csrf=${session.csrf}`);
    if (opts.csrf !== false) headers.set("x-csrf-token", session.csrf);
  }
  if (opts.contentLength) headers.set("content-length", opts.contentLength);
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const req = new NextRequest(new URL(`/api/admin/settings/branding/${slot}`, appUrl), { method: "PUT", headers, body: new Uint8Array(bytes) });
  return brandingPUT(req, { params: Promise.resolve({ slot }) });
}

const remove = (slot: string, session: TestSession = owner) =>
  callRoute(jar, brandingDELETE, { method: "DELETE", path: `/api/admin/settings/branding/${slot}`, params: { slot }, body: {}, session });

const file = (name: string, query = "", headers: Record<string, string> = {}) =>
  brandGET(new NextRequest(new URL(`/brand/${name}${query}`, getEnv().APP_URL), { headers }), { params: Promise.resolve({ file: name }) });

const fileError = async (res: Response) => ((await res.json()) as Json).error.fieldErrors?.file?.[0];
const brandingAudit = (actorId: string) =>
  db.auditLog.findMany({ where: { actorId, targetType: "settings", targetId: { startsWith: "branding." } }, orderBy: { createdAt: "asc" } });

describe("PUT /api/admin/settings/branding/:slot", () => {
  it("uploads, replaces and removes a logo with audit rows and storefront revalidation", async () => {
    const first = await upload("logo-light", await png(800, 200));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("no-store");
    const body = (await first.json()) as WriteBody;
    expect(body.changed).toBe(true);
    expect(body.branding["logo-light"]).toMatchObject({ format: "png", mime: "image/png", width: 800, height: 200, png: { width: 640, height: 160 } });
    expect(body.branding["logo-dark"]).toBeNull();
    expect(revalidated).toEqual(["settings"]);
    const row = await db.brandAsset.findUniqueOrThrow({ where: { slot: "LOGO_LIGHT" } });
    expect(row.updatedById).toBe(owner.user.id);
    expect(brandVersion(row.sha256)).toBe(body.branding["logo-light"]?.version);

    // The same file again: nothing written, nothing revalidated.
    revalidated.length = 0;
    const again = (await (await upload("logo-light", Buffer.from(row.bytes))).json()) as WriteBody;
    expect(again.changed).toBe(false);
    expect(revalidated).toEqual([]);

    const replaced = await upload("logo-light", SVG, { contentType: "image/svg+xml" });
    expect(replaced.status).toBe(200);
    expect(((await replaced.json()) as WriteBody).branding["logo-light"]).toMatchObject({ format: "svg", width: 120, height: 30 });

    const removed = await remove("logo-light");
    expect(((await removed.json()) as WriteBody)).toMatchObject({ changed: true, branding: { "logo-light": null } });
    expect(await db.brandAsset.count()).toBe(0);
    expect(((await (await remove("logo-light")).json()) as WriteBody).changed).toBe(false);
    expect(revalidated).toEqual(["settings", "settings"]);

    const rows = await brandingAudit(owner.user.id);
    expect(rows.map((r) => [r.action, r.target, r.targetId])).toEqual([
      ["Uploaded branding image", "Branding · Logo for light backgrounds", "branding.logo-light"],
      ["Replaced branding image", "Branding · Logo for light backgrounds", "branding.logo-light"],
      ["Removed branding image", "Branding · Logo for light backgrounds", "branding.logo-light"],
    ]);
    const shaPng = brandVersion(row.sha256);
    expect(rows[0]?.detail).toBe(`image/png, ${row.byteSize} bytes, sha256 ${shaPng}`);
    expect(rows[1]?.detail).toMatch(new RegExp(`^image/svg\\+xml, \\d+ bytes, sha256 [0-9a-f]{12} \\(was image/png, ${row.byteSize} bytes, sha256 ${shaPng}\\)$`));
    expect(rows[2]?.detail).toMatch(/^was image\/svg\+xml, \d+ bytes, sha256 [0-9a-f]{12}; the built-in logo is back$/);
    for (const r of rows) expect((r.detail ?? "").length).toBeLessThan(200);
  });

  it("is Owner only: other roles are refused and nothing is stored", async () => {
    await upload("favicon", await png(64, 64));
    for (const role of ["ADMIN", "SUPPORT", "FINANCE"] as const) {
      const session = await startSession(await makeStaff(role));
      const put = await upload("logo-dark", await png(400, 100), { session });
      expect([put.status, await errorCodeOf(put)], role).toEqual([403, "forbidden"]);
      const del = await remove("favicon", session);
      expect([del.status, await errorCodeOf(del)], role).toEqual([403, "forbidden"]);
    }
    const signedOut = await upload("logo-dark", await png(400, 100), { session: null });
    expect(signedOut.status).toBe(401);
    const customer = await startSession((await makeCustomer()).user);
    expect((await upload("logo-dark", await png(400, 100), { session: customer })).status).toBe(403);
    expect((await db.brandAsset.findMany({ select: { slot: true } })).map((r) => r.slot)).toEqual(["FAVICON"]);
  });

  it("needs the CSRF token and the raw file body", async () => {
    const noCsrf = await upload("logo-light", await png(400, 100), { csrf: false });
    expect([noCsrf.status, await errorCodeOf(noCsrf)]).toEqual([403, "csrf_failed"]);
    const json = await upload("logo-light", "{}", { contentType: "application/json" });
    expect([json.status, await errorCodeOf(json)]).toEqual([415, "unsupported_media_type"]);
    const unknown = await upload("banner", await png(400, 100));
    expect([unknown.status, await errorCodeOf(unknown)]).toEqual([404, "not_found"]);
    expect(await db.brandAsset.count()).toBe(0);
  });

  it("refuses a declared or actual body over the slot's limit before processing it", async () => {
    const declared = await upload("favicon", await png(64, 64), { contentLength: String(256 * 1024 + 1) });
    expect([declared.status, await fileError(declared)]).toEqual([422, "The file is larger than 256 KB."]);
    const actual = await upload("favicon", new Uint8Array(256 * 1024 + 10));
    expect([actual.status, await fileError(actual)]).toEqual([422, "The file is larger than 256 KB."]);
  });

  it("validates the file server-side as 422 field errors on `file`", async () => {
    const jpeg = await sharp({ create: { width: 400, height: 100, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    // The declared type is ignored: the bytes decide.
    const disguised = await upload("logo-light", jpeg, { contentType: "image/png" });
    expect([disguised.status, await fileError(disguised)]).toEqual([422, "Upload a PNG, SVG or WebP file."]);
    const script = await upload("logo-light", SVG.replace("<rect", "<script>alert(1)</script><rect"));
    expect(await fileError(script)).toBe(SVG_MESSAGES.script);
    const onload = await upload("logo-dark", SVG.replace("<svg ", '<svg onload="alert(1)" '));
    expect(await fileError(onload)).toBe(SVG_MESSAGES.handler);
    const small = await upload("favicon", await png(32, 32));
    expect(await fileError(small)).toBe("The icon must be at least 48 × 48 px.");
    expect(await db.brandAsset.count()).toBe(0);
    expect(await brandingAudit(owner.user.id)).toEqual([]);
  });

  it("limits uploads to 30 per hour per Owner", async () => {
    const rule = RATE_LIMITS.brandUpload(owner.user.id);
    for (let i = 0; i < 30; i++) await hit(db, rule);
    const res = await upload("logo-light", await png(400, 100));
    expect([res.status, await errorCodeOf(res)]).toEqual([429, "too_many_attempts"]);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("GET /brand/:file", () => {
  it("serves the stored file with its type, nosniff, inline, the sandbox CSP and caching by version", async () => {
    const up = (await (await upload("logo-dark", SVG, { contentType: "image/svg+xml" })).json()) as WriteBody;
    const version = up.branding["logo-dark"]?.version ?? "";
    expect(version).toMatch(/^[0-9a-f]{12}$/);

    const res = await file("logo-dark", `?v=${version}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="logo-dark.svg"');
    expect(res.headers.get("content-security-policy")).toBe(BRAND_ASSET_CSP);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const text = await res.text();
    expect(text).toContain('viewBox="0 0 120 30"');
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(text)));

    expect((await file("logo-dark")).headers.get("cache-control")).toBe("public, max-age=300");
    // A version this process does not hold: the bytes it has, but nothing may cache them under that URL.
    expect((await file("logo-dark", "?v=000000000000")).headers.get("cache-control")).toBe("no-store");

    const etag = res.headers.get("etag") ?? "";
    const cached = await file("logo-dark", `?v=${version}`, { "if-none-match": `W/${etag}` });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");

    const rendition = await file("logo-dark.png", `?v=${version}`);
    expect([rendition.status, rendition.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect(rendition.headers.get("content-disposition")).toBe('inline; filename="logo-dark.png"');
    expect((await sharp(Buffer.from(await rendition.arrayBuffer())).metadata()).height).toBe(160);
  });

  it("answers 404 (no-store) for empty slots, unknown names and after a removal", async () => {
    for (const name of ["favicon", "favicon.png", "logo.svg", "LOGO-LIGHT"]) {
      const res = await file(name);
      expect([res.status, res.headers.get("cache-control")], name).toEqual([404, "no-store"]);
    }
    await upload("favicon", await png(64, 64));
    const ok = await file("favicon");
    expect([ok.status, ok.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect((await file("logo-light-apple.png")).status).toBe(404);
    await remove("favicon");
    expect((await file("favicon")).status).toBe(404);
    expect((await file("favicon-apple.png")).status).toBe(404);
  });

  it("serves the favicon's apple-touch-icon flattened onto an opaque background", async () => {
    const up = (await (await upload("favicon", await png(64, 64))).json()) as WriteBody;
    const version = up.branding.favicon?.version ?? "";
    const tab = await file("favicon.png", `?v=${version}`);
    expect((await sharp(Buffer.from(await tab.arrayBuffer())).metadata()).hasAlpha).toBe(true);
    const apple = await file("favicon-apple.png", `?v=${version}`);
    expect([apple.status, apple.headers.get("content-type"), apple.headers.get("cache-control")]).toEqual([200, "image/png", "public, max-age=31536000, immutable"]);
    expect(apple.headers.get("content-disposition")).toBe('inline; filename="favicon-apple.png"');
    expect(apple.headers.get("content-security-policy")).toBe(BRAND_ASSET_CSP);
    expect(apple.headers.get("etag")).toMatch(/-apple"$/);
    const meta = await sharp(Buffer.from(await apple.arrayBuffer())).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([180, 180, false]);
  });

  it("serves a new upload at once in this process, for its new version", async () => {
    const a = (await (await upload("logo-light", await png(400, 100))).json()) as WriteBody;
    const first = await file("logo-light", `?v=${a.branding["logo-light"]?.version}`);
    expect(first.status).toBe(200);
    const b = (await (await upload("logo-light", await png(500, 100))).json()) as WriteBody;
    expect(b.branding["logo-light"]?.version).not.toBe(a.branding["logo-light"]?.version);
    const second = await file("logo-light", `?v=${b.branding["logo-light"]?.version}`);
    expect(second.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await sharp(Buffer.from(await second.arrayBuffer())).metadata()).width).toBe(500);
  });

  it("never caches a read that started before an upload committed", async () => {
    await upload("logo-light", await png(400, 100));
    const old = await db.brandAsset.findUniqueOrThrow({ where: { slot: "LOGO_LIGHT" }, select: { mime: true, sha256: true, bytes: true, pngBytes: true } });
    forgetBrandFile();
    // A GET's database read is still running when an upload commits (afterWrite clears the cache) ...
    let finishRead: (row: typeof old) => void = () => {};
    const slowClient = { brandAsset: { findUnique: () => new Promise<typeof old>((resolve) => (finishRead = resolve)) } } as unknown as typeof db;
    const stale = readBrandFile("logo-light", "original", null, slowClient);
    const b = (await (await upload("logo-light", await png(500, 100))).json()) as WriteBody;
    finishRead(old);
    expect((await stale)?.sha256).toBe(old.sha256);
    // ... so its old row is not cached: the next request (even without a version) gets the new file.
    const fresh = await readBrandFile("logo-light", "original", null);
    expect(fresh?.version).toBe(b.branding["logo-light"]?.version);
  });
});

describe("branding for PDFs, emails and pages", () => {
  it("has nothing to offer before an upload (the built-in look)", async () => {
    expect(await invoiceLogo(db)).toBeNull();
    expect(await emailLogo(db, "https://shop.example")).toBeNull();
    expect(await loadBrandingState(db)).toEqual({ "logo-light": null, "logo-dark": null, favicon: null });
    const email = await composeEmail(db, "email_verification", { name: "Asha", code: "123456" });
    expect(email.html).not.toContain("/brand/");
  });

  it("hands the light logo's PNG rendition to PDFs and its absolute URL to emails", async () => {
    await upload("logo-light", await png(800, 200));
    const logo = await invoiceLogo(db);
    expect(logo && [logo.width, logo.height]).toEqual([640, 160]);
    expect((await sharp(Buffer.from(logo?.png ?? [])).metadata()).format).toBe("png");
    const state = await loadBrandingState(db);
    const version = state["logo-light"]?.version;
    const appUrl = getEnv().APP_URL.replace(/\/+$/, "");
    const email = await composeEmail(db, "email_verification", { name: "Asha", code: "123456" });
    expect(email.html).toContain(`<img src="${appUrl}/brand/logo-light.png?v=${version}" width="144" height="36" alt="Axiomatic Software Solutions"`);
    expect(email.html).not.toContain("<picture>");
  });
});
