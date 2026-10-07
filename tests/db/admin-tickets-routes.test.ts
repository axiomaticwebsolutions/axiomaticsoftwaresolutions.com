/**
 * Staff ticket API end to end (decisions.md Phase 6; api-contracts section 7 `tickets`): Finance, customers and
 * signed-out callers are refused on every ticket route, internal notes posted through the API never appear in the
 * portal ticket API, a reply through the API sets the first response time, and staff attachments are Upload rows
 * that only their uploader can attach, only to tickets of the same account, downloadable by customers only on
 * public replies. Storage is the local driver with the dev PUT route standing in for S3.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as attachmentGET } from "@/app/api/admin/tickets/[id]/attachments/[uploadId]/route";
import { POST as messagesPOST } from "@/app/api/admin/tickets/[id]/messages/route";
import { GET as ticketGET, PATCH as ticketPATCH } from "@/app/api/admin/tickets/[id]/route";
import { POST as confirmPOST } from "@/app/api/admin/tickets/[id]/uploads/[uploadId]/confirm/route";
import { POST as uploadsPOST } from "@/app/api/admin/tickets/[id]/uploads/route";
import { POST as bulkPOST } from "@/app/api/admin/tickets/bulk/route";
import { GET as listGET } from "@/app/api/admin/tickets/route";
import { GET as portalTicketGET } from "@/app/api/account/tickets/[id]/route";
import { GET as portalDownloadGET } from "@/app/api/account/uploads/[id]/download/route";
import { POST as portalUploadPOST } from "@/app/api/account/uploads/route";
import { PUT as devStoragePUT } from "@/app/api/dev/storage/[...key]/route";
import type { User } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { setStorage } from "@/lib/storage";
import { LocalStorageDriver } from "@/lib/storage/local";
import { callRoute, errorCodeOf, startSession, type TestSession } from "../support/admin-fixtures";
import { makeCustomer, makeStaffSet, makeTicket, tag, type StaffSet } from "./admin-tickets-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

type Put = { url: string; method: string; headers: Record<string, string>; expiresAt: string };
type UploadResponse = { upload: { id: string; status: string }; put: Put };

let dir: string;
let staff: StaffSet;
let sessions: { owner: TestSession; admin: TestSession; support: TestSession; finance: TestSession; customer: TestSession };
let customer: { user: User; accountId: string };
let ticket: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "axs-admin-tickets-"));
  setStorage(new LocalStorageDriver({ dir, appUrl: getEnv().APP_URL, secret: getEnv().SESSION_SECRET }));
  staff = await makeStaffSet();
  customer = await makeCustomer();
  sessions = {
    owner: await startSession(staff.owner),
    admin: await startSession(staff.admin),
    support: await startSession(staff.support),
    finance: await startSession(staff.finance),
    customer: await startSession(customer.user, { activeAccountId: customer.accountId }),
  };
  ticket = await makeTicket({ accountId: customer.accountId, openedById: customer.user.id, subject: `Routes ${tag()}` });
});
afterAll(async () => {
  setStorage(null);
  await rm(dir, { recursive: true, force: true });
});

const ticketPath = (id: string, rest = "") => `/api/admin/tickets/${id}${rest}`;

/** What the browser does with the presigned PUT (through the dev storage route). */
async function putBytes(put: Put, bytes: Buffer): Promise<Response> {
  const url = new URL(put.url);
  const key = url.pathname.replace(/^\/api\/dev\/storage\//, "").split("/").map(decodeURIComponent);
  const req = new NextRequest(put.url, { method: "PUT", headers: { "content-type": put.headers["Content-Type"] ?? "" }, body: new Uint8Array(bytes) });
  return devStoragePUT(req, { params: Promise.resolve({ key }) });
}

/** A confirmed staff upload for `ticketId`. */
async function staffUpload(session: TestSession, ticketId: string, name = "steps.pdf", size = 512): Promise<string> {
  const res = await callRoute(jar, uploadsPOST, {
    method: "POST",
    path: ticketPath(ticketId, "/uploads"),
    params: { id: ticketId },
    body: { fileName: name, contentType: "application/pdf", sizeBytes: size },
    session,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as UploadResponse;
  expect((await putBytes(body.put, Buffer.alloc(size, 3))).status).toBe(200);
  const confirmed = await callRoute(jar, confirmPOST, {
    method: "POST",
    path: ticketPath(ticketId, `/uploads/${body.upload.id}/confirm`),
    params: { id: ticketId, uploadId: body.upload.id },
    session,
  });
  expect(confirmed.status).toBe(200);
  return body.upload.id;
}

function postMessage(session: TestSession, ticketId: string, body: Record<string, unknown>) {
  return callRoute(jar, messagesPOST, { method: "POST", path: ticketPath(ticketId, "/messages"), params: { id: ticketId }, body, session });
}

type RouteCall = { name: string; handler: unknown; method: string; path: string; params: Record<string, string>; body?: unknown };

describe("who may use the ticket API", () => {
  const calls = (): RouteCall[] => [
    { name: "list", handler: listGET, method: "GET", path: "/api/admin/tickets", params: {} },
    { name: "detail", handler: ticketGET, method: "GET", path: ticketPath(ticket), params: { id: ticket } },
    { name: "patch", handler: ticketPATCH, method: "PATCH", path: ticketPath(ticket), params: { id: ticket }, body: { priority: "high" } },
    { name: "message", handler: messagesPOST, method: "POST", path: ticketPath(ticket, "/messages"), params: { id: ticket }, body: { body: "Hi", internal: true } },
    { name: "bulk", handler: bulkPOST, method: "POST", path: "/api/admin/tickets/bulk", params: {}, body: { action: "resolve", ids: [ticket] } },
    {
      name: "upload",
      handler: uploadsPOST,
      method: "POST",
      path: ticketPath(ticket, "/uploads"),
      params: { id: ticket },
      body: { fileName: "a.txt", contentType: "text/plain", sizeBytes: 3 },
    },
    { name: "confirm", handler: confirmPOST, method: "POST", path: ticketPath(ticket, "/uploads/u1/confirm"), params: { id: ticket, uploadId: "u1" } },
    { name: "download", handler: attachmentGET, method: "GET", path: ticketPath(ticket, "/attachments/u1"), params: { id: ticket, uploadId: "u1" } },
  ];

  it("refuses Finance (403), customers (403) and signed-out callers (401) on every route, changing nothing", async () => {
    for (const call of calls()) {
      for (const [who, session, status] of [
        ["finance", sessions.finance, 403],
        ["customer", sessions.customer, 403],
        ["signed out", null, 401],
      ] as const) {
        const res = await callRoute(jar, call.handler, {
          method: call.method,
          path: call.path,
          params: call.params,
          ...(call.body === undefined ? {} : { body: call.body }),
          session,
        });
        expect(res.status, `${call.name} as ${who}`).toBe(status);
        expect(res.headers.get("cache-control"), `${call.name} as ${who}`).toBe("no-store");
      }
    }
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id: ticket } })).toMatchObject({ priority: "NORMAL", status: "OPEN" });
    expect(await db.ticketMessage.count({ where: { ticketId: ticket } })).toBe(1);
    expect(await db.upload.count({ where: { uploadedById: { in: [staff.finance.id, customer.user.id] } } })).toBe(0);
  });

  it("lets Support read the list and the ticket with its internal notes", async () => {
    const list = await callRoute(jar, listGET, { path: `/api/admin/tickets?q=${ticket}&filter[status]=open`, session: sessions.support });
    expect(list.status).toBe(200);
    const page = (await list.json()) as { items: { id: string }[]; total: number; page: number; pageSize: number };
    expect(page).toMatchObject({ page: 1, pageSize: 25 });
    expect(page.items.map((r) => r.id)).toContain(ticket);
    const detail = await callRoute(jar, ticketGET, { path: ticketPath(ticket), params: { id: ticket }, session: sessions.support });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { ticket: { id: string } }).ticket.id).toBe(ticket);
  });

  it("validates bodies strictly (422) and 404s unknown or malformed ids", async () => {
    const empty = await callRoute(jar, ticketPATCH, { method: "PATCH", path: ticketPath(ticket), params: { id: ticket }, body: {}, session: sessions.support });
    expect(empty.status).toBe(422);
    const extra = await callRoute(jar, ticketPATCH, {
      method: "PATCH",
      path: ticketPath(ticket),
      params: { id: ticket },
      body: { priority: "high", accountId: "x" },
      session: sessions.support,
    });
    expect(extra.status).toBe(422);
    const blank = await postMessage(sessions.support, ticket, { body: " " });
    expect(blank.status).toBe(422);
    for (const id of ["T-999999997", "LIC-1", "perm-test-0000"]) {
      const res = await callRoute(jar, ticketGET, { path: ticketPath(id), params: { id }, session: sessions.support });
      expect(res.status, id).toBe(404);
    }
  });
});

