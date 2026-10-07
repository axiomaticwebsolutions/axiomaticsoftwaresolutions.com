import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTACT_FIELD_ORDER,
  initialContactValues,
  toLeadRequestBody,
  type ContactFormValues,
} from "@/components/store/contact/contact-form-model";
import { CONTACT_COPY, formatDayMonth } from "@/content/contact";
import { SUPPORT_CHANNELS, SUPPORT_FAQ_COPY } from "@/content/support";
import { issueCsrfToken } from "@/lib/auth/csrf";
import { fromIstParts } from "@/lib/dates";
import type * as RateLimitModule from "@/lib/auth/rate-limit";
import type * as EnvModule from "@/lib/env";
import type * as LeadsModule from "@/lib/leads";
import { setLogSink } from "@/lib/log";
import { decoyLeadId, formatLeadId } from "@/lib/leads";
import { BILLING_ERRORS, tooLongMessage } from "@/lib/validation/billing";
import {
  addDaysToDateString,
  cleanMultiline,
  createLeadRequestSchema,
  isIsoDate,
  istDateString,
  LEAD_ERRORS,
  leadFieldErrors,
  preferredDateRange,
} from "@/lib/validation/lead";

// ---------- Route mocks (only the route tests below use them) ----------

const CSRF_SECRET = "test-csrf-secret-0123456789abcdef0123456789";
const APP_URL = "http://localhost:3000";

const mocks = vi.hoisted(() => ({
  products: [] as Array<{ id: string; demoEnabled: boolean }>,
  productsError: null as Error | null,
  hit: vi.fn(),
  transaction: vi.fn(),
  createLead: vi.fn(),
  auth: vi.fn(),
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  getEnv: () => ({ CSRF_SECRET, APP_URL, TRUSTED_PROXY_HOPS: 1 }) as unknown as EnvModule.Env,
}));
vi.mock("@/lib/auth/guards", () => ({ getCurrentAuth: mocks.auth }));
vi.mock("@/lib/storefront/data", () => ({
  getStoreProducts: async () => {
    if (mocks.productsError) throw mocks.productsError;
    return mocks.products;
  },
  getStoreSettings: async () => ({ business: { salesEmail: "sales@axiomatic.example" } }),
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/lib/auth/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitModule>()),
  hit: mocks.hit,
}));
vi.mock("@/lib/leads", async (importOriginal) => ({
  ...(await importOriginal<typeof LeadsModule>()),
  createLead: mocks.createLead,
}));

// ---------- Schema ----------

const DEMO_IDS = ["medical-billing", "restaurant-billing"];
// 7 Oct 2026, 12:00 IST.
const NOON_IST = fromIstParts({ year: 2026, month: 10, day: 7, hour: 12 });

function schemaAt(now: Date = NOON_IST) {
  return createLeadRequestSchema({ demoProductIds: DEMO_IDS, now: () => now });
}

const validDemo = {
  kind: "demo",
  name: "  Asha   Rao ",
  businessName: "Rao Medicals",
  email: " Asha@Example.com ",
  phone: "+91 98200 00000",
  product: "medical-billing",
  counters: "2-3",
  preferredDate: "2026-10-07",
  preferredSlot: "afternoon",
  message: "",
  marketingOptIn: false,
  website: "",
  source: "product:medical-billing",
} as const;

const validContact = {
  kind: "contact",
  name: "Vikram",
  email: "vikram@example.com",
  phone: "",
  topic: "licensing",
  message: "How do licenses move between computers?",
  marketingOptIn: true,
} as const;

function errorsOf(body: unknown, now?: Date): Record<string, string> {
  const parsed = schemaAt(now).safeParse(body);
  if (parsed.success) return {};
  return leadFieldErrors(parsed.error);
}

