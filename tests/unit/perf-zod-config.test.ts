/**
 * Guards the browser-side Zod switch in instrumentation-client.ts (docs/performance.md, section 1, "Zod's eval probe and
 * the CSP"): setting `globalThis.__zod_globalConfig.jitless = true` before any Zod module runs keeps object schemas from
 * probing `new Function("")` (a CSP violation under a script-src without 'unsafe-eval') without importing Zod on every
 * page. That only works while Zod keeps its global config on that object; this test fails if a Zod upgrade changes it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

type ZodGlobal = typeof globalThis & { __zod_globalConfig?: { jitless?: boolean } };
const zodGlobal = globalThis as ZodGlobal;

describe("zod global config", () => {
  const before = z.config().jitless;
  afterEach(() => {
    z.config({ jitless: before });
  });

  it("is the object on globalThis.__zod_globalConfig", () => {
    expect(zodGlobal.__zod_globalConfig).toBeDefined();
    expect(z.config()).toBe(zodGlobal.__zod_globalConfig);
  });

  it("reads jitless set directly on that object (the instrumentation-client switch)", () => {
    (zodGlobal.__zod_globalConfig ??= {}).jitless = true;
    expect(z.config().jitless).toBe(true);
  });

  it("parses object schemas the same way when jitless", () => {
    (zodGlobal.__zod_globalConfig ??= {}).jitless = true;
    const schema = z.object({ planId: z.string().trim().min(1), qty: z.number().int().min(1) });
    expect(schema.safeParse({ planId: " med-annual ", qty: 2, extra: true })).toEqual({
      success: true,
      data: { planId: "med-annual", qty: 2 },
    });
    expect(schema.safeParse({ planId: "", qty: 0 }).success).toBe(false);
  });
});
