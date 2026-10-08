/**
 * Email attachments (docs/decisions.md "Invoice PDF attached to the order email"): the typed reference allowlist,
 * the nodemailer mapping shared by SMTP and Amazon SES (same multipart/mixed MIME: the HTML + text alternative, then
 * the PDF), the SES raw message through a fake SESv2 client, the console transport (dev mailbox; names and sizes in
 * the log only), the dev mailbox download route, invalid references ignored without a database read, the deferrals
 * and the plain final attempt decided before any database read, and the Admin > Notification templates note.
 */
import { NextRequest } from "next/server";
import { createTransport } from "nodemailer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as devAttachmentRoute } from "@/app/api/dev/mailbox/[id]/attachments/[index]/route";
import { templateAttachmentNote, templateDto } from "@/lib/admin/templates/model";
import { attachmentKindsFor, MAX_ATTACHMENT_REFS, parseAttachmentRefs, TEMPLATE_ATTACHMENT_KINDS } from "@/lib/email/attachment-refs";
import { attachmentRunContext, AttachmentRenderError, resolveAttachments } from "@/lib/email/attachments";
import { EMAIL_TEMPLATE_IDS } from "@/lib/email/defaults";
import { clearDevMail, getDevMailAttachment, listDevMail } from "@/lib/email/dev-mailbox";
import type { OutgoingEmail } from "@/lib/email/transport";
import { createConsoleTransport } from "@/lib/email/transports/console";
import { mailOptions } from "@/lib/email/transports/mail-options";
import { createSesTransport, type SesClientLike, type SesConfig } from "@/lib/email/transports/ses";
import { setLogSink } from "@/lib/log";

const FROM = { name: "Axiomatic Software", address: "no-reply@axiomatic.example" };
/** A small stand-in for the invoice PDF: binary bytes, so base64 and byte equality are really checked. */
const PDF = Buffer.concat([Buffer.from("%PDF-1.3\n%\xE2\xE3\xCF\xD3\n", "latin1"), Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256))]);
const FILE_NAME = "Invoice-AXS-26-27-1181.pdf";
const MESSAGE: OutgoingEmail = {
  to: "priya@sharmamedicals.example",
  subject: "Your order AX-10312 is confirmed",
  html: "<p>Thanks for your purchase.</p>",
  text: "Thanks for your purchase.",
  templateId: "order_confirmation",
  attachments: [{ filename: FILE_NAME, contentType: "application/pdf", content: PDF }],
};
const SES: SesConfig = {
  transport: "ses",
  region: "ap-south-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "ses-secret-access-key-01",
  configurationSet: null,
  from: FROM,
};

let logs: string[];
beforeEach(() => {
  logs = [];
  setLogSink((_level, line) => logs.push(line));
  clearDevMail();
});
afterEach(() => {
  setLogSink(null);
  vi.unstubAllEnvs();
});

/** The MIME parts of a message: content type, disposition and decoded body of each leaf, plus the multipart types. */
function mimeOutline(raw: string): { types: string[]; pdf: { type: string; disposition: string; body: Buffer } | null; headers: string } {
  const headerEnd = raw.indexOf("\r\n\r\n");
  const headers = raw.slice(0, headerEnd);
  const types = [...raw.matchAll(/^Content-Type: ([^;\r\n]+)/gim)].map((m) => (m[1] ?? "").toLowerCase());
  const pdfAt = raw.search(/^Content-Type: application\/pdf/im);
  if (pdfAt < 0) return { types, pdf: null, headers };
  const partHeadersEnd = raw.indexOf("\r\n\r\n", pdfAt);
  const partHeaders = raw.slice(pdfAt, partHeadersEnd).replace(/\r\n\s+/g, " ");
  const bodyEnd = raw.indexOf("\r\n--", partHeadersEnd);
  const body = Buffer.from(raw.slice(partHeadersEnd + 4, bodyEnd).replace(/\s+/g, ""), "base64");
  const disposition = /Content-Disposition: ([^\r\n]+)/i.exec(partHeaders)?.[1] ?? "";
  const type = /Content-Type: ([^\r\n]+?)(?:\s+Content-|$)/i.exec(partHeaders)?.[1] ?? "";
  return { types, pdf: { type, disposition, body }, headers };
}

