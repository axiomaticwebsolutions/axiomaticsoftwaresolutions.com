/**
 * Ticket and attachment request validation (lib/validation/tickets.ts): prototype copy, normalisation, the attachment
 * allowlist (type and extension must agree), size limits and the list query string.
 */
import { describe, expect, it } from "vitest";
import {
  attachmentTypeFor,
  createTicketSchema,
  MAX_ATTACHMENT_BYTES,
  normalizeMessage,
  parseTicketListQuery,
  TICKET_ERRORS,
  TICKET_IMPACT_META,
  ticketReplySchema,
  ticketStatusSchema,
  uploadRequestSchema,
} from "@/lib/validation/tickets";

const valid = {
  productId: "medical-billing",
  subject: "Scanner stops working",
  body: "Since the update the barcode scanner does nothing.",
};

type Issues = { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } };
function fieldErrors(result: Issues) {
  const out: Record<string, string[]> = {};
  for (const issue of result.error?.issues ?? []) (out[issue.path.map(String).join(".")] ??= []).push(issue.message);
  return out;
}

describe("createTicketSchema", () => {
  it("accepts the prototype form and defaults impact, license and attachments", () => {
    const parsed = createTicketSchema.parse(valid);
    expect(parsed).toEqual({ ...valid, licenseId: null, impact: "normal", attachmentIds: [] });
    expect(TICKET_IMPACT_META[parsed.impact].priority).toBe("NORMAL");
    expect(createTicketSchema.parse({ ...valid, licenseId: "", impact: "high" })).toMatchObject({ licenseId: null, impact: "high" });
    expect(createTicketSchema.parse({ ...valid, licenseId: "LIC-24017" }).licenseId).toBe("LIC-24017");
  });

  it("uses the prototype messages for short subjects and bodies", () => {
    const r = createTicketSchema.safeParse({ ...valid, subject: "  Help ", body: "too short" });
    expect(fieldErrors(r)).toEqual({ subject: [TICKET_ERRORS.subject], body: [TICKET_ERRORS.body] });
    expect(TICKET_ERRORS.subject).toBe("Add a short subject (at least 6 characters).");
    expect(TICKET_ERRORS.body).toBe("Please describe the problem in a bit more detail (20+ characters).");
  });

  it("collapses the subject to one line and keeps the body's line breaks", () => {
    const body = "Line one is long enough\r\n\r\n\r\n\r\n\r\nLine two  \n";
    const parsed = createTicketSchema.parse({ ...valid, subject: "  Scanner \n  stops\tworking ", body });
    expect(parsed.subject).toBe("Scanner stops working");
    expect(parsed.body).toBe("Line one is long enough\n\n\nLine two");
    expect(normalizeMessage("  a  \r\nb ")).toBe("a\nb");
  });

  it("rejects unknown keys, bad ids, control characters, too many and duplicate attachments", () => {
    expect(createTicketSchema.safeParse({ ...valid, accountId: "x" }).success).toBe(false);
    expect(fieldErrors(createTicketSchema.safeParse({ ...valid, productId: "../x" }))).toEqual({ productId: [TICKET_ERRORS.product] });
    expect(fieldErrors(createTicketSchema.safeParse({ ...valid, licenseId: "LIC-1; drop" }))).toEqual({ licenseId: [TICKET_ERRORS.license] });
    expect(fieldErrors(createTicketSchema.safeParse({ ...valid, body: `${valid.body}\u0007` }))).toEqual({ body: [TICKET_ERRORS.characters] });
    expect(fieldErrors(createTicketSchema.safeParse({ ...valid, attachmentIds: ["a", "b", "c", "d", "e", "f"] }))).toEqual({
      attachmentIds: [TICKET_ERRORS.attachments],
    });
    expect(fieldErrors(createTicketSchema.safeParse({ ...valid, attachmentIds: ["a", "a"] }))).toEqual({
      attachmentIds: [TICKET_ERRORS.attachmentDuplicate],
    });
    expect(createTicketSchema.safeParse({ ...valid, impact: "urgent" }).success).toBe(false);
  });

  it("caps the subject and body length", () => {
    expect(fieldErrors(createTicketSchema.safeParse({ ...valid, subject: "x".repeat(151) }))).toEqual({ subject: [TICKET_ERRORS.subjectTooLong] });
    expect(fieldErrors(createTicketSchema.safeParse({ ...valid, body: "x".repeat(10_001) }))).toEqual({ body: [TICKET_ERRORS.bodyTooLong] });
  });
});

