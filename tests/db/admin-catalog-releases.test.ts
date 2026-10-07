/**
 * Admin Releases API (decisions.md Phase 6 "Releases"): drafts, installer uploads through presigned PUTs with the
 * SHA-256 computed on the server from the stored object (local driver in a temp dir), publish (audited, entitled
 * accounts notified in-app and by email, idempotently), withdraw (reason), draft deletion and the derived "Latest".
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as NextCache from "next/cache";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as releasesRoute from "@/app/api/admin/releases/route";
import * as releaseRoute from "@/app/api/admin/releases/[id]/route";
import * as filesRoute from "@/app/api/admin/releases/[id]/files/route";
import * as confirmRoute from "@/app/api/admin/releases/[id]/files/confirm/route";
import * as fileRoute from "@/app/api/admin/releases/[id]/files/[fileId]/route";
import * as publishRoute from "@/app/api/admin/releases/[id]/publish/route";
import * as withdrawRoute from "@/app/api/admin/releases/[id]/withdraw/route";
import { notifyReleaseAvailable, releaseNotificationHref } from "@/lib/admin/catalog/release-notify";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { setStorage } from "@/lib/storage";
import { LocalStorageDriver } from "@/lib/storage/local";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers, type TestSession } from "../support/admin-fixtures";
import { auditRows, makeAccount, makeLicenseRow, makePlan, makeProduct, makeRelease } from "./admin-catalog-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));
vi.mock("next/cache", async (importOriginal) => ({ ...(await importOriginal<typeof NextCache>()), revalidateTag }));

let callers: AdminCallers;
let dir: string;
let storage: LocalStorageDriver;
const DAY = 86_400_000;

beforeAll(async () => {
  callers = await makeAdminCallers();
  dir = await mkdtemp(join(tmpdir(), "axs-releases-"));
  storage = new LocalStorageDriver({ dir, appUrl: getEnv().APP_URL, secret: getEnv().SESSION_SECRET });
  setStorage(storage);
});

afterAll(async () => {
  setStorage(null);
  await rm(dir, { recursive: true, force: true });
});

type Json = Record<string, unknown>;
const body = async (res: Response) => (await res.json()) as Json;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function claimsOf(token: string): { k: string; s: number } {
  return JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { k: string; s: number };
}

async function createDraft(productId: string, version: string, session: TestSession = callers.ADMIN, extra: Json = {}) {
  const res = await callRoute(jar, releasesRoute.POST, {
    method: "POST",
    path: "/api/admin/releases",
    body: { productId, version, notes: ["Faster search"], ...extra },
    session,
  });
  expect(res.status).toBe(201);
  return (await body(res)).release as Json & { id: string };
}

async function ticket(id: string, input: Json, session: TestSession = callers.ADMIN): Promise<Response> {
  return callRoute(jar, filesRoute.POST, { method: "POST", path: `/api/admin/releases/${id}/files`, params: { id }, body: input, session });
}

async function confirm(id: string, uploadToken: string, session: TestSession = callers.ADMIN): Promise<Response> {
  return callRoute(jar, confirmRoute.POST, {
    method: "POST",
    path: `/api/admin/releases/${id}/files/confirm`,
    params: { id },
    body: { uploadToken },
    session,
  });
}

/** Ticket + PUT (straight into the local driver) + confirm. */
async function upload(id: string, platform: string, fileName: string, bytes: Buffer): Promise<Json> {
  const res = await ticket(id, { platform, fileName, sizeBytes: bytes.length });
  expect(res.status).toBe(201);
  const { uploadToken } = (await body(res)) as { uploadToken: string };
  await storage.putObject(claimsOf(uploadToken).k, bytes, "application/octet-stream");
  const done = await confirm(id, uploadToken);
  expect(done.status).toBe(200);
  return body(done);
}