describe("createLeadRequestSchema: demo", () => {
  it("cleans and normalises a valid request", () => {
    const parsed = schemaAt().parse(validDemo);
    expect(parsed).toEqual({
      honeypot: false,
      lead: {
        kind: "DEMO",
        name: "Asha Rao",
        businessName: "Rao Medicals",
        email: "asha@example.com",
        phone: "9820000000",
        productId: "medical-billing",
        countersBand: "2-3",
        preferredDate: "2026-10-07",
        preferredSlot: "afternoon",
        topic: null,
        message: null,
        marketingOptIn: false,
        source: "product:medical-billing",
      },
    });
  });

  it("stores 'Not sure yet' as no product and a blank counter band as null", () => {
    const { lead } = schemaAt().parse({ ...validDemo, product: "not-sure", counters: "", source: undefined });
    expect(lead.productId).toBeNull();
    expect(lead.countersBand).toBeNull();
    expect(lead.source).toBeNull();
  });

  it("reports every missing field with the prototype copy", () => {
    const errors = errorsOf({
      kind: "demo",
      name: " ",
      businessName: "",
      email: "nope",
      phone: "12345",
      product: "",
      preferredDate: "",
      preferredSlot: "morning",
    });
    expect(errors).toEqual({
      name: LEAD_ERRORS.name,
      businessName: LEAD_ERRORS.businessName,
      email: "Enter a valid email address.",
      phone: "Enter a 10-digit mobile number so we can confirm the slot.",
      product: "Choose the software you’re interested in.",
      preferredDate: "Pick a preferred date.",
    });
  });

  it("only accepts demo-enabled published products", () => {
    expect(errorsOf({ ...validDemo, product: "cheque-printing" })).toEqual({ product: LEAD_ERRORS.product });
    expect(errorsOf({ ...validDemo, product: "x".repeat(65) })).toEqual({ product: LEAD_ERRORS.product });
  });

  it("accepts today up to 180 days ahead, as IST calendar dates", () => {
    expect(errorsOf({ ...validDemo, preferredDate: "2026-10-06" })).toEqual({ preferredDate: "Choose today or a later date." });
    expect(errorsOf({ ...validDemo, preferredDate: "2026-10-07" })).toEqual({});
    expect(errorsOf({ ...validDemo, preferredDate: "2027-04-05" })).toEqual({});
    expect(errorsOf({ ...validDemo, preferredDate: "2027-04-06" })).toEqual({ preferredDate: LEAD_ERRORS.dateFar });
    expect(errorsOf({ ...validDemo, preferredDate: "2026-02-30" })).toEqual({ preferredDate: LEAD_ERRORS.date });
    expect(errorsOf({ ...validDemo, preferredDate: "07/10/2026" })).toEqual({ preferredDate: LEAD_ERRORS.date });
  });

  it("decides 'today' in IST, not UTC", () => {
    // 7 Oct 2026 19:00 UTC is 8 Oct 00:30 IST: the 7th is already in the past.
    const lateUtc = new Date(Date.UTC(2026, 9, 7, 19, 0));
    expect(errorsOf({ ...validDemo, preferredDate: "2026-10-07" }, lateUtc)).toEqual({ preferredDate: LEAD_ERRORS.datePast });
    expect(errorsOf({ ...validDemo, preferredDate: "2026-10-08" }, lateUtc)).toEqual({});
  });

  it("rejects unknown keys and keys of the other form (strict)", () => {
    expect(errorsOf({ ...validDemo, topic: "sales" })).toHaveProperty("topic");
    expect(errorsOf({ ...validDemo, isAdmin: true })).toHaveProperty("isAdmin");
    expect(errorsOf({ ...validDemo, kind: "partner" })).toHaveProperty("kind");
  });

  it("enforces length limits", () => {
    expect(errorsOf({ ...validDemo, name: "a".repeat(101) })).toEqual({ name: tooLongMessage(100) });
    expect(errorsOf({ ...validDemo, businessName: "b".repeat(121) })).toEqual({ businessName: tooLongMessage(120) });
    expect(errorsOf({ ...validDemo, message: "m".repeat(2001) })).toEqual({ message: tooLongMessage(2000) });
    expect(errorsOf({ ...validDemo, phone: "9".repeat(21) })).toEqual({ phone: LEAD_ERRORS.phoneDemo });
    expect(errorsOf({ ...validDemo, source: "Not A Slug" })).toHaveProperty("source");
  });

  it("flags the honeypot without failing validation", () => {
    expect(schemaAt().parse({ ...validDemo, website: "http://spam.example" }).honeypot).toBe(true);
    expect(schemaAt().parse({ ...validDemo, website: "   " }).honeypot).toBe(false);
  });
});

describe("createLeadRequestSchema: contact", () => {
  it("parses a valid message with an optional blank phone", () => {
    const { lead } = schemaAt().parse(validContact);
    expect(lead).toMatchObject({
      kind: "CONTACT",
      phone: null,
      topic: "licensing",
      businessName: null,
      productId: null,
      preferredDate: null,
      marketingOptIn: true,
    });
  });

  it("validates the optional phone as an Indian mobile when given", () => {
    expect(schemaAt().parse({ ...validContact, phone: "098200 00000" }).lead.phone).toBe("9820000000");
    expect(errorsOf({ ...validContact, phone: "022 2345 6789" })).toEqual({ phone: BILLING_ERRORS.phone });
  });

  it("needs a message of at least 10 characters", () => {
    expect(errorsOf({ ...validContact, message: "  too short " })).toEqual({ message: LEAD_ERRORS.message });
    expect(errorsOf({ ...validContact, message: undefined })).toEqual({ message: LEAD_ERRORS.message });
  });

  it("cleans the message: CRLF to LF, control characters removed, trimmed", () => {
    const raw = `  Line one\r\nLine two${String.fromCharCode(0)}${String.fromCharCode(7)}\twith tab  `;
    expect(schemaAt().parse({ ...validContact, message: raw }).lead.message).toBe("Line one\nLine two\twith tab");
    expect(cleanMultiline("a\rb")).toBe("a\nb");
  });

  it("defaults the marketing opt-in to false (unticked)", () => {
    const { marketingOptIn: _omitted, ...rest } = validContact;
    expect(schemaAt().parse(rest).lead.marketingOptIn).toBe(false);
  });

  it("rejects an unknown topic", () => {
    expect(errorsOf({ ...validContact, topic: "jobs" })).toEqual({ topic: LEAD_ERRORS.topic });
  });
});

