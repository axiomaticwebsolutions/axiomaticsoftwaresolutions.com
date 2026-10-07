/**
 * Server loaders of the portal license pages. Everything is scoped to the member's active business account from the
 * server-side session (getPortalContext); ids from the URL only select rows inside it, so another account's license
 * reads exactly like an unknown id. Keys are always masked (the full key only comes from the password-gated reveal).
 */
import "server-only";
import { cache } from "react";
import type { TeamRole } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import {
  getAccountLicenseDetail,
  listAccountLicenses,
  renewalOptionsFor,
  type AccountLicenseDetail,
  type RenewalOption,
} from "@/lib/licensing/account";
import { teamCan } from "@/lib/rbac";
import { cartMaxQty, optionLine, primaryOption, type CartLineSpec, type LicenseListRow } from "./model";

/** The plan fields renewalOptionsFor() reads (same shape as lib/licensing/account RenewalPlan). */
const PLAN_SELECT = {
  id: true,
  name: true,
  type: true,
  interval: true,
  pricePaise: true,
  perUnit: true,
  maxQty: true,
  multiDevice: true,
  archived: true,
  sortOrder: true,
} as const;

type Scope = { accountId: string; role: TeamRole };

export type LicenseListData = {
  rows: LicenseListRow[];
  /** Every license the account holds ("4 of 6 licenses"). */
  total: number;
  truncated: boolean;
  products: Array<{ id: string; name: string; shortName: string }>;
  /** Server time (ISO) for the day counts, so the server render and the browser agree. */
  now: string;
};

/** The renewal line "Renew selected" adds per license (renewal, maintenance or a trial's upgrade). */
async function renewalLines(accountId: string, ids: readonly string[], now: Date): Promise<Map<string, CartLineSpec>> {
  const out = new Map<string, CartLineSpec>();
  if (ids.length === 0) return out;
  const records = await db.license.findMany({
    where: { accountId, id: { in: [...ids] } },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      updatesUntil: true,
      deviceLimit: true,
      productId: true,
      plan: { select: PLAN_SELECT },
      product: { select: { status: true } },
    },
  });
  const plans = await db.plan.findMany({
    where: { productId: { in: [...new Set(records.map((r) => r.productId))] } },
    select: { ...PLAN_SELECT, productId: true },
  });
  for (const record of records) {
    const productPlans = plans.filter((p) => p.productId === record.productId);
    const option = primaryOption(
      renewalOptionsFor(
        {
          status: record.status,
          expiresAt: record.expiresAt,
          updatesUntil: record.updatesUntil,
          deviceLimit: record.deviceLimit,
          plan: record.plan,
          productStatus: record.product.status,
        },
        productPlans,
        now,
      ),
    );
    if (option) out.set(record.id, optionLine(option, record.id, productPlans.find((p) => p.id === option.planId) ?? null));
  }
  return out;
}

/** Every license of the account (filtered and sorted in the browser), with the renewal line for bulk renew. */
export async function loadLicenseList(scope: Scope, now: Date = new Date()): Promise<LicenseListData> {
  const list = await listAccountLicenses(db, scope, { status: "all", product: "all", q: "", sort: { key: "expiry", dir: 1 } }, now);
  const renewable = teamCan(scope.role, "purchases") ? list.licenses.filter((l) => l.status !== "revoked").map((l) => l.id) : [];
  const lines = await renewalLines(scope.accountId, renewable, now);
  return {
    rows: list.licenses.map((license) => ({ ...license, renewal: lines.get(license.id) ?? null })),
    total: list.total,
    truncated: list.truncated,
    products: list.products,
    now: now.toISOString(),
  };
}

/** A "Renew & upgrade" option with the cart line it adds. */
export type RenewalOptionView = RenewalOption & { line: CartLineSpec };

/** A paid plan a trial can convert to (the "Choose plan" dialog adds it as an UPGRADE of the trial license). */
export type PaidPlanChoice = {
  planId: string;
  name: string;
  type: "ONE_TIME" | "ANNUAL" | "SUBSCRIPTION";
  interval: RenewalOption["interval"];
  unitPricePaise: number;
  perUnit: string | null;
  line: CartLineSpec;
};

export type LicenseDetailData = {
  detail: AccountLicenseDetail;
  options: RenewalOptionView[];
  /** The device add-on ("Add computers"), when the product sells one. */
  addon: { planId: string; unitPricePaise: number; maxQty: number; available: boolean } | null;
  /** Paid plans for a trial's "Buy a license" / "Choose plan" (empty for other licenses). */
  paidPlans: PaidPlanChoice[];
  now: string;
};

const PAID_TYPES = new Set(["ONE_TIME", "ANNUAL", "SUBSCRIPTION"]);

function isPaidType(type: string): type is PaidPlanChoice["type"] {
  return PAID_TYPES.has(type);
}

/**
 * One license of the active account with devices, history and renewal options, or null when the id is unknown or
 * belongs to another account (the page then says "License not found"). Cached per request, so generateMetadata
 * and the page share one load.
 */
export const loadLicenseDetail = cache(async (accountId: string, role: TeamRole, licenseId: string): Promise<LicenseDetailData | null> => {
  const now = new Date();
  let detail: AccountLicenseDetail;
  try {
    detail = await getAccountLicenseDetail(db, { accountId, role }, licenseId, now);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  const plans = await db.plan.findMany({
    where: { productId: detail.license.productId },
    select: PLAN_SELECT,
    orderBy: [{ sortOrder: "asc" }, { pricePaise: "asc" }, { id: "asc" }],
  });
  const planById = new Map(plans.map((p) => [p.id, p]));
  const id = detail.license.id;
  const options = detail.renewalOptions.map((o) => ({ ...o, line: optionLine(o, id, planById.get(o.planId) ?? null) }));
  const addonOption = options.find((o) => o.kind === "ADDON");
  const addonPlan = addonOption ? planById.get(addonOption.planId) : undefined;
  const paidPlans: PaidPlanChoice[] = options.some((o) => o.tag === "BUY")
    ? plans.flatMap((p) => {
        const type = p.type;
        if (p.archived || p.pricePaise <= 0 || !isPaidType(type)) return [];
        return [
          {
            planId: p.id,
            name: p.name,
            type,
            interval: p.interval,
            unitPricePaise: p.pricePaise,
            perUnit: p.perUnit,
            line: { planId: p.id, qty: 1, maxQty: cartMaxQty(p), kind: "UPGRADE" as const, targetLicenseId: id },
          },
        ];
      })
    : [];
  return {
    detail,
    options,
    addon: addonOption
      ? {
          planId: addonOption.planId,
          unitPricePaise: addonOption.unitPricePaise,
          maxQty: addonPlan ? cartMaxQty(addonPlan) : addonOption.qty,
          available: addonOption.available,
        }
      : null,
    paidPlans,
    now: now.toISOString(),
  };
});
