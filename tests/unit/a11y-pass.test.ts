/**
 * Guards for the Phase 7 accessibility pass (docs/accessibility.md): forced colours (Windows contrast themes),
 * reflow of wide tables, reduced motion and focus rings of text fields. Source-level checks, like
 * focus-outline-classes.test.ts and design-a11y.test.ts; scripts/check-a11y.mjs checks the same in a browser.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const source = (file: string) => readFileSync(join(ROOT, file), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "dev" ? [] : sourceFiles(path);
    return /\.(tsx|ts)$/.test(name) ? [path] : [];
  });
}

const UI_FILES = [...sourceFiles(join(ROOT, "components")), ...sourceFiles(join(ROOT, "app"))];

describe("forced colours (compiled CSS)", () => {
  let css = "";

  beforeAll(async () => {
    const from = join(ROOT, "app/globals.css");
    const candidates =
      "forced-colors:border forced-colors:border-[color:ButtonText] forced-colors:bg-[color:Highlight] forced-color-adjust-none focus-visible:outline-hidden";
    const input = `${readFileSync(from, "utf8")}\n@source inline("${candidates}");\n`;
    css = (await postcss([tailwindcss({ base: ROOT })]).process(input, { from })).css;
  }, 60_000);

  /** The body of the first `@media (forced-colors: active)` block that contains `needle`. */
  function forcedBlockWith(needle: string): string {
    for (const m of css.matchAll(/@media \(forced-colors: active\) \{/g)) {
      const start = m.index ?? 0;
      let depth = 0;
      for (let i = start; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) {
          const block = css.slice(start, i + 1);
          if (block.includes(needle)) return block;
          break;
        }
      }
    }
    return "";
  }

  it("draws selected, pressed, current and highlighted states with the system highlight", () => {
    const block = forcedBlockWith('[aria-pressed="true"]');
    expect(block).not.toBe("");
    for (const selector of ['[aria-current]:not([aria-current="false"])', '[role="tab"][aria-selected="true"]', '[role="option"][data-highlighted]', '[role^="menuitem"][data-highlighted]']) {
      expect(block, selector).toContain(selector);
    }
    expect(block).toContain("forced-color-adjust: none");
    expect(block).toContain("background-color: Highlight");
    expect(block).toContain("color: HighlightText");
    // The price toggle's pressed look comes from <html data-price> before hydration.
    expect(forcedBlockWith("[data-price-toggle]")).toContain("Highlight");
  });

  it("compiles the forced-colors utilities the components use", () => {
    expect(css).toContain(".forced-colors\\:border");
    expect(css).toContain("ButtonText");
    // outline-hidden keeps a transparent 2px outline that the browser paints in forced colours.
    expect(forcedBlockWith("outline: 2px solid transparent")).not.toBe("");
  });
});

describe("forced colours (components)", () => {
  it("buttons keep a system-colour border, link buttons excepted", () => {
    const button = source("components/ui/button.tsx");
    expect(button).toContain("forced-colors:border forced-colors:border-[color:ButtonText]");
    expect(button).toContain('variant: "link", className: "rounded-6 p-0 forced-colors:border-0"');
  });

  it("the switch and the radio dot stay visible", () => {
    const sw = source("components/ui/switch.tsx");
    expect(sw).toContain("forced-colors:border forced-colors:border-[color:CanvasText]");
    expect(sw).toContain("forced-colors:data-[state=checked]:bg-[color:Highlight]");
    expect(sw).toContain("forced-colors:bg-[color:CanvasText]");
    expect(source("components/ui/radio-group.tsx")).toContain("forced-colors:bg-[color:CanvasText]");
  });

  it("text fields hide their outline with outline-hidden (never outline-none) when focused", () => {
    const offenders = UI_FILES.filter((file) => readFileSync(file, "utf8").includes("focus-visible:outline-none")).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("charts and usage bars keep their colours", () => {
    for (const file of [
      "components/admin/overview/overview-panels.tsx",
      "components/admin/overview/revenue-chart.tsx",
      "components/admin/reports/report-panels.tsx",
      "components/account/overview/overview-view.tsx",
      "components/account/licenses/licenses-columns.tsx",
      "components/account/licenses/license-devices-tab.tsx",
      "components/admin/licenses/cells.tsx",
    ]) {
      expect(source(file), file).toContain("forced-color-adjust-none");
    }
  });
});

describe("reflow (WCAG 1.4.10, 1.4.12)", () => {
  /**
   * Every <table> scrolls inside its own container, never the page: ScrollRegion (focusable while it overflows) or a
   * region of its own. Listed exceptions say why.
   */
  const EXCEPTIONS: Record<string, string> = {
    "components/admin/overview/revenue-chart.tsx": "a visually hidden data table (the chart's text alternative)",
    "components/account/team/members-card.tsx": "every row holds controls, so Tab scrolls the table",
  };

  it("wraps every table in a scroll container", () => {
    const offenders: string[] = [];
    for (const file of UI_FILES) {
      const text = readFileSync(file, "utf8");
      if (!/<table[\s>]/.test(text)) continue;
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (EXCEPTIONS[rel]) continue;
      if (!text.includes("<ScrollRegion") && !/role="region"/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe("reduced motion (WCAG 2.3.3)", () => {
  it("checks prefers-reduced-motion wherever a smooth scroll is requested from script", () => {
    const offenders = UI_FILES.filter((file) => {
      const text = readFileSync(file, "utf8");
      return /behavior: ["']smooth["']/.test(text) && !text.includes("prefers-reduced-motion");
    }).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