/** The same message without what differs per send (boundaries, Message-ID, Date). */
function normalizedMime(raw: string): string {
  const boundaries = [...raw.matchAll(/boundary="?([^";\r\n]+)"?/g)].map((m) => m[1] ?? "");
  let out = raw;
  boundaries.forEach((b, i) => (out = out.split(b).join(`BOUNDARY${i}`)));
  return out.replace(/^Message-ID: .*\r\n/im, "").replace(/^Date: .*\r\n/im, "");
}

async function smtpMime(message: OutgoingEmail): Promise<string> {
  const mailer = createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = (await mailer.sendMail(mailOptions(message, FROM))) as { message: Buffer };
  return info.message.toString("latin1");
}

function fakeSesClient(): SesClientLike & { inputs: Record<string, unknown>[] } {
  const inputs: Record<string, unknown>[] = [];
  return {
    inputs,
    config: { region: async () => "ap-south-1" },
    async send(command: unknown) {
      inputs.push((command as { input: Record<string, unknown> }).input);
      return { MessageId: `0109019a-${inputs.length}` };
    },
  };
}

const sesRaw = (input: Record<string, unknown> | undefined) =>
  Buffer.from((input as { Content: { Raw: { Data: Uint8Array } } }).Content.Raw.Data).toString("latin1");

describe("attachment references", () => {
  it("allows the invoice on order_confirmation only", () => {
    expect(TEMPLATE_ATTACHMENT_KINDS).toEqual({ order_confirmation: ["invoice"] });
    expect(attachmentKindsFor("order_confirmation")).toEqual(["invoice"]);
    for (const id of EMAIL_TEMPLATE_IDS.filter((t) => t !== "order_confirmation")) expect(attachmentKindsFor(id)).toEqual([]);
    expect(attachmentKindsFor("__proto__")).toEqual([]);
    expect(attachmentKindsFor("constructor")).toEqual([]);
  });

  it("accepts exact references, folds duplicates and reads JSON text", () => {
    const ref = { kind: "invoice", orderId: "AX-10312" };
    expect(parseAttachmentRefs("order_confirmation", [ref, { ...ref }])).toEqual({ refs: [ref], problems: [] });
    expect(parseAttachmentRefs("order_confirmation", JSON.stringify([ref]))).toEqual({ refs: [ref], problems: [] });
    expect(parseAttachmentRefs("order_confirmation", null)).toEqual({ refs: [], problems: [] });
    expect(parseAttachmentRefs("order_confirmation", undefined)).toEqual({ refs: [], problems: [] });
    expect(parseAttachmentRefs("order_confirmation", [])).toEqual({ refs: [], problems: [] });
  });

  it("drops unknown kinds, garbled values, extra fields, unsafe ids and kinds the template may not carry", () => {
    const problems = (templateId: string, value: unknown) => parseAttachmentRefs(templateId, value).problems.map((p) => p.problem);
    expect(problems("order_confirmation", [{ kind: "zip", orderId: "AX-1" }])).toEqual(["unknown_kind"]);
    expect(problems("order_confirmation", [{ kind: 7 }, null, "AX-1", [1]])).toEqual(["malformed", "malformed", "malformed", "malformed"]);
    expect(problems("order_confirmation", [{ kind: "invoice", orderId: "AX-1", path: "/etc/passwd" }])).toEqual(["malformed"]);
    for (const orderId of ["../AX-1", "AX-1/../../x", "https://evil.example/a.pdf", "C:\u005Cx", "", " AX-1", "a".repeat(65), 42]) {
      expect(problems("order_confirmation", [{ kind: "invoice", orderId }])).toEqual(["malformed"]);
    }
    expect(problems("order_confirmation", { kind: "invoice", orderId: "AX-1" })).toEqual(["not_a_list"]);
    expect(problems("order_confirmation", "{not json")).toEqual(["not_a_list"]);
    expect(problems("order_confirmation", Array.from({ length: MAX_ATTACHMENT_REFS + 1 }, (_, i) => ({ kind: "invoice", orderId: `AX-${i}` })))).toEqual(["too_many"]);
    const refund = parseAttachmentRefs("refund_issued", [{ kind: "invoice", orderId: "AX-1" }]);
    expect(refund).toEqual({ refs: [], problems: [{ problem: "not_allowed_for_template", kind: "invoice" }] });
  });

  it("are ignored and logged when read back invalid, without touching the database", async () => {
    const client = new Proxy({}, { get: () => { throw new Error("database touched"); } }) as never;
    const row = { id: "ob_1", templateId: "order_confirmation", to: "priya@sharmamedicals.example", attempts: 1 };
    const ctx = { ...attachmentRunContext(5), client };
    expect(await resolveAttachments({ ...row, attachments: null }, ctx)).toEqual([]);
    expect(await resolveAttachments({ ...row, attachments: [{ kind: "zip", url: "https://evil.example/x" }] }, ctx)).toEqual([]);
    expect(await resolveAttachments({ ...row, attachments: "garbage" }, ctx)).toEqual([]);
    expect(await resolveAttachments({ ...row, templateId: "license_issued", attachments: [{ kind: "invoice", orderId: "AX-1" }] }, ctx)).toEqual([]);
    const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.event, l.reason, l.problem, l.kind])).toEqual([
      ["email_attachment_skipped", "invalid_reference", "unknown_kind", "unknown"],
      ["email_attachment_skipped", "invalid_reference", "not_a_list", "unknown"],
      ["email_attachment_skipped", "invalid_reference", "not_allowed_for_template", "invoice"],
    ]);
    expect(lines.every((l) => l.outboxId === "ob_1" && l.attempt === 1)).toBe(true);
    expect(logs.join("\n")).not.toMatch(/priya@|evil\.example|garbage/);
  });

  it("defers a render over the run's budget once, then skips it; the final attempt never renders", async () => {
    const client = new Proxy({}, { get: () => { throw new Error("database touched"); } }) as never;
    const row = { id: "ob_2", templateId: "order_confirmation", to: "priya@sharmamedicals.example", attachments: [{ kind: "invoice", orderId: "AX-1" }] };
    // Budget spent (render time only): first attempt deferred through the backoff, later attempts go without the file.
    const spent = { ...attachmentRunContext(5, { budgetMs: 1000 }), spentMs: 1000, client };
    const deferred = await resolveAttachments({ ...row, attempts: 1 }, spent).catch((e: unknown) => e);
    expect(deferred).toBeInstanceOf(AttachmentRenderError);
    expect(deferred).toMatchObject({ code: "attachment_run_budget", reason: "run_budget", kind: "invoice" });
    expect(await resolveAttachments({ ...row, attempts: 2 }, spent)).toEqual([]);
    // The final attempt is plain whatever the budget: nothing about the file can make the email fail.
    expect(await resolveAttachments({ ...row, attempts: 5 }, { ...attachmentRunContext(5), client })).toEqual([]);
    expect(await resolveAttachments({ ...row, attempts: 6 }, { ...attachmentRunContext(5), client })).toEqual([]);
    const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.event, l.reason, l.attempt])).toEqual([
      ["email_attachment_retry", "run_budget", 1],
      ["email_attachment_skipped", "run_budget", 2],
      ["email_attachment_skipped", "final_attempt", 5],
      ["email_attachment_skipped", "final_attempt", 6],
    ]);
    expect(lines.every((l) => l.outboxId === "ob_2" && l.kind === "invoice")).toBe(true);
    expect(logs.join("\n")).not.toMatch(/priya@/);
  });

  it("starts a run with nothing spent and the default budget", () => {
    expect(attachmentRunContext(5)).toMatchObject({ budgetMs: 3 * 60_000, spentMs: 0, finalAttempt: 5 });
    expect(attachmentRunContext(5, { budgetMs: 0, timeoutMs: 50 })).toMatchObject({ budgetMs: 0, spentMs: 0, timeoutMs: 50 });
  });
});

