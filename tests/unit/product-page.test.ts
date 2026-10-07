import { describe, expect, it } from "vitest";
import {
  INSTALL_GUIDE_HREF,
  PRODUCT_COPY,
  PRODUCT_SECTIONS,
  installSteps,
  minutesLabel,
  policyCards,
} from "@/components/store/product/copy";
import {
  activeSectionId,
  cartToastDetail,
  perUnitCopy,
  productBreadcrumbs,
  productSections,
  relatedProducts,
  releaseDateLabel,
  releaseMetaLabel,
  screenshotsFor,
  trialChipLabel,
} from "@/components/store/product/model";
import { PRODUCT_SCREENSHOTS } from "@/content/screenshots";
import { trialPlan } from "@/lib/storefront/derive";
import { fixtureProducts } from "@/lib/storefront/fixtures";
import type { StoreProduct } from "@/lib/storefront/types";

const products = fixtureProducts();

function product(slug: string): StoreProduct {
  const found = products.find((p) => p.id === slug);
  if (!found) throw new Error(`fixture ${slug} missing`);
  return found;
}

describe("productSections", () => {
  it("lists every section in prototype order when the product has content", () => {
    const ids = productSections(product("medical-billing"), 3).map((s) => s.id);
    expect(ids).toEqual(["features", "plans", "requirements", "install", "releases", "support", "faqs"]);
    expect(productSections(product("medical-billing"), 3).map((s) => s.label)).toEqual([
      "Features",
      "Plans",
      "Requirements",
      "Installation",
      "Releases",
      "Support",
      "FAQs",
    ]);
  });

  it("skips empty sections so the nav never points at a missing anchor", () => {
    const bare: StoreProduct = {
      ...product("cheque-printing"),
      content: { features: [], benefits: [], requirements: [] },
      plans: [],
      releases: [],
    };
    expect(productSections(bare, 0).map((s) => s.id)).toEqual(["install", "support"]);
  });

  it("keeps the nav ids in sync with PRODUCT_SECTIONS", () => {
    const all = PRODUCT_SECTIONS.map((s) => s.id);
    for (const p of products) {
      for (const s of productSections(p, p.faqs.length)) expect(all).toContain(s.id);
    }
  });
});

describe("labels", () => {
  it("formats the trial chip from the trial plan", () => {
    const trial = trialPlan(product("medical-billing"));
    expect(trial && trialChipLabel(trial)).toBe("15-day free trial");
    const rstTrial = trialPlan(product("restaurant-billing"));
    expect(rstTrial && trialChipLabel(rstTrial)).toBe("7-day free trial");
  });

  it("builds the add-to-cart toast detail like the prototype", () => {
    expect(cartToastDetail("Medical Store Billing", "Annual license", 1)).toBe("Medical Store Billing · Annual license");
    expect(cartToastDetail("Restaurant Billing", "Monthly subscription", 3)).toBe(
      "Restaurant Billing · Monthly subscription × 3",
    );
  });

  it("shows release dates in IST with fixed month abbreviations", () => {
    const latest = product("medical-billing").releases[0];
    expect(latest).toBeDefined();
    if (!latest) return;
    expect(releaseDateLabel(latest)).toBe("15 Sep 2026");
    expect(releaseMetaLabel(latest)).toBe("Released 15 Sep 2026 · 148 MB");
    expect(releaseMetaLabel({ releasedAt: "2026-03-19T18:30:00.000Z", sizeLabel: "" })).toBe("Released 20 Mar 2026");
  });

  it("derives the per-unit stepper copy", () => {
    expect(perUnitCopy("terminal")).toEqual({ label: "Terminals", fewer: "Fewer terminals", more: "More terminals" });
    expect(perUnitCopy("Users")).toEqual({ label: "Users", fewer: "Fewer users", more: "More users" });
  });

  it("states the minutes in the install steps and names the portal page", () => {
    expect(minutesLabel(1)).toBe("1 minute");
    const steps = installSteps(10);
    expect(steps).toHaveLength(4);
    expect(steps[0]?.body).toBe(
      "Sign in to your account and open Software & downloads. Download links are valid for 10 minutes.",
    );
    expect(steps.map((s) => s.title)).toEqual([
      "Download the installer",
      "Run the setup",
      "Enter your license key",
      "Start billing",
    ]);
    expect(INSTALL_GUIDE_HREF).toBe("/docs/install");
  });

  it("writes the tax notes with the configured GST rate", () => {
    expect(PRODUCT_COPY.plansNoteExcl(18)).toBe(
      "Prices exclude GST. 18% GST is added at checkout based on your billing state.",
    );
    expect(PRODUCT_COPY.plansNoteIncl(18)).toBe(
      "Prices include 18% GST. Final tax is calculated from your billing state at checkout.",
    );
    expect(PRODUCT_COPY.taxLineExcl(18)).toBe("+ 18% GST at checkout");
    expect(PRODUCT_COPY.taxLineIncl(18)).toBe("Includes 18% GST");
  });
});

