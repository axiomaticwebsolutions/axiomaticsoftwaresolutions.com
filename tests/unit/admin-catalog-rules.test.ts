/** Admin catalog rules: Latest release, publish blockers, audit wording, request schemas and upload tokens. */
import { describe, expect, it } from "vitest";
import { signUploadToken, verifyUploadToken, type UploadTokenClaims } from "@/lib/admin/catalog/installers";
import { catalogQueryFromState, PLANS_LIST, PRODUCTS_LIST } from "@/lib/admin/catalog/list-config";
import { changedKeys, latestReleaseIds, planChangeAudit, productChangeSummary, productPublishBlockers, PUBLISH_BLOCKERS, type PlanEditable } from "@/lib/admin/catalog/rules";
import {
  categoryCreateSchema,
  installerUploadSchema,
  planCreateSchema,
  planRuleIssues,
  planUpdateSchema,
  productCreateSchema,
  productUpdateSchema,
  releaseCreateSchema,
  VERSION_RE,
} from "@/lib/admin/catalog/schemas";
import { parseListState } from "@/lib/url-state";

const pub = (id: string, productId: string, version: string, day: number, channel = "stable", status = "PUBLISHED") => ({
  id,
  productId,
  version,
  releasedAt: new Date(Date.UTC(2026, 0, day)),
  channel,
  status,
});

describe("latestReleaseIds", () => {
  it("picks the highest stable published version per product, date only breaking ties", () => {
    const latest = latestReleaseIds([
      pub("a", "med", "4.2.0", 1),
      pub("b", "med", "4.1.5", 20),
      pub("c", "med", "4.3.0-beta.1", 25, "beta"),
      pub("d", "med", "5.0.0", 30, "stable", "DRAFT"),
      pub("e", "rst", "3.6", 1),
      pub("f", "rst", "3.6.0", 2),
    ]);
    expect(latest.get("med")).toBe("a");
    expect(latest.get("rst")).toBe("f");
  });
});

describe("publish blockers and audit wording", () => {
  it("lists what publishing still needs", () => {
    expect(productPublishBlockers({ contentValid: true, mainPlansOnSale: 1, publishedStableReleases: 1 })).toEqual([]);
    expect(productPublishBlockers({ contentValid: false, mainPlansOnSale: 0, publishedStableReleases: 0 })).toEqual([
      PUBLISH_BLOCKERS.content,
      PUBLISH_BLOCKERS.plan,
      PUBLISH_BLOCKERS.release,
    ]);
  });

  it("describes product and plan edits", () => {
    const before = { code: "MED", name: "A", shortName: "A", tagline: "t", summary: "s", categoryId: "c", platforms: ["windows"], icon: "x", tone: null, rank: 1, demoEnabled: true, content: {}, relatedIds: [] };
    const changed = changedKeys(before, { code: "MDX", tagline: "t", rank: 2, platforms: ["windows"] });
    expect(changed).toEqual(["code", "rank"]);
    // jsonb hands content back with its keys reordered: still unchanged.
    expect(changedKeys({ content: { features: [{ body: "b", icon: "i", title: "t" }] } }, { content: { features: [{ icon: "i", title: "t", body: "b" }] } })).toEqual([]);
    expect(productChangeSummary(before, changed, { code: "MDX" })).toBe("License prefix MED \u2192 MDX \u00B7 Rank");

    const plan: PlanEditable = {
      name: "Annual",
      summary: null,
      includes: [],
      pricePaise: 600_000,
      interval: "YEAR",
      trialDays: null,
      deviceLimit: 1,
      perUnit: null,
      maxQty: null,
      multiDevice: false,
      updatesMonths: null,
      popular: false,
      sortOrder: 1,
    };
    const after = { ...plan, pricePaise: 0, popular: true, includes: ["Support"] };
    expect(planChangeAudit(plan, ["pricePaise", "popular", "includes"], after)).toEqual({
      action: "Changed plan price",
      detail: "\u20B96,000 \u2192 Free \u00B7 Popular off \u2192 on \u00B7 Includes",
    });
    expect(planChangeAudit(plan, ["deviceLimit"], { ...plan, deviceLimit: 3 })).toEqual({ action: "Updated plan", detail: "Device limit 1 \u2192 3" });
  });
});