describe("reply and status bodies", () => {
  it("needs a non-blank reply", () => {
    expect(fieldErrors(ticketReplySchema.safeParse({ body: "   \n " }))).toEqual({ body: ["Write a message before sending."] });
    expect(ticketReplySchema.parse({ body: " Thanks " })).toEqual({ body: "Thanks", attachmentIds: [] });
  });

  it("only knows resolve and reopen", () => {
    expect(ticketStatusSchema.parse({ action: "reopen" })).toEqual({ action: "reopen" });
    expect(ticketStatusSchema.safeParse({ action: "close" }).success).toBe(false);
  });
});

describe("attachments", () => {
  it("allows PNG, JPEG, PDF and TXT only when the extension matches the type", () => {
    expect(attachmentTypeFor("scanner-error.PNG", "image/png")).toBe("image/png");
    expect(attachmentTypeFor("photo.jpeg", "image/jpeg; charset=binary")).toBe("image/jpeg");
    expect(attachmentTypeFor("guide.pdf", "application/pdf")).toBe("application/pdf");
    expect(attachmentTypeFor("app.log", "text/plain")).toBe("text/plain");
    expect(attachmentTypeFor("setup.exe", "image/png")).toBeNull();
    expect(attachmentTypeFor("page.html", "text/html")).toBeNull();
    expect(attachmentTypeFor("image.svg", "image/svg+xml")).toBeNull();
    expect(attachmentTypeFor("noextension", "text/plain")).toBeNull();
    expect(attachmentTypeFor("x.png", "")).toBeNull();
  });

  it("validates upload requests: type, empty files and the 10 MB limit", () => {
    const ok = uploadRequestSchema.parse({ fileName: " scanner error.png ", contentType: "IMAGE/PNG", sizeBytes: 214 * 1024 });
    expect(ok).toEqual({ fileName: "scanner error.png", contentType: "image/png", sizeBytes: 214 * 1024 });
    const max = uploadRequestSchema.parse({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: MAX_ATTACHMENT_BYTES });
    expect(max.sizeBytes).toBe(MAX_ATTACHMENT_BYTES);
    const big = uploadRequestSchema.safeParse({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: MAX_ATTACHMENT_BYTES + 1 });
    expect(fieldErrors(big)).toEqual({ sizeBytes: ["Each file can be up to 10 MB."] });
    const empty = uploadRequestSchema.safeParse({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 0 });
    expect(fieldErrors(empty)).toEqual({ sizeBytes: ["This file is empty."] });
    const exe = uploadRequestSchema.safeParse({ fileName: "run.exe", contentType: "application/pdf", sizeBytes: 10 });
    expect(fieldErrors(exe)).toEqual({ contentType: ["Attach PNG, JPEG, PDF or TXT files."] });
    expect(uploadRequestSchema.safeParse({ fileName: "a.png", contentType: "image/png", sizeBytes: 1.5 }).success).toBe(false);
    expect(uploadRequestSchema.safeParse({ fileName: "a.png", contentType: "image/png", sizeBytes: 1, key: "x" }).success).toBe(false);
  });
});

describe("parseTicketListQuery", () => {
  it("defaults to all statuses, newest update first, page 1", () => {
    expect(parseTicketListQuery(new URLSearchParams())).toEqual({
      status: "all",
      product: "all",
      q: "",
      sort: { key: "updated", dir: -1 },
      page: 1,
    });
  });

  it("parses filters, ascending/descending sort and the page; ignores unknown parameters", () => {
    const q = parseTicketListQuery(new URLSearchParams("status=awaiting_customer&product=medical-billing&q=+scanner+&sort=priority&page=3&x=1"));
    expect(q).toEqual({ status: "awaiting_customer", product: "medical-billing", q: "scanner", sort: { key: "priority", dir: 1 }, page: 3 });
    expect(parseTicketListQuery(new URLSearchParams("sort=-created")).sort).toEqual({ key: "created", dir: -1 });
  });

  it("throws (422) for invalid values", () => {
    expect(() => parseTicketListQuery(new URLSearchParams("status=closed"))).toThrow();
    expect(() => parseTicketListQuery(new URLSearchParams("sort=accountId"))).toThrow();
    expect(() => parseTicketListQuery(new URLSearchParams("page=0"))).toThrow();
    expect(() => parseTicketListQuery(new URLSearchParams(`q=${"x".repeat(101)}`))).toThrow();
  });
});