describe("internal notes and the portal", () => {
  it("a note posted through the API never appears in the customer's ticket API; a reply does, with the first response", async () => {
    const id = await makeTicket({ accountId: customer.accountId, openedById: customer.user.id, createdAt: new Date(Date.now() - 7_200_000) });
    const note = await postMessage(sessions.support, id, { body: "Internal: the customer runs an old POS build.", internal: true });
    expect(note.status).toBe(201);
    const portal = async () => {
      const res = await callRoute(jar, portalTicketGET, { path: `/api/account/tickets/${id}`, params: { id }, session: sessions.customer });
      expect(res.status).toBe(200);
      return (await res.json()) as { ticket: { status: string }; messages: { body: string; author: { isStaff: boolean } }[] };
    };
    const before = await portal();
    expect(before.messages).toHaveLength(1);
    expect(JSON.stringify(before)).not.toContain("old POS build");
    expect(await db.supportTicket.findUniqueOrThrow({ where: { id } })).toMatchObject({ firstResponseAt: null, status: "OPEN" });

    const reply = await postMessage(sessions.support, id, { body: "Please update to 4.2.2." });
    expect(reply.status).toBe(201);
    const after = await portal();
    expect(after.ticket.status).toBe("awaiting_customer");
    expect(after.messages.map((m) => m.body)).toEqual([expect.any(String), "Please update to 4.2.2."]);
    expect(JSON.stringify(after)).not.toContain("old POS build");
    const stored = await db.supportTicket.findUniqueOrThrow({ where: { id } });
    expect(stored.firstResponseAt).not.toBeNull();
    expect(stored.firstResponseAt!.getTime() - stored.createdAt.getTime()).toBeGreaterThanOrEqual(7_200_000);

    // The staff view keeps both, the note marked internal.
    const staffView = (await (await callRoute(jar, ticketGET, { path: ticketPath(id), params: { id }, session: sessions.owner })).json()) as {
      messages: { internal: boolean }[];
    };
    expect(staffView.messages.map((m) => m.internal)).toEqual([false, true, false]);
  });
});

