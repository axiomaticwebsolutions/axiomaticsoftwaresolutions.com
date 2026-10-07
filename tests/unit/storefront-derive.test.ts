import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LICENSE_TYPE_LABELS,
  addOnPlans,
  compareHref,
  demoHref,
  formatFileSize,
  hasTrial,
  isLicenseTypeKey,
  latestRelease,
  licenseTypeKeys,
  mainPlans,
  majorMinor,
  maxQtyFor,
  newestRelease,
  planTypeTag,
  planUnitLabel,
  platformsLabel,
  productHref,
  startingPlan,
  trialHref,
  trialPlan,
  unitLabel,
} from "@/lib/storefront/derive";
import { fixtureProducts } from "@/lib/storefront/fixtures";
import {
  PRICE_COOKIE,
  PRICE_DISPLAY_SCRIPT,
  priceModeFromCookie,
  priceModeFromSetting,
} from "@/lib/storefront/price-display";
import type { StorePlan, StoreProduct } from "@/lib/storefront/types";

const products = fixtureProducts();

function product(id: string): StoreProduct {
  const found = products.find((p) => p.id === id);
  if (!found) throw new Error(`no product ${id}`);
  return found;
}

function plan(id: string): StorePlan {
  const found = products.flatMap((p) => p.plans).find((p) => p.id === id);
  if (!found) throw new Error(`no plan ${id}`);
  return found;
}

describe("plans", () => {
  it("picks the cheapest paid main plan as the starting price", () => {
    const starting = Object.fromEntries(products.map((p) => [p.id, startingPlan(p)]));
    expect(starting["medical-billing"]).toMatchObject({ id: "med-annual", pricePaise: 499900 });
    expect(starting["restaurant-billing"]).toMatchObject({ id: "rst-monthly", pricePaise: 69900 });
    expect(starting["general-store-gst"]).toMatchObject({ id: "gst-annual", pricePaise: 349900 });
    expect(starting["cheque-printing"]).toMatchObject({ id: "chq-onetime", pricePaise: 299900 });
    expect(startingPlan({ plans: [plan("med-trial")] })).toBeNull();
  });

  it("splits main plans from add-ons and finds trials", () => {
    expect(mainPlans(product("medical-billing")).map((p) => p.id)).toEqual(["med-trial", "med-annual", "med-onetime"]);
    expect(addOnPlans(product("medical-billing")).map((p) => p.id)).toEqual(["med-device", "med-amc"]);
    expect(addOnPlans(product("restaurant-billing"))).toEqual([]);
    expect(trialPlan(product("restaurant-billing"))?.trialDays).toBe(7);
    expect(products.map((p) => [p.id, hasTrial(p)])).toEqual([
      ["medical-billing", true],
      ["restaurant-billing", true],
      ["general-store-gst", true],
      ["cheque-printing", false],
    ]);
  });

  it("lists license types in plan order, with multi for multi-device and per-unit plans", () => {
    expect(licenseTypeKeys(product("medical-billing"))).toEqual(["trial", "annual", "one_time"]);
    expect(licenseTypeKeys(product("restaurant-billing"))).toEqual(["trial", "subscription", "multi"]);
    expect(licenseTypeKeys(product("general-store-gst"))).toEqual(["trial", "annual", "one_time", "multi"]);
    expect(licenseTypeKeys(product("cheque-printing"))).toEqual(["one_time", "multi"]);
    expect(licenseTypeKeys(product("cheque-printing")).map((k) => LICENSE_TYPE_LABELS[k])).toEqual(["One-time", "Multi-device"]);
    expect(isLicenseTypeKey("multi")).toBe(true);
    expect(isLicenseTypeKey("maintenance")).toBe(false);
  });

  it("tags plan cards like the product page", () => {
    expect(planTypeTag(plan("med-trial"))).toBe("FREE TRIAL");
    expect(planTypeTag(plan("med-onetime"))).toBe("ONE-TIME");
    expect(planTypeTag(plan("med-annual"))).toBe("ANNUAL");
    expect(planTypeTag(plan("rst-yearly"))).toBe("SUBSCRIPTION");
    expect(planTypeTag(plan("gst-multi"))).toBe("MULTI-DEVICE");
    expect(planTypeTag(plan("chq-office"))).toBe("MULTI-DEVICE");
    expect(planTypeTag(plan("med-device"))).toBe("ADD-ON");
    expect(planTypeTag(plan("med-amc"))).toBe("MAINTENANCE");
  });

  it("labels units like the prototype, with per-terminal variants", () => {
    expect(unitLabel(plan("med-trial"))).toBe("15 days");
    expect(unitLabel(plan("rst-trial"))).toBe("7 days");
    expect(unitLabel(plan("med-annual"))).toBe("/year");
    expect(unitLabel(plan("rst-monthly"))).toBe("/month");
    expect(unitLabel(plan("chq-onetime"))).toBe("one-time");
    expect(unitLabel(plan("med-amc"))).toBe("/year");
    expect(unitLabel(plan("med-device"))).toBe("one-time");
    expect(unitLabel(plan("rst-monthly"), 1)).toBe("/month per terminal");
    expect(unitLabel(plan("rst-yearly"), 3)).toBe("/year for 3 terminals");
    expect(unitLabel(plan("med-annual"), 2)).toBe("/year");
    expect(planUnitLabel(plan("med-trial"))).toBe("for 15 days");
    expect(planUnitLabel(plan("rst-monthly"), 4)).toBe("/month for 4 terminals");
    expect(planUnitLabel(plan("gst-onetime"))).toBe("one-time");
  });

  it("caps quantities at maxQty for per-unit plans (10 by default) and 1 otherwise", () => {
    expect(maxQtyFor(plan("rst-monthly"))).toBe(10);
    expect(maxQtyFor({ perUnit: "terminal", maxQty: null })).toBe(10);
    expect(maxQtyFor({ perUnit: "terminal", maxQty: 4 })).toBe(4);
    expect(maxQtyFor(plan("gst-multi"))).toBe(1);
    expect(maxQtyFor(plan("med-annual"))).toBe(1);
  });
});

