/**
 * Test plan E2E 6 at 360 px (project "mobile"): the storefront navigation menu (with its "Coming soon" category
 * disclosures, decisions.md 2026-10-09), the catalog filters drawer, the portal and admin sidebars as drawers, and
 * data tables shown as cards. No page may scroll sideways, and every open drawer passes axe (WCAG 2.0 A/AA, 2.1 AA).
 */
import type { Page } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { signInAs, waitForHydration } from "./support/auth";
import { PEOPLE } from "./support/env";
import { expect, test } from "./support/fixtures";
import { go, warm } from "./support/guard";

/** Horizontal overflow of the page in px (0 when nothing scrolls sideways). */
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** At this width every data table is a list of cards: the cards are visible, the <table> is not. */
async function expectCards(page: Page, label: string) {
  await expect(page.locator("main [data-slot='data-table-cards']").filter({ visible: true }).first(), `${label}: cards`).toBeVisible();
  await expect(page.locator("main table").filter({ visible: true }), `${label}: no visible table`).toHaveCount(0);
  const cards = page.locator("main [data-slot='data-table-cards'] > li").filter({ visible: true });
  expect(await cards.count(), `${label}: at least one card`).toBeGreaterThan(0);
}

test("storefront: the navigation menu opens, links and closes", async ({ page, problems }) => {
  await go(page, "/", problems);
  await waitForHydration(page, "header button[aria-label='Menu']");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await warm(page, "/software");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Menu" });
  await expect(menu).toBeVisible();
  const nav = menu.getByRole("navigation", { name: "Mobile" });
  await expect(nav.getByRole("link", { name: /Medical Store Billing/ })).toBeVisible();
  // Coming soon: one collapsed disclosure per category; expanding one shows its products, each named "..., coming soon".
  const soon = nav.getByRole("group", { name: "Coming soon", exact: true });
  const soonLinks = soon.getByRole("link", { name: /, coming soon$/ });
  await expect(soonLinks).toHaveCount(0);
  const category = soon.getByRole("button", { name: /^Retail & Grocery/ });
  await expect(category).toHaveAttribute("aria-expanded", "false");
  await category.click();
  await expect(category).toHaveAttribute("aria-expanded", "true");
  await expect(soonLinks.first()).toBeVisible();
  await expect(soon.getByRole("link", { name: /^See all coming soon/ })).toHaveAttribute("href", "/software?availability=coming-soon");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await nav.evaluate((el) => el.scrollWidth - el.clientWidth), "the panel does not scroll sideways").toBeLessThanOrEqual(0);
  await expectNoAxeViolations(page, "storefront menu open");
  await category.click();
  await expect(category).toHaveAttribute("aria-expanded", "false");
  await expect(soonLinks).toHaveCount(0);
  await nav.getByRole("link", { name: /Browse all software/ }).click();
  await page.waitForURL((url) => url.pathname === "/software");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("catalog: the filters drawer narrows the results", async ({ page, problems }) => {
  await go(page, "/software", problems);
  const trigger = page.getByRole("button", { name: /^Filters/ });
  await waitForHydration(page, "main form button");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await expect(page.getByRole("complementary", { name: "Filters" })).toBeHidden();
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "Filters" });
  await expect(drawer).toBeVisible();
  await expectNoAxeViolations(page, "filters drawer open");
  const label = "Medical & Pharmacy";
  const option = drawer.getByRole("checkbox", { name: new RegExp(`^${label}`) });
  await option.click();
  await expect(option).toBeChecked();
  await drawer.getByRole("button", { name: /^Show \d+ results?$/ }).click();
  await expect(drawer).toBeHidden();
  await expect(trigger).toHaveText(/Filters \(1\)/);
  await expect(page.getByRole("button", { name: `Remove filter ${label}` })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("portal: the sidebar is a drawer and tables are cards", async ({ page, context, problems }) => {
  await signInAs(context, PEOPLE.kavya());
  await go(page, "/account/licenses", problems);
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Account" })).toBeHidden();
  await expectCards(page, "/account/licenses");
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await warm(page, "/account/devices");
  await page.getByRole("button", { name: "Open menu" }).click();
  const drawer = page.getByRole("dialog", { name: "Account navigation" });
  await expect(drawer).toBeVisible();
  await expectNoAxeViolations(page, "portal drawer open");
  await drawer.getByRole("navigation", { name: "Account" }).getByRole("link", { name: /^Devices/ }).click();
  await page.waitForURL((url) => url.pathname === "/account/devices");
  await expect(drawer).toBeHidden();
  await expectCards(page, "/account/devices");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("admin: the sidebar is a drawer and tables are cards", async ({ page, context, problems }) => {
  await signInAs(context, PEOPLE.support());
  await go(page, "/admin/licenses", problems);
  await expect(page.locator("main h1")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Admin" })).toBeHidden();
  await expectCards(page, "/admin/licenses");
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await warm(page, "/admin/tickets");
  await page.getByRole("button", { name: "Open menu" }).click();
  const drawer = page.getByRole("dialog", { name: "Admin navigation" });
  await expect(drawer).toBeVisible();
  await expectNoAxeViolations(page, "admin drawer open");
  await drawer.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: /^Tickets/ }).click();
  await page.waitForURL((url) => url.pathname === "/admin/tickets");
  await expect(drawer).toBeHidden();
  await expectCards(page, "/admin/tickets");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});
