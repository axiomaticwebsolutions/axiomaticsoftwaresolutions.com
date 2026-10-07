import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@/lib/env";
import sitemap from "@/app/sitemap";
import { ROBOTS_DISALLOW } from "@/lib/seo/metadata";
import { fixtureProducts } from "@/lib/storefront/fixtures";

// The storefront data layer reads CATALOG_SOURCE through getEnv(): serve the fixtures (no database needed).
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  getEnv: () => ({ CATALOG_SOURCE: "fixtures" }) as unknown as EnvModule.Env,
}));

const ORIGIN = "https://axiomatic.example";
let savedAppUrl: string | undefined;

beforeAll(() => {
  savedAppUrl = process.env.APP_URL;
  process.env.APP_URL = `${ORIGIN}/`;
});

afterAll(() => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
});

describe("sitemap.xml", () => {
  it("lists the public pages, published products, docs guides and legal documents as absolute URLs", async () => {
    const entries = await sitemap();
    expect(entries.map((e) => e.url)).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/software`,
      `${ORIGIN}/software/medical-billing`,
      `${ORIGIN}/software/restaurant-billing`,
      `${ORIGIN}/software/general-store-gst`,
      `${ORIGIN}/software/cheque-printing`,
      `${ORIGIN}/pricing`,
      `${ORIGIN}/about`,
      `${ORIGIN}/contact`,
      `${ORIGIN}/support`,
      `${ORIGIN}/docs/getting-started`,
      `${ORIGIN}/docs/install`,
      `${ORIGIN}/docs/activate`,
      `${ORIGIN}/docs/move`,
      `${ORIGIN}/docs/renew`,
      `${ORIGIN}/docs/backup`,
      `${ORIGIN}/docs/printers`,
      `${ORIGIN}/docs/troubleshooting`,
      `${ORIGIN}/legal/terms`,
      `${ORIGIN}/legal/privacy`,
      `${ORIGIN}/legal/refund`,
      `${ORIGIN}/legal/eula`,
    ]);
    expect(new Set(entries.map((e) => e.url)).size).toBe(entries.length);
  });

  it("dates each product by its newest published release", async () => {
    const entries = await sitemap();
    for (const product of fixtureProducts()) {
      const entry = entries.find((e) => e.url === `${ORIGIN}/software/${product.id}`);
      expect(entry?.lastModified).toBe(product.releases[0]?.releasedAt);
    }
    // Medical Store Billing 4.2.1 was released on 15 Sep 2026 (IST).
    expect(entries.find((e) => e.url.endsWith("/software/medical-billing"))?.lastModified).toBe("2026-09-14T18:30:00.000Z");
  });

  it("dates legal documents by their Last updated day (IST)", async () => {
    const entries = await sitemap();
    const terms = entries.find((e) => e.url.endsWith("/legal/terms"));
    expect(terms?.lastModified).toEqual(new Date("2026-10-06T18:30:00.000Z"));
  });

  it("leaves out redirects, /compare, filtered catalog URLs and every disallowed area", async () => {
    const paths = (await sitemap()).map((e) => new URL(e.url).pathname);
    expect(paths).not.toContain("/docs");
    expect(paths).not.toContain("/legal");
    expect(paths.some((p) => p.startsWith("/compare"))).toBe(false);
    expect((await sitemap()).some((e) => e.url.includes("?"))).toBe(false);
    for (const disallowed of ROBOTS_DISALLOW) {
      expect(paths.some((p) => p === disallowed || p.startsWith(`${disallowed}/`))).toBe(false);
    }
    expect(paths).not.toContain("/sign-in");
  });
});
