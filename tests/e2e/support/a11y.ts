/**
 * axe-core check of the page as it is now (e.g. with a drawer open, a state the check-* crawls never reach), for the
 * WCAG 2.0 A/AA and 2.1 AA rules the check scripts use.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];

export async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  // A drawer still sliding in is half transparent: let running animations finish (contrast is measured).
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), undefined, { timeout: 5_000 })
    .catch(() => undefined);
  const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const violations = result.violations.map(
    (v) => `${v.id} (${v.impact ?? "?"}, ${v.nodes.length}): ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`,
  );
  expect(violations, `${label}: axe violations`).toEqual([]);
}