describe("drafts and installer uploads", () => {
  it("creates a draft and refuses duplicate or malformed versions", async () => {
    const product = await makeProduct();
    const draft = await createDraft(product.id, "4.3.0");
    expect(draft).toMatchObject({ rawStatus: "DRAFT", status: "draft", version: "4.3.0", fileCount: 0, missingPlatforms: ["windows", "macos"] });
    expect(draft.storagePrefix).toBe(`releases/${product.id}/4.3.0/`);
    expect((await auditRows(draft.id)).map((r) => r.action)).toEqual(["Created release draft"]);

    const dup = await callRoute(jar, releasesRoute.POST, { method: "POST", path: "/api/admin/releases", body: { productId: product.id, version: "4.3.0" }, session: callers.ADMIN });
    expect(dup.status).toBe(422);
    const bad = await callRoute(jar, releasesRoute.POST, { method: "POST", path: "/api/admin/releases", body: { productId: product.id, version: "v4" }, session: callers.ADMIN });
    expect(bad.status).toBe(422);
    const support = await callRoute(jar, releasesRoute.POST, { method: "POST", path: "/api/admin/releases", body: { productId: product.id, version: "4.4.0" }, session: callers.SUPPORT });
    expect(support.status).toBe(403);
  });

  it("uploads through a presigned PUT and stores the SHA-256 computed on the server", async () => {
    const product = await makeProduct({ platforms: ["windows", "macos"] });
    const draft = await createDraft(product.id, "5.0.0");
    const android = await ticket(draft.id, { platform: "android", fileName: "app.apk", sizeBytes: 10 });
    expect(android.status).toBe(422);
    const wrongExt = await ticket(draft.id, { platform: "windows", fileName: "setup.dmg", sizeBytes: 10 });
    expect(((await body(wrongExt)).error as Json).fieldErrors).toHaveProperty("fileName");

    const bytes = Buffer.from("MZ installer bytes for 5.0.0");
    const res = await ticket(draft.id, { platform: "windows", fileName: "Catalog Setup 5.0.0 (x64).exe", sizeBytes: bytes.length });
    expect(res.status).toBe(201);
    const t = (await body(res)) as { upload: { url: string; method: string; headers: Record<string, string> }; uploadToken: string };
    expect(t.upload.method).toBe("PUT");
    expect(t.upload.headers["Content-Type"]).toBe("application/octet-stream");
    expect(t.upload.url).toContain(`/api/dev/storage/releases/${product.id}/5.0.0/`);
    expect(t.upload.url).toContain("Catalog-Setup-5.0.0-x64.exe");

    const early = await confirm(draft.id, t.uploadToken);
    expect(await errorCodeOf(early)).toBe("upload_missing");
    const foreign = await confirm(draft.id, t.uploadToken, callers.OWNER);
    expect(await errorCodeOf(foreign)).toBe("upload_invalid");

    const { k } = claimsOf(t.uploadToken);
    await storage.putObject(k, Buffer.from("short"), "application/octet-stream");
    const mismatch = await confirm(draft.id, t.uploadToken);
    expect(mismatch.status).toBe(422);
    expect(await errorCodeOf(mismatch)).toBe("upload_mismatch");
    expect(await storage.head(k)).toBeNull();

    await storage.putObject(k, bytes, "application/octet-stream");
    const ok = await confirm(draft.id, t.uploadToken);
    expect(ok.status).toBe(200);
    const result = (await body(ok)) as { file: Json; release: Json };
    expect(result.file).toMatchObject({ platform: "windows", fileName: "Catalog-Setup-5.0.0-x64.exe", sizeBytes: bytes.length, sha256: sha(bytes) });
    expect(result.release).toMatchObject({ fileCount: 1, platforms: ["windows"], missingPlatforms: ["macos"] });
    const twice = await confirm(draft.id, t.uploadToken);
    expect(((await body(twice)).file as Json).id).toBe(result.file.id);
    expect((await auditRows(draft.id)).map((r) => r.action)).toEqual(["Created release draft", "Uploaded installer"]);

    // Replacing the Windows installer removes the previous object.
    const bytes2 = Buffer.from("MZ installer bytes, second build");
    const replaced = await upload(draft.id, "windows", "setup.exe", bytes2);
    expect((replaced.release as Json).files).toEqual([expect.objectContaining({ platform: "windows", sha256: sha(bytes2) })]);
    expect(await storage.head(k)).toBeNull();

    const versionChange = await callRoute(jar, releaseRoute.PATCH, {
      method: "PATCH",
      path: `/api/admin/releases/${draft.id}`,
      params: { id: draft.id },
      body: { version: "5.0.1" },
      session: callers.ADMIN,
    });
    expect(await errorCodeOf(versionChange)).toBe("has_installers");

    const fileId = ((replaced.release as Json).files as Json[])[0]?.id as string;
    const noReason = await callRoute(jar, fileRoute.DELETE, {
      method: "DELETE",
      path: `/api/admin/releases/${draft.id}/files/${fileId}`,
      params: { id: draft.id, fileId },
      body: {},
      session: callers.ADMIN,
    });
    expect(await errorCodeOf(noReason)).toBe("reason_required");
    const removed = await callRoute(jar, fileRoute.DELETE, {
      method: "DELETE",
      path: `/api/admin/releases/${draft.id}/files/${fileId}`,
      params: { id: draft.id, fileId },
      body: { reason: "Wrong build" },
      session: callers.ADMIN,
    });
    expect(removed.status).toBe(200);
    expect((await auditRows(draft.id)).at(-1)).toMatchObject({ action: "Removed installer", reason: "Wrong build" });
    expect(((await body(removed)).release as Json).fileCount).toBe(0);
    expect(await db.releaseFile.count({ where: { releaseId: draft.id } })).toBe(0);
  });

  it("deletes a draft with its installers", async () => {
    const product = await makeProduct();
    const draft = await createDraft(product.id, "6.0.0");
    await upload(draft.id, "windows", "setup.exe", Buffer.from("bytes"));
    const keys = (await db.releaseFile.findMany({ where: { releaseId: draft.id } })).map((f) => f.storageKey);
    const path = `/api/admin/releases/${draft.id}`;
    const noReason = await callRoute(jar, releaseRoute.DELETE, { method: "DELETE", path, params: { id: draft.id }, body: {}, session: callers.OWNER });
    expect([noReason.status, await errorCodeOf(noReason)]).toEqual([422, "reason_required"]);
    expect(await db.release.findUnique({ where: { id: draft.id } })).not.toBeNull();
    const res = await callRoute(jar, releaseRoute.DELETE, { method: "DELETE", path, params: { id: draft.id }, body: { reason: "Built from the wrong branch" }, session: callers.OWNER });
    expect(res.status).toBe(200);
    expect(await db.release.findUnique({ where: { id: draft.id } })).toBeNull();
    for (const key of keys) expect(await storage.head(key)).toBeNull();
    expect((await auditRows(draft.id)).at(-1)).toMatchObject({ action: "Deleted release draft", reason: "Built from the wrong branch", detail: "1 installer removed" });
  });
});

