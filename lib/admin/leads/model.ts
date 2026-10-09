/**
 * Admin Leads inbox (decisions.md Phase 6 "plus a Leads inbox (contact and demo requests; not in the prototype)", and
 * launch waitlist sign-ups from coming-soon product pages since 2026-10-09):
 * statuses and their workflow, the DTOs, the list URL contract shared by the page, the table and GET /api/admin/leads.
 * Pure and client-safe.
 *
 * Workflow: NEW -> CONTACTED -> SCHEDULED (demo requests only) -> CLOSED, or SPAM at any point; any status can be set
 * again (reopen). Staff notes travel with a status change (or alone) and are kept in the audit log ("reason").
 */
import type { LeadKind, LeadStatus } from "@/generated/prisma/enums";
import { defineListState } from "@/lib/url-state";

export const LEAD_STATUS_VALUES = ["new", "contacted", "scheduled", "closed", "spam"] as const;
export type LeadStatusValue = (typeof LEAD_STATUS_VALUES)[number];

export const LEAD_KIND_VALUES = ["demo", "contact", "waitlist"] as const;
export type LeadKindValue = (typeof LEAD_KIND_VALUES)[number];

export const LEAD_STATUS_ENUM: Readonly<Record<LeadStatusValue, LeadStatus>> = {
  new: "NEW",
  contacted: "CONTACTED",
  scheduled: "SCHEDULED",
  closed: "CLOSED",
  spam: "SPAM",
};

export const LEAD_KIND_ENUM: Readonly<Record<LeadKindValue, LeadKind>> = { demo: "DEMO", contact: "CONTACT", waitlist: "WAITLIST" };

export function leadStatusValue(status: LeadStatus): LeadStatusValue {
  return status.toLowerCase() as LeadStatusValue;
}

export const LEAD_STATUS_LABELS: Readonly<Record<LeadStatusValue, string>> = {
  new: "New",
  contacted: "Contacted",
  scheduled: "Scheduled",
  closed: "Closed",
  spam: "Spam",
};

/** What each status means (status select hints). */
export const LEAD_STATUS_HINTS: Readonly<Record<LeadStatusValue, string>> = {
  new: "Nobody has replied yet.",
  contacted: "We replied or called.",
  scheduled: "A demo is booked.",
  closed: "Done: answered, bought or not interested.",
  spam: "Not a real request.",
};

export const LEAD_KIND_LABELS: Readonly<Record<LeadKind, string>> = { DEMO: "Demo request", CONTACT: "Message", WAITLIST: "Waitlist" };

/** Statuses a lead of this kind can be set to (only demo requests get "Scheduled"). */
export function leadStatusesFor(kind: LeadKind): LeadStatusValue[] {
  return LEAD_STATUS_VALUES.filter((s) => s !== "scheduled" || kind === "DEMO");
}

export type LeadDto = {
  id: string;
  kind: LeadKind;
  kindLabel: string;
  status: LeadStatusValue;
  name: string;
  businessName: string | null;
  email: string;
  /** "+91 98200 00000" for Indian mobiles, else as entered. */
  phone: string | null;
  productId: string | null;
  /** Product name (demo requests and waitlist sign-ups), "Not sure yet" for demo requests without one, else null. */
  productName: string | null;
  countersLabel: string | null;
  /** "12 Oct 2026, Morning (10–1)". */
  preferredLabel: string | null;
  topicLabel: string | null;
  message: string | null;
  marketingOptIn: boolean;
  source: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LeadHistoryEntry = {
  id: string;
  at: string;
  action: string;
  /** "New -> Contacted". */
  detail: string | null;
  note: string | null;
  actorName: string;
};

export type LeadDetail = { lead: LeadDto; history: LeadHistoryEntry[] };

export type LeadStats = Record<LeadStatusValue, number>;

/** Short reference line under the name: "DEMO-1004 · Sharma Medicals". */
export function leadSubtitle(lead: Pick<LeadDto, "id" | "businessName">): string {
  return lead.businessName ? `${lead.id} \u00b7 ${lead.businessName}` : lead.id;
}

// ---------- List URL contract (?q=&filter[kind]=&filter[status]=&sort=&page=) ----------

export const LEAD_SORTS = ["received", "name", "status"] as const;
export type LeadSort = (typeof LEAD_SORTS)[number];
export const LEAD_PAGE_SIZE = 25;

export const LEADS_LIST = defineListState<"kind" | "status">({
  filterStyle: "bracket",
  filters: { kind: { values: LEAD_KIND_VALUES }, status: { values: LEAD_STATUS_VALUES } },
  sortable: LEAD_SORTS,
  defaultSort: { id: "received", desc: true },
  pageSize: LEAD_PAGE_SIZE,
});

export const LEAD_LIST_SPEC = {
  filters: { kind: LEAD_KIND_VALUES, status: LEAD_STATUS_VALUES },
  sortable: LEAD_SORTS,
  defaultSort: { id: "received", desc: true },
  defaultPageSize: LEAD_PAGE_SIZE,
} as const;

export type LeadListQuery = {
  q: string;
  filters: { kind?: LeadKindValue; status?: LeadStatusValue };
  sort: { id: LeadSort; desc: boolean };
  page: number;
  pageSize: number;
};

export const LEAD_NOTE_MAX = 500;

export const LEAD_ERRORS = {
  status: "Choose a status from the list.",
  scheduledDemoOnly: "Only demo requests can be scheduled.",
  note: `Keep the note to ${LEAD_NOTE_MAX} characters or fewer.`,
  nothingToSave: "Choose a new status or write a note.",
} as const;

export const LEAD_COPY = {
  searchPlaceholder: "Search reference, name, email or business",
  searchLabel: "Search leads",
  caption: "Contact and demo requests and waitlist sign-ups",
  empty: "No requests yet. Contact and demo forms and \u201cNotify me\u201d sign-ups on the website land here.",
  saved: "Lead updated",
  noteSaved: "Note added",
  noChanges: "No changes to save",
  noteLabel: "Note (saved to the history)",
  noteHint: "Visible to staff only, e.g. \u201cCalled, demo on Friday 11 am\u201d.",
  historyEmpty: "No updates yet.",
} as const;
