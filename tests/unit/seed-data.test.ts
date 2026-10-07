import { describe, expect, it } from "vitest";
import { ICON_NAMES } from "@/components/icons/icon-names";
import type { PrismaClient } from "@/generated/prisma/client";
import { ItemKind, LicenseStatus, OrderStatus, PaymentStatus, PlanType } from "@/generated/prisma/enums";
import { SETTING_KEYS, settingSchemas } from "@/lib/config";
import { DAY_MS, endOfDayIST, fiscalYearLabel } from "@/lib/dates";
import { decryptLicenseKey, hashLicenseKey } from "@/lib/licensing/crypto";
import { LICENSE_KEY_RE, generateLicenseKey } from "@/lib/licensing/keys";
import { formatINR } from "@/lib/money";
import { gstinMatchesState, isValidGstin } from "@/lib/validation/gstin";
import { isIndianState } from "@/lib/validation/states";
import { ADMIN_ORDER_ITERATIONS, generateAdminSample } from "@/prisma/seed-data/admin";
import {
  CATEGORIES,
  PLANS,
  PRODUCTS,
  findProduct,
  parseSizeBytes,
  productContentSchema,
  releaseFileName,
  sampleSha256,
} from "@/prisma/seed-data/catalog";
import {
  COUPONS,
  HOME_FAQS,
  NOTIFICATION_TEMPLATES,
  PRICING_FAQS,
  SAMPLE_NOTICE_TEXT,
  SEED_SETTINGS,
  SUPPORT_FAQS,
  couponRules,
  templateBody,
} from "@/prisma/seed-data/content";
import { SEED_ID_PREFIX } from "@/prisma/seed-data/ids";
import {
  CURRENT_FY_LAST_INVOICE,
  documentNumber,
  planCreditNoteNumbers,
  planInvoiceNumbers,
} from "@/prisma/seed-data/invoices";
import { SAMPLE_CUSTOMERS, SAMPLE_STAFF, SHARMA_ACCOUNT, customerEmail, customerPhone } from "@/prisma/seed-data/people";
import { allLicenseGroups, buildSeedPlan } from "@/prisma/seed-data/plan";
import { PORTAL_LICENSE_KEYS, PORTAL_ORDER_IDS } from "@/prisma/seed-data/portal";
import { parkMiller } from "@/prisma/seed-data/prng";
import { SeedError, assertNoEmailConflicts, countRows, writeSeedPlan } from "@/prisma/seed-data/write";

/** 2026-10-06 12:00 IST, the prototype's "today" (FY 26-27). */
const NOW = new Date("2026-10-06T06:30:00.000Z");
const OWNER = "owner@axiomatic.example";
const plan = buildSeedPlan({ now: NOW, ownerEmail: OWNER });