describe("publish, notify and withdraw", () => {
  it("publishes a draft with installers and notifies only entitled members, once", async () => {
    const product = await makeProduct({ status: "PUBLISHED" });
    const plan = await makePlan(product.id);
    const entitled = await makeAccount([{ role: "OWNER" }, { role: "TECHNICAL", updates: false }, { role: "BILLING", status: "INVITED" }, { role: "VIEWER", verified: false }]);
    await makeLicenseRow(product.id, plan.id, entitled.account.id);
    await makeLicenseRow(product.id, plan.id, entitled.account.id); // two licenses, still one notification each
    const expired = await makeAccount([{}]);
    await makeLicenseRow(product.id, plan.id, expired.account.id, { expiresAt: new Date(Date.now() - DAY) });
    const updatesEnded = await makeAccount([{}]);
    await makeLicenseRow(product.id, plan.id, updatesEnded.account.id, { expiresAt: null, updatesUntil: new Date(Date.now() - DAY) });
    const revoked = await makeAccount([{}]);
    await makeLicenseRow(product.id, plan.id, revoked.account.id, { status: "REVOKED" });
    const trial = await makeAccount([{}]);
    await makeLicenseRow(product.id, plan.id, trial.account.id, { status: "TRIAL" });
    await makeLicenseRow(product.id, plan.id, null);

    const draft = await createDraft(product.id, "7.1.0");
    const publishPath = `/api/admin/releases/${draft.id}/publish`;
    const empty = await callRoute(jar, publishRoute.POST, { method: "POST", path: publishPath, params: { id: draft.id }, body: {}, session: callers.ADMIN });
    expect(await errorCodeOf(empty)).toBe("no_installers");
    await upload(draft.id, "windows", "setup.exe", Buffer.from("seven one zero"));

    const support = await callRoute(jar, publishRoute.POST, { method: "POST", path: publishPath, params: { id: draft.id }, body: {}, session: callers.SUPPORT });
    expect(support.status).toBe(403);
    const res = await callRoute(jar, publishRoute.POST, { method: "POST", path: publishPath, params: { id: draft.id }, body: {}, session: callers.ADMIN });
    expect(res.status).toBe(200);
    const release = (await body(res)).release as Json;
    expect(release).toMatchObject({ rawStatus: "PUBLISHED", status: "latest" });
    expect(release.releasedAt).toEqual(expect.any(String));
    expect(revalidateTag).toHaveBeenCalledWith("catalog");
    expect((await auditRows(draft.id)).at(-1)).toMatchObject({ action: "Published release", detail: "Windows" });

    const href = releaseNotificationHref(draft.id);
    const notified = await db.notification.findMany({ where: { href }, select: { userId: true, kind: true, title: true } });
    const [owner, technical, invited, unverified] = entitled.users;
    expect(notified.map((n) => n.userId).sort()).toEqual([owner!.id, technical!.id, unverified!.id, trial.users[0]!.id].sort());
    expect(notified.every((n) => n.kind === "update" && n.title === `${product.shortName} 7.1.0 is available`)).toBe(true);
    expect(notified.some((n) => n.userId === invited!.id)).toBe(false);
    const emails = await db.outboxEmail.findMany({
      where: { dedupeKey: { startsWith: `release_available:${draft.id}:` } },
      select: { dedupeKey: true, subject: true },
    });
    expect(emails.map((e) => e.dedupeKey).sort()).toEqual([`release_available:${draft.id}:${owner!.id}`, `release_available:${draft.id}:${trial.users[0]!.id}`].sort());
    expect(emails[0]?.subject).toContain("7.1.0 is available");

    const rerun = await notifyReleaseAvailable(draft.id, { batchSize: 1 });
    expect(rerun).toMatchObject({ notifications: 0, emails: 0, skipped: null });
    expect(await db.notification.count({ where: { href } })).toBe(4);
  });
});

