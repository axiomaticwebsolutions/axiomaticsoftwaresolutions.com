import { readFileSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import { beforeAll, describe, expect, it } from "vitest";
import { returnFocusTarget } from "@/components/ui/return-focus";
import { palette, screens } from "@/lib/design/tokens";

const ROOT = process.cwd();
const source = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** WCAG 2.x contrast ratio for #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("compiled CSS (app/globals.css through Tailwind)", () => {
  let css = "";

  beforeAll(async () => {
    const from = join(ROOT, "app/globals.css");
    const candidates = "sm:p-1 md:p-2 cards:p-3 catalog:p-4 nav:p-5 portal:p-6 lg:p-7 admin:p-8 xl:p-9 field-focus";
    const input = `${readFileSync(from, "utf8")}\n@source inline("${candidates}");\n`;
    css = (await postcss([tailwindcss({ base: ROOT })]).process(input, { from })).css;
  }, 60_000);

  /** Name of the innermost `@layer x {` block that opened before `selector`. */
  function layerOf(selector: string): string | null {
    const at = css.indexOf(selector);
    if (at < 0) return null;
    return [...css.slice(0, at).matchAll(/@layer ([a-z]+) \{/g)].pop()?.[1] ?? null;
  }

  it("puts the control focus styles after border-line-input in the utilities layer, so focus wins", () => {
    expect(layerOf(".border-line-input")).toBe("utilities");
    expect(layerOf(".focus-visible\\:border-primary:focus-visible")).toBe("utilities");
    expect(layerOf(".field-focus:focus-visible")).toBe("utilities");
    expect(css.indexOf(".focus-visible\\:border-primary:focus-visible")).toBeGreaterThan(css.indexOf(".border-line-input"));
    // Invalid fields keep the danger border while focused (higher specificity than the plain focus utility).
    expect(css).toContain('.aria-invalid\\:focus-visible\\:border-danger-border[aria-invalid="true"]:focus-visible');
  });

  it("emits every breakpoint, custom and default, in ascending width order", () => {
    const widths = [...new Set([...css.matchAll(/@media \(width >= ([\d.]+)(px|rem)\)/g)].map((m) => `${m[1]}${m[2]}`))];
    const px = widths.map((w) => (w.endsWith("rem") ? parseFloat(w) * 16 : parseFloat(w)));
    expect(px).toEqual([...px].sort((a, b) => a - b));
    for (const value of Object.values(screens)) expect(widths).toContain(value);
  });

  it("generates the interactive-card focus ring and the line.control boundaries", () => {
    expect(css).toContain(".has-focus-visible\\:outline-primary:has(:focus-visible)");
    expect(css).toContain(".has-focus-visible\\:border-primary:has(:focus-visible)");
    expect(css).toMatch(/\.border-line-control \{\s*border-color: #7C8597;/);
    expect(css).toMatch(/\.bg-line-control \{\s*background-color: #7C8597;/);
  });
});

describe("custom breakpoints", () => {
  it("use rem like Tailwind's defaults (mixed units are not sorted against each other)", () => {
    for (const value of Object.values(screens)) expect(value).toMatch(/^\d+(\.\d+)?rem$/);
    expect(Object.values(screens).map((v) => parseFloat(v) * 16)).toEqual([760, 900, 960, 1000, 1040]);
  });
});

describe("non-text contrast (WCAG 1.4.11)", () => {
  it("line.control keeps control boundaries at 3:1 or more on every page background", () => {
    for (const bg of [palette.surface, palette.bg.DEFAULT, palette.bg.portal, palette.bg.admin]) {
      expect(contrast(palette.line.control, bg), bg).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(palette.line.input, palette.surface)).toBeLessThan(3);
  });

  it("unchecked checkbox and radio borders and the switch off-track use line.control", () => {
    expect(source("components/ui/checkbox.tsx")).toContain("border-line-control");
    expect(source("components/ui/radio-group.tsx")).toContain("border-line-control");
    expect(source("components/ui/switch.tsx")).toContain("bg-line-control");
    for (const file of ["checkbox", "radio-group", "switch"]) {
      expect(source(`components/ui/${file}.tsx`), file).not.toMatch(/(border|bg)-line-input/);
    }
  });
});

describe("returnFocusTarget", () => {
  type Fake = {
    id: string;
    attrs: Record<string, string>;
    parent: Fake | null;
    ownerDocument: FakeDoc;
    focus: () => void;
    getAttribute: (name: string) => string | null;
    closest: (selector: string) => Fake | null;
  };
  type FakeDoc = {
    body: Fake | null;
    getElementById: (id: string) => Fake | null;
    querySelector: (selector: string) => Fake | null;
  };

  /** Just enough DOM for returnFocusTarget: ids, attributes, parents, closest('[role="..."]'). */
  function fakeDom() {
    const all: Fake[] = [];
    const doc: FakeDoc = {
      body: null,
      getElementById: (id) => all.find((n) => n.id === id) ?? null,
      querySelector: (selector) => {
        const id = /^\[aria-controls="(.+)"\]$/.exec(selector)?.[1];
        return all.find((n) => n.attrs["aria-controls"] === id) ?? null;
      },
    };
    const el = (id: string, attrs: Record<string, string> = {}, parent: Fake | null = doc.body): Fake => {
      const node: Fake = {
        id,
        attrs,
        parent,
        ownerDocument: doc,
        focus: () => undefined,
        getAttribute: (name) => attrs[name] ?? null,
        closest: (selector) => {
          const role = /^\[role="(.+)"\]$/.exec(selector)?.[1];
          for (let n: Fake | null = node; n; n = n.parent) if (n.attrs.role === role) return n;
          return null;
        },
      };
      all.push(node);
      return node;
    };
    doc.body = el("body", {}, null);
    return { doc, el };
  }
  const target = (node: Fake | null) => returnFocusTarget(node as unknown as Element);

  it("returns a plain opener unchanged and ignores <body>", () => {
    const { doc, el } = fakeDom();
    const button = el("open-dialog");
    expect(target(button)).toBe(button);
    expect(target(doc.body)).toBeNull();
    expect(target(null)).toBeNull();
  });

  it("maps a menu item to its menu's trigger, which outlives the menu, and climbs out of submenus", () => {
    const { el } = fakeDom();
    const trigger = el("menu-trigger", { "aria-haspopup": "menu" });
    const menu = el("menu-content", { role: "menu", "aria-labelledby": "menu-trigger" });
    el("sub-trigger", { role: "menuitem" }, menu);
    const submenu = el("sub-content", { role: "menu", "aria-labelledby": "sub-trigger" });
    expect(target(el("revoke", { role: "menuitem" }, menu))).toBe(trigger);
    expect(target(el("export", { role: "menuitem" }, submenu))).toBe(trigger);
  });

  it("falls back to the trigger's aria-controls, and to null when no trigger is found", () => {
    const { el } = fakeDom();
    const trigger = el("t", { "aria-controls": "m" });
    const menu = el("m", { role: "menu" });
    expect(target(el("i", { role: "menuitem" }, menu))).toBe(trigger);
    const orphan = el("o", { role: "menu" });
    expect(target(el("j", { role: "menuitem" }, orphan))).toBeNull();
  });
});