const toDate = (v: Date | string | null | undefined): Date | null => (v ? new Date(v) : null);
const ms = (v: Date | string | null | undefined): number => toDate(v)?.getTime() ?? Number.NaN;
const orders = plan.orderGroups.map((g) => g.bundle.order);
const order = (id: string) => {
  const found = plan.orderGroups.find((g) => g.bundle.order.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};
const licenses = allLicenseGroups(plan);
const license = (id: string) => {
  const found = licenses.find((l) => l.license.row.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;

describe("sample license keys", () => {
  it("every fixed sample key matches LICENSE_KEY_RE and its product code", () => {
    for (const group of licenses) {
      if (group.license.key.kind !== "fixed") continue;
      expect(group.license.key.key).toMatch(LICENSE_KEY_RE);
      const product = PRODUCTS.find((p) => p.id === group.license.row.productId);
      expect(group.license.key.key.slice(0, 3)).toBe(product?.code);
    }
    expect(Object.values(PORTAL_LICENSE_KEYS)).toHaveLength(4);
    for (const key of Object.values(PORTAL_LICENSE_KEYS)) expect(key).toMatch(LICENSE_KEY_RE);
  });

  it("replaces the prototype trial key, which contains a banned I", () => {
    expect("GST-TRIA-L5HP-8QVM-R2KC").not.toMatch(LICENSE_KEY_RE);
    expect(PORTAL_LICENSE_KEYS["LIC-24112"]).toBe("GST-TR7A-L5HP-8QVM-R2KC");
  });

  it("generated keys are only requested for valid product codes", () => {
    for (const group of licenses) {
      if (group.license.key.kind === "random") expect(PRODUCTS.map((p) => p.code)).toContain(group.license.key.productCode);
    }
  });
});

describe("sample GSTINs and addresses", () => {
  it("are valid and registered in the state they are used with", () => {
    const pairs: [string, string][] = [
      [SHARMA_ACCOUNT.gstin, SHARMA_ACCOUNT.state],
      [SEED_SETTINGS.business.gstin, SEED_SETTINGS.business.state],
      ...SAMPLE_CUSTOMERS.flatMap((c): [string, string][] => (c.gstin ? [[c.gstin, c.state]] : [])),
    ];
    expect(pairs.length).toBe(9);
    for (const [gstin, state] of pairs) {
      expect(isValidGstin(gstin), gstin).toBe(true);
      expect(gstinMatchesState(gstin, state), `${gstin} in ${state}`).toBe(true);
    }
    for (const a of plan.accounts) {
      if (a.gstin) expect(gstinMatchesState(a.gstin, a.state ?? "")).toBe(true);
    }
  });

  it("uses known states, 6-digit PINs, valid mobiles and the prototype email pattern", () => {
    for (const c of SAMPLE_CUSTOMERS) {
      expect(isIndianState(c.state)).toBe(true);
      expect(c.pin).toMatch(/^\d{6}$/);
    }
    SAMPLE_CUSTOMERS.forEach((_, i) => expect(customerPhone(i)).toMatch(/^[6-9]\d{9}$/));
    expect(customerEmail({ name: "Arjun Menon", business: "Spice Route Kitchen" })).toBe("arjun@spiceroutekitchen.example");
    expect(customerEmail({ name: "Kavita Joshi", business: "Joshi & Sons Hardware" })).toBe("kavita@joshisonshardware.example");
    for (const o of orders) {
      const billing = o.billing as { state: string; pin: string; phone: string; gstin?: string };
      expect(isIndianState(billing.state)).toBe(true);
      expect(o.placeOfSupply).toBe(billing.state);
      expect(billing.pin).toMatch(/^\d{6}$/);
      expect(billing.phone).toMatch(/^[6-9]\d{9}$/);
      if (billing.gstin !== undefined) expect(gstinMatchesState(billing.gstin, billing.state)).toBe(true);
    }
  });

  it("every seeded email is unique and uses a reserved .example domain", () => {
    const emails = plan.users.map((u) => u.row.email);
    expect(unique(emails)).toBe(true);
    for (const e of emails) expect(e).toMatch(/^[a-z0-9.]+@[a-z0-9.]+\.example$/);
  });
});

describe("catalog", () => {
  it("has the prototype's 4 categories, 4 products and 16 plans with unique ids", () => {
    expect(CATEGORIES).toHaveLength(4);
    expect(PRODUCTS).toHaveLength(4);
    expect(PLANS).toHaveLength(16);
    expect(unique(PRODUCTS.map((p) => p.id))).toBe(true);
    expect(unique(PRODUCTS.map((p) => p.code))).toBe(true);
    expect(unique(PLANS.map((p) => p.id))).toBe(true);
    for (const p of PRODUCTS) expect(p.code).toMatch(/^[A-Z]{3}$/);
  });

  it("resolves every product, category, related and plan reference", () => {
    const productIds = new Set(PRODUCTS.map((p) => p.id));
    const categoryIds = new Set(CATEGORIES.map((c) => c.id));
    const planIds = new Set(PLANS.map((p) => p.id));
    for (const p of PRODUCTS) {
      expect(categoryIds.has(p.categoryId)).toBe(true);
      for (const r of p.relatedIds) {
        expect(productIds.has(r)).toBe(true);
        expect(r).not.toBe(p.id);
      }
    }
    for (const p of PLANS) expect(productIds.has(p.productId)).toBe(true);
    for (const c of COUPONS) for (const id of c.productIds) expect(productIds.has(id)).toBe(true);
    for (const f of plan.faqs) expect(["home", "pricing", "support", ...productIds]).toContain(f.page);
    for (const g of plan.orderGroups) for (const item of g.bundle.items) expect(planIds.has(item.planId)).toBe(true);
    for (const t of plan.tickets) if (t.productId) expect(productIds.has(t.productId)).toBe(true);
    const licenseIds = new Set(licenses.map((l) => l.license.row.id));
    for (const l of licenses) {
      const p = PLANS.find((x) => x.id === l.license.row.planId);
      expect(p?.productId).toBe(l.license.row.productId);
      if (l.license.row.orderId) expect(orders.some((o) => o.id === l.license.row.orderId)).toBe(true);
    }
    for (const g of plan.orderGroups) {
      for (const item of g.bundle.items) {
        if (item.targetLicenseId) expect(licenseIds.has(item.targetLicenseId)).toBe(true);
        if (item.issuedLicenseId) expect(licenseIds.has(item.issuedLicenseId)).toBe(true);
      }
    }
    for (const t of plan.tickets) if (t.licenseId) expect(licenseIds.has(t.licenseId)).toBe(true);
  });

  it("keeps sortOrder unique per product (plans) and per page (FAQs) in data-file order", () => {
    for (const p of PRODUCTS) {
      const rows = plan.plans.filter((x) => x.productId === p.id);
      expect(rows.map((x) => x.sortOrder)).toEqual(rows.map((_, i) => i));
    }
    const pages = new Set(plan.faqs.map((f) => f.page));
    for (const page of pages) {
      const sortOrders = plan.faqs.filter((f) => f.page === page).map((f) => f.sortOrder);
      expect(unique(sortOrders)).toBe(true);
    }
    expect(plan.categories.map((c) => c.sortOrder)).toEqual([0, 1, 2, 3]);
  });

  it("writes the Home category blurbs", () => {
    expect(plan.categories.map((c) => c.blurb)).toEqual([
      "Billing with batch and expiry tracking for chemists and medical stores.",
      "Table billing, KOTs and day-end reports for food businesses.",
      "GST invoicing, barcode billing and stock for general stores.",
      "Cheque printing and payment records for any business.",
    ]);
  });

  it("maps plan types, device limits and trial days like the prototype", () => {
    const byId = new Map(plan.plans.map((p) => [p.id, p]));
    for (const p of plan.plans) {
      if (p.type === PlanType.DEVICE_ADDON || p.type === PlanType.MAINTENANCE) expect(p.deviceLimit).toBeNull();
      else expect(p.deviceLimit).toBeGreaterThanOrEqual(1);
    }
    expect(byId.get("med-trial")?.trialDays).toBe(15);
    expect(byId.get("rst-trial")?.trialDays).toBe(7);
    expect(byId.get("rst-monthly")).toMatchObject({ interval: "MONTH", perUnit: "terminal", maxQty: 10 });
    expect(byId.get("gst-multi")).toMatchObject({ multiDevice: true, deviceLimit: 5, updatesMonths: 12 });
    expect(byId.get("chq-amc")).toMatchObject({ type: PlanType.MAINTENANCE, interval: "YEAR", includes: [] });
  });

  it("validates product content with the exported schema and only uses registered icons", () => {
    const icons = new Set<string>(ICON_NAMES);
    for (const p of PRODUCTS) {
      expect(productContentSchema.safeParse(p.content).success).toBe(true);
      expect(icons.has(p.icon), p.icon).toBe(true);
      for (const f of p.content.features) expect(icons.has(f.icon), f.icon).toBe(true);
    }
    for (const c of CATEGORIES) expect(icons.has(c.icon), c.icon).toBe(true);
    expect(productContentSchema.safeParse({ features: [], benefits: [], requirements: [] }).success).toBe(false);
    expect(productContentSchema.safeParse({ ...PRODUCTS[0]?.content, faqs: [] }).success).toBe(false);
  });

  it("builds one file per platform per release with sample checksums", () => {
    const expected = PRODUCTS.reduce((n, p) => n + p.releases.length * p.platforms.length, 0);
    expect(plan.releaseFiles).toHaveLength(expected);
    const first = plan.releaseFiles.find((f) => f.id === "seed_file_medical-billing_4.2.1_windows");
    expect(first).toMatchObject({
      fileName: "MedicalStoreBilling-4.2.1-setup.exe",
      storageKey: "releases/medical-billing/4.2.1/MedicalStoreBilling-4.2.1-setup.exe",
      sizeBytes: 148n * 1024n * 1024n,
      sha256: sampleSha256("releases/medical-billing/4.2.1/MedicalStoreBilling-4.2.1-setup.exe"),
    });
    expect(first?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(releaseFileName(findProduct("restaurant-billing"), "3.6.0", "android")).toBe("RestaurantBilling-3.6.0.apk");
    expect(parseSizeBytes("64 MB")).toBe(67108864n);
    expect(plan.releases.find((r) => r.id === "seed_rel_medical-billing_4.2.1")?.releasedAt).toEqual(new Date("2026-09-14T18:30:00.000Z"));
  });
});

describe("content and settings", () => {
  it("stores settings that pass the strict admin schemas and are marked sample", () => {
    expect(plan.settings.map((s) => s.key)).toEqual([...SETTING_KEYS]);
    for (const s of plan.settings) expect(settingSchemas[s.key].safeParse(s.value).success).toBe(true);
    expect(SEED_SETTINGS.business.sample).toBe(true);
    expect(SEED_SETTINGS.business.legalName).toContain("(placeholder)");
    expect(SEED_SETTINGS["content.banner"]).toEqual({ enabled: false, text: "Diwali offer: 20% off annual licenses with code DIWALI20" });
    expect(SEED_SETTINGS.tax).toEqual({ gstRatePct: 18, sac: "997331", priceDisplay: "exclusive", invoicePrefix: "AXS", creditNotePrefix: "AXC" });
    expect(SEED_SETTINGS.licensing).toEqual({ selfServiceResetsPerYear: 3, expiringDays: 60, downloadLinkMinutes: 10 });
  });

  it("uses the Site Header strip copy for the sample notice", () => {
    expect(SAMPLE_NOTICE_TEXT).toBe("Prototype · Prices, policies and screenshots are sample content and configurable");
    expect(SEED_SETTINGS["content.sampleNotice"]).toEqual({ enabled: true, text: SAMPLE_NOTICE_TEXT });
  });

  it("seeds 6 home, 6 pricing, 7 support and 3 FAQs per product, all published, without mandate promises", () => {
    expect(HOME_FAQS).toHaveLength(6);
    expect(PRICING_FAQS).toHaveLength(6);
    expect(SUPPORT_FAQS).toHaveLength(7);
    expect(plan.faqs).toHaveLength(19 + PRODUCTS.length * 3);
    expect(plan.faqs.every((f) => f.published)).toBe(true);
    for (const f of plan.faqs) expect(f.answer).not.toMatch(/mandate/i);
    expect(PRICING_FAQS[3]?.answer).toContain("can’t");
  });

  it("links every support FAQ to a guide and leaves the others without a link", () => {
    const support = plan.faqs.filter((f) => f.page === "support");
    expect(support.map((f) => f.href)).toEqual([
      "/docs/activate",
      "/docs/move",
      "/docs/renew",
      "/docs/activate",
      "/docs/backup",
      "/docs/troubleshooting",
      "/docs/troubleshooting",
    ]);
    expect(support[0]?.question).toBe("It says “activation limit reached”.");
    for (const f of plan.faqs) if (f.page !== "support") expect(f.href).toBeNull();
  });

  it("adds the Contact and Legal addresses to the business settings", () => {
    expect(SEED_SETTINGS.business).toMatchObject({
      supportEmail: "support@axiomatic.example",
      salesEmail: "sales@axiomatic.example",
      legalEmail: "legal@axiomatic.example",
      privacyEmail: "privacy@axiomatic.example",
    });
  });

  it("seeds the 16 templates with license_expired as a draft", () => {
    expect(NOTIFICATION_TEMPLATES).toHaveLength(16);
    expect(plan.templates.filter((t) => t.active === false).map((t) => t.id)).toEqual(["license_expired"]);
    expect(plan.templates[0]?.body).toBe(templateBody("Your order {{order_id}} is confirmed"));
    expect(templateBody("X")).toBe("Hi {{customer_name}},\n\nX.\n\nThanks,\nAxiomatic Software Solutions");
  });

  it("dates coupons relative to the run, except MONSOON25's fixed end", () => {
    const rules = new Map(couponRules(NOW).map((c) => [c.code, c]));
    expect([...rules.keys()]).toEqual(["WELCOME10", "ANNUAL500", "CHEQUE15", "DIWALI20", "MONSOON25", "FIRSTPC"]);
    expect(rules.get("MONSOON25")?.endsAt).toEqual(endOfDayIST("2026-08-31"));
    expect(ms(rules.get("MONSOON25")?.endsAt)).toBeLessThan(NOW.getTime());
    expect(ms(rules.get("DIWALI20")?.startsAt)).toBeGreaterThan(NOW.getTime());
    expect(rules.get("FIRSTPC")?.active).toBe(false);
    expect(rules.get("WELCOME10")?.startsAt).toEqual(new Date(NOW.getTime() - 90 * DAY_MS));
    // Run long after the fixed end date: the start still precedes the end.
    const late = couponRules(new Date("2028-01-01T00:00:00Z")).find((c) => c.code === "MONSOON25");
    expect(ms(late?.startsAt)).toBeLessThan(ms(late?.endsAt));
    expect(plan.coupons.map((c) => c.redemptions)).toEqual([14, 31, 6, 0, 88, 3]);
  });
});

describe("invoice numbering", () => {
  const invoices = plan.orderGroups.flatMap((g) => (g.invoice ? [{ number: g.invoice.number, paidAt: ms(g.bundle.order.paidAt) }] : []));
  const counter = (key: string) => plan.counters.find((c) => c.key === key)?.next;

  it("gives every paid or refunded order exactly one invoice, and nothing else", () => {
    for (const g of plan.orderGroups) {
      const settled = g.bundle.order.status === OrderStatus.PAID || g.bundle.order.status === OrderStatus.REFUNDED;
      expect(g.invoice !== null).toBe(settled);
      if (g.invoice) expect(ms(g.invoice.issuedAt)).toBe(ms(g.bundle.order.paidAt));
    }
    expect(unique(invoices.map((i) => i.number))).toBe(true);
  });

  it("is gap-free per FY, follows paidAt order and ends at 1180 for 26-27", () => {
    const byFy = new Map<string, { n: number; paidAt: number }[]>();
    for (const inv of invoices) {
      const m = /^AXS\/(\d{2}-\d{2})\/(\d{4})$/.exec(inv.number);
      expect(m, inv.number).not.toBeNull();
      const fy = m?.[1] ?? "";
      expect(fy).toBe(fiscalYearLabel(new Date(inv.paidAt)));
      byFy.set(fy, [...(byFy.get(fy) ?? []), { n: Number(m?.[2]), paidAt: inv.paidAt }]);
    }
    for (const [fy, list] of byFy) {
      list.sort((a, b) => a.n - b.n);
      list.forEach((x, i) => {
        if (i > 0) {
          expect(x.n).toBe((list[i - 1]?.n ?? 0) + 1);
          expect(x.paidAt).toBeGreaterThanOrEqual(list[i - 1]?.paidAt ?? 0);
        }
      });
      expect(counter(`invoice:${fy}`)).toBe((list.at(-1)?.n ?? 0) + 1);
    }
    expect(byFy.get("26-27")?.at(-1)?.n).toBe(CURRENT_FY_LAST_INVOICE);
    expect(counter("invoice:26-27")).toBe(1181);
  });

  it("keeps the prototype numbers of the earlier portal orders", () => {
    expect(order("AX-10198").invoice?.number).toBe("AXS/25-26/1104");
    expect(order("AX-10102").invoice?.number).toBe("AXS/24-25/0988");
  });

  it("numbers synthetic entries per FY with anchors, in date order", () => {
    const d = (s: string) => new Date(s);
    const result = planInvoiceNumbers(
      [
        { orderId: "B", at: d("2026-06-01T00:00:00Z") },
        { orderId: "A", at: d("2026-05-01T00:00:00Z") },
        { orderId: "X", at: d("2025-06-01T00:00:00Z") },
        { orderId: "Y", at: d("2025-07-01T00:00:00Z") },
        { orderId: "Z", at: d("2024-06-01T00:00:00Z") },
        // 1 April 2026 00:10 IST is already FY 26-27.
        { orderId: "C", at: d("2026-03-31T18:40:00Z") },
      ],
      { prefix: "AXS", now: NOW, anchors: { Y: 500 } },
    );
    expect(Object.fromEntries(result.numbers)).toEqual({
      C: "AXS/26-27/1178",
      A: "AXS/26-27/1179",
      B: "AXS/26-27/1180",
      X: "AXS/25-26/0499",
      Y: "AXS/25-26/0500",
      Z: "AXS/24-25/0001",
    });
    expect(Object.fromEntries(result.next)).toEqual({ "26-27": 1181, "25-26": 501, "24-25": 2 });
    expect(planInvoiceNumbers([], { prefix: "AXS", now: NOW }).next.get("26-27")).toBe(1181);
    expect(() => planInvoiceNumbers([{ orderId: "A", at: NOW }, { orderId: "A", at: NOW }], { prefix: "AXS", now: NOW })).toThrow();
    expect(documentNumber("AXC", "26-27", 7)).toBe("AXC/26-27/0007");
  });

  it("numbers credit notes from 0001 per FY of the refund", () => {
    const refunds = plan.orderGroups.flatMap((g) => (g.refund ? [g.refund] : []));
    expect(refunds).toHaveLength(orders.filter((o) => o.status === OrderStatus.REFUNDED).length);
    const byFy = new Map<string, number[]>();
    for (const r of refunds) {
      const m = /^AXC\/(\d{2}-\d{2})\/(\d{4})$/.exec(r.creditNoteNo ?? "");
      expect(m).not.toBeNull();
      expect(m?.[1]).toBe(fiscalYearLabel(new Date(ms(r.createdAt))));
      byFy.set(m?.[1] ?? "", [...(byFy.get(m?.[1] ?? "") ?? []), Number(m?.[2])]);
    }
    for (const [fy, list] of byFy) {
      expect([...list].sort((a, b) => a - b)).toEqual(list.map((_, i) => i + 1));
      expect(counter(`creditnote:${fy}`)).toBe(list.length + 1);
    }
    const synthetic = planCreditNoteNumbers([{ orderId: "A", at: NOW }], "AXC");
    expect(synthetic.numbers.get("A")).toBe("AXC/26-27/0001");
  });
});

describe("admin sample generator (Park-Miller, seed 42)", () => {
  it("reproduces the minimal standard sequence", () => {
    const rng = parkMiller(42);
    expect(rng.next()).toBe((705894 - 1) / 2147483646);
    expect(rng.next()).toBe((1126542223 - 1) / 2147483646);
    expect(() => parkMiller(0)).toThrow(RangeError);
  });

  it("is deterministic and independent of the run time except for the dates", () => {
    const a = generateAdminSample(NOW, new Set(PORTAL_ORDER_IDS));
    expect(generateAdminSample(NOW, new Set(PORTAL_ORDER_IDS))).toEqual(a);
    const later = new Date(NOW.getTime() + 123.4 * DAY_MS);
    const b = generateAdminSample(later, new Set(PORTAL_ORDER_IDS));
    const shape = (s: typeof a) =>
      s.orders.map((o) => [o.id, o.customerIndex, o.planId, o.qty, o.status, o.wantsCoupon, o.method, o.license?.id, o.license?.suspended, o.license?.devices.length]);
    expect(shape(b)).toEqual(shape(a));
    a.orders.forEach((o, i) => expect(ms(b.orders[i]?.createdAt) - ms(o.createdAt)).toBeCloseTo(123.4 * DAY_MS, -1));
    expect(b.tickets.map((t) => [t.id, t.status, t.assignee, t.productId])).toEqual(a.tickets.map((t) => [t.id, t.status, t.assignee, t.productId]));
  });

  it("matches the prototype distribution and never collides with portal orders", () => {
    const s = generateAdminSample(NOW, new Set(PORTAL_ORDER_IDS));
    expect(s.orders).toHaveLength(ADMIN_ORDER_ITERATIONS);
    expect(unique(s.orders.map((o) => o.id))).toBe(true);
    const counts = s.orders.reduce<Record<string, number>>((m, o) => ({ ...m, [o.status]: (m[o.status] ?? 0) + 1 }), {});
    expect(counts).toEqual({ paid: 56, refunded: 4, failed: 3, pending: 1 });
    expect(s.orders.filter((o) => o.license?.suspended).map((o) => o.license?.id)).toEqual(["LIC-23734"]);
    for (const o of s.orders) {
      expect(PORTAL_ORDER_IDS).not.toContain(o.id);
      const n = Number(o.id.slice(3));
      expect(n).toBeGreaterThanOrEqual(10120 + o.index * 3);
      expect(n).toBeLessThanOrEqual(10122 + o.index * 3);
      expect(o.license === null).toBe(o.status !== "paid" && o.status !== "refunded");
    }
    // A reserved id is skipped after its draws, exactly like the prototype (later draws shift accordingly).
    const reserved = generateAdminSample(NOW, new Set([...PORTAL_ORDER_IDS, "AX-10122"]));
    expect(reserved.orders.some((o) => o.id === "AX-10122")).toBe(false);
    expect(reserved.orders[0]?.index).toBe(1);
    expect(reserved.orders.length).toBeLessThan(ADMIN_ORDER_ITERATIONS);
    for (const o of reserved.orders) expect(PORTAL_ORDER_IDS).not.toContain(o.id);
    expect(s.tickets.map((t) => t.id)).toEqual(Array.from({ length: 10 }, (_, i) => `T-${3000 + i}`));
    expect(s.audit).toHaveLength(12);
  });

  it("produces the same plan twice for the same run time", () => {
    expect(buildSeedPlan({ now: NOW, ownerEmail: OWNER })).toEqual(plan);
  });
});

describe("orders, payments and licenses", () => {
  it("prices every order with consistent GST (intra-state only for Maharashtra)", () => {
    for (const g of plan.orderGroups) {
      const o = g.bundle.order;
      const items = g.bundle.items;
      const sum = (pick: (i: (typeof items)[number]) => number | undefined) => items.reduce((n, i) => n + (pick(i) ?? 0), 0);
      expect(sum((i) => i.taxablePaise)).toBe(o.taxablePaise);
      expect(sum((i) => i.discountPaise)).toBe(o.discountPaise ?? 0);
      const gst = (o.cgstPaise ?? 0) + (o.sgstPaise ?? 0) + (o.igstPaise ?? 0);
      expect(sum((i) => i.taxPaise)).toBe(gst);
      expect(gst).toBe(Math.round((o.taxablePaise * 18) / 100));
      expect(o.totalPaise).toBe(o.taxablePaise + gst);
      expect(o.subtotalPaise - (o.discountPaise ?? 0)).toBe(o.taxablePaise);
      const intra = o.placeOfSupply === "Maharashtra";
      expect((o.igstPaise ?? 0) === 0).toBe(intra || gst === 0);
      expect(g.bundle.payment.amountPaise).toBe(o.totalPaise);
    }
  });

  it("applies WELCOME10 only where it was valid: minimum met and within its dates", () => {
    const welcome = couponRules(NOW).find((c) => c.code === "WELCOME10");
    const withCoupon = plan.orderGroups.filter((g) => g.bundle.order.couponCode);
    expect(withCoupon.length).toBeGreaterThan(0);
    for (const g of withCoupon) {
      const o = g.bundle.order;
      expect(o.couponCode).toBe("WELCOME10");
      expect(o.subtotalPaise).toBeGreaterThanOrEqual(welcome?.minSubtotal ?? Number.POSITIVE_INFINITY);
      expect(ms(o.createdAt)).toBeGreaterThanOrEqual(ms(welcome?.startsAt));
      expect(o.discountPaise).toBe(Math.round(o.subtotalPaise / 10));
      const settled = o.status === OrderStatus.PAID || o.status === OrderStatus.REFUNDED;
      expect(g.bundle.redemption !== null).toBe(settled);
    }
    for (const g of plan.orderGroups) if (!g.bundle.order.couponCode) expect(g.bundle.order.discountPaise).toBe(0);
  });

  it("reproduces the portal orders and their amounts", () => {
    const o10198 = order("AX-10198");
    expect(o10198.bundle.order.subtotalPaise).toBe(999700);
    expect(o10198.bundle.items.map((i) => [i.planId, i.kind, i.quantity, i.targetLicenseId, i.issuedLicenseId])).toEqual([
      ["med-annual", ItemKind.NEW, 1, null, "LIC-24017"],
      ["med-device", ItemKind.ADDON, 2, "LIC-24017", null],
    ]);
    expect(license("LIC-24017").license.row.deviceLimit).toBe(3);
    expect(ms(license("LIC-24017").license.row.expiresAt)).toBe(NOW.getTime() + 41 * DAY_MS);
    const o10288 = order("AX-10288").bundle.order;
    expect(o10288.status).toBe(OrderStatus.REFUNDED);
    expect(formatINR(o10288.totalPaise)).toBe("₹4,128.82");
    expect(order("AX-10288").refund).toMatchObject({ amountPaise: o10288.totalPaise, createdById: "seed_user_karan" });
    expect(plan.activities.find((a) => a.action === "Refund processed")?.target).toBe(`AX-10288 · ${formatINR(o10288.totalPaise)}`);
    expect(plan.notifications.find((n) => n.kind === "billing")?.body).toContain(formatINR(o10288.totalPaise));
    expect(plan.auditLogs.find((a) => a.action === "Issued refund")?.detail).toBe(`${formatINR(o10288.totalPaise)} · customer request`);
  });

  it("links payments, licenses and refunds to order status", () => {
    const paymentStatus: Partial<Record<OrderStatus, PaymentStatus>> = {
      PAID: PaymentStatus.CAPTURED, REFUNDED: PaymentStatus.REFUNDED, FAILED: PaymentStatus.FAILED, PENDING: PaymentStatus.PENDING,
    };
    for (const g of plan.orderGroups) {
      const o = g.bundle.order;
      expect(g.bundle.payment.status).toBe(paymentStatus[o.status ?? OrderStatus.AWAITING_PAYMENT]);
      expect(g.bundle.payment.providerOrderId).toMatch(/^order_SAMPLE_\d+$/);
      const settled = o.status === OrderStatus.PAID || o.status === OrderStatus.REFUNDED;
      const newItems = g.bundle.items.filter((i) => i.kind === ItemKind.NEW);
      expect(g.licenses.length).toBe(settled ? newItems.length : 0);
      expect(g.refund !== null).toBe(o.status === OrderStatus.REFUNDED);
      for (const l of g.licenses) {
        expect(ms(l.license.row.issuedAt)).toBe(ms(o.paidAt));
        if (o.status === OrderStatus.REFUNDED) {
          expect(l.license.row.status).toBe(LicenseStatus.REVOKED);
          expect(l.license.row.revokedReason).toBeTruthy();
          expect(l.devices.every((d) => d.deactivatedAt === null)).toBe(true);
        }
      }
    }
    const statuses = licenses.map((l) => l.license.row.status);
    expect(statuses.filter((s) => s === LicenseStatus.SUSPENDED).length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === LicenseStatus.TRIAL)).toHaveLength(1);
  });

  it("uses lib/licensing/terms: annual +365 days, one-time 12 months of updates, device limits", () => {
    for (const l of licenses) {
      const p = PLANS.find((x) => x.id === l.license.row.planId);
      const issued = ms(l.license.row.issuedAt);
      if (p?.type === PlanType.ANNUAL) expect(ms(l.license.row.expiresAt)).toBe(issued + 365 * DAY_MS);
      if (p?.type === PlanType.ONE_TIME) {
        expect(l.license.row.expiresAt).toBeNull();
        expect(ms(l.license.row.updatesUntil)).toBeGreaterThan(issued + 364 * DAY_MS);
      }
      expect(l.devices.filter((d) => !d.deactivatedAt).length).toBeLessThanOrEqual(l.license.row.deviceLimit);
      expect(l.license.row.selfServiceResets ?? 0).toBeLessThanOrEqual(3);
    }
  });

  it("never dates activity in the future and keeps device timelines ordered", () => {
    const now = NOW.getTime();
    for (const l of licenses) {
      for (const d of l.devices) {
        expect(ms(d.activatedAt)).toBeLessThanOrEqual(ms(d.lastSeenAt));
        expect(ms(d.lastSeenAt)).toBeLessThanOrEqual(now);
      }
      for (const e of l.events) expect(ms(e.createdAt)).toBeLessThanOrEqual(now);
    }
    for (const o of orders) {
      expect(ms(o.createdAt)).toBeLessThanOrEqual(now);
      if (o.refundedAt) expect(ms(o.refundedAt)).toBeLessThanOrEqual(now);
    }
    for (const t of plan.tickets) expect(ms(t.updatedAt)).toBeLessThanOrEqual(now);
    for (const m of plan.ticketMessages) expect(ms(m.createdAt)).toBeLessThanOrEqual(now);
  });

  it("drops validation events and keeps the portal history otherwise", () => {
    expect(license("LIC-24017").events.map((e) => e.type)).toEqual(["issued", "devices_added", "activated", "activated", "deactivated", "activated"]);
    expect(licenses.flatMap((l) => l.events).some((e) => /validat/i.test(e.type))).toBe(false);
    expect(license("LIC-24112").events.map((e) => e.type)).toEqual(["trial_started", "trial_ended"]);
  });
});

describe("ids, people and counters", () => {
  it("gives every row a unique deterministic seed id", () => {
    const groups: Record<string, readonly { id: string }[]> = {
      users: plan.users.map((u) => u.row),
      accounts: plan.accounts,
      members: plan.members,
      inviteTokens: plan.inviteTokens,
      items: plan.orderGroups.flatMap((g) => g.bundle.items),
      devices: licenses.flatMap((l) => l.devices),
      events: licenses.flatMap((l) => l.events),
      messages: plan.ticketMessages,
      faqs: plan.faqs,
      audit: plan.auditLogs,
      deliveries: plan.webhookDeliveries,
    };
    for (const [name, rows] of Object.entries(groups)) {
      expect(unique(rows.map((r) => r.id)), name).toBe(true);
      for (const r of rows) expect(r.id.startsWith(SEED_ID_PREFIX), `${name} ${r.id}`).toBe(true);
    }
    expect(unique(orders.map((o) => o.id))).toBe(true);
    expect(unique(licenses.map((l) => l.license.row.id))).toBe(true);
  });

  it("starts counters above every seeded id", () => {
    const next = (key: string) => plan.counters.find((c) => c.key === key)?.next ?? 0;
    expect(next("order")).toBeGreaterThanOrEqual(10312);
    for (const o of orders) expect(Number(o.id.slice(3))).toBeLessThan(next("order"));
    expect(next("license")).toBe(24200);
    for (const l of licenses) expect(Number(l.license.row.id.slice(4))).toBeLessThan(24200);
    expect(next("ticket")).toBe(3019);
  });

  it("gives passwords only to the env owner and the demo logins", () => {
    const withPassword = plan.users.filter((u) => u.password !== null).map((u) => [u.row.email, u.password]);
    expect(withPassword).toEqual([
      [OWNER, "owner"],
      ["vikram@axiomatic.example", "demo"],
      ["sneha@axiomatic.example", "demo"],
      ["karan@axiomatic.example", "demo"],
      ["priya@sharmamedicals.example", "demo"],
      ["rohan@sharmamedicals.example", "demo"],
      ["kavya@sharmamedicals.example", "demo"],
    ]);
    expect(SAMPLE_STAFF.find((s) => s.key === "karan")?.twoStepEnabled).toBe(true);
    expect(plan.logins.map((l) => l.email)).toEqual(withPassword.map(([email]) => email));
  });

  it("keeps the pending invitation open (Invited 3d ago) and marks who joined by invitation", () => {
    const member = (key: string) => plan.members.find((m) => m.id === `seed_mem_${SHARMA_ACCOUNT.key}_${key}`);
    expect(member("priya")?.invitedAt ?? null).toBeNull();
    const invitedAgoDays = { rohan: 400, kavya: 300, joshica: 3 };
    for (const [key, days] of Object.entries(invitedAgoDays)) {
      expect(member(key)?.invitedAt, key).toEqual(new Date(NOW.getTime() - days * DAY_MS));
    }
    expect(plan.inviteTokens).toEqual([
      {
        id: `seed_invite_${SHARMA_ACCOUNT.key}_joshica`,
        type: "TEAM_INVITE",
        userId: "seed_user_joshica",
        email: "accounts@joshica.example",
        expiresAt: new Date(NOW.getTime() + 4 * DAY_MS),
        usedAt: null,
        attempts: 0,
        meta: { accountId: `seed_acct_${SHARMA_ACCOUNT.key}`, role: "VIEWER", invitedById: "seed_user_priya" },
        createdAt: member("joshica")?.invitedAt,
      },
    ]);
    expect(Object.keys(plan.inviteTokens[0] ?? {})).not.toContain("codeHash");
  });

  it("normalises the owner email and refuses a sample address", () => {
    expect(buildSeedPlan({ now: NOW, ownerEmail: "  Boss@Example.COM " }).users[0]?.row.email).toBe("boss@example.com");
    expect(() => buildSeedPlan({ now: NOW, ownerEmail: "anita@axiomatic.example" })).toThrow(/sample addresses/);
  });

  it("points the webhook samples at a paid order", () => {
    const evt = plan.webhookEvents[0];
    expect(evt?.orderId).toBe("AX-10294");
    expect(order("AX-10294").bundle.order.status).toBe(OrderStatus.PAID);
    expect(plan.webhookDeliveries.map((d) => [d.eventId, d.result, d.signatureOk])).toEqual([
      ["evt_7Qm2pX", "fulfilled", true],
      ["evt_7Qm2pX", "duplicate_ignored", true],
      ["evt_9xk2Lr", "invalid_signature", false],
    ]);
    const system = plan.auditLogs.filter((a) => a.actorRole === "system");
    expect(system.every((a) => a.actorId === null && a.ipPrefix === null)).toBe(true);
  });
});


// ---------- Write path (prisma/seed-data/write.ts) against a recording fake client ----------

type Call = { model: string; method: string; args: Record<string, unknown> };
type Existing = {
  invoices?: { id: string; number: string }[];
  refunds?: { id: string; creditNoteNo: string | null }[];
  users?: { id: string; email: string }[];
  counters?: Record<string, number>;
};

/** Just enough of PrismaClient for the seed writer: records every model call, runs transactions inline. */
function fakeDb(existing: Existing = {}): { client: PrismaClient; calls: Call[] } {
  const calls: Call[] = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) => {
          if (typeof method !== "string" || method === "then") return undefined;
          return async (args: Record<string, unknown> = {}) => {
            calls.push({ model: name, method, args });
            if (method === "findMany") {
              if (name === "invoice") return existing.invoices ?? [];
              if (name === "refund") return existing.refunds ?? [];
              if (name === "user") return existing.users ?? [];
              return [];
            }
            if (method === "findUnique" && name === "counter") {
              const key = (args.where as { key: string }).key;
              const next = existing.counters?.[key];
              return next === undefined ? null : { key, next };
            }
            if (method === "count") return 0;
            return null;
          };
        },
      },
    );
  const client: object = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (prop === "$transaction") return async (fn: (tx: unknown) => Promise<unknown>) => fn(client);
        return model(prop);
      },
    },
  );
  return { client: client as PrismaClient, calls };
}