describe("after publishing", () => {
  it("freezes installers and version, keeps notes editable, and withdraws with a reason", async () => {
    const product = await makeProduct();
    const draft = await createDraft(product.id, "7.2.0");
    await upload(draft.id, "windows", "setup.exe", Buffer.from("seven two zero"));
    const pub = await callRoute(jar, publishRoute.POST, { method: "POST", path: `/api/admin/releases/${draft.id}/publish`, params: { id: draft.id }, body: {}, session: callers.OWNER });
    expect(pub.status).toBe(200);
    const again = await callRoute(jar, publishRoute.POST, { method: "POST", path: `/api/admin/releases/${draft.id}/publish`, params: { id: draft.id }, body: {}, session: callers.OWNER });
    expect(await errorCodeOf(again)).toBe("not_draft");

    const lateUpload = await ticket(draft.id, { platform: "macos", fileName: "setup.dmg", sizeBytes: 5 });
    expect(await errorCodeOf(lateUpload)).toBe("not_draft");
    const path = `/api/admin/releases/${draft.id}`;
    const versionEdit = await callRoute(jar, releaseRoute.PATCH, { method: "PATCH", path, params: { id: draft.id }, body: { version: "7.2.1" }, session: callers.ADMIN });
    expect(await errorCodeOf(versionEdit)).toBe("release_published");
    const notesEdit = await callRoute(jar, releaseRoute.PATCH, { method: "PATCH", path, params: { id: draft.id }, body: { notes: ["Faster search", "Fixes"] }, session: callers.ADMIN });
    expect(notesEdit.status).toBe(200);
    expect((await auditRows(draft.id)).at(-1)).toMatchObject({ action: "Updated release", detail: "Release notes" });
    const del = await callRoute(jar, releaseRoute.DELETE, { method: "DELETE", path, params: { id: draft.id }, body: { reason: "Too late now" }, session: callers.ADMIN });
    expect(await errorCodeOf(del)).toBe("not_draft");

    const withdrawPath = `/api/admin/releases/${draft.id}/withdraw`;
    const noReason = await callRoute(jar, withdrawRoute.POST, { method: "POST", path: withdrawPath, params: { id: draft.id }, body: {}, session: callers.ADMIN });
    expect(await errorCodeOf(noReason)).toBe("reason_required");
    const withdrawn = await callRoute(jar, withdrawRoute.POST, {
      method: "POST",
      path: withdrawPath,
      params: { id: draft.id },
      body: { reason: "Crash on start-up" },
      session: callers.OWNER,
    });
    expect(withdrawn.status).toBe(200);
    expect(((await body(withdrawn)).release as Json).status).toBe("withdrawn");
    expect((await auditRows(draft.id)).at(-1)).toMatchObject({ action: "Withdrew release", reason: "Crash on start-up", detail: "Was the latest release" });
  });

  it("does not notify for another channel", async () => {
    const product = await makeProduct();
    const plan = await makePlan(product.id);
    const acct = await makeAccount([{}]);
    await makeLicenseRow(product.id, plan.id, acct.account.id);
    const beta = await createDraft(product.id, "8.0.0-beta.1", callers.ADMIN, { channel: "beta" });
    await upload(beta.id, "windows", "setup.exe", Buffer.from("beta"));
    const res = await callRoute(jar, publishRoute.POST, { method: "POST", path: `/api/admin/releases/${beta.id}/publish`, params: { id: beta.id }, body: {}, session: callers.OWNER });
    expect(((await body(res)).release as Json).status).toBe("published");
    expect(await db.notification.count({ where: { href: releaseNotificationHref(beta.id) } })).toBe(0);
    expect(await notifyReleaseAvailable(beta.id)).toMatchObject({ skipped: "not_customer_channel" });
  });
});