describe("date helpers", () => {
  it("formats IST calendar dates and adds days across month and year ends", () => {
    expect(istDateString(new Date(Date.UTC(2026, 11, 31, 18, 30)))).toBe("2027-01-01");
    expect(addDaysToDateString("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToDateString("2028-02-28", 1)).toBe("2028-02-29");
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2027-02-29")).toBe(false);
    expect(preferredDateRange(NOON_IST)).toEqual({ min: "2026-10-07", max: "2027-04-05" });
  });

  it("formats the success date like the prototype (en-IN day and long month)", () => {
    expect(formatDayMonth("2026-10-07")).toBe("7 October");
    expect(formatDayMonth("")).toBeNull();
    expect(CONTACT_COPY.demoSentBody("", null, "Morning (10–1)")).toBe(
      "We’ll call you to confirm a time on your chosen day (morning (10–1)).",
    );
  });
});

describe("contact form model", () => {
  const filled: ContactFormValues = {
    ...initialContactValues("restaurant-billing"),
    name: "Asha",
    businessName: "Rao Medicals",
    email: "asha@example.com",
    phone: "9820000000",
    preferredDate: "2026-10-08",
    message: "We want to move our item list.",
  };

  it("starts with the prototype defaults and the marketing opt-in unticked", () => {
    expect(initialContactValues("")).toMatchObject({ preferredSlot: "morning", topic: "sales", marketingOptIn: false, website: "" });
  });

  it("builds a strict body per mode that the API schema accepts", () => {
    const demo = schemaAt().parse(toLeadRequestBody("demo", filled, "product:restaurant-billing"));
    expect(demo.lead).toMatchObject({ kind: "DEMO", productId: "restaurant-billing", source: "product:restaurant-billing" });
    const contact = schemaAt().parse(toLeadRequestBody("contact", filled, null));
    expect(contact.lead).toMatchObject({ kind: "CONTACT", topic: "sales", source: null, businessName: null });
  });

  it("lists exactly the fields each mode sends", () => {
    for (const mode of ["demo", "contact"] as const) {
      const keys = Object.keys(toLeadRequestBody(mode, filled, null)).filter(
        (k) => !["kind", "marketingOptIn", "website", "source"].includes(k),
      );
      expect(new Set(keys)).toEqual(new Set(CONTACT_FIELD_ORDER[mode]));
    }
  });
});

describe("lead ids and support copy", () => {
  it("formats references per kind", () => {
    expect(formatLeadId("DEMO", 1001)).toBe("DEMO-1001");
    expect(formatLeadId("CONTACT", 1002)).toBe("MSG-1002");
    expect(decoyLeadId("DEMO", () => 0)).toBe("DEMO-1001");
    expect(decoyLeadId("CONTACT", () => 0.9999)).toMatch(/^MSG-\d{4,5}$/);
  });

  it("pluralises the support search result heading", () => {
    expect(SUPPORT_FAQ_COPY.resultsTitle(1, "backup")).toBe("1 answer for “backup”");
    expect(SUPPORT_FAQ_COPY.resultsTitle(3, "licen")).toBe("3 answers for “licen”");
    expect(SUPPORT_CHANNELS.intro("Mon–Sat, 10:00–19:00 IST", true)).toBe(
      "Mon–Sat, 10:00–19:00 IST (configurable). Have your license ID ready.",
    );
    expect(SUPPORT_CHANNELS.phone.bodyAfterNumber(false)).toBe(". Priority line for maintenance plan customers.");
  });
});

// ---------- POST /api/contact ----------

type Json = Record<string, unknown> & { error?: Record<string, unknown> };

function contactRequest(body: unknown, opts: { csrf?: boolean; origin?: string; xff?: string } = {}): NextRequest {
  const token = issueCsrfToken("anon", CSRF_SECRET);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: opts.origin ?? APP_URL,
    "x-forwarded-for": opts.xff ?? "103.21.44.7",
  };
  if (opts.csrf !== false) {
    headers.cookie = `axs_csrf=${encodeURIComponent(token)}`;
    headers["x-csrf-token"] = token;
  }
  return new NextRequest(`${APP_URL}/api/contact`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function post(body: unknown, opts?: Parameters<typeof contactRequest>[1]): Promise<{ status: number; json: Json; headers: Headers }> {
  const { POST } = await import("@/app/api/contact/route");
  const res = await POST(contactRequest(body, opts), undefined);
  return { status: res.status, json: (await res.json()) as Json, headers: res.headers };
}

function tomorrowIst(): string {
  return addDaysToDateString(istDateString(new Date()), 1);
}

describe("POST /api/contact", () => {
  let logLines: string[];

  beforeEach(() => {
    logLines = [];
    setLogSink((_level, line) => logLines.push(line));
    mocks.products = [
      { id: "medical-billing", demoEnabled: true },
      { id: "cheque-printing", demoEnabled: false },
    ];
    mocks.productsError = null;
    mocks.auth.mockReset().mockResolvedValue(null);
    mocks.hit.mockReset().mockResolvedValue({ allowed: true, count: 1, limit: 5, remaining: 4, retryAfterSec: 0, resetAt: new Date() });
    mocks.transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
    mocks.createLead.mockReset().mockResolvedValue({ id: "DEMO-1001" });
  });

  afterEach(() => setLogSink(null));

  const demoBody = () => ({ ...validDemo, preferredDate: tomorrowIst() });

  it("stores a demo request and returns its reference, logging no personal details", async () => {
    const res = await post(demoBody());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ reference: "DEMO-1001" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.hit).toHaveBeenCalledOnce();
    expect(mocks.createLead).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ kind: "DEMO", email: "asha@example.com", phone: "9820000000", ipPrefix: "103.21.44.x" }),
    );
    const logs = logLines.join("\n");
    expect(logs).toContain("DEMO-1001");
    expect(logs).not.toMatch(/asha|9820000000|Rao/i);
  });

  it("binds the CSRF token to the session: an anonymous token fails once signed in", async () => {
    mocks.auth.mockResolvedValue({ session: { id: "session-1" } });
    const res = await post(demoBody());
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe("csrf_failed");
  });

  it("refuses requests without the CSRF token or from another origin", async () => {
    expect((await post(demoBody(), { csrf: false })).status).toBe(403);
    expect((await post(demoBody(), { origin: "https://evil.example" })).status).toBe(403);
    expect(mocks.createLead).not.toHaveBeenCalled();
  });

  it("returns 422 with field errors", async () => {
    const res = await post({ ...demoBody(), product: "cheque-printing", name: "" });
    expect(res.status).toBe(422);
    expect(res.json.error?.code).toBe("validation_failed");
    expect(res.json.error?.fieldErrors).toEqual({ name: [LEAD_ERRORS.name], product: [LEAD_ERRORS.product] });
    expect(mocks.hit).not.toHaveBeenCalled();
  });

  it("answers a filled honeypot with a decoy reference and stores nothing", async () => {
    const res = await post({ ...demoBody(), website: "https://spam.example" });
    expect(res.status).toBe(200);
    expect(res.json.reference).toMatch(/^DEMO-\d{4,5}$/);
    expect(mocks.hit).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rate-limits per IP with 429, Retry-After and the sales address", async () => {
    mocks.hit.mockResolvedValue({ allowed: false, count: 6, limit: 5, remaining: 0, retryAfterSec: 1800, resetAt: new Date() });
    const res = await post(validContact);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1800");
    expect(String(res.json.error?.message)).toBe(
      "You’ve sent several requests in a short time. Try again in 30 minutes, or email us at sales@axiomatic.example.",
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("answers 503 with the sales address when the database is unavailable", async () => {
    mocks.hit.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED asha@example.com"), { code: "ECONNREFUSED" }));
    const res = await post(demoBody());
    expect(res.status).toBe(503);
    expect(res.json.error).toEqual({
      code: "unavailable",
      message: "We couldn’t send your request. Email us at sales@axiomatic.example instead.",
    });
    expect(logLines.join("\n")).not.toContain("asha@example.com");

    mocks.hit.mockResolvedValue({ allowed: true, count: 1, limit: 5, remaining: 4, retryAfterSec: 0, resetAt: new Date() });
    mocks.createLead.mockRejectedValue(new Error("Invalid `tx.lead.create()` invocation: asha@example.com"));
    expect((await post(demoBody())).status).toBe(503);
    expect(logLines.join("\n")).not.toContain("asha@example.com");
  });

  it("answers 503 when the catalog cannot be read", async () => {
    mocks.productsError = new Error("catalog down");
    expect((await post(demoBody())).status).toBe(503);
  });
});