describe("plan rules", () => {
  const base = { pricePaise: 100, interval: null, trialDays: null, deviceLimit: 1, perUnit: null, maxQty: null, multiDevice: false, updatesMonths: null } as const;
  it("enforces what each plan type sets", () => {
    expect(planRuleIssues({ ...base, type: "ONE_TIME", updatesMonths: 12 })).toEqual([]);
    expect(planRuleIssues({ ...base, type: "ONE_TIME" }).map((i) => i.path)).toEqual(["updatesMonths"]);
    expect(planRuleIssues({ ...base, type: "TRIAL", pricePaise: 0, trialDays: 15 })).toEqual([]);
    expect(planRuleIssues({ ...base, type: "ANNUAL" }).map((i) => i.path)).toEqual(["interval"]);
    expect(planRuleIssues({ ...base, type: "SUBSCRIPTION", interval: "MONTH" })).toEqual([]);
    expect(planRuleIssues({ ...base, type: "DEVICE_ADDON", deviceLimit: null, maxQty: 10 })).toEqual([]);
    expect(planRuleIssues({ ...base, type: "MAINTENANCE", interval: "YEAR" }).map((i) => i.path)).toEqual(["deviceLimit"]);
    expect(planRuleIssues({ ...base, type: "ANNUAL", interval: "YEAR", deviceLimit: null, perUnit: "terminal", maxQty: 10 })).toEqual([]);
    expect(planRuleIssues({ ...base, type: "ANNUAL", interval: "YEAR", multiDevice: true }).map((i) => i.path)).toEqual(["multiDevice"]);
  });

  it("validates create and update bodies strictly", () => {
    const annual = { productId: "x", type: "ANNUAL", name: "Annual", pricePaise: 100, interval: "YEAR", deviceLimit: 1 };
    expect(planCreateSchema.safeParse({ id: "x-annual", ...annual }).success).toBe(true);
    expect(planCreateSchema.safeParse({ id: "export", ...annual }).success).toBe(false);
    expect(planUpdateSchema.safeParse({}).success).toBe(false);
    expect(planUpdateSchema.safeParse({ pricePaise: 1.5 }).success).toBe(false);
    expect(planUpdateSchema.safeParse({ type: "TRIAL" }).success).toBe(false);
  });
});

describe("product, category and release schemas", () => {
  const product = {
    id: "clinic-billing",
    code: "cln",
    name: "Clinic Billing",
    shortName: "Clinic",
    tagline: "t",
    summary: "s",
    categoryId: "clinics",
    platforms: ["macos", "windows", "windows"],
    icon: "medication",
  };
  it("normalises and rejects", () => {
    expect(productCreateSchema.parse(product)).toMatchObject({ code: "CLN", platforms: ["windows", "macos"], rank: 100, demoEnabled: true, tone: null });
    expect(productCreateSchema.safeParse({ ...product, code: "CL1" }).success).toBe(false);
    expect(productCreateSchema.safeParse({ ...product, icon: "no_such_icon_x" }).success).toBe(false);
    expect(productCreateSchema.safeParse({ ...product, extra: 1 }).success).toBe(false);
    expect(productUpdateSchema.safeParse({ relatedIds: ["a", "a"] }).data?.relatedIds).toEqual(["a"]);
    expect(categoryCreateSchema.safeParse({ id: "Bad Id", name: "X", tone: "sage", icon: "storefront" }).success).toBe(false);
  });

  it("accepts the version shapes the apps use", () => {
    for (const v of ["4.2", "4.2.1", "4.2.1.1830", "5.0.0-beta.1", "1.0.0+20261007"]) expect(VERSION_RE.test(v), v).toBe(true);
    for (const v of ["4", "v4.2", "04.2", "4.2.", "4..2"]) expect(VERSION_RE.test(v), v).toBe(false);
    expect(releaseCreateSchema.parse({ productId: "med", version: "4.2.1" })).toMatchObject({ channel: "stable", notes: [] });
    expect(installerUploadSchema.safeParse({ platform: "windows", fileName: "a.exe", sizeBytes: 3 * 1024 ** 3 }).success).toBe(false);
  });
});

describe("upload tokens", () => {
  const secret = "s".repeat(40);
  const claims: UploadTokenClaims = { r: "rel1", v: "4.2.1", p: "windows", k: "releases/med/4.2.1/abc/setup.exe", n: "setup.exe", s: 10, u: "staff1", e: 2_000_000_000 };
  const now = new Date("2026-10-07");
  it("verifies its own signature and expiry only", () => {
    const token = signUploadToken(claims, secret);
    expect(verifyUploadToken(token, now, secret)).toEqual(claims);
    expect(verifyUploadToken(token, new Date("2033-06-01"), secret)).toBeNull();
    expect(verifyUploadToken(token, now, "t".repeat(40))).toBeNull();
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, s: 99 })).toString("base64url");
    expect(verifyUploadToken(`${forged}.${sig}`, now, secret)).toBeNull();
    expect(verifyUploadToken(`${payload}`, now, secret)).toBeNull();
  });
});

describe("list state", () => {
  it("turns page URLs into service queries", () => {
    const state = parseListState(new URLSearchParams("filter[status]=hidden&sort=-price&page=2"), PRODUCTS_LIST);
    expect(catalogQueryFromState(state, ["name", "latest", "price", "rank"], { id: "rank", desc: false })).toEqual({
      q: "",
      filters: { status: "hidden" },
      sort: { id: "price", desc: true },
      page: 2,
      pageSize: 10,
    });
    const plans = catalogQueryFromState(parseListState(new URLSearchParams("filter[type]=bogus"), PLANS_LIST), ["name", "product", "price"], {
      id: "product",
      desc: false,
    });
    expect(plans.filters).toEqual({});
    expect(plans.sort).toEqual({ id: "product", desc: false });
  });
});
