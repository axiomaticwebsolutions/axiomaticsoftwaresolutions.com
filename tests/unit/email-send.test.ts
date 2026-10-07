import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@/lib/env";
import { setLogSink } from "@/lib/log";
import { clearDevMail, DEV_MAILBOX_LIMIT, getDevMail, listDevMail, recordDevMail } from "@/lib/email/dev-mailbox";
import { normalizeRecipient } from "@/lib/email/compose";
import { sendAuthEmail, AUTH_EMAIL_TIMEOUT_MS } from "@/lib/email/send";
import { outboxBackoffMs, OUTBOX_MAX_DELAY_MS, kickEmailDispatch, waitForEmailDispatch } from "@/lib/email/outbox";
import { maskEmail, sendErrorSummary, setEmailTransport, type EmailTransport, type OutgoingEmail } from "@/lib/email/transport";
import { createConsoleTransport } from "@/lib/email/transports/console";
import { createSmtpTransport, smtpOptionsFromEnv } from "@/lib/email/transports/smtp";
import { greetingName, leadEmailVars } from "@/lib/leads";

const APP_URL = "http://localhost:3000";

const mocks = vi.hoisted(() => ({ findTemplate: vi.fn(), findSetting: vi.fn() }));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  getEnv: () => ({ APP_URL, EMAIL_TRANSPORT: "console" }) as unknown as EnvModule.Env,
}));
vi.mock("@/lib/db", () => ({
  db: {
    notificationTemplate: { findUnique: mocks.findTemplate },
    siteSetting: { findUnique: mocks.findSetting },
  },
}));

let logs: string[];

