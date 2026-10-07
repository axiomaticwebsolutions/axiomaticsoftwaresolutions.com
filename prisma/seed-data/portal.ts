/**
 * Customer portal SAMPLE: the "Sharma Medicals" workspace of Priya Sharma (seedPortal + seedEnterprise in
 * axiomatic-data.js): 3 orders, 4 licenses, devices, license history, 2 tickets, 5 notifications, 12 activity rows.
 * License terms come from lib/licensing/terms (the binding rules), which agree with the prototype's dates.
 */
import { ItemKind, LicenseStatus, OrderStatus, TicketPriority, TicketStatus } from "@/generated/prisma/enums";
import { DAY_MS, istCalendarYear } from "@/lib/dates";
import { addonTerms, newLicenseTerms } from "@/lib/licensing/terms";
import { findPlan } from "./catalog";
import { seedIds } from "./ids";
import type { BillingSnapshot, OrderDraft } from "./orders";
import { SHARMA_ACCOUNT } from "./people";
import {
  sampleFingerprint,
  type ActivityRow,
  type AttachmentJson,
  type DeviceRow,
  type LicenseEventRow,
  type NotificationRow,
  type SeedLicense,
  type TicketMessageRow,
  type TicketRow,
} from "./types";

export const PORTAL_ORDER_IDS: readonly string[] = ["AX-10198", "AX-10102", "AX-10288"];

/** The prototype's sample keys. Stored only as hash + ciphertext + last 4 (lib/licensing/crypto sealLicenseKey). */
export const PORTAL_LICENSE_KEYS: Readonly<Record<string, string>> = {
  "LIC-24017": "MED-7Q4K-9XTP-W2HD-K8NM",
  "LIC-23961": "CHQ-4MRT-H8ZQ-6PWA-J3XV",
  "LIC-24188": "GST-W9KD-2LQN-T7RC-M4EB",
  // The prototype's "GST-TRIA-L5HP-8QVM-R2KC" contains an I, which the key alphabet excludes.
  "LIC-24112": "GST-TR7A-L5HP-8QVM-R2KC",
};

export function portalKey(licenseId: string): string {
  const key = PORTAL_LICENSE_KEYS[licenseId];
  if (!key) throw new RangeError(`No sample key for ${licenseId}`);
  return key;
}

export const PRIYA_BILLING: BillingSnapshot = {
  name: "Priya Sharma",
  email: "priya@sharmamedicals.example",
  phone: "9820000000",
  business: SHARMA_ACCOUNT.legalName,
  address: SHARMA_ACCOUNT.address,
  city: SHARMA_ACCOUNT.city,
  state: SHARMA_ACCOUNT.state,
  pin: SHARMA_ACCOUNT.pin,
  gstin: SHARMA_ACCOUNT.gstin,
};

export const AX_10288_REVOKED_REASON = "Order AX-10288 was refunded at your request.";

export type PortalSample = {
  orders: OrderDraft[];
  licenses: SeedLicense[];
  devices: DeviceRow[];
  events: LicenseEventRow[];
  tickets: TicketRow[];
  messages: TicketMessageRow[];
  notifications: NotificationRow[];
  activities: ActivityRow[];
};

type EventInput = { at: Date; type: string; actor: string; detail: string | null };

function eventRows(licenseId: string, events: readonly EventInput[]): LicenseEventRow[] {
  return [...events]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((e, i) => ({ id: seedIds.licenseEvent(licenseId, i + 1), licenseId, type: e.type, actor: e.actor, detail: e.detail, createdAt: e.at }));
}

function attachment(ticketId: string, name: string, kb: number): AttachmentJson {
  return { name, sizeBytes: kb * 1024, storageKey: `sample/tickets/${ticketId}/${name}` };
}

