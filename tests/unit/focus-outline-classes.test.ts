/**
 * Tailwind 4 focus rings: `outline-none` / `outline-hidden` set `--tw-outline-style: none`, and the width utilities
 * (`outline-2`) only set `outline-style: var(--tw-outline-style)`, so `outline-none focus-visible:outline-2` draws no
 * ring at all. The checkout error summary and server-error banner had exactly that (focused on submit, no ring).
 * Every class list that hides the outline and adds a focus outline width must also restore a style.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx|ts)$/.test(name) ? [path] : [];
  });
}

/** String literals (quoted or template) that look like class lists. */
function classLists(source: string): string[] {
  return [...source.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? "").filter((s) => /\boutline-/.test(s));
}

const HIDES = /(^|\s)outline-(none|hidden)(\s|$)/;
const FOCUS_WIDTH = /(^|\s)(focus|focus-visible|focus-within):outline-(\d+|\[[^\]]+\])(\s|$)/;
const FOCUS_STYLE = /(^|\s)(focus|focus-visible|focus-within):outline-(solid|dashed|dotted|double)(\s|$)/;

describe("focus outline class lists (components/, app/)", () => {
  it("restore an outline style wherever the outline is hidden and a focus outline width is added", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(join(ROOT, "components")), ...sourceFiles(join(ROOT, "app"))]) {
      for (const list of classLists(readFileSync(file, "utf8"))) {
        if (HIDES.test(list) && FOCUS_WIDTH.test(list) && !FOCUS_STYLE.test(list)) offenders.push(`${relative(ROOT, file)}: ${list}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("checks the pattern that broke the checkout alerts", () => {
    const broken = "flex text-danger outline-none focus-visible:outline-2 focus-visible:outline-danger";
    const fixed =
      "flex text-danger outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger scroll-mt-6";
    expect(HIDES.test(broken) && FOCUS_WIDTH.test(broken) && !FOCUS_STYLE.test(broken)).toBe(true);
    expect(FOCUS_STYLE.test(fixed)).toBe(true);
    const checkout = readFileSync(join(ROOT, "components/checkout/checkout-view.tsx"), "utf8");
    expect(checkout).toContain(fixed.replace("flex text-danger ", "flex gap-2.5 rounded-14 bg-pink-bg px-[18px] py-3.5 font-bold text-danger "));
  });
});

describe("compiled Tailwind outline utilities", () => {
  it("need outline-solid to undo outline-hidden / outline-none (the reason for the rule above)", async () => {
    const from = join(ROOT, "app/globals.css");
    const candidates = "outline-none outline-hidden focus-visible:outline-2 focus-visible:outline-solid";
    const input = `${readFileSync(from, "utf8")}\n@source inline("${candidates}");\n`;
    const css = (await postcss([tailwindcss({ base: ROOT })]).process(input, { from })).css;
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(rule(".outline-none")).toContain("--tw-outline-style: none");
    expect(rule(".outline-hidden")).toContain("--tw-outline-style: none");
    expect(rule(".focus-visible\\:outline-2:focus-visible")).toContain("outline-style: var(--tw-outline-style)");
    expect(rule(".focus-visible\\:outline-solid:focus-visible")).toContain("--tw-outline-style: solid");
  }, 60_000);
});
