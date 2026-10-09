/**
 * The storefront Software menu at desktop widths (design C "Featured + directory", decisions.md 2026-10-09): the
 * "Available now" tiles, the "Coming soon" directory with every COMING_SOON product (each link named "<name>, coming
 * soon"), the panel inside the viewport at 1024 and 1280px, axe with the menu open, the keyboard (arrows through every
 * link, Home/End, Escape returns focus), an outside click, and following a link closes it.
 */
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { waitForHydration } from "./support/auth";
import { expect, test } from "./support/fixtures";
import { go, warm } from "./support/guard";

const TRIGGER = "#site-header nav[aria-label='Primary'] button[aria-controls]";

const trigger = (page: Page) => page.locator(TRIGGER, { hasText: "Software" });

async function menuOf(page: Page): Promise<Locator> {
  const id = await trigger(page).getAttribute("aria-controls");
  expect(id, "the trigger controls the menu").toBeTruthy();
  return page.locator(`[id="${id}"]`);
}

async function load(page: Page, path: string, problems: Parameters<typeof go>[2]): Promise<Locator> {
  await go(page, path, problems);
  await waitForHydration(page, TRIGGER);
  return menuOf(page);
}

for (const width of [1024, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("lists the products on sale and every coming-soon product, inside the viewport", async ({ page, db, problems }) => {
      const menu = await load(page, "/pricing", problems);
      await expect(menu).toBeHidden();
      await trigger(page).click();
      await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
      await expect(menu).toBeVisible();

      const available = menu.getByRole("group", { name: "Available now", exact: true });
      await expect(available.getByRole("link", { name: /Medical Store Billing/ })).toBeVisible();

      const soon = menu.getByRole("group", { name: "Coming soon", exact: true });
      const rows = await db.all<{ shortName: string }>(`SELECT "shortName" FROM "Product" WHERE status = 'COMING_SOON' ORDER BY rank`);
      expect(rows.length, "the seed has coming-soon products").toBeGreaterThan(0);
      const links = soon.getByRole("link", { name: /, coming soon$/ });
      await expect(links).toHaveCount(rows.length);
      for (const row of rows) await expect(soon.getByRole("link", { name: `${row.shortName}, coming soon`, exact: true })).toBeVisible();
      // Grouped under labelled categories.
      await expect(soon.getByRole("group", { name: "Retail & Grocery", exact: true }).getByRole("link")).not.toHaveCount(0);
      await expect(soon.getByRole("link", { name: /^See all coming soon/ })).toHaveAttribute("href", "/software?availability=coming-soon");
      await expect(menu.getByRole("link", { name: /^Browse all software/ })).toHaveAttribute("href", "/software");

      // The panel never leaves the viewport and the page never scrolls sideways.
      const box = await menu.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, bottom: r.bottom, vw: document.documentElement.clientWidth, vh: window.innerHeight };
      });
      expect(box.left, "menu left edge").toBeGreaterThanOrEqual(0);
      expect(box.right, "menu right edge").toBeLessThanOrEqual(box.vw);
      expect(box.bottom, "menu bottom edge").toBeLessThanOrEqual(box.vh);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await expectNoAxeViolations(page, `Software menu open @${width}`);

      // A click outside closes it.
      await page.mouse.click(5, box.vh - 5);
      await expect(menu).toBeHidden();
      await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
    });
  });
}

test("keyboard: arrows move through every link, Home/End jump, Escape returns focus; a link closes the menu", async ({ page, problems }) => {
  const menu = await load(page, "/pricing", problems);
  const button = trigger(page);
  const focusedName = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return (el?.getAttribute("aria-label") ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();
    });
  const links = menu.locator("a[href]");

  await button.focus();
  await page.keyboard.press("ArrowDown");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(links.first()).toBeFocused();
  const count = await links.count();
  const lastName = ((await links.last().textContent()) ?? "").trim();
  expect(lastName).toBe("Book a demo");

  // ArrowDown walks the links in DOM order: tiles, "See all coming soon", the directory, the bottom bar.
  const names: string[] = [await focusedName()];
  for (let i = 1; i < count; i++) {
    await page.keyboard.press("ArrowDown");
    names.push(await focusedName());
  }
  expect(names[names.length - 1]).toBe("Book a demo");
  expect(new Set(names).size, "every link is reached once").toBe(count);
  expect(names.some((n) => /, coming soon$/.test(n)), "the walk reaches the coming-soon links").toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect(links.first(), "ArrowDown wraps to the first link").toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(links.last(), "ArrowUp wraps to the last link").toBeFocused();
  await page.keyboard.press("Home");
  await expect(links.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(links.last()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).toBeFocused();

  // ArrowUp opens on the last link; Tab past it closes the menu.
  await page.keyboard.press("ArrowUp");
  await expect(links.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu).toBeHidden();

  // Following a coming-soon link closes the menu; on that page the link is the current page.
  await trigger(page).click();
  const link = menu.getByRole("link", { name: /, coming soon$/ }).first();
  const href = (await link.getAttribute("href")) ?? "";
  expect(href).toMatch(/^\/software\/[a-z0-9-]+$/);
  await warm(page, href);
  await link.click();
  await page.waitForURL((url) => url.pathname === href);
  await expect(menu).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await trigger(page).click();
  await expect(menu.locator(`a[href="${href}"]`)).toHaveAttribute("aria-current", "page");
  await expect(trigger(page)).toHaveAttribute("aria-current", "true");
});
