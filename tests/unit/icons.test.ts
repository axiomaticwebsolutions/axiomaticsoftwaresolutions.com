import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_ALIASES, ICON_NAMES } from "@/components/icons/icon-names";
import { ICON_PATHS } from "@/components/icons/registry";

const SOURCE_DIR = join(process.cwd(), "node_modules", "@material-symbols", "svg-400", "rounded");

describe("icon names", () => {
  it("are sorted and unique", () => {
    const sorted = [...new Set(ICON_NAMES)].sort();
    expect([...ICON_NAMES]).toEqual(sorted);
  });

  it("only alias names that are in the list", () => {
    for (const name of Object.keys(ICON_ALIASES)) {
      expect(ICON_NAMES).toContain(name);
    }
  });
});

describe("icon registry", () => {
  it("matches the curated list (run `pnpm icons` after editing icon-names.ts)", () => {
    expect(Object.keys(ICON_PATHS).sort()).toEqual([...ICON_NAMES]);
  });

  it("holds plain SVG path data for the 960-unit grid", () => {
    for (const [name, d] of Object.entries(ICON_PATHS)) {
      expect(d, name).toMatch(/^[Mm]/);
      expect(d, name).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/);
    }
  });

  it.runIf(existsSync(SOURCE_DIR))("resolves every name to a source SVG", () => {
    for (const name of ICON_NAMES) {
      const file = ICON_ALIASES[name] ?? name;
      expect(existsSync(join(SOURCE_DIR, `${file}.svg`)), name).toBe(true);
    }
  });
});
