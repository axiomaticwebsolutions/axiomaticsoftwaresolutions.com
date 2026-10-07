/**
 * Ticket attachments end to end with the local storage driver: presigned PUT (type and size limits), the dev PUT
 * route standing in for S3, confirmation by size, attaching to a ticket (only the uploader's own confirmed files in
 * the same account, once), and 10-minute download links for members who can view tickets (never other accounts'
 * files or staff-only notes).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT as devStoragePUT } from "@/app/api/dev/storage/[...key]/route";
import { POST as createTicketPOST } from "@/app/api/account/tickets/route";
import { POST as confirmPOST } from "@/app/api/account/uploads/[id]/confirm/route";
import { GET as downloadGET } from "@/app/api/account/uploads/[id]/download/route";
import { POST as uploadPOST } from "@/app/api/account/uploads/route";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { setStorage } from "@/lib/storage";
import { LocalStorageDriver } from "@/lib/storage/local";
import { bodyOf, call, errorOf, makeCatalog, makeMember, signIn, type Catalog, type Member } from "./license-actions-fixtures";

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

let dir: string;
let catalog: Catalog;
let owner: Member;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "axs-uploads-"));
  setStorage(new LocalStorageDriver({ dir, appUrl: getEnv().APP_URL, secret: getEnv().SESSION_SECRET }));
  catalog = await makeCatalog();
});
afterAll(async () => {
  setStorage(null);
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  owner = await makeMember({ name: "Priya Sharma" });
  await signIn(jar, owner);
});

type Put = { url: string; method: string; headers: Record<string, string>; expiresAt: string };
type UploadResponse = { upload: { id: string; status: string; sizeLabel: string }; put: Put };

const requestUpload = (file: Record<string, unknown>) => call(jar, uploadPOST, "/api/account/uploads", { method: "POST", body: file });
const confirm = (id: string) => call(jar, confirmPOST, `/api/account/uploads/${id}/confirm`, { method: "POST", params: { id } });
const download = (id: string, query = "") =>
  call(jar, downloadGET, `/api/account/uploads/${id}/download${query}`, { params: { id } });
const createTicket = (attachmentIds: string[]) =>
  call(jar, createTicketPOST, "/api/account/tickets", {
    method: "POST",
    body: { productId: catalog.product.id, subject: "Screenshot of the error", body: "The billing screen shows an error, see the file.", attachmentIds },
  });

/** What the browser does with the presigned PUT (through the dev storage route). */
async function putBytes(put: Put, bytes: Buffer, contentType = put.headers["Content-Type"] ?? ""): Promise<Response> {
  const url = new URL(put.url);
  const key = url.pathname.replace(/^\/api\/dev\/storage\//, "").split("/").map(decodeURIComponent);
  const req = new NextRequest(put.url, { method: "PUT", headers: { "content-type": contentType }, body: new Uint8Array(bytes) });
  return devStoragePUT(req, { params: Promise.resolve({ key }) });
}

async function uploaded(name = "scanner-error.png", size = 2048, type = "image/png"): Promise<UploadResponse> {
  const res = await requestUpload({ fileName: name, contentType: type, sizeBytes: size });
  expect(res.status).toBe(201);
  const body = (await res.json()) as UploadResponse;
  expect((await putBytes(body.put, Buffer.alloc(size, 7))).status).toBe(200);
  return body;
}

describe("upload requests", () => {
  it("signs a 5-minute PUT for an allowed file under uploads/<accountId>/", async () => {
    const res = await requestUpload({ fileName: "Scanner error.png", contentType: "image/png", sizeBytes: 214 * 1024 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadResponse;
    expect(body.upload).toMatchObject({ status: "pending", sizeLabel: "214 KB" });
    expect(body.put).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/png" } });
    expect(Date.parse(body.put.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    expect(Date.parse(body.put.expiresAt) - Date.now()).toBeGreaterThan(240_000);
    const row = await db.upload.findUniqueOrThrow({ where: { id: body.upload.id } });
    expect(row).toMatchObject({ accountId: owner.accountId, uploadedById: owner.user.id, status: "PENDING", fileName: "Scanner error.png" });
    expect(row.storageKey).toMatch(new RegExp(`^uploads/${owner.accountId}/[0-9a-f-]{36}/Scanner-error[.]png$`));
  });

  it("refuses other types, mismatched extensions, empty and oversized files", async () => {
    for (const file of [
      { fileName: "setup.exe", contentType: "application/octet-stream", sizeBytes: 10 },
      { fileName: "invoice.exe", contentType: "application/pdf", sizeBytes: 10 },
      { fileName: "a.png", contentType: "image/png", sizeBytes: 0 },
      { fileName: "a.png", contentType: "image/png", sizeBytes: 10 * 1024 * 1024 + 1 },
    ]) {
      const res = await requestUpload(file);
      expect(res.status, file.fileName).toBe(422);
    }
    expect(await db.upload.count({ where: { uploadedById: owner.user.id } })).toBe(0);
  });

  it("is refused to Viewers (they cannot raise tickets)", async () => {
    const viewer = await makeMember({ accountId: owner.accountId, role: "VIEWER" });
    await signIn(jar, viewer);
    expect((await requestUpload({ fileName: "a.png", contentType: "image/png", sizeBytes: 10 })).status).toBe(403);
  });
});

describe("storage PUT and confirmation", () => {
  it("rejects a PUT with another content type or more bytes than signed", async () => {
    const body = (await (await requestUpload({ fileName: "a.txt", contentType: "text/plain", sizeBytes: 10 })).json()) as UploadResponse;
    expect((await putBytes(body.put, Buffer.alloc(10), "text/html")).status).toBe(403);
    expect((await putBytes(body.put, Buffer.alloc(11))).status).toBe(413);
  });

  it("confirms only an object of exactly the declared size, and only for the uploader", async () => {
    const pending = (await (await requestUpload({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 100 })).json()) as UploadResponse;
    const missing = await confirm(pending.upload.id);
    expect(missing.status).toBe(409);
    expect(errorOf(await bodyOf(missing)).code).toBe("upload_missing");

    const teammate = await makeMember({ accountId: owner.accountId, role: "TECHNICAL" });
    const good = await uploaded("guide.pdf", 300, "application/pdf");
    await signIn(jar, teammate);
    expect((await confirm(good.upload.id)).status).toBe(404);
    await signIn(jar, owner);
    const ok = await confirm(good.upload.id);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as UploadResponse).upload.status).toBe("ready");

    expect((await putBytes(pending.put, Buffer.alloc(40))).status).toBe(200);
    const short = await confirm(pending.upload.id);
    expect(short.status).toBe(422);
    expect(errorOf(await bodyOf(short)).code).toBe("upload_mismatch");
    expect(await db.upload.findUnique({ where: { id: pending.upload.id } })).toBeNull();
  });

  it("deletes the stored object of a refused upload", async () => {
    const pending = (await (await requestUpload({ fileName: "b.pdf", contentType: "application/pdf", sizeBytes: 100 })).json()) as UploadResponse;
    expect((await putBytes(pending.put, Buffer.alloc(60))).status).toBe(200);
    const key = (await db.upload.findUniqueOrThrow({ where: { id: pending.upload.id } })).storageKey;
    const driver = new LocalStorageDriver({ dir, appUrl: getEnv().APP_URL, secret: getEnv().SESSION_SECRET });
    expect(await driver.head(key)).toEqual({ sizeBytes: 60 });
    expect((await confirm(pending.upload.id)).status).toBe(422);
    expect(await driver.head(key)).toBeNull();
  });
});

type Detail = { ticket: { id: string }; messages: { attachments: { id: string | null; name: string; sizeLabel: string }[] }[] };

describe("attaching", () => {
  it("attaches the uploader's files to the new ticket, once", async () => {
    const a = await uploaded("scanner-error.png", 2048);
    const b = await uploaded("notes.txt", 64, "text/plain");
    const res = await createTicket([a.upload.id, b.upload.id]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Detail;
    expect(body.messages[0]?.attachments).toEqual([
      { id: a.upload.id, name: "scanner-error.png", sizeBytes: 2048, sizeLabel: "2 KB", contentType: "image/png" },
      { id: b.upload.id, name: "notes.txt", sizeBytes: 64, sizeLabel: "1 KB", contentType: "text/plain" },
    ]);
    const rows = await db.upload.findMany({ where: { id: { in: [a.upload.id, b.upload.id] } } });
    expect(rows.every((r) => r.status === "ATTACHED" && r.ticketMessageId !== null && r.attachedAt !== null)).toBe(true);
    const again = await createTicket([a.upload.id]);
    expect(again.status).toBe(422);
    expect(errorOf(await bodyOf(again)).fieldErrors).toEqual({ attachmentIds: ["One of the attachments isn’t available any more. Remove it and attach it again."] });
  });

  it("refuses files of a teammate or another account, and files never uploaded (nothing is created)", async () => {
    const teammate = await makeMember({ accountId: owner.accountId, role: "TECHNICAL" });
    await signIn(jar, teammate);
    const theirs = await uploaded();
    const stranger = await makeMember();
    await signIn(jar, stranger);
    const foreign = await uploaded();
    const never = (await (await requestUpload({ fileName: "a.png", contentType: "image/png", sizeBytes: 50 })).json()) as UploadResponse;
    await signIn(jar, owner);
    const mine = await uploaded();
    for (const ids of [[theirs.upload.id], [foreign.upload.id], [mine.upload.id, never.upload.id]]) {
      expect((await createTicket(ids)).status).toBe(422);
    }
    expect(await db.supportTicket.count({ where: { accountId: owner.accountId } })).toBe(0);
    expect((await db.upload.findUniqueOrThrow({ where: { id: mine.upload.id } })).status).toBe("PENDING");
  });

  it("re-checks the stored object when attaching (a replaced object is refused)", async () => {
    const a = await uploaded("a.png", 100);
    await setStorageObject(a.upload.id, Buffer.alloc(5000));
    expect((await createTicket([a.upload.id])).status).toBe(422);
  });
});

async function setStorageObject(uploadId: string, bytes: Buffer): Promise<void> {
  const row = await db.upload.findUniqueOrThrow({ where: { id: uploadId } });
  const driver = new LocalStorageDriver({ dir, appUrl: getEnv().APP_URL, secret: getEnv().SESSION_SECRET });
  await driver.putObject(row.storageKey, bytes, row.contentType);
}

describe("downloads", () => {
  it("gives every member who can view tickets a 10-minute link, and nobody outside the account", async () => {
    const a = await uploaded("scanner-error.png", 2048);
    const ticket = (await (await createTicket([a.upload.id])).json()) as Detail;
    const viewer = await makeMember({ accountId: owner.accountId, role: "VIEWER" });
    await signIn(jar, viewer);
    const res = await download(a.upload.id);
    expect(res.status).toBe(200);
    const link = (await res.json()) as { url: string; expiresAt: string; fileName: string };
    expect(link.fileName).toBe("scanner-error.png");
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(600_000);
    expect(link.url).toContain("/api/dev/storage/uploads/");
    const redirect = await download(a.upload.id, "?redirect=1");
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toContain("/api/dev/storage/uploads/");

    const stranger = await makeMember();
    await signIn(jar, stranger);
    expect((await download(a.upload.id)).status).toBe(404);
    expect(ticket.ticket.id).toMatch(/^T-/);
  });

  it("never serves attachments of staff-only notes; pending files only to their uploader", async () => {
    const internal = await uploaded("internal.pdf", 100, "application/pdf");
    const ticket = (await (await createTicket([])).json()) as Detail;
    const staff = await db.user.create({ data: { email: `staff.${Date.now()}@axiomatic.test`, name: "Rahul Nair", kind: "STAFF", staffRole: "SUPPORT", staffStatus: "ACTIVE" } });
    const note = await db.ticketMessage.create({ data: { ticketId: ticket.ticket.id, authorId: staff.id, isStaff: true, internal: true, body: "note", attachments: [] } });
    await db.upload.update({ where: { id: internal.upload.id }, data: { status: "ATTACHED", ticketMessageId: note.id } });
    expect((await download(internal.upload.id)).status).toBe(404);

    const pending = await uploaded("draft.png", 10);
    expect((await download(pending.upload.id)).status).toBe(200);
    const teammate = await makeMember({ accountId: owner.accountId, role: "TECHNICAL" });
    await signIn(jar, teammate);
    expect((await download(pending.upload.id)).status).toBe(404);
  });
});
