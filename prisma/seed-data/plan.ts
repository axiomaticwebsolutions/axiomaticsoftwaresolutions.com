/**
 * Builds the complete SAMPLE seed as plain rows: pure (no database, no env, no secrets), so it is unit-tested and
 * prisma/seed.ts only has to hash passwords, seal license keys and upsert. Every id is deterministic and every
 * date is relative to `now` (except MONSOON25's end and release dates), so two runs write the same rows.
 */
import type { Prisma } from "@/generated/prisma/client";
import {
  AuthTokenType,
  ItemKind,
  LicenseStatus,
  MemberStatus,
  OrderStatus,
  PublishStatus,
  ReleaseStatus,
  StaffRole,
  StaffStatus,
  TeamRole,
  UserKind,
} from "@/generated/prisma/enums";
import { SETTING_KEYS, settingSchemas, taxSettingsForPricing, type SettingKey } from "@/lib/config";
import { COUNTER_START } from "@/lib/counters";
import { DAY_MS, istCalendarYear, maxDate, startOfDayIST } from "@/lib/dates";
import { newLicenseTerms } from "@/lib/licensing/terms";
import { evaluateCoupon, type CouponRule, type PricingPlan } from "@/lib/pricing";
import { INVITE_TTL_DAYS } from "@/lib/validation/team";
import { generateAdminSample, type AdminOrderDraft } from "./admin";
import {
  CATEGORIES,
  COMING_SOON_PRODUCTS,
  PLANS,
  PRODUCTS,
  findPlan,
  findProduct,
  parseSizeBytes,
  planSortOrder,
  productContentSchema,
  releaseFileName,
  releaseStorageKey,
  sampleSha256,
  type SeedFaq,
} from "./catalog";
import { comingSoonProductRow } from "./coming-soon";
import {
  HOME_FAQS,
  NOTIFICATION_TEMPLATES,
  PRICING_FAQS,
  SEED_SETTINGS,
  SUPPORT_FAQS,
  couponRules,
  templateBody,
} from "./content";
import { orderNumber, seedIds } from "./ids";
import { planCreditNoteNumbers, planInvoiceNumbers } from "./invoices";
import { buildOrderBundle, SAMPLE_PAYMENT_PROVIDER, type OrderBundle, type OrderDraft, type PricingContext } from "./orders";
import {
  OWNER_NAME,
  SAMPLE_CUSTOMERS,
  SAMPLE_STAFF,
  SHARMA_ACCOUNT,
  SHARMA_LOCATIONS,
  SHARMA_MEMBERS,
  customerAddress,
  customerEmail,
  customerPhone,
} from "./people";
import { PORTAL_ORDER_IDS, buildPortalSample } from "./portal";
import {
  sampleFingerprint,
  type ActivityRow,
  type DeviceRow,
  type LicenseEventRow,
  type NotificationRow,
  type SeedLicense,
  type SeedUser,
  type TicketMessageRow,
  type TicketRow,
  type WithId,
} from "./types";

export type LicenseGroup = { license: SeedLicense; devices: DeviceRow[]; events: LicenseEventRow[] };

export type OrderGroup = {
  bundle: OrderBundle;
  invoice: WithId<Prisma.InvoiceCreateManyInput> | null;
  refund: WithId<Prisma.RefundCreateManyInput> | null;
  licenses: LicenseGroup[];
};

export type SeedLogin = { who: string; email: string; password: "owner" | "demo"; twoStep: boolean };

/**
 * The open TEAM_INVITE link of a seeded pending invitation (lib/portal/invites.ts meta shape). The writer stores the
 * SHA-256 of a fresh random secret that it never keeps or prints, so the link exists (the Team page shows
 * "Invited 3d ago", and "Invite expired" only once it really expires) but nobody can ever open it.
 */
export type SeedInviteToken = WithId<Omit<Prisma.AuthTokenCreateManyInput, "codeHash" | "meta">> & {
  meta: { accountId: string; role: TeamRole; invitedById: string };
};