describe("staff attachments", () => {
  const download = (session: TestSession, ticketId: string, uploadId: string, query = "") =>
    callRoute(jar, attachmentGET, { path: ticketPath(ticketId, `/attachments/${uploadId}${query}`), params: { id: ticketId, uploadId }, session });
  const customerDownload = (uploadId: string) =>
    callRoute(jar, portalDownloadGET, { path: `/api/account/uploads/${uploadId}/download`, params: { id: uploadId }, session: sessions.customer });

  it("are Upload rows of the ticket's account; customers download them from public replies only", async () => {
    const id = await makeTicket({ accountId: customer.accountId, openedById: customer.user.id });
    const forReply = await staffUpload(sessions.support, id, "steps.pdf");
    const forNote = await staffUpload(sessions.support, id, "logs.pdf");
    expect(await db.upload.findUniqueOrThrow({ where: { id: forReply } })).toMatchObject({
      accountId: customer.accountId,
      uploadedById: staff.support.id,
      status: "PENDING",
    });

    const reply = await postMessage(sessions.support, id, { body: "Steps attached.", attachmentIds: [forReply] });
    expect(reply.status).toBe(201);
    const note = await postMessage(sessions.support, id, { body: "Logs from the call.", internal: true, attachmentIds: [forNote] });
    expect(note.status).toBe(201);
    const rows = await db.upload.findMany({ where: { id: { in: [forReply, forNote] } }, select: { id: true, status: true, ticketMessageId: true } });
    expect(rows.every((r) => r.status === "ATTACHED" && r.ticketMessageId)).toBe(true);

    // Customers: the reply's file downloads, the note's does not exist for them.
    expect((await customerDownload(forReply)).status).toBe(200);
    expect((await customerDownload(forNote)).status).toBe(404);
    // Staff: both, through this ticket only.
    const link = await download(sessions.owner, id, forNote);
    expect(link.status).toBe(200);
    expect((await link.json()) as { fileName: string }).toMatchObject({ fileName: "logs.pdf" });
    const redirect = await download(sessions.owner, id, forReply, "?redirect=1");
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBeTruthy();
    expect((await download(sessions.owner, ticket, forNote)).status).toBe(404);
    // An attached file cannot be attached again.
    const again = await postMessage(sessions.support, id, { body: "Same file again.", attachmentIds: [forReply] });
    expect(again.status).toBe(422);
  });

  it("only the uploader can confirm and attach, only on a ticket of the same account", async () => {
    const id = await makeTicket({ accountId: customer.accountId, openedById: customer.user.id });
    const other = await makeCustomer();
    const otherTicket = await makeTicket({ accountId: other.accountId, openedById: other.user.id });

    const mine = await staffUpload(sessions.support, id, "mine.pdf");
    // Another staff member: cannot confirm, attach or download someone else's pending upload.
    const confirm = await callRoute(jar, confirmPOST, {
      method: "POST",
      path: ticketPath(id, `/uploads/${mine}/confirm`),
      params: { id, uploadId: mine },
      session: sessions.admin,
    });
    expect(confirm.status).toBe(404);
    const byAdmin = await postMessage(sessions.admin, id, { body: "Using Sneha's file.", attachmentIds: [mine] });
    expect(byAdmin.status).toBe(422);
    expect(await errorCodeOf(byAdmin)).toBe("validation_failed");
    expect((await download(sessions.admin, id, mine)).status).toBe(404);
    expect((await download(sessions.support, id, mine)).status).toBe(200);

    // The uploader, on another account's ticket: refused (the file belongs to the first account).
    const crossAccount = await postMessage(sessions.support, otherTicket, { body: "Wrong ticket.", attachmentIds: [mine] });
    expect(crossAccount.status).toBe(422);
    expect((await download(sessions.support, otherTicket, mine)).status).toBe(404);

    // A customer's own pending upload cannot be attached by staff.
    const customerUpload = await callRoute(jar, portalUploadPOST, {
      method: "POST",
      path: "/api/account/uploads",
      body: { fileName: "screen.png", contentType: "image/png", sizeBytes: 64 },
      session: sessions.customer,
    });
    expect(customerUpload.status).toBe(201);
    const customerUploadId = ((await customerUpload.json()) as UploadResponse).upload.id;
    const borrowed = await postMessage(sessions.support, id, { body: "Customer's file.", attachmentIds: [customerUploadId] });
    expect(borrowed.status).toBe(422);

    expect(await db.ticketMessage.count({ where: { ticketId: { in: [id, otherTicket] }, isStaff: true } })).toBe(0);
    expect(await db.upload.findUniqueOrThrow({ where: { id: mine } })).toMatchObject({ status: "PENDING", ticketMessageId: null });
  });

  it("refuses other file types and sizes (422) and unknown tickets (404)", async () => {
    for (const body of [
      { fileName: "setup.exe", contentType: "application/octet-stream", sizeBytes: 10 },
      { fileName: "a.png", contentType: "image/png", sizeBytes: 10 * 1024 * 1024 + 1 },
    ]) {
      const res = await callRoute(jar, uploadsPOST, { method: "POST", path: ticketPath(ticket, "/uploads"), params: { id: ticket }, body, session: sessions.support });
      expect(res.status, body.fileName).toBe(422);
    }
    const unknown = await callRoute(jar, uploadsPOST, {
      method: "POST",
      path: ticketPath("T-999999996", "/uploads"),
      params: { id: "T-999999996" },
      body: { fileName: "a.txt", contentType: "text/plain", sizeBytes: 3 },
      session: sessions.support,
    });
    expect(unknown.status).toBe(404);
  });
});
