/**
 * Admin console SAMPLE data: customer sign-up dates, ~64 orders, 10 tickets and 12 audit rows, generated with the
 * prototype's Park-Miller PRNG (seed 42) in the prototype's exact call order, so ids, plans, customers, statuses
 * and relative dates match the prototype. Every value that reads the clock is relative to `now`, and every random
 * decision compares relative times, so the rows produced (ids, statuses, counts) do not depend on the run time.
 *
 * Pricing, terms, invoice numbers and coupon eligibility are NOT decided here; prisma/seed-data/plan.ts applies
 * the real rules (lib/pricing quote(), lib/licensing/terms, per-FY numbering) to these drafts.
 */
import { BillingInterval, PlanType, TicketPriority, TicketStatus } from "@/generated/prisma/enums";
import { DAY_MS, maxDate } from "@/lib/dates";
import { PLANS, PRODUCTS, type SeedPlan } from "./catalog";
import { SAMPLE_CUSTOMERS } from "./people";
import { parkMiller } from "./prng";

export const ADMIN_PRNG_SEED = 42;
export const ADMIN_ORDER_ITERATIONS = 64;

export type AdminOrderStatus = "paid" | "pending" | "failed" | "refunded" | "canceled";

export type AdminDeviceDraft = { key: string; name: string; os: string; activatedAt: Date; lastSeenAt: Date };

export type AdminLicenseDraft = {
  id: string;
  suspended: boolean;
  /** Self-service deactivations used this year (prototype deactivationsUsed 0..1). */
  selfServiceResets: number;
  devices: AdminDeviceDraft[];
};

export type AdminOrderDraft = {
  index: number;
  id: string;
  customerIndex: number;
  planId: string;
  qty: number;
  createdAt: Date;
  status: AdminOrderStatus;
  /** The prototype's 15% roll for WELCOME10; plan.ts applies it only when the coupon is actually valid. */
  wantsCoupon: boolean;
  method: string;
  /** Present for paid and refunded orders. */
  license: AdminLicenseDraft | null;
};

export type AdminTicketDraft = {
  id: string;
  customerIndex: number;
  subject: string;
  priority: TicketPriority;
  status: TicketStatus;
  productId: string;
  assignee: "sneha" | "rahul" | null;
  createdAt: Date;
  updatedAt: Date;
  body: string;
};

export type AuditDraft = {
  /** Staff key from people.ts, or null for System. */
  actor: string | null;
  role: "owner" | "admin" | "support" | "finance" | "system";
  action: string;
  target: string;
  targetType: string;
  /** Human id, slug or code; "release:" / "staff:" values are resolved to row ids by plan.ts. */
  targetId: string;
  reason: string | null;
  detail: string;
  createdAt: Date;
  ipPrefix: string | null;
};

export type AdminSample = {
  customerCreatedAt: Date[];
  orders: AdminOrderDraft[];
  tickets: AdminTicketDraft[];
  audit: AuditDraft[];
};

const DEVICE_NAMES = ["Counter PC", "Billing desk", "Office laptop", "Kitchen terminal", "Manager PC", "Cash counter 2"];
const DEVICE_OS = ["Windows 11 Pro", "Windows 10 Pro", "Windows 11 Home", "macOS 14"];
const METHODS = ["UPI", "UPI", "UPI", "Card", "Card", "Net banking"];

const TICKET_SUBJECTS: readonly (readonly [string, TicketPriority])[] = [
  ["Cannot activate on new computer", TicketPriority.HIGH],
  ["GST invoice shows wrong state code", TicketPriority.NORMAL],
  ["KOT printer not printing", TicketPriority.HIGH],
  ["How to import items from Excel", TicketPriority.LOW],
  ["Need GST invoice for last order", TicketPriority.NORMAL],
  ["Refund request — bought wrong plan", TicketPriority.NORMAL],
  ["Cheque layout offset on SBI leaf", TicketPriority.NORMAL],
  ["Software slow with large item list", TicketPriority.NORMAL],
  ["Reset device slots after PC crash", TicketPriority.HIGH],
  ["Barcode scale integration", TicketPriority.LOW],
];
const TICKET_STATUSES = [TicketStatus.OPEN, TicketStatus.OPEN, TicketStatus.AWAITING_CUSTOMER, TicketStatus.RESOLVED, TicketStatus.OPEN];
const TICKET_ASSIGNEES = ["sneha", "rahul", null] as const;