describe("Admin > Notification templates", () => {
  it("notes the automatic invoice PDF on order_confirmation only", () => {
    const note = templateAttachmentNote("order_confirmation");
    expect(note).toMatch(/tax invoice is attached as a PDF automatically when the email is sent/);
    expect(note).toMatch(/Previews and test emails don.t include it/);
    expect(templateDto("order_confirmation", null).attachmentNote).toBe(note);
    expect(templateDto("refund_issued", null).attachmentNote).toBeNull();
    expect(templateDto("email_verification", null).attachmentNote).toBeNull();
  });
});

describe("mail options (shared by SMTP and SES)", () => {
  it("maps attachments to nodemailer attachments with the bytes, never a path or URL; headers unchanged", () => {
    const options = mailOptions(MESSAGE, FROM);
    expect(options.attachments).toEqual([{ filename: FILE_NAME, content: PDF, contentType: "application/pdf", contentDisposition: "attachment" }]);
    expect(options.headers).toEqual({ "Auto-Submitted": "auto-generated", "X-Axs-Template": "order_confirmation" });
    expect(options).toMatchObject({ from: FROM, to: MESSAGE.to, subject: MESSAGE.subject, html: MESSAGE.html, text: MESSAGE.text });
    const plain = mailOptions({ ...MESSAGE, attachments: undefined }, FROM);
    expect(plain).not.toHaveProperty("attachments");
    expect(mailOptions({ ...MESSAGE, attachments: [] }, FROM)).not.toHaveProperty("attachments");
  });

  it("builds multipart/mixed: the HTML + text alternative first, then the PDF as an attachment", async () => {
    const raw = await smtpMime(MESSAGE);
    const outline = mimeOutline(raw);
    expect(outline.types).toEqual(["multipart/mixed", "multipart/alternative", "text/plain", "text/html", "application/pdf"]);
    expect(outline.headers).toMatch(/^Auto-Submitted: auto-generated$/m);
    expect(outline.headers).toMatch(/^X-Axs-Template: order_confirmation$/m);
    expect(outline.headers).not.toMatch(/^List-/m);
    expect(outline.pdf?.type).toBe(`application/pdf; name=${FILE_NAME}`);
    expect(outline.pdf?.disposition).toBe(`attachment; filename=${FILE_NAME}`);
    expect(outline.pdf?.body.equals(PDF)).toBe(true);
    // Without attachments the message stays multipart/alternative, as before.
    expect(mimeOutline(await smtpMime({ ...MESSAGE, attachments: undefined })).types).toEqual(["multipart/alternative", "text/plain", "text/html"]);
  });
});

