/**
 * Order page key strip: hiding a delivered key (the Hide button or the 60 s timer) unmounts its Hide and Copy key
 * buttons. Focus must move to the key text of that license instead of dropping to <body>.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expiredKeyIds,
  keyToRefocus,
  licenseKeyDomId,
  licenseKeyStripDomId,
  withoutKeyIds,
} from "@/components/store/order/order-model";

const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("key strip focus helpers", () => {
  it("give each license a key text id and a strip id", () => {
    expect(licenseKeyDomId("lic_1")).toBe("license-key-lic_1");
    expect(licenseKeyStripDomId("lic_1")).toBe("license-key-strip-lic_1");
    expect(licenseKeyDomId("lic_1")).not.toBe(licenseKeyStripDomId("lic_1"));
  });

  it("finds the keys whose 60 s are over", () => {
    const keys = { a: { until: 1_000 }, b: { until: 2_000 }, c: { until: 1_500 } };
    expect(expiredKeyIds(keys, 999)).toEqual([]);
    expect(expiredKeyIds(keys, 1_000)).toEqual(["a"]);
    expect(expiredKeyIds(keys, 1_600).sort()).toEqual(["a", "c"]);
  });

  it("removes keys, keeping the same object when nothing changes (no extra render)", () => {
    const keys = { a: { key: "K1", until: 1 }, b: { key: "K2", until: 2 } };
    expect(withoutKeyIds(keys, [])).toBe(keys);
    expect(withoutKeyIds(keys, ["zz"])).toBe(keys);
    expect(withoutKeyIds(keys, ["a"])).toEqual({ b: { key: "K2", until: 2 } });
    expect(withoutKeyIds(keys, ["a", "b"])).toEqual({});
  });

  it("refocuses only the hidden key whose strip holds focus", () => {
    expect(keyToRefocus(["a", "b"], (id) => id === "b")).toBe("b");
    expect(keyToRefocus(["a"], () => false)).toBeNull(); // focus elsewhere on the page stays where it is
    expect(keyToRefocus([], () => true)).toBeNull();
  });
});

describe("wiring (LicenseCard / OrderView)", () => {
  it("makes the key text a programmatic focus target inside the identified strip", () => {
    const card = source("components/store/order/license-card.tsx");
    expect(card).toMatch(/id=\{licenseKeyStripDomId\(license\.id\)\}/);
    expect(card).toMatch(/<code\s+id=\{licenseKeyDomId\(license\.id\)\}\s+tabIndex=\{-1\}/);
  });

  it("moves focus there after Hide and after the timer, never to <body>", () => {
    const view = source("components/store/order/order-view.tsx");
    // Hide: remembers the license, then focuses its key text once the key is gone.
    expect(view).toMatch(/function hideKey\(id: string\) \{\s+if \(keys\[id\]\) refocusKey\.current = id;/);
    expect(view).toMatch(/document\.getElementById\(licenseKeyDomId\(licenseId\)\)\?\.focus\(\)/);
    // Timer: only when focus is inside the expiring key's strip.
    expect(view).toMatch(/keyToRefocus\(expired,[\s\S]*licenseKeyStripDomId\(licenseId\)\)\?\.contains\(focused\)/);
  });
});
