import { describe, expect, it } from "vitest";
import {
  DOC_GROUPS,
  DOC_GUIDES,
  DOC_PLATFORMS,
  FIRST_GUIDE_SLUG,
  findGuide,
  groupByDocGroup,
  guideHref,
  type DocGuide,
  type DocStep,
} from "@/content/docs/guides";
import { docsResultsLabel, docsSearchIndex, normalizeDocsQuery, searchDocs } from "@/content/docs/search";
import { fillTemplate, plural, splitTemplate, templateTokens } from "@/content/docs/template";
import {
  DOCS_VALUE_DEFAULTS,
  DOC_TOKENS,
  docsValues,
  resolveGuide,
  resolveGuides,
  type DocsProduct,
  type ResolvedGuide,
} from "@/content/docs/values";
import {
  CONTACT_LINK_TOKEN,
  DEFAULT_LEGAL_DOC,
  LEGAL_COPY,
  LEGAL_DOCUMENTS,
  LEGAL_DOC_SLUGS,
  LEGAL_PLACEHOLDERS,
  LEGAL_TOKENS,
  isLegalDocSlug,
  legalDocHref,
  legalDocuments,
  legalValues,
} from "@/content/legal/documents";
import { SETTING_DEFAULTS } from "@/lib/config";
import { fixtureProducts } from "@/lib/storefront/fixtures";
import type { StorePlan } from "@/lib/storefront/types";
import { SUPPORT_FAQS } from "@/prisma/seed-data/content";

const products = fixtureProducts();

function allSteps(guide: DocGuide): DocStep[] {
  return guide.steps ? [...guide.steps] : DOC_PLATFORMS.flatMap((p) => [...(guide.platformSteps?.[p] ?? [])]);
}

function guideCopy(guide: DocGuide): string[] {
  return [
    guide.title,
    guide.summary,
    guide.note ?? "",
    ...allSteps(guide).flatMap((s) => [s.title, s.body, s.code ?? ""]),
  ];
}

function legalCopy(): string[] {
  return [
    ...legalDocuments().flatMap((d) => [d.title, d.tabLabel, d.description, d.intro, ...d.sections.flatMap((s) => [s.heading, ...s.paragraphs])]),
    ...Object.values(LEGAL_COPY),
  ];
}

function resolved(slug: string, values = docsValues(defaultInput())): ResolvedGuide {
  const guide = findGuide(slug);
  if (!guide) throw new Error(`no guide ${slug}`);
  return resolveGuide(guide, values);
}

function defaultInput(over: Partial<Parameters<typeof docsValues>[0]> = {}) {
  return {
    downloadTtlSeconds: 600,
    selfServiceResetsPerYear: SETTING_DEFAULTS.licensing.selfServiceResetsPerYear,
    offlineGraceDays: 7,
    products,
    ...over,
  };
}

describe("template", () => {
  it("splits copy into text and tokens", () => {
    expect(splitTemplate("a {x} b {y1}")).toEqual([
      { kind: "text", text: "a " },
      { kind: "token", name: "x" },
      { kind: "text", text: " b " },
      { kind: "token", name: "y1" },
    ]);
    expect(splitTemplate("no tokens { here } or {1x}")).toEqual([{ kind: "text", text: "no tokens { here } or {1x}" }]);
    expect(templateTokens("{a} and {b} and {a}")).toEqual(["a", "b", "a"]);
  });

  it("fills known tokens and keeps unknown ones, never reading inherited properties", () => {
    expect(fillTemplate("Links expire after {t}.", { t: "10 minutes" })).toBe("Links expire after 10 minutes.");
    expect(fillTemplate("{missing} {constructor} {toString}", {})).toBe("{missing} {constructor} {toString}");
  });

  it("pluralises", () => {
    expect(plural(1, "minute")).toBe("1 minute");
    expect(plural(10, "minute")).toBe("10 minutes");
    expect(plural(0, "self-service deactivation")).toBe("0 self-service deactivations");
  });
});