export function buildPortalSample(now: Date): PortalSample {
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const accountId = seedIds.account(SHARMA_ACCOUNT.key);
  const priya = seedIds.user("priya");
  const loc1 = seedIds.location("loc1");
  const loc2 = seedIds.location("loc2");
  const year = istCalendarYear(now);

  const paid10198 = ago(324);
  const paid10102 = ago(560);
  const paid10288 = ago(20);
  const refunded10288 = ago(14);

  const orders: OrderDraft[] = [
    {
      id: "AX-10198", accountId, placedByUserId: priya, billing: PRIYA_BILLING, status: OrderStatus.PAID,
      createdAt: paid10198, paidAt: paid10198, refundedAt: null, coupon: null, method: "UPI",
      // One order, two items: the annual license it issued and two extra computers added to that license.
      lines: [
        { planId: "med-annual", qty: 1, kind: ItemKind.NEW, issuedLicenseId: "LIC-24017" },
        { planId: "med-device", qty: 2, kind: ItemKind.ADDON, targetLicenseId: "LIC-24017" },
      ],
    },
    {
      id: "AX-10102", accountId, placedByUserId: priya, billing: PRIYA_BILLING, status: OrderStatus.PAID,
      createdAt: paid10102, paidAt: paid10102, refundedAt: null, coupon: null, method: "UPI",
      lines: [{ planId: "chq-onetime", qty: 1, kind: ItemKind.NEW, issuedLicenseId: "LIC-23961" }],
    },
    {
      // The activity log says Rohan placed this one.
      id: "AX-10288", accountId, placedByUserId: seedIds.user("rohan"), billing: PRIYA_BILLING, status: OrderStatus.REFUNDED,
      createdAt: paid10288, paidAt: paid10288, refundedAt: refunded10288, coupon: null, method: "UPI",
      lines: [{ planId: "gst-annual", qty: 1, kind: ItemKind.NEW, issuedLicenseId: "LIC-24188" }],
    },
  ];

  const t24017 = addonTerms(newLicenseTerms(findPlan("med-annual"), 1, paid10198), 2);
  const t23961 = newLicenseTerms(findPlan("chq-onetime"), 1, paid10102);
  const t24188 = newLicenseTerms(findPlan("gst-annual"), 1, paid10288);
  const trialStart = ago(40);
  const t24112 = newLicenseTerms(findPlan("gst-trial"), 1, trialStart);
  const oldPcDeactivated = ago(210);

  const license = (
    id: string,
    productId: string,
    planId: string,
    orderId: string | null,
    issuedAt: Date,
    terms: { expiresAt: Date | null; updatesUntil: Date; deviceLimit: number },
    extra: Partial<SeedLicense["row"]> = {},
  ): SeedLicense => ({
    key: { kind: "fixed", key: portalKey(id) },
    row: {
      id, accountId, productId, planId, orderId, keyDeliveredAt: issuedAt, status: LicenseStatus.ACTIVE, issuedAt,
      expiresAt: terms.expiresAt, updatesUntil: terms.updatesUntil, deviceLimit: terms.deviceLimit,
      selfServiceResets: 0, resetsYear: year, autoRenew: false, revokedAt: null, revokedReason: null, ...extra,
    },
  });

  const licenses: SeedLicense[] = [
    // One self-service deactivation (the old counter PC); it counts only if it happened this calendar year (IST).
    license("LIC-24017", "medical-billing", "med-annual", "AX-10198", paid10198, t24017, {
      selfServiceResets: istCalendarYear(oldPcDeactivated) === year ? 1 : 0,
    }),
    license("LIC-23961", "cheque-printing", "chq-onetime", "AX-10102", paid10102, t23961),
    license("LIC-24188", "general-store-gst", "gst-annual", "AX-10288", paid10288, t24188, {
      status: LicenseStatus.REVOKED, revokedAt: refunded10288, revokedReason: AX_10288_REVOKED_REASON,
    }),
    license("LIC-24112", "general-store-gst", "gst-trial", null, trialStart, t24112, { status: LicenseStatus.TRIAL }),
  ];

  const device = (key: string, licenseId: string, name: string, os: string, locationId: string, activatedAt: Date, lastSeenAt: Date, extra: Partial<DeviceRow> = {}): DeviceRow => ({
    id: seedIds.device(key), licenseId, fingerprint: sampleFingerprint(key), name, os, appVersion: null, locationId,
    activatedAt, lastSeenAt, deactivatedAt: null, deactivatedBy: null, ...extra,
  });

  const devices: DeviceRow[] = [
    device("d1", "LIC-24017", "Billing counter PC", "Windows 11 Pro", loc1, ago(323), ago(0.05), { appVersion: "4.2.1" }),
    device("d2", "LIC-24017", "Back office laptop", "Windows 10 Home", loc2, ago(200), ago(2)),
    device("d0", "LIC-24017", "Old counter PC", "Windows 10 Pro", loc1, ago(323), oldPcDeactivated, {
      deactivatedAt: oldPcDeactivated, deactivatedBy: "customer",
    }),
    device("d3", "LIC-23961", "Accounts PC", "Windows 11 Home", loc1, ago(559), ago(1)),
  ];

  // License history from the prototype. "Validated" rows are dropped: routine validations are never written to
  // LicenseEvent (docs/decisions.md, scale target); the device's lastSeenAt/appVersion carry that information.
  const events: LicenseEventRow[] = [
    ...eventRows("LIC-24017", [
      { at: paid10198, type: "issued", actor: "System", detail: "Order AX-10198" },
      { at: paid10198, type: "devices_added", actor: "System", detail: "+2 devices · Order AX-10198" },
      { at: ago(323), type: "activated", actor: "Device", detail: "Billing counter PC" },
      { at: ago(323), type: "activated", actor: "Device", detail: "Old counter PC" },
      { at: oldPcDeactivated, type: "deactivated", actor: "Priya Sharma", detail: "Old counter PC" },
      { at: ago(200), type: "activated", actor: "Device", detail: "Back office laptop" },
    ]),
    ...eventRows("LIC-23961", [
      { at: paid10102, type: "issued", actor: "System", detail: "Order AX-10102" },
      { at: ago(559), type: "activated", actor: "Device", detail: "Accounts PC" },
      { at: t23961.updatesUntil, type: "updates_ended", actor: "System", detail: null },
    ]),
    ...eventRows("LIC-24188", [
      { at: paid10288, type: "issued", actor: "System", detail: "Order AX-10288" },
      { at: ago(19), type: "deactivated", actor: "Device", detail: "Second shop PC" },
      { at: refunded10288, type: "revoked", actor: "System", detail: AX_10288_REVOKED_REASON },
    ]),
    ...eventRows("LIC-24112", [
      { at: trialStart, type: "trial_started", actor: "Priya Sharma", detail: null },
      { at: t24112.expiresAt ?? ago(25), type: "trial_ended", actor: "System", detail: null },
    ]),
  ];

  const sneha = seedIds.user("sneha");
  const rahul = seedIds.user("rahul");
  const tickets: TicketRow[] = [
    {
      id: "T-3018", accountId, productId: "medical-billing", licenseId: "LIC-24017",
      subject: "Barcode scanner stops working after 4.2.1 update", priority: TicketPriority.HIGH,
      status: TicketStatus.AWAITING_CUSTOMER, assigneeId: sneha, openedById: priya, createdAt: ago(1.2), updatedAt: ago(0.4),
    },
    {
      id: "T-2994", accountId, productId: "medical-billing", licenseId: null,
      subject: "B2B invoice format with customer GSTIN", priority: TicketPriority.NORMAL,
      status: TicketStatus.RESOLVED, assigneeId: rahul, openedById: priya, createdAt: ago(32), updatedAt: ago(30),
    },
  ];

  const message = (ticketId: string, n: number, authorId: string, isStaff: boolean, at: Date, body: string, files: AttachmentJson[]): TicketMessageRow => ({
    id: seedIds.ticketMessage(ticketId, n), ticketId, authorId, isStaff, internal: false, body, attachments: files, createdAt: at,
  });
  const messages: TicketMessageRow[] = [
    message("T-3018", 1, priya, false, ago(1.2), "Since updating to 4.2.1 this morning the USB barcode scanner on the counter PC doesn’t enter anything in the billing screen. It still works in Notepad.", [attachment("T-3018", "scanner-error.png", 214)]),
    message("T-3018", 2, sneha, true, ago(0.4), "Thanks Priya. Please open Settings → Devices → Barcode input and check whether “Keyboard wedge mode” is on. If it is, switch it off and on again and restart the app. Let us know the scanner model if it still doesn’t work.", []),
    message("T-2994", 1, priya, false, ago(32), "How do I print the customer’s GSTIN on bills for hospital customers?", []),
    message("T-2994", 2, rahul, true, ago(31), "Open the customer, add their GSTIN, and choose the “B2B tax invoice” format under Settings → Print. The GSTIN and place of supply will then print on their bills.", [attachment("T-2994", "b2b-format-guide.pdf", 380)]),
  ];

  // Prototype hash routes rewritten to the portal's /account routes. Read notifications were read an hour later.
  const notification = (key: string, at: Date, kind: string, title: string, body: string, href: string, read: boolean): NotificationRow => ({
    id: seedIds.notification(key), userId: priya, kind, title, body, href, createdAt: at,
    readAt: read ? new Date(Math.min(at.getTime() + 3_600_000, now.getTime())) : null,
  });
  const notifications: NotificationRow[] = [
    notification("n1", ago(0.4), "ticket", "Support replied to T-3018", "Sneha suggested a fix for the barcode scanner issue.", "/account/tickets/T-3018", false),
    notification("n2", ago(4), "renewal", "Medical Store Billing renews in 45 days", "Renew LIC-24017 before it ends to keep billing without interruption.", "/account/licenses/LIC-24017", false),
    notification("n3", ago(21), "update", "Version 4.2.1 is available", "Faster salt-name search and a near-expiry return report.", "/account/software", true),
    notification("n4", refunded10288, "billing", "Refund processed for AX-10288", "₹4,128.82 will reach your account in 5–7 working days.", "/account/orders", true),
    notification("n5", t23961.updatesUntil, "update", "Cheque Printing updates have ended", "Renew maintenance to download version 3.x.", "/account/licenses/LIC-23961", true),
  ];

  const ACTIVITY: readonly (readonly [number, string, string, string, string])[] = [
    [0.05, "System", "License validated", "LIC-24017 · Billing counter PC", "license"],
    [0.4, "Sneha (Axiomatic Support)", "Replied to ticket", "T-3018", "ticket"],
    [1.2, "Priya Sharma", "Opened ticket", "T-3018", "ticket"],
    [3, "Priya Sharma", "Invited team member", "accounts@joshica.example · Viewer", "team"],
    [14, "Axiomatic Finance", "Refund processed", "AX-10288 · ₹4,128.82", "billing"],
    [14, "System", "License revoked after refund", "LIC-24188", "license"],
    [20, "Rohan Sharma", "Placed order", "AX-10288", "billing"],
    [21, "Kavya Desai", "Downloaded installer", "Medical Store Billing v4.2.1", "download"],
    [200, "Kavya Desai", "Activated device", "LIC-24017 · Back office laptop", "license"],
    [210, "Priya Sharma", "Deactivated device", "LIC-24017 · Old counter PC", "license"],
    [324, "Priya Sharma", "Placed order", "AX-10198", "billing"],
    [560, "Priya Sharma", "Placed order", "AX-10102", "billing"],
  ];
  // Entries by a member of the workspace record who did it (AccountActivity.actorId); System and staff entries do not.
  const memberIds: Readonly<Record<string, string>> = {
    "Priya Sharma": priya,
    "Rohan Sharma": seedIds.user("rohan"),
    "Kavya Desai": seedIds.user("kavya"),
  };
  const activities: ActivityRow[] = ACTIVITY.map(([days, actorName, action, target, kind], i) => ({
    id: seedIds.activity(i + 1), accountId, actorId: memberIds[actorName] ?? null, actorName, action, target, kind, createdAt: ago(days),
  }));

  return { orders, licenses, devices, events, tickets, messages, notifications, activities };
}