beforeEach(() => {
  logs = [];
  setLogSink((_level, line) => logs.push(line));
  clearDevMail();
  mocks.findTemplate.mockReset().mockResolvedValue(null);
  mocks.findSetting.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  setLogSink(null);
  setEmailTransport(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const VERIFY = { to: "priya@sharmamedicals.example", templateId: "email_verification", vars: { customer_name: "Priya", code: "482913" } } as const;

describe("console transport and dev mailbox", () => {
  it("keeps sent messages for /dev/mailbox, newest first, capped at 50", async () => {
    const transport = createConsoleTransport();
    for (let i = 0; i < DEV_MAILBOX_LIMIT + 5; i += 1) {
      await transport.send({ to: `u${i}@example.com`, subject: `S${i}`, html: "<p>h</p>", text: "t", templateId: "lead_received" });
    }
    const list = listDevMail();
    expect(list).toHaveLength(DEV_MAILBOX_LIMIT);
    expect(list[0]?.subject).toBe(`S${DEV_MAILBOX_LIMIT + 4}`);
    expect(list.at(-1)?.subject).toBe("S5");
    expect(getDevMail(list[0]?.id ?? "")?.to).toBe(`u${DEV_MAILBOX_LIMIT + 4}@example.com`);
  });

  it("records and lists nothing in production", () => {
    recordDevMail({ id: "a", sentAt: "", templateId: "x", to: "a@b.co", subject: "s", html: "", text: "" });
    vi.stubEnv("NODE_ENV", "production");
    recordDevMail({ id: "b", sentAt: "", templateId: "x", to: "a@b.co", subject: "s", html: "", text: "" });
    expect(listDevMail()).toEqual([]);
    vi.unstubAllEnvs();
    expect(listDevMail().map((m) => m.id)).toEqual(["a"]);
  });
});

describe("sendAuthEmail", () => {
  it("sends through the console transport and logs a summary without the code, subject or address", async () => {
    setEmailTransport(createConsoleTransport());
    await expect(sendAuthEmail({ ...VERIFY })).resolves.toEqual({ ok: true });
    const [mail] = listDevMail();
    expect(mail?.subject).toBe("Your verification code: 482913");
    expect(mail?.html).toContain(">482913<");
    expect(mail?.text).toContain("Verification code: 482913");
    expect(mail?.html).toContain("Axiomatic Software Solutions (placeholder)"); // default footer
    const out = logs.join("\n");
    expect(out).toContain('"event":"email_sent"');
    expect(out).toContain("pr***@sharmamedicals.example");
    expect(out).not.toMatch(/482913|verification code|priya@/i);
  });

  it("never logs the reset link", async () => {
    const sent: OutgoingEmail[] = [];
    setEmailTransport({ name: "test", send: async (m) => (sent.push(m), { messageId: "m1" }) });
    const resetUrl = `${APP_URL}/reset?token=secret-token-value`;
    const res = await sendAuthEmail({ to: "a@example.com", templateId: "password_reset", vars: { customer_name: "A", reset_url: resetUrl } });
    expect(res.ok).toBe(true);
    expect(sent[0]?.html).toContain(`href="${resetUrl}"`);
    expect(logs.join("\n")).not.toContain("secret-token-value");
  });

  it("uses an active NotificationTemplate row for the copy and the code defaults otherwise", async () => {
    const sent: OutgoingEmail[] = [];
    setEmailTransport({ name: "test", send: async (m) => (sent.push(m), { messageId: "m" }) });
    mocks.findTemplate.mockResolvedValueOnce({ subject: "Code {{code}} inside", body: "Hello {{customer_name}}", active: true });
    await sendAuthEmail({ ...VERIFY });
    mocks.findTemplate.mockResolvedValueOnce({ subject: "Draft {{code}}", body: "x", active: false });
    await sendAuthEmail({ ...VERIFY });
    expect(sent.map((m) => m.subject)).toEqual(["Code 482913 inside", "Your verification code: 482913"]);
    expect(sent[0]?.html).toContain(">482913<"); // the code box is code-defined
  });

  it("falls back to the code defaults when the database is unavailable", async () => {
    mocks.findTemplate.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const sent: OutgoingEmail[] = [];
    setEmailTransport({ name: "test", send: async (m) => (sent.push(m), { messageId: "m" }) });
    await expect(sendAuthEmail({ ...VERIFY })).resolves.toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(logs.join("\n")).toContain("email_template_fallback");
  });

  it("refuses bad input without sending or throwing", async () => {
    const send = vi.fn();
    setEmailTransport({ name: "test", send });
    const bad = [
      { ...VERIFY, vars: { customer_name: "Priya" } },
      { ...VERIFY, vars: { customer_name: "Priya", code: "  " } },
      { ...VERIFY, to: "a@b.co\r\nBcc: x@evil.example" },
      { ...VERIFY, to: "a@b.co, c@d.co" },
      { ...VERIFY, templateId: "order_confirmation" },
    ];
    for (const input of bad) {
      await expect(sendAuthEmail(input as unknown as Parameters<typeof sendAuthEmail>[0])).resolves.toEqual({ ok: false });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("reports transport failures and timeouts as { ok: false }", async () => {
    setEmailTransport({
      name: "smtp",
      send: async () => {
        throw Object.assign(new Error("550 <priya@sharmamedicals.example> rejected"), { code: "EENVELOPE", responseCode: 550 });
      },
    });
    await expect(sendAuthEmail({ ...VERIFY })).resolves.toEqual({ ok: false });
    const out = logs.join("\n");
    expect(out).toContain("email_send_failed");
    expect(out).toContain("EENVELOPE");
    expect(out).not.toMatch(/priya@|482913/);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setEmailTransport({ name: "smtp", send: () => new Promise<never>(() => undefined) });
    const pending = sendAuthEmail({ ...VERIFY });
    await vi.advanceTimersByTimeAsync(AUTH_EMAIL_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ ok: false });
  });
});

describe("helpers", () => {
  it("accepts one plain address only", () => {
    expect(normalizeRecipient(" a.b+c@example.co.in ")).toBe("a.b+c@example.co.in");
    for (const bad of ["", "a", "a@b", "a b@c.co", "A <a@b.co>", "a@b.co,c@d.co", "a@b.co\nx", 42, null]) {
      expect(normalizeRecipient(bad)).toBeNull();
    }
  });

  it("masks addresses and summarises errors without their message", () => {
    expect(maskEmail("priya@sharmamedicals.example")).toBe("pr***@sharmamedicals.example");
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
    expect(maskEmail("nope")).toBe("***");
    const summary = sendErrorSummary(Object.assign(new Error("RCPT TO:<a@b.co> failed"), { code: "EENVELOPE", responseCode: 550, command: "RCPT TO:<a@b.co>" }));
    expect(summary).toEqual({ name: "Error", errorCode: "EENVELOPE", smtpStatus: 550, smtpCommand: "RCPT" });
  });

  it("backs off exponentially from one minute, capped at an hour", () => {
    expect([1, 2, 3, 4].map(outboxBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(outboxBackoffMs(0)).toBe(60_000);
    expect(outboxBackoffMs(20)).toBe(OUTBOX_MAX_DELAY_MS);
  });

  it("does not auto-dispatch under Vitest unless enabled", async () => {
    kickEmailDispatch();
    await waitForEmailDispatch();
    expect(mocks.findTemplate).not.toHaveBeenCalled();
  });
});

describe("SMTP transport", () => {
  const env = { SMTP_HOST: "smtp.example.com", SMTP_PORT: 587, SMTP_USER: "mailer", SMTP_PASSWORD: "pw", NODE_ENV: "production" } as const;

  it("uses STARTTLS (required in production) or implicit TLS on 465, with timeouts", () => {
    expect(smtpOptionsFromEnv(env)).toMatchObject({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
      pool: true,
      auth: { user: "mailer", pass: "pw" },
      connectionTimeout: 10_000,
      socketTimeout: 30_000,
    });
    expect(smtpOptionsFromEnv({ ...env, SMTP_PORT: 465 })).toMatchObject({ secure: true, requireTLS: false });
    expect(smtpOptionsFromEnv({ ...env, NODE_ENV: "development", SMTP_USER: undefined, SMTP_PORT: 1025 })).toMatchObject({
      requireTLS: false,
      auth: undefined,
    });
  });

  it("hands the message to nodemailer", async () => {
    const transport: EmailTransport = createSmtpTransport({ jsonTransport: true }, "Axiomatic <no-reply@axiomatic.example>");
    const res = await transport.send({ to: "a@example.com", subject: "S", html: "<p>H</p>", text: "T", templateId: "lead_received" });
    expect(res.messageId).toMatch(/@/);
    expect(transport.name).toBe("smtp");
  });
});

describe("lead email variables", () => {
  const lead = {
    id: "DEMO-1001",
    kind: "DEMO",
    status: "NEW",
    name: "Asha Rao",
    businessName: "Rao Medicals",
    email: "asha@example.com",
    phone: "9820000000",
    productId: "medical-billing",
    countersBand: "2-3",
    preferredDate: "2026-10-08",
    preferredSlot: "afternoon",
    topic: null,
    message: "Two counters.\nGST billing.",
    marketingOptIn: false,
    source: "product:medical-billing",
    ipPrefix: "103.21.44.x",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as const;

  it("builds the acknowledgement and the internal notice", () => {
    const { received, notice } = leadEmailVars({ ...lead }, { productName: "Medical Billing" });
    expect(received).toEqual({ name: "Asha Rao", reference: "DEMO-1001", kind_label: "demo request" });
    expect(notice).toEqual({
      reference: "DEMO-1001",
      kind_label: "demo request",
      name: "Asha Rao",
      email: "asha@example.com",
      phone: "+91 98200 00000",
      product: "Medical Billing",
      message: "Two counters.\nGST billing.",
      business: "Rao Medicals",
      preferred: "8 Oct 2026, Afternoon (2–5)",
      counters: "2–3",
      topic: "",
      marketing: "No",
      source: "product:medical-billing",
    });
    const contact = leadEmailVars({ ...lead, kind: "CONTACT", productId: null, topic: "licensing", preferredDate: null, preferredSlot: null, countersBand: null }, { productName: null });
    expect(contact.received.kind_label).toBe("message");
    expect(contact.notice).toMatchObject({ kind_label: "contact message", product: "", topic: "Licensing or billing", preferred: "", counters: "" });
  });

  it("greets by name unless the name looks like a link or an address", () => {
    expect(greetingName("  Asha Rao ")).toBe("Asha Rao");
    expect(greetingName("R.Sharma")).toBe("R.Sharma");
    expect(greetingName("Dr. K. Iyer")).toBe("Dr. K. Iyer");
    for (const spam of ["visit evil.com now", "https://x.example", "www.win", "a@b.co", "<b>x</b>", "C:\u005Cx", ""]) {
      expect(greetingName(spam)).toBe("there");
    }
  });
});