type AuditTemplate = Omit<AuditDraft, "createdAt" | "ipPrefix">;

/** Admin seed audit rows A[0..11]; reasons are split out of the detail text for destructive actions. */
export const AUDIT_TEMPLATES: readonly AuditTemplate[] = [
  { actor: "vikram", role: "admin", action: "Changed plan price", target: "Medical Store Billing · Annual license", targetType: "plan", targetId: "med-annual", reason: null, detail: "₹4,499 → ₹4,999" },
  { actor: "karan", role: "finance", action: "Issued refund", target: "AX-10288", targetType: "order", targetId: "AX-10288", reason: "customer request", detail: "₹4,128.82 · customer request" },
  { actor: null, role: "system", action: "Revoked license", target: "LIC-24188", targetType: "license", targetId: "LIC-24188", reason: "Order refunded", detail: "Order refunded" },
  { actor: "sneha", role: "support", action: "Reset devices", target: "LIC-23314", targetType: "license", targetId: "LIC-23314", reason: "PC crash", detail: "2 devices cleared · PC crash" },
  { actor: null, role: "system", action: "Webhook processed", target: "payment.captured · AX-10294", targetType: "webhook", targetId: "evt_7Qm2pX", reason: null, detail: "fulfilled" },
  { actor: null, role: "system", action: "Webhook rejected", target: "evt_9xk2…", targetType: "webhook", targetId: "evt_9xk2Lr", reason: null, detail: "invalid signature" },
  { actor: "anita", role: "owner", action: "Invited staff", target: "priyanka@axiomatic.example", targetType: "staff", targetId: "staff:priyanka", reason: null, detail: "Support" },
  { actor: "vikram", role: "admin", action: "Published release", target: "General Store GST Billing 5.0.2", targetType: "release", targetId: "release:general-store-gst:5.0.2", reason: null, detail: "Windows, macOS" },
  { actor: "vikram", role: "admin", action: "Created coupon", target: "DIWALI20", targetType: "coupon", targetId: "DIWALI20", reason: null, detail: "20% · annual plans" },
  { actor: "anita", role: "owner", action: "Updated settings", target: "Tax · invoice prefix", targetType: "settings", targetId: "tax", reason: null, detail: "AXS/25-26/ → AXS/26-27/" },
  { actor: "sneha", role: "support", action: "Extended license", target: "LIC-23447", targetType: "license", targetId: "LIC-23447", reason: "goodwill", detail: "+15 days · goodwill" },
  { actor: "karan", role: "finance", action: "Exported report", target: "GST summary · Q2", targetType: "report", targetId: "gst-summary", reason: null, detail: "CSV" },
];

/** Plans the prototype samples orders from: everything except trials, add-ons and maintenance. */
export const ADMIN_ORDER_PLANS: readonly SeedPlan[] = PLANS.filter(
  (p) => p.type !== PlanType.TRIAL && p.type !== PlanType.DEVICE_ADDON && p.type !== PlanType.MAINTENANCE,
);

const minDate = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

function statusFor(createdAt: Date, roll: number, now: Date): AdminOrderStatus {
  if (createdAt.getTime() > now.getTime() - 2 * DAY_MS && roll < 0.3) return "pending";
  if (roll < 0.06) return "failed";
  if (roll < 0.1) return "refunded";
  if (roll < 0.12) return "canceled";
  return "paid";
}