describe("docs guides", () => {
  it("has the prototype's 8 guides, groups and order", () => {
    expect(DOC_GUIDES.map((g) => [g.group, g.slug, g.title])).toEqual([
      ["Getting started", "getting-started", "Before you begin"],
      ["Getting started", "install", "Install the software"],
      ["Licensing", "activate", "Activate your license"],
      ["Licensing", "move", "Move to a new computer"],
      ["Licensing", "renew", "Renewals and updates"],
      ["Using the software", "backup", "Back up and restore"],
      ["Using the software", "printers", "Set up printers"],
      ["Troubleshooting", "troubleshooting", "Common problems"],
    ]);
    expect(groupByDocGroup(DOC_GUIDES).map((g) => [g.label, g.items.length])).toEqual(
      DOC_GROUPS.map((label) => [label, DOC_GUIDES.filter((g) => g.group === label).length]),
    );
    expect(FIRST_GUIDE_SLUG).toBe(DOC_GUIDES[0]?.slug);
  });

  it("uses unique URL-safe slugs and well-formed steps", () => {
    const slugs = DOC_GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const guide of DOC_GUIDES) {
      expect(guide.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(guideHref(guide.slug)).toBe(`/docs/${guide.slug}`);
      // Exactly one of steps / platformSteps, and every OS tab has steps.
      expect(Boolean(guide.steps) !== Boolean(guide.platformSteps)).toBe(true);
      if (guide.platformSteps) for (const p of DOC_PLATFORMS) expect(guide.platformSteps[p].length).toBeGreaterThan(0);
      expect(allSteps(guide).length).toBeGreaterThan(0);
    }
    expect(DOC_GUIDES.filter((g) => g.platformSteps).map((g) => g.slug)).toEqual(["install"]);
    expect(findGuide("nope")).toBeNull();
  });

  it("only uses known tokens, and none in titles or summaries (page metadata uses them raw)", () => {
    for (const guide of DOC_GUIDES) {
      for (const text of guideCopy(guide)) {
        for (const token of templateTokens(text)) expect(DOC_TOKENS).toContain(token);
      }
      expect(templateTokens(guide.title + guide.summary)).toEqual([]);
    }
    for (const guide of resolveGuides(DOCS_VALUE_DEFAULTS)) {
      expect(JSON.stringify(guide)).not.toMatch(/\{[A-Za-z][A-Za-z0-9]*\}/);
    }
  });

  it("is typographically clean and names the portal page Software & downloads", () => {
    const copy = DOC_GUIDES.flatMap(guideCopy).join("\n");
    expect(copy).not.toMatch(/['"]/);
    expect(copy).not.toMatch(/My Software/i);
    expect(copy).toContain("Software & downloads");
  });

  it("reproduces the prototype copy from the sample settings, env defaults and fixture catalog", () => {
    const values = docsValues(defaultInput());
    expect(values).toEqual(DOCS_VALUE_DEFAULTS);
    const install = resolved("install", values);
    expect(install.platformSteps?.windows[0]?.body).toBe(
      "Sign in, open Software & downloads and choose the Windows download. Links expire after 10 minutes, so start the download right away.",
    );
    expect(install.platformSteps?.windows[1]?.code).toBe("Axiomatic-MED-4.2.1-x64.exe");
    expect(install.platformSteps?.macos[1]?.code).toBe("Axiomatic-GST-5.0.2.dmg");
    expect(resolved("activate", values).steps?.[1]?.code).toBe("MED-XXXX-XXXX-XXXX-XXXX");
    expect(resolved("move", values).steps?.[1]?.body).toBe(
      "In your account, open the license, go to Devices and select Deactivate. You get 3 self-service deactivations a year.",
    );
    expect(resolved("renew", values).steps?.[1]?.body).toBe(
      "Updates are included for 12 months. Renew maintenance to download versions released after that.",
    );
    expect(resolved("troubleshooting", values).steps?.[2]?.body).toBe(
      "Check the internet connection. Activated copies keep working offline for 7 days between checks.",
    );
    expect(resolved("activate", values).note).toBe(
      "If you see “activation limit reached”, every device slot is in use. Deactivate an old computer from your account or add a computer to the license.",
    );
  });

  it("follows the configured numbers", () => {
    const values = docsValues(defaultInput({ downloadTtlSeconds: 90, selfServiceResetsPerYear: 1, offlineGraceDays: 1 }));
    expect(values.downloadLinkTime).toBe("1 minute");
    expect(values.selfServiceResets).toBe("1 self-service deactivation");
    expect(values.offlineGrace).toBe("1 day");
    // The TTL is rounded down so the copy never promises longer than the link lives.
    expect(docsValues(defaultInput({ downloadTtlSeconds: 299 })).downloadLinkTime).toBe("4 minutes");
    expect(docsValues(defaultInput({ downloadTtlSeconds: 30 })).downloadLinkTime).toBe("1 minute");
  });

  it("derives the update period from one-time plans", () => {
    const withMonths = (months: (number | null)[]): DocsProduct[] => [
      {
        code: "ABC",
        releases: [],
        plans: months.map((m, i) => ({ id: `p${i}`, type: "ONE_TIME", updatesMonths: m }) as unknown as StorePlan),
      },
    ];
    expect(docsValues(defaultInput({ products: withMonths([24]) })).updatesPeriod).toBe("24 months");
    expect(docsValues(defaultInput({ products: withMonths([null]) })).updatesPeriod).toBe("12 months");
    expect(docsValues(defaultInput({ products: withMonths([24, 12, 12]) })).updatesPeriod).toBe(
      "12 to 24 months, depending on the plan",
    );
    expect(docsValues(defaultInput({ products: withMonths([]) })).updatesPeriod).toBe("12 months");
  });

  it("falls back to the prototype examples when the catalog has no matching release", () => {
    const values = docsValues(defaultInput({ products: [] }));
    expect(values.windowsInstaller).toBe(DOCS_VALUE_DEFAULTS.windowsInstaller);
    expect(values.macInstaller).toBe(DOCS_VALUE_DEFAULTS.macInstaller);
    expect(values.licenseKeyExample).toBe(DOCS_VALUE_DEFAULTS.licenseKeyExample);
  });

  it("has a guide behind every support FAQ link and the footer's install link", () => {
    const hrefs = [...SUPPORT_FAQS.map((f) => f.href), "/docs/install"];
    for (const href of hrefs) {
      expect(href).toMatch(/^\/docs\//);
      expect(findGuide(String(href).slice("/docs/".length))).not.toBeNull();
    }
  });
});

describe("docs search", () => {
  const index = docsSearchIndex(resolveGuides(DOCS_VALUE_DEFAULTS));

  it("matches title, summary and step text of every OS, case-insensitively, in reading order", () => {
    expect(searchDocs(index, "backup").map((e) => e.slug)).toEqual(["move", "backup"]);
    expect(searchDocs(index, "  BACKUP ").map((e) => e.slug)).toEqual(["move", "backup"]);
    expect(searchDocs(index, ".dmg").map((e) => e.slug)).toEqual(["install"]);
    expect(searchDocs(index, "printer").map((e) => e.slug)).toContain("printers");
    expect(searchDocs(index, "zzzz")).toEqual([]);
    expect(searchDocs(index, "   ")).toEqual([]);
    expect(normalizeDocsQuery("  Key ")).toBe("key");
    expect(index[0]).toMatchObject({ slug: "getting-started", href: "/docs/getting-started", group: "Getting started" });
  });

  it("labels results like the prototype", () => {
    expect(docsResultsLabel(1, " backup ")).toBe("1 result for “backup”");
    expect(docsResultsLabel(0, "zzzz")).toBe("0 results for “zzzz”");
    expect(docsResultsLabel(2, "key")).toBe("2 results for “key”");
  });
});

describe("legal documents", () => {
  it("has the four documents with the prototype's titles, labels and sections", () => {
    expect([...LEGAL_DOC_SLUGS]).toEqual(["terms", "privacy", "refund", "eula"]);
    expect(DEFAULT_LEGAL_DOC).toBe("terms");
    expect(legalDocuments().map((d) => [d.slug, d.tabLabel, d.title])).toEqual([
      ["terms", "Terms", "Terms of service"],
      ["privacy", "Privacy", "Privacy policy"],
      ["refund", "Refunds", "Refund policy"],
      ["eula", "License agreement", "End User License Agreement"],
    ]);
    expect(LEGAL_DOCUMENTS.terms.sections.map((s) => s.heading)).toEqual([
      "Your account",
      "Orders and payment",
      "Licenses",
      "Acceptable use",
      "Changes and availability",
      "Liability",
      "Governing law",
    ]);
    expect(LEGAL_DOCUMENTS.privacy.sections.map((s) => s.heading)).toEqual([
      "What we collect",
      "License activation data",
      "How we use data",
      "Sharing",
      "Retention and security",
      "Your choices",
    ]);
    expect(LEGAL_DOCUMENTS.refund.sections.map((s) => s.heading)).toEqual([
      "Eligibility",
      "How to request",
      "What happens next",
      "Exceptions",
    ]);
    expect(LEGAL_DOCUMENTS.eula.sections).toHaveLength(8);
  });

  it("is versioned, dated, marked as a sample and uses stable unique fragment ids", () => {
    for (const doc of legalDocuments()) {
      expect(doc.slug).toBe(LEGAL_DOCUMENTS[doc.slug].slug);
      expect(doc.version).toBe("0.1");
      expect(doc.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(doc.lastUpdated))).toBe(false);
      expect(doc.status).toBe("sample");
      const ids = doc.sections.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(legalDocHref(doc.slug)).toBe(`/legal/${doc.slug}`);
    }
    expect(LEGAL_COPY.sampleTitle).toBe("Sample — to be reviewed by counsel.");
    expect(isLegalDocSlug("eula")).toBe(true);
    expect(isLegalDocSlug("cookies")).toBe(false);
    expect(isLegalDocSlug("constructor")).toBe(false);
  });

  it("only uses known tokens and stays typographically clean", () => {
    const known = new Set<string>([...LEGAL_TOKENS, CONTACT_LINK_TOKEN]);
    for (const text of legalCopy()) for (const token of templateTokens(text)) expect(known).toContain(token);
    expect(templateTokens(LEGAL_COPY.footer)).toEqual(["legalEmail", "contactUs"]);
    expect(legalCopy().join("\n")).not.toMatch(/['"]/);
  });

  it("fills seller details from business settings, and the brand while they are placeholders", () => {
    const sample = legalValues({ business: SETTING_DEFAULTS.business, offlineGraceDays: 7 });
    expect(sample).toMatchObject({
      sellerName: "Axiomatic Software Solutions",
      legalEmail: "legal@axiomatic.example",
      privacyEmail: "privacy@axiomatic.example",
      supportEmail: "support@axiomatic.example",
      offlineGrace: "7 days",
      ...LEGAL_PLACEHOLDERS,
    });
    expect(fillTemplate(LEGAL_DOCUMENTS.terms.intro, sample)).toBe(
      "These terms apply when you browse our website, create an account or buy software from Axiomatic Software Solutions (“we”, “us”). By using the website you agree to them.",
    );
    expect(fillTemplate(LEGAL_DOCUMENTS.eula.sections[2]?.paragraphs[0] ?? "", sample)).toBe(
      "The software must be activated with a valid key and checks the license periodically. If it can’t connect, it continues working for a grace period of 7 days.",
    );
    expect(fillTemplate(LEGAL_DOCUMENTS.terms.sections[6]?.paragraphs[0] ?? "", sample)).toBe(
      "These terms are governed by the laws of India. Courts at [city] have jurisdiction.",
    );

    const real = legalValues({
      business: { ...SETTING_DEFAULTS.business, sample: false, legalName: "Axiomatic Web Solutions Pvt. Ltd." },
      offlineGraceDays: 10,
    });
    expect(real.sellerName).toBe("Axiomatic Web Solutions Pvt. Ltd.");
    expect(real.offlineGrace).toBe("10 days");
  });

  it("does not promise cancellable or automatic subscription renewals (docs/decisions.md 2)", () => {
    const refund = LEGAL_DOCUMENTS.refund.sections.flatMap((s) => s.paragraphs).join(" ");
    expect(refund).not.toMatch(/cancel/i);
    expect(refund).toContain("Subscriptions renew only when you renew them");
  });

  it("covers every legal link in the store footer", () => {
    for (const href of ["/legal/terms", "/legal/privacy", "/legal/refund", "/legal/eula"]) {
      expect(isLegalDocSlug(href.slice("/legal/".length))).toBe(true);
    }
  });
});