describe("Amazon SES", () => {
  it("sends the same raw MIME as SMTP, with the PDF part, its file name and content type", async () => {
    const client = fakeSesClient();
    const transport = createSesTransport(SES, client);
    await transport.send(MESSAGE);
    const [input] = client.inputs;
    expect(input).toMatchObject({ Destination: { ToAddresses: [MESSAGE.to] } });
    const raw = sesRaw(input);
    const outline = mimeOutline(raw);
    expect(outline.types).toEqual(["multipart/mixed", "multipart/alternative", "text/plain", "text/html", "application/pdf"]);
    expect(outline.pdf?.type).toBe(`application/pdf; name=${FILE_NAME}`);
    expect(outline.pdf?.disposition).toBe(`attachment; filename=${FILE_NAME}`);
    expect(outline.pdf?.body.equals(PDF)).toBe(true);
    expect(outline.headers).toMatch(/^Auto-Submitted: auto-generated$/m);
    expect(outline.headers).toMatch(/^X-Axs-Template: order_confirmation$/m);
    expect(normalizedMime(raw)).toBe(normalizedMime(await smtpMime(MESSAGE)));
  });
});

describe("console transport and the dev mailbox", () => {
  it("keeps the files for /dev/mailbox and logs their names and sizes only", async () => {
    const { messageId } = await createConsoleTransport().send(MESSAGE);
    const [mail] = listDevMail();
    expect(mail?.attachments).toEqual([{ filename: FILE_NAME, contentType: "application/pdf", size: PDF.length, content: PDF }]);
    expect(getDevMailAttachment(messageId, 0)?.content.equals(PDF)).toBe(true);
    expect(getDevMailAttachment(messageId, 1)).toBeNull();
    expect(getDevMailAttachment(messageId, -1)).toBeNull();
    const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([
      expect.objectContaining({ event: "email_console_attachments", messageId, template: "order_confirmation", files: [{ name: FILE_NAME, bytes: PDF.length }] }),
    ]);
    expect(logs.join("\n")).not.toMatch(/priya@|is confirmed|Thanks for|%PDF/);
    // No attachments: nothing extra is logged or stored.
    await createConsoleTransport().send({ ...MESSAGE, attachments: undefined });
    expect(listDevMail()[0]?.attachments).toBeUndefined();
    expect(logs).toHaveLength(1);
  });

  it("serves a stored attachment for download in development and 404s otherwise", async () => {
    const { messageId } = await createConsoleTransport().send(MESSAGE);
    const get = (id: string, index: string) =>
      devAttachmentRoute(new NextRequest(`http://localhost:3000/api/dev/mailbox/${id}/attachments/${index}`), { params: Promise.resolve({ id, index }) });
    const res = await get(messageId, "0");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(`attachment; filename="${FILE_NAME}"`);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
    for (const [id, index] of [[messageId, "1"], [messageId, "-1"], [messageId, "x"], ["console-nope", "0"]] as const) {
      expect((await get(id, index)).status).toBe(404);
    }
    vi.stubEnv("NODE_ENV", "production");
    expect((await get(messageId, "0")).status).toBe(404);
  });
});