export type SeedPlanData = {
  now: Date;
  settings: { key: SettingKey; value: Prisma.InputJsonValue }[];
  categories: WithId<Prisma.CategoryCreateManyInput>[];
  products: WithId<Prisma.ProductCreateManyInput>[];
  plans: WithId<Prisma.PlanCreateManyInput>[];
  releases: WithId<Prisma.ReleaseCreateManyInput>[];
  releaseFiles: WithId<Prisma.ReleaseFileCreateManyInput>[];
  faqs: WithId<Prisma.FaqCreateManyInput>[];
  coupons: (Prisma.CouponCreateManyInput & { code: string })[];
  templates: WithId<Prisma.NotificationTemplateCreateManyInput>[];
  users: SeedUser[];
  accounts: WithId<Prisma.BusinessAccountCreateManyInput>[];
  members: WithId<Prisma.AccountMemberCreateManyInput>[];
  /** One open invitation link per seeded pending invitation. */
  inviteTokens: SeedInviteToken[];
  locations: WithId<Prisma.LocationCreateManyInput>[];
  /** Orders in id order, each with its payment, invoice, refund and the licenses it issued. */
  orderGroups: OrderGroup[];
  /** Licenses without an order (trials). */
  standaloneLicenses: LicenseGroup[];
  tickets: TicketRow[];
  ticketMessages: TicketMessageRow[];
  notifications: NotificationRow[];
  activities: ActivityRow[];
  webhookEvents: (Prisma.WebhookEventCreateManyInput & { provider: string; id: string })[];
  webhookDeliveries: WithId<Prisma.WebhookDeliveryCreateManyInput>[];
  auditLogs: WithId<Prisma.AuditLogCreateManyInput>[];
  /** Counter.next values: never lower than the existing value (seed.ts takes the max). */
  counters: { key: string; next: number }[];
  logins: SeedLogin[];
};

export const REFUND_REASON = "customer request";
const STAFF_CREATED_AGO_DAYS = 400;
const INVITED_STAFF_CREATED_AGO_DAYS = 8;

/** Plans as lib/pricing sees them. */
export function pricingPlans(): Map<string, PricingPlan> {
  return new Map(
    PLANS.map((p) => [p.id, { id: p.id, productId: p.productId, type: p.type, pricePaise: p.pricePaise, perUnit: p.perUnit, maxQty: p.maxQty, archived: false }]),
  );
}

function settingRows(): SeedPlanData["settings"] {
  // Parse with the strict admin-write schemas so the seed can never store a value the app would reject.
  return SETTING_KEYS.map((key) => ({ key, value: settingSchemas[key].parse(SEED_SETTINGS[key]) as Prisma.InputJsonValue }));
}

function catalogRows(): Pick<SeedPlanData, "categories" | "products" | "plans" | "releases" | "releaseFiles"> {
  const categories = CATEGORIES.map((c, i) => ({ id: c.id, name: c.name, blurb: c.blurb, tone: c.tone, icon: c.icon, sortOrder: i }));
  const products: SeedPlanData["products"] = PRODUCTS.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    shortName: p.shortName,
    tagline: p.tagline,
    summary: p.summary,
    icon: p.icon,
    tone: p.tone,
    categoryId: p.categoryId,
    platforms: [...p.platforms],
    status: PublishStatus.PUBLISHED,
    demoEnabled: p.demoEnabled,
    rank: p.rank,
    content: productContentSchema.parse(p.content),
    relatedIds: [...p.relatedIds],
    createdAt: startOfDayIST(p.added),
  }));
  // The coming-soon catalog: listed with a waitlist form, never sold (no plans, releases or FAQs).
  products.push(...COMING_SOON_PRODUCTS.map(comingSoonProductRow));
  const plans = PLANS.map((p) => ({
    id: p.id,
    productId: p.productId,
    type: p.type,
    name: p.name,
    summary: p.summary,
    includes: [...p.includes],
    pricePaise: p.pricePaise,
    interval: p.interval,
    trialDays: p.trialDays,
    deviceLimit: p.deviceLimit,
    perUnit: p.perUnit,
    maxQty: p.maxQty,
    multiDevice: p.multiDevice,
    updatesMonths: p.updatesMonths,
    popular: p.popular,
    archived: false,
    sortOrder: planSortOrder(p.id),
  }));
  const releases: SeedPlanData["releases"] = [];
  const releaseFiles: SeedPlanData["releaseFiles"] = [];
  for (const p of PRODUCTS) {
    for (const r of p.releases) {
      const id = seedIds.release(p.id, r.version);
      const releasedAt = startOfDayIST(r.date);
      releases.push({ id, productId: p.id, version: r.version, channel: "stable", status: ReleaseStatus.PUBLISHED, releasedAt, notes: [...r.notes], createdAt: releasedAt });
      for (const platform of p.platforms) {
        const fileName = releaseFileName(p, r.version, platform);
        const storageKey = releaseStorageKey(p.id, r.version, fileName);
        releaseFiles.push({
          id: seedIds.releaseFile(p.id, r.version, platform),
          releaseId: id,
          platform,
          fileName,
          storageKey,
          sizeBytes: parseSizeBytes(r.size),
          sha256: sampleSha256(storageKey),
        });
      }
    }
  }
  return { categories, products, plans, releases, releaseFiles };
}