describe("policyCards", () => {
  it("uses the support hours and keeps the sample note while details are placeholders", () => {
    const cards = policyCards({ hours: "Mon–Sat, 10:00–19:00 IST", sample: true });
    expect(cards.map((c) => c.title)).toEqual(["Annual & subscription", "One-time licenses", "Support hours"]);
    expect(cards[2]?.body).toBe("Mon–Sat, 10:00–19:00 IST by ticket, email and phone. Hours are configurable.");
    expect(policyCards({ hours: "Mon–Fri, 9:00–18:00 IST", sample: false })[2]?.body).toBe(
      "Mon–Fri, 9:00–18:00 IST by ticket, email and phone.",
    );
  });

  it("says renewals are manual (decisions.md 2)", () => {
    const annual = policyCards({ hours: "", sample: false })[0]?.body ?? "";
    expect(annual).toContain("Renewal is manual");
    expect(annual).not.toMatch(/automatic(ally)? renew/i);
  });
});

describe("productBreadcrumbs", () => {
  it("is Home / Software / category / short name", () => {
    expect(productBreadcrumbs(product("medical-billing"))).toEqual([
      { name: "Home", path: "/" },
      { name: "Software", path: "/software" },
      { name: "Medical & Pharmacy", path: "/software?category=pharmacy" },
      { name: "Medical Store Billing", path: "/software/medical-billing" },
    ]);
  });
});

describe("relatedProducts", () => {
  it("keeps the admin order and skips unknown ids, duplicates and the product itself", () => {
    const med = product("medical-billing");
    expect(relatedProducts(med, products).map((p) => p.id)).toEqual(["general-store-gst", "cheque-printing"]);
    const odd = { ...med, relatedIds: ["nope", "medical-billing", "cheque-printing", "cheque-printing"] };
    expect(relatedProducts(odd, products).map((p) => p.id)).toEqual(["cheque-printing"]);
  });
});

describe("screenshotsFor", () => {
  it("has three placeholder panels for every sample product", () => {
    for (const p of products) {
      const shots = screenshotsFor(p);
      expect(shots, p.id).toHaveLength(3);
      expect(shots).toEqual(PRODUCT_SCREENSHOTS[p.id]);
    }
    expect(screenshotsFor(product("medical-billing"))[0]).toMatchObject({
      tab: "Billing",
      title: "Counter billing",
      heading: "Bill #B-2291",
      foot: ["Total", "₹312.40"],
    });
  });

  it("falls back to one generic panel for a product without configured screenshots", () => {
    const med = product("medical-billing");
    const shots = screenshotsFor({ ...med, id: "new-product" });
    expect(shots).toHaveLength(1);
    expect(shots[0]?.tab).toBe("Overview");
    expect(shots[0]?.rows).toHaveLength(5);
    expect(shots[0]?.foot).toEqual(["Version", "4.2.1"]);
    expect(screenshotsFor({ ...med, id: "new-product", releases: [] })[0]?.foot).toEqual(["Status", "Ready"]);
  });
});

describe("activeSectionId", () => {
  const positions = [
    { id: "features", top: 400 },
    { id: "plans", top: 1200 },
    { id: "requirements", top: 2100 },
  ];

  it("is null while no section has reached the line under the sticky nav", () => {
    expect(activeSectionId(positions, 180)).toBeNull();
    expect(activeSectionId([], 180)).toBeNull();
  });

  it("picks the last section whose top has passed the line", () => {
    expect(activeSectionId(positions, 400)).toBe("features");
    expect(activeSectionId(positions, 1500)).toBe("plans");
    expect(activeSectionId(positions, 99_999)).toBe("requirements");
  });

  it("tolerates sub-pixel scroll positions after an anchor jump", () => {
    expect(activeSectionId(positions, 1199.4)).toBe("plans");
  });
});
