/**
 * Bundle-size guards (docs/performance.md "JS per page"). Source-level checks that keep two measured savings:
 * - Server-renderable modules (no leading "use client") never import the `radix-ui` barrel. Importing it from a
 *   component that also renders on the storefront pulled every Radix primitive into the client graph; use the deep
 *   entries instead (`import * as Slot from "radix-ui/slot"`).
 * - The storefront's always-loaded client modules (cart and compare stores, the header account menu) do not import Zod
 *   or the auth/validation modules that carry the Zod schemas (75-112 kB of first-load JS on every storefront page).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const rel = (path: string) => relative(ROOT, path).split("\\").join("/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx|ts)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** True when the module starts (after comments and blank lines) with the "use client" directive. */
function isClientModule(src: string): boolean {
  const body = src.replace(/^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return /^["']use client["']/.test(body);
}

/** Module specifiers of every static import / export-from / dynamic import in `src`. */
function importedSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) out.push(m[1] as string);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1] as string);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1] as string);
  return out;
}

describe("isClientModule", () => {
  it("finds the directive after comments and blank lines only", () => {
    expect(isClientModule('"use client";\nimport x from "y";')).toBe(true);
    expect(isClientModule("/** doc */\n// note\n\n'use client';\n")).toBe(true);
    expect(isClientModule('import x from "y";\n"use client";\n')).toBe(false);
    expect(isClientModule('export const a = "use client";')).toBe(false);
  });
});

describe("radix-ui barrel", () => {
  it("is never imported by a module without a leading \"use client\"", () => {
    const offenders = ["components", "lib", "app"]
      .flatMap((dir) => sourceFiles(join(ROOT, dir)))
      .filter((file) => {
        const src = readFileSync(file, "utf8");
        return !isClientModule(src) && importedSpecifiers(src).includes("radix-ui");
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("storefront client graph", () => {
  const ALWAYS_LOADED = [
    "lib/cart/store.ts",
    "lib/compare/store.ts",
    "components/auth/account-menu-model.ts",
    "components/store/account-menu.tsx",
  ];
  const FORBIDDEN = (specifier: string) =>
    specifier === "zod" ||
    specifier.startsWith("zod/") ||
    specifier === "@/components/auth/auth-model" ||
    specifier === "./auth-model" ||
    specifier.startsWith("@/lib/validation");

  it.each(ALWAYS_LOADED)("%s imports neither Zod nor the auth/validation schemas", (file) => {
    const forbidden = importedSpecifiers(readFileSync(join(ROOT, file), "utf8")).filter(FORBIDDEN);
    expect(forbidden).toEqual([]);
  });

  it("instrumentation-client.ts sets Zod's jitless flag without importing Zod", () => {
    const src = readFileSync(join(ROOT, "instrumentation-client.ts"), "utf8");
    expect(importedSpecifiers(src).filter(FORBIDDEN)).toEqual([]);
    expect(src).toContain("__zod_globalConfig");
  });
});