function contentRows(now: Date): Pick<SeedPlanData, "faqs" | "coupons" | "templates"> {
  const faqSet = (page: string, list: readonly SeedFaq[]) =>
    list.map((f, i) => ({
      id: seedIds.faq(page, i + 1),
      page,
      question: f.question,
      answer: f.answer,
      href: f.href ?? null,
      published: true,
      sortOrder: i,
    }));
  const faqs = [
    ...faqSet("home", HOME_FAQS),
    ...faqSet("pricing", PRICING_FAQS),
    ...faqSet("support", SUPPORT_FAQS),
    ...PRODUCTS.flatMap((p) => faqSet(p.id, p.faqs)),
  ];
  const coupons = couponRules(now).map((c) => ({ ...c, productIds: [...c.productIds], planTypes: [...c.planTypes] }));
  const templates = NOTIFICATION_TEMPLATES.map((t, i) => ({
    id: t.id,
    name: t.name,
    channel: "email",
    subject: t.subject,
    body: t.body ?? templateBody(t.subject),
    active: t.active,
    updatedAt: new Date(now.getTime() - (3 + i * 4) * DAY_MS),
  }));
  return { faqs, coupons, templates };
}

function peopleRows(
  now: Date,
  ownerEmail: string,
  customerCreatedAt: readonly Date[],
): Pick<SeedPlanData, "users" | "accounts" | "members" | "inviteTokens" | "locations"> {
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const staffCreated = ago(STAFF_CREATED_AGO_DAYS);
  const users: SeedUser[] = [
    {
      password: "owner",
      row: {
        id: seedIds.user("owner"), kind: UserKind.STAFF, email: ownerEmail, name: OWNER_NAME, phone: null,
        emailVerifiedAt: staffCreated, twoStepEnabled: true, staffRole: StaffRole.OWNER, staffStatus: StaffStatus.ACTIVE,
        createdAt: staffCreated, lastActiveAt: null,
      },
    },
    ...SAMPLE_STAFF.map((s): SeedUser => {
      const invited = s.status === StaffStatus.INVITED;
      const createdAt = invited ? ago(INVITED_STAFF_CREATED_AGO_DAYS) : staffCreated;
      return {
        password: s.password,
        row: {
          id: seedIds.user(s.key), kind: UserKind.STAFF, email: s.email, name: s.name, phone: null,
          emailVerifiedAt: invited ? null : createdAt, twoStepEnabled: s.twoStepEnabled, staffRole: s.role,
          staffStatus: s.status, createdAt, lastActiveAt: s.lastActiveAgoDays === null ? null : ago(s.lastActiveAgoDays),
        },
      };
    }),
    ...SHARMA_MEMBERS.map((m): SeedUser => {
      const createdAt = ago(m.createdAgoDays);
      return {
        password: m.password,
        row: {
          id: seedIds.user(m.key), kind: UserKind.CUSTOMER, email: m.email, name: m.name, phone: m.phone,
          emailVerifiedAt: m.invited ? null : createdAt, twoStepEnabled: false, staffRole: null, staffStatus: null,
          createdAt, lastActiveAt: m.lastActiveAgoDays === null ? null : ago(m.lastActiveAgoDays),
        },
      };
    }),
    ...SAMPLE_CUSTOMERS.map((c, i): SeedUser => {
      const createdAt = customerCreatedAt[i] ?? ago(60);
      return {
        password: null,
        row: {
          id: seedIds.user(`c${i}`), kind: UserKind.CUSTOMER, email: customerEmail(c), name: c.name, phone: customerPhone(i),
          emailVerifiedAt: createdAt, twoStepEnabled: false, staffRole: null, staffStatus: null, createdAt, lastActiveAt: null,
        },
      };
    }),
  ];

  const sharmaId = seedIds.account(SHARMA_ACCOUNT.key);
  const accounts: SeedPlanData["accounts"] = [
    {
      id: sharmaId, legalName: SHARMA_ACCOUNT.legalName, gstin: SHARMA_ACCOUNT.gstin, address: SHARMA_ACCOUNT.address,
      city: SHARMA_ACCOUNT.city, state: SHARMA_ACCOUNT.state, pin: SHARMA_ACCOUNT.pin, createdAt: ago(SHARMA_ACCOUNT.createdAgoDays),
    },
    ...SAMPLE_CUSTOMERS.map((c, i) => ({
      id: seedIds.account(`c${i}`), legalName: c.business, gstin: c.gstin, address: customerAddress(c), city: c.city,
      state: c.state, pin: c.pin, createdAt: customerCreatedAt[i] ?? ago(60),
    })),
  ];
  // The Owner created Sharma Medicals (no invitedAt); everyone else joined, or is joining, by invitation. invitedAt is
  // what keeps a member's own guest orders out of an account they joined (lib/auth/flows/common.ts ownAccountId).
  const sharmaOwner = SHARMA_MEMBERS.find((m) => m.role === TeamRole.OWNER && !m.invited);
  if (!sharmaOwner) throw new Error("The Sharma Medicals sample needs an active Owner");
  const members: SeedPlanData["members"] = [
    ...SHARMA_MEMBERS.map((m) => ({
      id: seedIds.member(SHARMA_ACCOUNT.key, m.key), accountId: sharmaId, userId: seedIds.user(m.key), role: m.role,
      status: m.invited ? MemberStatus.INVITED : MemberStatus.ACTIVE, invitedAt: m === sharmaOwner ? null : ago(m.createdAgoDays),
      createdAt: ago(m.createdAgoDays),
    })),
    ...SAMPLE_CUSTOMERS.map((_, i) => ({
      id: seedIds.member(`c${i}`, `c${i}`), accountId: seedIds.account(`c${i}`), userId: seedIds.user(`c${i}`),
      role: TeamRole.OWNER, status: MemberStatus.ACTIVE, invitedAt: null, createdAt: customerCreatedAt[i] ?? ago(60),
    })),
  ];
  const inviteTokens: SeedInviteToken[] = SHARMA_MEMBERS.filter((m) => m.invited).map((m) => {
    const invitedAt = ago(m.createdAgoDays);
    return {
      id: seedIds.inviteToken(SHARMA_ACCOUNT.key, m.key), type: AuthTokenType.TEAM_INVITE, userId: seedIds.user(m.key),
      email: m.email, expiresAt: new Date(invitedAt.getTime() + INVITE_TTL_DAYS * DAY_MS), usedAt: null, attempts: 0,
      meta: { accountId: sharmaId, role: m.role, invitedById: seedIds.user(sharmaOwner.key) }, createdAt: invitedAt,
    };
  });
  const locations = SHARMA_LOCATIONS.map((l) => ({ id: seedIds.location(l.key), accountId: sharmaId, name: l.name }));
  return { users, accounts, members, inviteTokens, locations };
}

