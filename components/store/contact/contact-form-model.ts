/**
 * Contact form state and its mapping to the POST /api/contact body. Pure and client-safe (unit-tested).
 */
import type { ContactMode } from "@/content/contact";
import type { LeadCounterBand, LeadRequestBody, LeadSlot, LeadTopic } from "@/lib/validation/lead";

export type DemoProductOption = { id: string; name: string };

/** Everything the form holds. Values survive mode switches, as in the prototype. */
export type ContactFormValues = {
  name: string;
  businessName: string;
  email: string;
  phone: string;
  product: string;
  counters: "" | LeadCounterBand;
  preferredDate: string;
  preferredSlot: LeadSlot;
  topic: LeadTopic;
  message: string;
  marketingOptIn: boolean;
  /** Honeypot: stays empty for people. */
  website: string;
};

export type ContactFieldKey = Exclude<keyof ContactFormValues, "marketingOptIn" | "website">;

/** Fields per mode, in prototype order (also the error summary order). */
export const CONTACT_FIELD_ORDER: Readonly<Record<ContactMode, readonly ContactFieldKey[]>> = {
  demo: ["name", "businessName", "email", "phone", "product", "counters", "preferredDate", "preferredSlot", "message"],
  contact: ["name", "email", "phone", "topic", "message"],
};

/** Element id of a field's control (the error summary links to it). */
export function contactFieldId(key: ContactFieldKey): string {
  return `contact-${key}`;
}

export function initialContactValues(product: string): ContactFormValues {
  return {
    name: "",
    businessName: "",
    email: "",
    phone: "",
    product,
    counters: "",
    preferredDate: "",
    preferredSlot: "morning",
    topic: "sales",
    message: "",
    marketingOptIn: false,
    website: "",
  };
}

/** The POST /api/contact body for the current mode (only that mode's keys: the schema is strict). */
export function toLeadRequestBody(mode: ContactMode, v: ContactFormValues, source: string | null): LeadRequestBody {
  const common = {
    name: v.name,
    email: v.email,
    marketingOptIn: v.marketingOptIn,
    website: v.website,
    ...(source ? { source } : {}),
  };
  if (mode === "demo") {
    return {
      kind: "demo",
      ...common,
      businessName: v.businessName,
      phone: v.phone,
      product: v.product,
      counters: v.counters,
      preferredDate: v.preferredDate,
      preferredSlot: v.preferredSlot,
      message: v.message,
    };
  }
  return { kind: "contact", ...common, phone: v.phone, topic: v.topic, message: v.message };
}