describe("releases and platforms", () => {
  it("finds each product's latest release and the newest one overall", () => {
    expect(latestRelease(product("medical-billing"))).toMatchObject({ version: "4.2.1", sizeLabel: "148 MB" });
    expect(latestRelease({ releases: [] })).toBeNull();
    const newest = newestRelease(products);
    expect(newest?.product).toEqual({ id: "general-store-gst", name: "General Store GST Billing Software", shortName: "General Store GST Billing" });
    expect(newest?.release.version).toBe("5.0.2");
    expect(`${newest?.product.shortName} ${majorMinor(newest?.release.version ?? "")} is out`).toBe(
      "General Store GST Billing 5.0 is out",
    );
    expect(newestRelease([])).toBeNull();
  });

  it("labels platforms and file sizes", () => {
    expect(platformsLabel(product("restaurant-billing").platforms)).toBe("Windows · Android");
    expect(platformsLabel(product("general-store-gst").platforms, ", ")).toBe("Windows, macOS");
    expect(formatFileSize(148n * 1024n * 1024n)).toBe("148 MB");
    expect(formatFileSize(64 * 1024 * 1024)).toBe("64 MB");
    expect(formatFileSize(512 * 1024)).toBe("512 KB");
    expect(formatFileSize(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe("2 GB");
    expect(formatFileSize(0)).toBe("0 KB");
  });
});

describe("links", () => {
  it("builds the storefront URLs from docs/decisions.md", () => {
    expect(productHref("medical-billing")).toBe("/software/medical-billing");
    expect(demoHref()).toBe("/contact?type=demo");
    expect(demoHref("cheque-printing")).toBe("/contact?type=demo&product=cheque-printing");
    expect(trialHref("general-store-gst")).toBe("/register?next=/account/software&trial=general-store-gst");
    expect(compareHref(["medical-billing", "general-store-gst"])).toBe("/compare?ids=medical-billing,general-store-gst");
    expect(compareHref([])).toBe("/compare");
  });
});

describe("price display", () => {
  it("maps the setting and the cookie to a mode", () => {
    expect(priceModeFromSetting("exclusive")).toBe("excl");
    expect(priceModeFromSetting("inclusive")).toBe("incl");
    expect(priceModeFromCookie("1")).toBe("incl");
    expect(priceModeFromCookie("0")).toBe("excl");
    expect(priceModeFromCookie("yes")).toBeNull();
    expect(priceModeFromCookie(undefined)).toBeNull();
  });

  function runScript(cookie: string, initial = "excl"): string {
    const attrs = new Map<string, string>([["data-price", initial]]);
    const document = {
      cookie,
      documentElement: { setAttribute: (name: string, value: string) => attrs.set(name, value) },
    };
    new Function("document", PRICE_DISPLAY_SCRIPT)(document);
    return attrs.get("data-price") ?? "";
  }

  it("applies the cookie choice before paint and ignores anything else", () => {
    expect(PRICE_DISPLAY_SCRIPT).toContain(`"${PRICE_COOKIE}="`);
    expect(runScript("a=b; axs_price_incl=1; c=d")).toBe("incl");
    expect(runScript("axs_price_incl=0", "incl")).toBe("excl");
    expect(runScript("theme=dark", "incl")).toBe("incl");
    expect(runScript("x_axs_price_incl=1")).toBe("excl");
    expect(runScript("axs_price_incl=<script>")).toBe("excl");
    expect(runScript("")).toBe("excl");
  });

  it("is a fixed string, so a CSP hash can be pinned", () => {
    expect(PRICE_DISPLAY_SCRIPT).not.toMatch(/<\/?script/i);
    expect(createHash("sha256").update(PRICE_DISPLAY_SCRIPT).digest("base64")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});