const ADMIN_STATUS: Record<AdminOrderDraft["status"], OrderStatus> = {
  paid: OrderStatus.PAID,
  pending: OrderStatus.PENDING,
  failed: OrderStatus.FAILED,
  refunded: OrderStatus.REFUNDED,
  canceled: OrderStatus.CANCELED,
};

/** Days between an admin sample payment and its refund (prototype: at + 3 days), capped at the run time. */
const REFUND_AFTER_DAYS = 3;
/** When the sample suspension happened (the prototype records none). */
const SUSPENDED_AGO_DAYS = 5;

function adminOrderDraft(d: AdminOrderDraft, now: Date, welcome: CouponRule, plans: ReadonlyMap<string, PricingPlan>): OrderDraft {
  const c = SAMPLE_CUSTOMERS[d.customerIndex];
  if (!c) throw new RangeError(`Unknown sample customer ${d.customerIndex}`);
  const status = ADMIN_STATUS[d.status];
  const settled = status === OrderStatus.PAID || status === OrderStatus.REFUNDED;
  const line = { planId: d.planId, qty: d.qty, kind: ItemKind.NEW, issuedLicenseId: d.license?.id ?? null };
  // Prototype defect fixed: WELCOME10 was applied to 15% of orders regardless of its minimum or dates.
  const couponOk =
    d.wantsCoupon && evaluateCoupon({ code: welcome.code, coupon: welcome, lines: [line], plans, now: d.createdAt }).ok;
  return {
    id: d.id,
    accountId: seedIds.account(`c${d.customerIndex}`),
    placedByUserId: seedIds.user(`c${d.customerIndex}`),
    billing: {
      name: c.name, email: customerEmail(c), phone: customerPhone(d.customerIndex), business: c.business,
      address: customerAddress(c), city: c.city, state: c.state, pin: c.pin, ...(c.gstin ? { gstin: c.gstin } : {}),
    },
    status,
    createdAt: d.createdAt,
    paidAt: settled ? d.createdAt : null,
    refundedAt:
      status === OrderStatus.REFUNDED
        ? new Date(Math.min(d.createdAt.getTime() + REFUND_AFTER_DAYS * DAY_MS, now.getTime()))
        : null,
    coupon: couponOk ? welcome : null,
    lines: [line],
    method: d.method,
  };
}

