/**
 * Contact and demo requests (Contact.dc.html), shared by the form (client) and POST /api/contact (server).
 *
 * The body is a strict discriminated union on `kind` ("demo" | "contact"); unknown keys are rejected. Field keys are
 * the form's field ids, so 422 field errors map straight back onto the form. Messages are the prototype copy.
 * The schema is built per request: the product list (published, demo-enabled) and the clock are inputs, so the
 * same rules run in the browser and on the server, and tests can pin "today" (an IST calendar date).
 * Client-safe: zod and the pure validation/date helpers only.
 */
import { z } from "zod";
import { istParts } from "@/lib/dates";
import { BILLING_ERRORS, cleanLine, tooLongMessage } from "@/lib/validation/billing";
import { makeEmailSchema, makeIndianMobileSchema, PHONE_INPUT_MAX } from "@/lib/validation/contact";

export const LEAD_KINDS = ["demo", "contact"] as const;
export type LeadKindKey = (typeof LEAD_KINDS)[number];

/** Input length limits (characters, after clean-up). */
export const LEAD_MAX = {
  name: 100,
  businessName: 120,
  message: 2000,
  /** Product slugs are short; anything longer is not a product. */
  product: 64,
  source: 100,
  /** Honeypot: generous, so a bot's value never fails validation (which would give the trap away). */
  website: 2000,
} as const;

/** Contact messages need at least this many characters (trimmed). */
export const LEAD_MESSAGE_MIN = 10;

/** Latest preferred demo date, in IST calendar days from today. */
export const PREFERRED_DATE_MAX_DAYS = 180;

/** Product select value for "Not sure yet" (stored as productId null). */
export const NOT_SURE_PRODUCT = "not-sure";

/** "Number of billing counters" (optional): stored keys and the prototype labels. */
export const LEAD_COUNTER_BANDS = ["1", "2-3", "4-10", "10+"] as const;
export type LeadCounterBand = (typeof LEAD_COUNTER_BANDS)[number];
export const LEAD_COUNTER_LABELS: Readonly<Record<LeadCounterBand, string>> = {
  "1": "1",
  "2-3": "2–3",
  "4-10": "4–10",
  "10+": "More than 10",
};

/** "Preferred time" (IST): stored keys and the prototype labels. */
export const LEAD_SLOTS = ["morning", "afternoon", "evening"] as const;
export type LeadSlot = (typeof LEAD_SLOTS)[number];
export const LEAD_SLOT_LABELS: Readonly<Record<LeadSlot, string>> = {
  morning: "Morning (10–1)",
  afternoon: "Afternoon (2–5)",
  evening: "Evening (5–7)",
};

/** "Topic" (contact form): stored keys and the prototype labels. */
export const LEAD_TOPICS = ["sales", "licensing", "partnership", "press", "other"] as const;
export type LeadTopic = (typeof LEAD_TOPICS)[number];
export const LEAD_TOPIC_LABELS: Readonly<Record<LeadTopic, string>> = {
  sales: "Sales question",
  licensing: "Licensing or billing",
  partnership: "Partnership",
  press: "Press",
  other: "Something else",
};

/**
 * Field errors: the prototype copy. New: `phoneContact` (Checkout's phone copy; the prototype never checked the
 * optional phone), `dateFar`, `counters`, `slot` and `topic` (selects the form always fills; API callers only).
 */
