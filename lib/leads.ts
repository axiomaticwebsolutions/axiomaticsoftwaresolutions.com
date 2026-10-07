/**
 * Contact and demo requests ("leads"), stored as `Lead` rows (docs/decisions.md > Phase 2).
 *
 * Ids come from the shared Counter "lead" (start 1001) with a prefix per kind: "DEMO-1001", "MSG-1002", ... allocated
 * inside the caller's transaction, so a rolled-back insert gives its number back. The ip prefix ("103.21.44.x") is
 * kept for abuse handling; the full IP never is.
 *
 * Emails (Phase 3): with `notify`, createLead() enqueues the acknowledgement to the visitor (`lead_received`) and the
 * internal notice to the sales address (`lead_new`) in the same transaction (outbox, dedupe keys per lead); the caller
 * calls kickEmailDispatch() after commit. The admin inbox arrives in Phase 6 (`leads.view`).
 */
import type { Lead } from "@/generated/prisma/client";
import { nextCounterValue } from "@/lib/counters";
import { formatDateIST, startOfDayIST } from "@/lib/dates";
import type { Tx } from "@/lib/db";
import { enqueueEmail } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import {
  isIsoDate,
  LEAD_COUNTER_LABELS,
  LEAD_SLOT_LABELS,
  LEAD_TOPIC_LABELS,
  type LeadInput,
} from "@/lib/validation/lead";

export const LEAD_COUNTER_KEY = "lead";
export const LEAD_COUNTER_START = 1001;

export const LEAD_ID_PREFIX: Readonly<Record<LeadInput["kind"], string>> = { DEMO: "DEMO-", CONTACT: "MSG-" };

/** "DEMO-1001" / "MSG-1001". */
export function formatLeadId(kind: LeadInput["kind"], n: number): string {
  return `${LEAD_ID_PREFIX[kind]}${n}`;
}

/** A plausible reference for requests that are dropped silently (the honeypot): same shape, never stored. */
export function decoyLeadId(kind: LeadInput["kind"], random: () => number = Math.random): string {
  return formatLeadId(kind, LEAD_COUNTER_START + Math.floor(random() * 9000));
}

export type LeadNotifyOptions = {
  /** Recipient of the internal notice: SiteSetting business.salesEmail. */
  salesEmail: string;
  /** Display name of the requested product; null for "Not sure yet" or when the form does not ask. */
  productName: string | null;
};

export type CreateLeadInput = LeadInput & {
  /** Truncated client IP from lib/http ipPrefix(), or null when unknown. */
  ipPrefix: string | null;
  /** Enqueue the acknowledgement and the internal notice in the same transaction (see the module comment). */
  notify?: LeadNotifyOptions;
};

/** Allocates the reference and inserts the lead (status NEW), plus its emails with `notify`. Call inside a short transaction. */
export async function createLead(tx: Tx, input: CreateLeadInput): Promise<Lead> {
  const n = await nextCounterValue(tx, LEAD_COUNTER_KEY, LEAD_COUNTER_START);
  const lead = await tx.lead.create({
    data: {
      id: formatLeadId(input.kind, n),
      kind: input.kind,
      name: input.name,
      businessName: input.businessName,
      email: input.email,
      phone: input.phone,
      productId: input.productId,
      countersBand: input.countersBand,
      preferredDate: input.preferredDate,
      preferredSlot: input.preferredSlot,
      topic: input.topic,
      message: input.message,
      marketingOptIn: input.marketingOptIn,
      source: input.source,
      ipPrefix: input.ipPrefix,
    },
  });
  if (input.notify) await enqueueLeadEmails(tx, lead, input.notify);
  return lead;
}

/** What the acknowledgement calls the request ("We received your demo request"). */
export const LEAD_ACK_KIND_LABEL: Readonly<Record<LeadInput["kind"], string>> = { DEMO: "demo request", CONTACT: "message" };
/** What the internal notice calls it ("New contact message: MSG-1002 from ..."). */
export const LEAD_NOTICE_KIND_LABEL: Readonly<Record<LeadInput["kind"], string>> = {
  DEMO: "demo request",
  CONTACT: "contact message",
};

/** The visitor's name for "Hi {{name}}" (lib/email/greeting.ts; kept here for existing imports). */
export { greetingName };

function labelOf(map: Readonly<Record<string, string>>, key: string | null): string {
  return key !== null && Object.prototype.hasOwnProperty.call(map, key) ? (map[key] ?? "") : "";
}

/** "+91 98200 00000" for the stored ten digits; anything else as stored. */
function formatPhone(phone: string | null): string {
  if (!phone) return "";
  return /^\d{10}$/.test(phone) ? `+91 ${phone.slice(0, 5)} ${phone.slice(5)}` : phone;
}

function preferredTime(lead: Pick<Lead, "preferredDate" | "preferredSlot">): string {
  const date = lead.preferredDate && isIsoDate(lead.preferredDate) ? formatDateIST(startOfDayIST(lead.preferredDate)) : "";
  const slot = labelOf(LEAD_SLOT_LABELS, lead.preferredSlot);
  return [date, slot].filter(Boolean).join(", ");
}

/** Variables of the two lead emails. */
export function leadEmailVars(
  lead: Lead,
  opts: Pick<LeadNotifyOptions, "productName">,
): { received: Record<string, string>; notice: Record<string, string> } {
  const received = { name: greetingName(lead.name), reference: lead.id, kind_label: LEAD_ACK_KIND_LABEL[lead.kind] };
  const notice = {
    reference: lead.id,
    kind_label: LEAD_NOTICE_KIND_LABEL[lead.kind],
    name: lead.name,
    email: lead.email,
    phone: formatPhone(lead.phone),
    product: opts.productName ?? (lead.kind === "DEMO" ? "Not sure yet" : ""),
    message: lead.message ?? "",
    business: lead.businessName ?? "",
    preferred: preferredTime(lead),
    counters: labelOf(LEAD_COUNTER_LABELS, lead.countersBand),
    topic: labelOf(LEAD_TOPIC_LABELS, lead.topic),
    marketing: lead.marketingOptIn ? "Yes" : "No",
    source: lead.source ?? "",
  };
  return { received, notice };
}

/** Enqueues `lead_received` (to the visitor) and `lead_new` (to sales) in the caller's transaction. */
export async function enqueueLeadEmails(tx: Tx, lead: Lead, opts: LeadNotifyOptions): Promise<void> {
  const { received, notice } = leadEmailVars(lead, opts);
  await enqueueEmail(tx, { to: lead.email, templateId: "lead_received", vars: received, dedupeKey: `lead_received:${lead.id}` });
  await enqueueEmail(tx, { to: opts.salesEmail, templateId: "lead_new", vars: notice, dedupeKey: `lead_new:${lead.id}` });
}