function adminLicenseGroup(d: AdminOrderDraft, bundle: OrderBundle, now: Date): LicenseGroup | null {
  if (!d.license || !bundle.order.paidAt) return null;
  const paidAt = new Date(bundle.order.paidAt);
  const plan = findPlan(d.planId);
  const product = findProduct(plan.productId);
  const qty = bundle.items[0]?.quantity ?? 1;
  const terms = newLicenseTerms(plan, qty, paidAt);
  const refunded = bundle.order.status === OrderStatus.REFUNDED;
  const refundedAt = bundle.order.refundedAt ? new Date(bundle.order.refundedAt) : null;
  const id = d.license.id;
  const license: SeedLicense = {
    key: { kind: "random", productCode: product.code },
    row: {
      id, accountId: bundle.order.accountId, productId: product.id, planId: plan.id, orderId: d.id, keyDeliveredAt: paidAt,
      status: refunded ? LicenseStatus.REVOKED : d.license.suspended ? LicenseStatus.SUSPENDED : terms.status,
      issuedAt: paidAt, expiresAt: terms.expiresAt, updatesUntil: terms.updatesUntil, deviceLimit: terms.deviceLimit,
      selfServiceResets: d.license.selfServiceResets, resetsYear: istCalendarYear(now), autoRenew: false,
      revokedAt: refunded ? refundedAt : null, revokedReason: refunded ? `Order ${d.id} refunded.` : null,
    },
  };
  const devices: DeviceRow[] = d.license.devices.map((dev) => ({
    id: seedIds.device(dev.key), licenseId: id, fingerprint: sampleFingerprint(dev.key), name: dev.name, os: dev.os,
    appVersion: null, locationId: null, activatedAt: dev.activatedAt, lastSeenAt: dev.lastSeenAt, deactivatedAt: null, deactivatedBy: null,
  }));
  const raw = [
    { at: paidAt, type: "issued", actor: "System", detail: `Order ${d.id}` },
    ...d.license.devices.map((dev) => ({ at: dev.activatedAt, type: "activated", actor: "Device", detail: dev.name })),
    ...(refunded && refundedAt ? [{ at: refundedAt, type: "revoked", actor: "System", detail: "Revoked after refund" }] : []),
    ...(d.license.suspended ? [{ at: maxDate(paidAt, new Date(now.getTime() - SUSPENDED_AGO_DAYS * DAY_MS)), type: "suspended", actor: "Sneha Patil", detail: "Suspended for review (sample)" }] : []),
  ];
  const events = raw.map((e, i) => ({ id: seedIds.licenseEvent(id, i + 1), licenseId: id, type: e.type, actor: e.actor, detail: e.detail, createdAt: e.at }));
  return { license, devices, events };
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Seed plan is missing the ${what}`);
  return value;
}

const asDate = (value: Date | string | null | undefined): Date | null => (value ? new Date(value) : null);
const idNumber = (id: string) => Number(id.replace(/^\D+/, ""));

/** The webhook samples point at AX-10294 when it was paid, otherwise at the newest paid sample order. */
export const WEBHOOK_SAMPLE_ORDER_ID = "AX-10294";

function webhookRows(now: Date, groups: readonly OrderGroup[]): Pick<SeedPlanData, "webhookEvents" | "webhookDeliveries"> & { orderId: string } {
  const paid = groups.filter((g) => g.bundle.order.status === OrderStatus.PAID && g.bundle.order.paidAt);
  const preferred = paid.find((g) => g.bundle.order.id === WEBHOOK_SAMPLE_ORDER_ID);
  const newest = [...paid].sort((a, b) => (asDate(b.bundle.order.paidAt)?.getTime() ?? 0) - (asDate(a.bundle.order.paidAt)?.getTime() ?? 0))[0];
  const target = preferred ?? newest;
  if (!target) throw new Error("No paid sample order for the webhook samples");
  const order = target.bundle.order;
  const at = asDate(order.paidAt) ?? now;
  // The duplicate arrives 0.01 day later, as in the prototype (ago(.2) then ago(.19)).
  const duplicateAt = new Date(at.getTime() + 0.01 * DAY_MS);
  const payload = {
    sample: true,
    event: "payment.captured",
    orderId: order.id,
    providerOrderId: target.bundle.payment.providerOrderId,
    providerPaymentId: target.bundle.payment.providerPaymentId ?? null,
    amountPaise: order.totalPaise,
    currency: "INR",
  };
  return {
    orderId: order.id,
    webhookEvents: [
      { provider: SAMPLE_PAYMENT_PROVIDER, id: "evt_7Qm2pX", type: "payment.captured", orderId: order.id, result: "fulfilled", payload, receivedAt: at, processedAt: at },
    ],
    webhookDeliveries: [
      { id: seedIds.webhookDelivery(1), provider: SAMPLE_PAYMENT_PROVIDER, eventId: "evt_7Qm2pX", type: "payment.captured", orderId: order.id, signatureOk: true, result: "fulfilled", replayedById: null, receivedAt: at },
      { id: seedIds.webhookDelivery(2), provider: SAMPLE_PAYMENT_PROVIDER, eventId: "evt_7Qm2pX", type: "payment.captured", orderId: order.id, signatureOk: true, result: "duplicate_ignored", replayedById: null, receivedAt: duplicateAt },
      // Body fields of a bad-signature delivery are unverified; they are kept only as the claimed values.
      { id: seedIds.webhookDelivery(3), provider: SAMPLE_PAYMENT_PROVIDER, eventId: "evt_9xk2Lr", type: "payment.captured", orderId: "AX-10301", signatureOk: false, result: "invalid_signature", replayedById: null, receivedAt: new Date(now.getTime() - DAY_MS) },
    ],
  };
}

function resolveAuditTarget(targetId: string): string {
  const [kind, ...rest] = targetId.split(":");
  if (kind === "staff" && rest[0]) return seedIds.user(rest[0]);
  if (kind === "release" && rest[0] && rest[1]) return seedIds.release(rest[0], rest[1]);
  return targetId;
}

/** Builds every seeded row for a run at `now`. `ownerEmail` is SEED_OWNER_EMAIL (the real Owner login). */
export function buildSeedPlan(input: { now: Date; ownerEmail: string }): SeedPlanData {
  const { now } = input;
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  const admin = generateAdminSample(now, new Set(PORTAL_ORDER_IDS));
  const portal = buildPortalSample(now);
  const people = peopleRows(now, ownerEmail, admin.customerCreatedAt);
  const clash = people.users.find((u) => u.row.id !== seedIds.user("owner") && u.row.email === ownerEmail);
  if (clash) throw new Error(`SEED_OWNER_EMAIL must not be one of the sample addresses (${ownerEmail}).`);

  const content = contentRows(now);
  const welcomeRule = couponRules(now).find((c) => c.code === "WELCOME10");
  if (!welcomeRule) throw new Error("WELCOME10 sample coupon is missing");
  const ctx: PricingContext = { plans: pricingPlans(), tax: taxSettingsForPricing(SEED_SETTINGS) };

  const adminById = new Map(admin.orders.map((d) => [d.id, d]));
  const drafts = [...portal.orders, ...admin.orders.map((d) => adminOrderDraft(d, now, welcomeRule, ctx.plans))].sort(
    (a, b) => idNumber(a.id) - idNumber(b.id),
  );
  const portalLicenses = new Map<string, LicenseGroup>();
  for (const license of portal.licenses) {
    portalLicenses.set(license.row.id, {
      license,
      devices: portal.devices.filter((d) => d.licenseId === license.row.id),
      events: portal.events.filter((e) => e.licenseId === license.row.id),
    });
  }

  const groups: OrderGroup[] = drafts.map((draft) => {
    const bundle = buildOrderBundle(draft, ctx);
    const adminDraft = adminById.get(draft.id);
    const licenses = adminDraft
      ? [adminLicenseGroup(adminDraft, bundle, now)].filter((g): g is LicenseGroup => g !== null)
      : [...portalLicenses.values()].filter((g) => g.license.row.orderId === draft.id);
    return { bundle, invoice: null, refund: null, licenses };
  });
  const standaloneLicenses = [...portalLicenses.values()].filter((g) => !g.license.row.orderId);

  // Invoice numbers per FY in paidAt order; credit notes per FY of the refund date.
  const settled = groups.filter((g) => g.bundle.order.status === OrderStatus.PAID || g.bundle.order.status === OrderStatus.REFUNDED);
  const invoicePlan = planInvoiceNumbers(
    settled.map((g) => ({ orderId: g.bundle.order.id, at: asDate(g.bundle.order.paidAt) ?? now })),
    { prefix: SEED_SETTINGS.tax.invoicePrefix, now },
  );
  const refundedGroups = groups.filter((g) => g.bundle.order.status === OrderStatus.REFUNDED);
  const creditPlan = planCreditNoteNumbers(
    refundedGroups.map((g) => ({ orderId: g.bundle.order.id, at: asDate(g.bundle.order.refundedAt) ?? now })),
    SEED_SETTINGS.tax.creditNotePrefix,
  );
  const { business } = SEED_SETTINGS;
  const seller = { legalName: business.legalName, gstin: business.gstin, address: business.address, city: business.city, state: business.state, pin: business.pin, sample: business.sample };
  for (const g of settled) {
    const orderId = g.bundle.order.id;
    g.invoice = {
      id: seedIds.invoice(orderId), number: required(invoicePlan.numbers.get(orderId), `invoice number for ${orderId}`), orderId, sac: SEED_SETTINGS.tax.sac,
      seller, issuedAt: asDate(g.bundle.order.paidAt) ?? now, pdfKey: null,
    };
  }
  for (const g of refundedGroups) {
    const orderId = g.bundle.order.id;
    g.refund = {
      id: seedIds.refund(orderId), paymentId: g.bundle.payment.id, providerRefundId: `rfnd_SAMPLE_${orderNumber(orderId)}`,
      amountPaise: g.bundle.order.totalPaise, reason: REFUND_REASON, createdById: seedIds.user("karan"),
      createdAt: asDate(g.bundle.order.refundedAt) ?? now, creditNoteNo: required(creditPlan.numbers.get(orderId), `credit note for ${orderId}`),
    };
  }

  const adminTickets: TicketRow[] = admin.tickets.map((t) => ({
    id: t.id, accountId: seedIds.account(`c${t.customerIndex}`), productId: t.productId, licenseId: null, subject: t.subject,
    priority: t.priority, status: t.status, assigneeId: t.assignee ? seedIds.user(t.assignee) : null, createdAt: t.createdAt, updatedAt: t.updatedAt,
  }));
  const adminMessages: TicketMessageRow[] = admin.tickets.map((t) => ({
    id: seedIds.ticketMessage(t.id, 1), ticketId: t.id, authorId: seedIds.user(`c${t.customerIndex}`), isStaff: false, internal: false,
    body: t.body, attachments: [], createdAt: t.createdAt,
  }));

  const webhooks = webhookRows(now, groups);
  const auditLogs: SeedPlanData["auditLogs"] = admin.audit.map((a, i) => ({
    id: seedIds.audit(i + 1),
    actorId: a.actor ? seedIds.user(a.actor) : null,
    actorRole: a.role,
    action: a.action,
    target: a.targetType === "webhook" && a.targetId === "evt_7Qm2pX" ? `payment.captured · ${webhooks.orderId}` : a.target,
    targetType: a.targetType,
    targetId: resolveAuditTarget(a.targetId),
    reason: a.reason,
    detail: a.detail,
    ipPrefix: a.ipPrefix,
    createdAt: a.createdAt,
  }));

  const allLicenseIds = [...groups.flatMap((g) => g.licenses), ...standaloneLicenses].map((l) => idNumber(l.license.row.id));
  const tickets = [...portal.tickets, ...adminTickets];
  const counters = [
    { key: "order", next: Math.max(COUNTER_START.order, ...groups.map((g) => idNumber(g.bundle.order.id) + 1)) },
    { key: "license", next: Math.max(COUNTER_START.license, ...allLicenseIds.map((n) => n + 1)) },
    { key: "ticket", next: Math.max(COUNTER_START.ticket, ...tickets.map((t) => idNumber(t.id) + 1)) },
    ...[...invoicePlan.next].map(([fy, next]) => ({ key: `invoice:${fy}`, next })),
    ...[...creditPlan.next].map(([fy, next]) => ({ key: `creditnote:${fy}`, next })),
  ];

  const twoStep = new Map(people.users.map((u) => [u.row.email, u.row.twoStepEnabled === true]));
  const logins: SeedLogin[] = people.users
    .filter((u): u is SeedUser & { password: "owner" | "demo" } => u.password !== null)
    .map((u) => ({
      who: u.row.kind === UserKind.STAFF ? `${u.row.name} (staff ${u.row.staffRole ?? ""})` : `${u.row.name} (customer, ${SHARMA_ACCOUNT.legalName})`,
      email: u.row.email,
      password: u.password,
      twoStep: twoStep.get(u.row.email) ?? false,
    }));

  return {
    now,
    settings: settingRows(),
    ...catalogRows(),
    ...content,
    ...people,
    orderGroups: groups,
    standaloneLicenses,
    tickets,
    ticketMessages: [...portal.messages, ...adminMessages],
    notifications: portal.notifications,
    activities: portal.activities,
    webhookEvents: webhooks.webhookEvents,
    webhookDeliveries: webhooks.webhookDeliveries,
    auditLogs,
    counters,
    logins,
  };
}

/** Every license group in the plan (order-issued and standalone). */
export function allLicenseGroups(plan: Pick<SeedPlanData, "orderGroups" | "standaloneLicenses">): LicenseGroup[] {
  return [...plan.orderGroups.flatMap((g) => g.licenses), ...plan.standaloneLicenses];
}
