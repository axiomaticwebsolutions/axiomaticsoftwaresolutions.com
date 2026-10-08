import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard (decisions.md 2026-10-08). With `export const dynamicParams = false`, Next.js 15.5 answers 404 for
 * a prerendered path once revalidateTag() has run for a tag the page uses: the cache reports a miss, and production
 * treats a miss under `fallback: false` as "never prerendered" (NoFallbackError). Every Admin catalog, content or
 * settings save calls revalidateTag(), so /legal/* and /docs/* went 404 on the live site after an Admin edit. Pages
 * reject unknown params with notFound() instead.
 */
const APP_DIR = join(process.cwd(), "app");

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return /^(page|layout)\.(tsx|ts|jsx|js)$/.test(entry.name) ? [path] : [];
  });
}

describe("dynamicParams = false", () => {
  it("is not used by any app page or layout", () => {
    const offenders = pageFiles(APP_DIR)
      .filter((file) => /export\s+const\s+dynamicParams\s*=\s*false/.test(readFileSync(file, "utf8")))
      .map((file) => relative(process.cwd(), file));
    expect(offenders).toEqual([]);
  });

  it("finds the pages it scans (the guard is not vacuous)", () => {
    const files = pageFiles(APP_DIR).map((file) => relative(process.cwd(), file).split("\\").join("/"));
    expect(files).toContain("app/(store)/legal/[doc]/page.tsx");
    expect(files).toContain("app/(store)/docs/[slug]/page.tsx");
  });
});