const PEPPER = "seed-test-pepper-0123456789abcdef";
const ENC_KEY = Buffer.alloc(32, 7);
const FAKE_HASH = "$argon2id$v=19$m=19456,t=2,p=1$fake";

function writeSecrets() {
  const rng = parkMiller(7);
  return {
    passwordHashes: new Map(plan.users.map((u) => [u.row.id, u.password === null ? null : FAKE_HASH])),
    licenseKeys: { pepper: PEPPER, encKey: ENC_KEY },
    generateKey: (code: string) => generateLicenseKey(code, (max) => Math.floor(rng.next() * max)),
  };
}

const upserts = (calls: Call[], model: string) => calls.filter((c) => c.model === model && c.method === "upsert");
const firstIndex = (calls: Call[], model: string) => calls.findIndex((c) => c.model === model && c.method === "upsert");
const lastIndex = (calls: Call[], model: string) => calls.map((c) => `${c.model}.${c.method}`).lastIndexOf(`${model}.upsert`);
const json = (value: unknown) => JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

describe("seed writer", () => {
  it("upserts every planned row once, in foreign-key order", async () => {
    const { client, calls } = fakeDb();
    await writeSeedPlan(client, plan, writeSecrets());
    for (const c of calls.filter((x) => x.method === "upsert")) {
      expect(Object.keys(c.args).sort(), c.model).toEqual(["create", "update", "where"]);
    }
    expect(upserts(calls, "user")).toHaveLength(plan.users.length);
    expect(upserts(calls, "order")).toHaveLength(plan.orderGroups.length);
    expect(upserts(calls, "license")).toHaveLength(licenses.length);
    expect(upserts(calls, "deviceActivation")).toHaveLength(licenses.reduce((n, l) => n + l.devices.length, 0));
    expect(upserts(calls, "licenseEvent")).toHaveLength(licenses.reduce((n, l) => n + l.events.length, 0));
    expect(upserts(calls, "invoice")).toHaveLength(plan.orderGroups.filter((g) => g.invoice).length);
    expect(upserts(calls, "counter")).toHaveLength(plan.counters.length);
    expect(upserts(calls, "authToken")).toHaveLength(plan.inviteTokens.length);
    const before = (a: string, b: string) => expect(lastIndex(calls, a), `${a} before ${b}`).toBeLessThan(firstIndex(calls, b));
    before("plan", "order");
    before("user", "order");
    before("user", "authToken");
    before("accountMember", "authToken");
    before("businessAccount", "order");
    before("location", "deviceActivation");
    before("user", "supportTicket");
    before("supportTicket", "ticketMessage");
    before("coupon", "couponRedemption");
    expect(firstIndex(calls, "license")).toBeLessThan(firstIndex(calls, "deviceActivation"));
    expect(firstIndex(calls, "payment")).toBeLessThan(firstIndex(calls, "refund"));
  });

  it("never writes a plaintext key or password, and seals fixed and random keys correctly", async () => {
    const { client, calls } = fakeDb();
    await writeSeedPlan(client, plan, writeSecrets());
    const written = json(calls);
    for (const key of Object.values(PORTAL_LICENSE_KEYS)) {
      expect(written).not.toContain(key);
      expect(written).not.toContain(key.replace(/-/g, ""));
    }
    for (const u of upserts(calls, "user")) {
      const create = u.args.create as { passwordHash: string | null };
      expect([null, FAKE_HASH]).toContain(create.passwordHash);
    }
    for (const c of upserts(calls, "license")) {
      const create = c.args.create as { id: string; keyHash: string; keyCiphertext: string; keyLast4: string };
      const update = c.args.update as Record<string, unknown>;
      const fixed = PORTAL_LICENSE_KEYS[create.id];
      const key = decryptLicenseKey(create.keyCiphertext, ENC_KEY);
      expect(key).toMatch(LICENSE_KEY_RE);
      expect(create.keyHash).toBe(hashLicenseKey(key, PEPPER));
      expect(create.keyLast4).toBe(key.slice(-4));
      expect(written).not.toContain(`"${key}"`);
      if (fixed) {
        expect(key).toBe(fixed);
        expect(update.keyHash).toBe(create.keyHash);
      } else {
        // Generated keys are kept on later runs: the update never touches them.
        expect(update).not.toHaveProperty("keyHash");
        expect(update).not.toHaveProperty("keyCiphertext");
        expect(update).not.toHaveProperty("keyLast4");
      }
    }
  });

  it("stores invitation links with a fresh unusable hash and voids the person's other open links", async () => {
    const first = fakeDb();
    await writeSeedPlan(first.client, plan, writeSecrets());
    const second = fakeDb();
    await writeSeedPlan(second.client, plan, writeSecrets());
    const tokenRow = (calls: Call[]) => upserts(calls, "authToken")[0]?.args as { where: { id: string }; create: { codeHash: string }; update: { codeHash: string } };
    const a = tokenRow(first.calls);
    const b = tokenRow(second.calls);
    expect(a.where.id).toBe(`seed_invite_${SHARMA_ACCOUNT.key}_joshica`);
    expect(a.create.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.update.codeHash).toBe(a.create.codeHash);
    expect(b.create.codeHash).not.toBe(a.create.codeHash);
    const voided = first.calls.filter((c) => c.model === "authToken" && c.method === "updateMany");
    expect(voided.map((c) => c.args)).toEqual([
      {
        where: {
          type: "TEAM_INVITE",
          userId: "seed_user_joshica",
          usedAt: null,
          id: { not: `seed_invite_${SHARMA_ACCOUNT.key}_joshica` },
          meta: { path: ["accountId"], equals: `seed_acct_${SHARMA_ACCOUNT.key}` },
        },
        data: { usedAt: NOW },
      },
    ]);
    expect(first.calls.indexOf(voided[0] as Call)).toBeLessThan(first.calls.findIndex((c) => c.model === "authToken" && c.method === "upsert"));
  });

  it("never lowers a counter the running app has already advanced", async () => {
    const { client, calls } = fakeDb({ counters: { order: 20000, "invoice:26-27": 1100 } });
    await writeSeedPlan(client, plan, writeSecrets());
    const next = (key: string) =>
      (upserts(calls, "counter").find((c) => (c.args.where as { key: string }).key === key)?.args.update as { next: number }).next;
    expect(next("order")).toBe(20000);
    expect(next("invoice:26-27")).toBe(1181);
    expect(next("license")).toBe(24200);
  });

  it("parks invoice and credit-note numbers that change before renumbering", async () => {
    const changed = order("AX-10198").invoice?.id ?? "";
    const same = order("AX-10102").invoice;
    const refund = order("AX-10288").refund;
    const { client, calls } = fakeDb({
      invoices: [
        { id: changed, number: "AXS/25-26/9999" },
        { id: same?.id ?? "", number: same?.number ?? "" },
      ],
      refunds: [{ id: refund?.id ?? "", creditNoteNo: "AXC/25-26/0042" }],
    });
    await writeSeedPlan(client, plan, writeSecrets());
    const parked = calls.filter((c) => c.method === "update");
    expect(parked.map((c) => [c.model, (c.args.where as { id: string }).id, c.args.data])).toEqual([
      ["invoice", changed, { number: `SEEDTMP-${changed}` }],
      ["refund", refund?.id, { creditNoteNo: `SEEDTMP-${refund?.id ?? ""}` }],
    ]);
    const parkIndex = calls.indexOf(parked[0] as Call);
    expect(parkIndex).toBeLessThan(firstIndex(calls, "invoice"));
  });

  it("refuses to take over an email held by a user the seed did not create", async () => {
    const taken = fakeDb({ users: [{ id: "ckuser123", email: "priya@sharmamedicals.example" }] });
    await expect(assertNoEmailConflicts(taken.client, plan)).rejects.toBeInstanceOf(SeedError);
    const ours = fakeDb({ users: [{ id: "seed_user_priya", email: "priya@sharmamedicals.example" }] });
    await expect(assertNoEmailConflicts(ours.client, plan)).resolves.toBeUndefined();
  });

  it("counts every seeded table for the summary", async () => {
    const { client } = fakeDb();
    const counts = await countRows(client);
    expect(counts.length).toBe(30);
    expect(unique(counts.map(([label]) => label))).toBe(true);
  });
});