describe("list", () => {
  it("derives Latest from the highest version and filters by status", async () => {
    const product = await makeProduct();
    const v420 = await makeRelease(product.id, { version: "4.2.0", status: "PUBLISHED", releasedAt: new Date("2026-07-01") });
    await makeRelease(product.id, { version: "4.1.5", status: "PUBLISHED", releasedAt: new Date("2026-08-01") });
    await makeRelease(product.id, { version: "4.3.0" });
    await makeRelease(product.id, { version: "4.0.0", status: "WITHDRAWN", releasedAt: new Date("2026-01-01") });

    const list = async (q: string) => {
      const res = await callRoute(jar, releasesRoute.GET, { path: `/api/admin/releases?filter[product]=${product.id}${q}`, session: callers.FINANCE });
      return ((await body(res)).items as Json[]).map((r) => [r.version, r.status]);
    };
    expect(await list("")).toEqual([["4.3.0", "draft"], ["4.1.5", "published"], ["4.2.0", "latest"], ["4.0.0", "withdrawn"]]);
    expect(await list("&filter[status]=latest")).toEqual([["4.2.0", "latest"]]);
    expect(await list("&filter[status]=published")).toEqual([["4.1.5", "published"]]);
    expect(await list("&sort=date")).toEqual([["4.0.0", "withdrawn"], ["4.2.0", "latest"], ["4.1.5", "published"], ["4.3.0", "draft"]]);
    const detail = await callRoute(jar, releaseRoute.GET, { path: `/api/admin/releases/${v420.id}`, params: { id: v420.id }, session: callers.SUPPORT });
    expect(((await body(detail)).release as Json).status).toBe("latest");
  });
});