export const LEAD_ERRORS = {
  name: "Enter your name.",
  email: "Enter a valid email address.",
  phoneDemo: "Enter a 10-digit mobile number so we can confirm the slot.",
  phoneContact: BILLING_ERRORS.phone,
  businessName: "Enter your business name.",
  product: "Choose the software you’re interested in.",
  counters: "Choose the number of billing counters.",
  date: "Pick a preferred date.",
  datePast: "Choose today or a later date.",
  dateFar: "Choose a date within the next 6 months.",
  slot: "Choose a preferred time.",
  topic: "Choose a topic.",
  message: "Tell us a little more (at least 10 characters).",
} as const;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9:._-]*$/;
// C0 controls except tab (\x09) and newline (\x0A), plus DEL.
const CONTROL_CHARS_RE = /[\x00-\x08\x0B-\x1F\x7F]/g;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The IST calendar date of `d` as "YYYY-MM-DD" (the date input's value format). */
export function istDateString(d: Date): string {
  const p = istParts(d);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** A real calendar date in "YYYY-MM-DD" form (rejects 2026-02-30). */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** "YYYY-MM-DD" plus `days` calendar days. */
export function addDaysToDateString(date: string, days: number): string {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new RangeError(`Expected YYYY-MM-DD, got "${date}"`);
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Earliest (today) and latest preferred demo dates for `now`, as IST calendar dates. */
export function preferredDateRange(now: Date): { min: string; max: string } {
  const min = istDateString(now);
  return { min, max: addDaysToDateString(min, PREFERRED_DATE_MAX_DAYS) };
}

/** Text over several lines: CRLF -> LF, control characters other than tab and newline removed, trimmed. */
export function cleanMultiline(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS_RE, "").trim();
}

function requiredLine(message: string, max: number) {
  return z
    .string({ error: message })
    .overwrite(cleanLine)
    .superRefine((value, ctx) => {
      if (value.length === 0) ctx.addIssue(message);
      else if (value.length > max) ctx.addIssue(tooLongMessage(max));
    });
}

const emailField = makeEmailSchema(LEAD_ERRORS.email);

/** Required Indian mobile; output is the bare ten digits. */
const demoPhoneField = z
  .string({ error: LEAD_ERRORS.phoneDemo })
  .max(PHONE_INPUT_MAX, { message: LEAD_ERRORS.phoneDemo })
  .pipe(makeIndianMobileSchema(LEAD_ERRORS.phoneDemo));

const contactMobile = makeIndianMobileSchema(LEAD_ERRORS.phoneContact);

/** Optional phone: blank -> null, otherwise an Indian mobile (bare ten digits). */
const contactPhoneField = z
  .string({ error: LEAD_ERRORS.phoneContact })
  .optional()
  .transform((value, ctx) => {
    const trimmed = (value ?? "").trim();
    if (trimmed === "") return null;
    const parsed = contactMobile.safeParse(trimmed);
    if (parsed.success) return parsed.data;
    ctx.addIssue(LEAD_ERRORS.phoneContact);
    return z.NEVER;
  });

function messageField(required: boolean) {
  return z
    .string({ error: LEAD_ERRORS.message })
    .optional()
    .transform((value, ctx) => {
      const text = cleanMultiline(value ?? "");
      if (text.length > LEAD_MAX.message) {
        ctx.addIssue(tooLongMessage(LEAD_MAX.message));
        return z.NEVER;
      }
      if (required && text.length < LEAD_MESSAGE_MIN) {
        ctx.addIssue(LEAD_ERRORS.message);
        return z.NEVER;
      }
      return text === "" ? null : text;
    });
}

const marketingOptInField = z.boolean().optional().default(false);
const honeypotField = z.string().max(LEAD_MAX.website).optional().default("");
const sourceField = z
  .string()
  .max(LEAD_MAX.source)
  .regex(SOURCE_RE)
  .optional()
  .transform((value) => value ?? null);

export type LeadSchemaOptions = {
  /** Slugs of PUBLISHED products with demo requests enabled. */
  demoProductIds: Iterable<string>;
  /** Clock for the preferred-date rules (default: the current time). */
  now?: () => Date;
};

/** What the server stores (lib/leads.ts createLead). Strings are cleaned up; blanks are null. */
export type LeadInput = {
  kind: "DEMO" | "CONTACT";
  name: string;
  businessName: string | null;
  email: string;
  /** Bare ten digits. */
  phone: string | null;
  /** null = "Not sure yet" (demo), or not asked (contact). */
  productId: string | null;
  countersBand: LeadCounterBand | null;
  /** IST calendar date "YYYY-MM-DD". */
  preferredDate: string | null;
  preferredSlot: LeadSlot | null;
  topic: LeadTopic | null;
  message: string | null;
  marketingOptIn: boolean;
  /** Page or CTA that led here, e.g. "product:medical-billing". */
  source: string | null;
};

/** A parsed request: the lead, and whether the hidden "website" field was filled in (a bot). */
export type LeadRequest = { lead: LeadInput; honeypot: boolean };

/**
 * The POST /api/contact body schema.
 * Demo: name, businessName, email, phone (Indian mobile), product (a demo-enabled slug or "not-sure"), counters
 * (optional), preferredDate (today to +180 days, IST), preferredSlot, message (optional).
 * Contact: name, email, phone (optional Indian mobile), topic, message (at least 10 characters).
 * Both: marketingOptIn (default false), website (honeypot), source (optional).
 */
export function createLeadRequestSchema(options: LeadSchemaOptions) {
  const demoIds = new Set(options.demoProductIds);
  const now = options.now ?? (() => new Date());

  const productField = z
    .string({ error: LEAD_ERRORS.product })
    .trim()
    .superRefine((value, ctx) => {
      if (value === "" || value.length > LEAD_MAX.product) ctx.addIssue(LEAD_ERRORS.product);
      else if (value !== NOT_SURE_PRODUCT && !demoIds.has(value)) ctx.addIssue(LEAD_ERRORS.product);
    })
    .transform((value) => (value === NOT_SURE_PRODUCT ? null : value));

  const preferredDateField = z
    .string({ error: LEAD_ERRORS.date })
    .trim()
    .superRefine((value, ctx) => {
      if (value === "" || !isIsoDate(value)) {
        ctx.addIssue(LEAD_ERRORS.date);
        return;
      }
      const { min, max } = preferredDateRange(now());
      if (value < min) ctx.addIssue(LEAD_ERRORS.datePast);
      else if (value > max) ctx.addIssue(LEAD_ERRORS.dateFar);
    });

  const countersField = z
    .union([z.literal(""), z.enum(LEAD_COUNTER_BANDS)], { error: LEAD_ERRORS.counters })
    .optional()
    .transform((value): LeadCounterBand | null => (value ? value : null));

  const demo = z.strictObject({
    kind: z.literal("demo"),
    name: requiredLine(LEAD_ERRORS.name, LEAD_MAX.name),
    businessName: requiredLine(LEAD_ERRORS.businessName, LEAD_MAX.businessName),
    email: emailField,
    phone: demoPhoneField,
    product: productField,
    counters: countersField,
    preferredDate: preferredDateField,
    preferredSlot: z.enum(LEAD_SLOTS, LEAD_ERRORS.slot),
    message: messageField(false),
    marketingOptIn: marketingOptInField,
    website: honeypotField,
    source: sourceField,
  });

  const contact = z.strictObject({
    kind: z.literal("contact"),
    name: requiredLine(LEAD_ERRORS.name, LEAD_MAX.name),
    email: emailField,
    phone: contactPhoneField,
    topic: z.enum(LEAD_TOPICS, LEAD_ERRORS.topic),
    message: messageField(true),
    marketingOptIn: marketingOptInField,
    website: honeypotField,
    source: sourceField,
  });

  return z.discriminatedUnion("kind", [demo, contact]).transform((body): LeadRequest => {
    const honeypot = body.website.trim() !== "";
    if (body.kind === "demo") {
      return {
        honeypot,
        lead: {
          kind: "DEMO",
          name: body.name,
          businessName: body.businessName,
          email: body.email,
          phone: body.phone,
          productId: body.product,
          countersBand: body.counters,
          preferredDate: body.preferredDate,
          preferredSlot: body.preferredSlot,
          topic: null,
          message: body.message,
          marketingOptIn: body.marketingOptIn,
          source: body.source,
        },
      };
    }
    return {
      honeypot,
      lead: {
        kind: "CONTACT",
        name: body.name,
        businessName: null,
        email: body.email,
        phone: body.phone,
        productId: null,
        countersBand: null,
        preferredDate: null,
        preferredSlot: null,
        topic: body.topic,
        message: body.message,
        marketingOptIn: body.marketingOptIn,
        source: body.source,
      },
    };
  });
}

export type LeadRequestSchema = ReturnType<typeof createLeadRequestSchema>;
/** The JSON body the form sends (the schema's input side). */
export type LeadRequestBody = z.input<LeadRequestSchema>;

/** First message per top-level field of a failed parse, in issue order (inline errors and the summary). */
export function leadFieldErrors(error: z.core.$ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const head = issue.path[0];
    const field = issue.code === "unrecognized_keys" ? issue.keys[0] : typeof head === "string" ? head : undefined;
    if (field !== undefined && !(field in out)) out[field] = issue.message;
  }
  return out;
}