/**
 * Ports seedAdmin(). `reservedOrderIds` are the portal sample orders: as in the prototype, an iteration whose id
 * collides with one of them is skipped after its id has been drawn. Device dates are clamped so nothing lies in
 * the future or before its activation (the prototype could produce both).
 */
export function generateAdminSample(now: Date, reservedOrderIds: ReadonlySet<string>): AdminSample {
  const rng = parkMiller(ADMIN_PRNG_SEED);
  const r = rng.next;
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);

  const customerCreatedAt = SAMPLE_CUSTOMERS.map(() => ago(60 + Math.floor(r() * 500)));
  const customerIndexes = SAMPLE_CUSTOMERS.map((_, i) => i);

  const orders: AdminOrderDraft[] = [];
  for (let index = 0; index < ADMIN_ORDER_ITERATIONS; index += 1) {
    const customerIndex = rng.pick(customerIndexes);
    const plan = rng.pick(ADMIN_ORDER_PLANS);
    const qty = plan.perUnit ? 1 + Math.floor(r() * 3) : 1;
    const ageDays = Math.floor(Math.pow(r(), 1.6) * 380);
    const createdAt = ago(ageDays + r());
    const status = statusFor(createdAt, r(), now);
    const wantsCoupon = r() < 0.15;
    const id = `AX-${10120 + index * 3 + Math.floor(r() * 3)}`;
    if (reservedOrderIds.has(id)) continue;
    const method = rng.pick(METHODS);

    let license: AdminLicenseDraft | null = null;
    if (status === "paid" || status === "refunded") {
      // The prototype gave monthly subscriptions an expiry of now + 5..30 days; lib/licensing/terms decides
      // terms now, but the draw is kept so the rest of the sequence matches the prototype.
      if (plan.type === PlanType.SUBSCRIPTION && plan.interval === BillingInterval.MONTH) r();
      const limit = plan.perUnit ? qty : (plan.deviceLimit ?? 1);
      let deviceCount = 0;
      let suspended = false;
      if (status !== "refunded") {
        const base = Math.floor(r() * (limit + 1));
        deviceCount = Math.min(limit, base + (r() < 0.5 ? 1 : 0));
        suspended = r() < 0.03;
      }
      const selfServiceResets = Math.floor(r() * 2);
      const activatedAt = minDate(new Date(createdAt.getTime() + DAY_MS), now);
      const devices: AdminDeviceDraft[] = [];
      for (let k = 0; k < deviceCount; k += 1) {
        const name = rng.pick(DEVICE_NAMES);
        const os = rng.pick(DEVICE_OS);
        const lastSeen = new Date(now.getTime() - r() * 40 * DAY_MS);
        devices.push({ key: `dv${index}_${k}`, name, os, activatedAt, lastSeenAt: maxDate(activatedAt, lastSeen) });
      }
      license = { id: `LIC-${23300 + index * 7}`, suspended, selfServiceResets, devices };
    }

    orders.push({ index, id, customerIndex, planId: plan.id, qty, createdAt, status, wantsCoupon, method, license });
  }

  const tickets: AdminTicketDraft[] = TICKET_SUBJECTS.map(([subject, priority], i) => {
    const createdAt = ago(r() * 12);
    const status = rng.pick(TICKET_STATUSES);
    const productId = rng.pick(PRODUCTS).id;
    const assignee = rng.pick(TICKET_ASSIGNEES);
    const updatedAt = minDate(new Date(createdAt.getTime() + r() * DAY_MS), now);
    return { id: `T-${3000 + i}`, customerIndex: i, subject, priority, status, productId, assignee, createdAt, updatedAt, body: `${subject}. Please help.` };
  });

  const audit: AuditDraft[] = AUDIT_TEMPLATES.map((template, i) => {
    const createdAt = ago(i * 1.3 + r());
    const octet = Math.floor(r() * 255);
    return { ...template, createdAt, ipPrefix: template.actor === null ? null : `103.21.${octet}.x` };
  });

  return { customerCreatedAt, orders, tickets, audit };
}
