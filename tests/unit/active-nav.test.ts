import { describe, expect, it } from "vitest";
import {
  HEADER_LINKS,
  TONE_TILE_CLASSES,
  activeNavFor,
  ariaCurrentFor,
  normalizePath,
  toIconName,
  toNavProducts,
} from "@/components/store/active-nav";
import { TONE_NAMES } from "@/lib/design/tokens";

describe("normalizePath", () => {
  it("drops the query, the hash and trailing or duplicate slashes", () => {
    expect(normalizePath("/software/?category=retail#plans")).toBe("/software");
    expect(normalizePath("/docs//install/")).toBe("/docs/install");
    expect(normalizePath("pricing")).toBe("/pricing");
  });

  it("treats empty input as the home page", () => {
    expect(normalizePath(undefined)).toBe("/");
    expect(normalizePath(null)).toBe("/");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/?q=1")).toBe("/");
  });
});

describe("activeNavFor", () => {
  it.each([
    ["/software", "software"],
    ["/software/medical-billing", "software"],
    ["/software?category=pharmacy", "software"],
    ["/compare", "software"],
    ["/compare?ids=a,b", "software"],
    ["/cart", "software"],
    ["/pricing", "pricing"],
    ["/pricing#maintenance", "pricing"],
    ["/docs", "resources"],
    ["/docs/install", "resources"],
    ["/about", "resources"],
    ["/support", "support"],
    ["/support/", "support"],
  ] as const)("%s -> %s", (path, key) => {
    expect(activeNavFor(path)).toBe(key);
  });

  it.each(["/", "/contact", "/contact?type=demo", "/legal/terms", "/orders/AX-10231", "/sign-in", "/missing"])(
    "%s highlights nothing",
    (path) => {
      expect(activeNavFor(path)).toBeNull();
    },
  );

  it("matches whole path segments only", () => {
    expect(activeNavFor("/software-old")).toBeNull();
    expect(activeNavFor("/pricingx")).toBeNull();
    expect(activeNavFor("/documents")).toBeNull();
    // The portal's software page is not the catalog.
    expect(activeNavFor("/account/software")).toBeNull();
  });
});

describe("ariaCurrentFor", () => {
  it("is page on the link's own page", () => {
    expect(ariaCurrentFor("/pricing", "/pricing", "pricing")).toBe("page");
    expect(ariaCurrentFor("/pricing/", "/pricing")).toBe("page");
    expect(ariaCurrentFor("/software/medical-billing", "/software/medical-billing")).toBe("page");
  });

  it("is true for the highlighted item of the page's section", () => {
    expect(ariaCurrentFor("/docs/install", "/docs", "resources")).toBe("true");
    expect(ariaCurrentFor("/about", "/docs", "resources")).toBe("true");
    expect(ariaCurrentFor("/software/medical-billing", "/software", "software")).toBe("true");
  });

  it("is undefined elsewhere", () => {
    expect(ariaCurrentFor("/", "/pricing", "pricing")).toBeUndefined();
    expect(ariaCurrentFor("/docs/install", "/docs")).toBeUndefined();
    expect(ariaCurrentFor("/support", "/docs", "resources")).toBeUndefined();
  });
});

describe("HEADER_LINKS", () => {
  it("lists Pricing, Resources and Support in prototype order, each inside its own section", () => {
    expect(HEADER_LINKS.map((l) => l.label)).toEqual(["Pricing", "Resources", "Support"]);
    for (const link of HEADER_LINKS) expect(activeNavFor(link.href)).toBe(link.key);
  });
});

describe("toNavProducts", () => {
  const source = [
    { id: "medical-billing", name: "Medical Store Billing Software", shortName: "Medical Store Billing", tagline: "T1", icon: "medication", tone: "sage" as const, extra: 1 },
    { id: "unknown-icon", name: "Other", shortName: "Other", tagline: "T2", icon: "not_an_icon", tone: "blue" as const },
  ];

  it("keeps order and maps slug, names, tone and the product URL", () => {
    const rows = toNavProducts(source);
    expect(rows).toEqual([
      {
        slug: "medical-billing",
        name: "Medical Store Billing Software",
        shortName: "Medical Store Billing",
        tagline: "T1",
        icon: "medication",
        tone: "sage",
        href: "/software/medical-billing",
      },
      { slug: "unknown-icon", name: "Other", shortName: "Other", tagline: "T2", icon: "storefront", tone: "blue", href: "/software/unknown-icon" },
    ]);
  });

  it("falls back for icons missing from the registry", () => {
    expect(toIconName("medication")).toBe("medication");
    expect(toIconName("nope")).toBe("storefront");
    expect(toIconName(null, "info")).toBe("info");
    expect(toIconName("toString")).toBe("storefront");
  });
});

describe("TONE_TILE_CLASSES", () => {
  it("pairs each tone's background with its foreground", () => {
    expect(Object.keys(TONE_TILE_CLASSES).sort()).toEqual([...TONE_NAMES].sort());
    for (const tone of TONE_NAMES) expect(TONE_TILE_CLASSES[tone]).toBe(`bg-${tone}-bg text-${tone}-fg`);
  });
});
