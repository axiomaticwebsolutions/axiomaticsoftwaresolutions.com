/**
 * Admin > Settings > Integrations as the Owner (docs/admin-integrations-design.md sections 17 and 18): the cards on
 * desktop and at 360 px without horizontal scrolling and without axe violations, write-only secret inputs that no
 * password manager fills (secrets autocomplete="new-password", identifiers autocomplete="off", ignore attributes, ids
 * and names that do not look like a sign-in field; docs/decisions.md 2026-10-08), the email provider switch (SMTP or
 * Amazon SES), cards of one row sharing one height with their footers lined up (1280 and 1920 px), and the keyboard
 * path through the password dialog (an empty and a wrong password show their error inside the dialog; Escape closes it
 * and returns focus to Save).
 *
 * Non-mutating on purpose: a saved storage or email configuration would replace the development drivers under the
 * other specs (global setup refuses to start when one exists). The wrong password is refused before anything is
 * written, which the test checks in the database. Status-only cards are covered by unit tests; saving and the CSP
 * follow-up by the DB tests, the middleware unit tests and the production-build check.
 */
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { PEOPLE } from "./support/env";
import { expect, test } from "./support/fixtures";
import { go } from "./support/guard";

const CARDS = ["Payment provider", "Installer storage", "Email delivery", "Rate limits"];

const SETTINGS_CARDS = [
  "#settings-business",
  "#settings-tax",
  "#settings-licensing",
  "#settings-sample-notice",
  "#integration-payments",
  "#integration-storage",
  "#integration-email",
  "#integration-redis",
];
const LOGIN_LIKE = /user|login|e-?mail/i;
const IGNORE_ATTRIBUTES = [
  ["data-1p-ignore", ""],
  ["data-lpignore", "true"],
  ["data-bwignore", ""],
  ["data-form-type", "other"],
] as const;

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

/** No password manager may fill it: autocomplete, the ignore attributes, and an id and name unlike a sign-in field. */
async function expectNoAutofill(input: Locator, autocomplete: "off" | "new-password"): Promise<void> {
  await expect(input).toHaveAttribute("autocomplete", autocomplete);
  for (const [name, value] of IGNORE_ATTRIBUTES) await expect(input).toHaveAttribute(name, value);
  const [id, name] = await Promise.all([input.getAttribute("id"), input.getAttribute("name")]);
  expect(id ?? "").not.toMatch(LOGIN_LIKE);
  expect(name ?? "").not.toBe("");
  expect(name ?? "").not.toMatch(LOGIN_LIKE);
}

/**
 * Cards whose tops line up form a row: they must share one height and their footers (the Save / test bar) one bottom
 * edge. Returns the number of rows with more than one card.
 */
async function expectEqualRows(page: Page): Promise<number> {
  const cards = await page.evaluate((selectors) => {
    return selectors.map((selector) => {
      const card = document.querySelector(selector);
      const footer = card?.querySelector('[data-slot="settings-card-footer"]');
      const box = card?.getBoundingClientRect();
      const foot = footer?.getBoundingClientRect();
      return { selector, top: Math.round(box?.top ?? -1), height: Math.round(box?.height ?? -1), footerBottom: Math.round(foot?.bottom ?? -1), bottom: Math.round(box?.bottom ?? -1) };
    });
  }, SETTINGS_CARDS);
  const rows = new Map<number, typeof cards>();
  for (const card of cards) {
    expect(card.height, card.selector).toBeGreaterThan(0);
    const key = [...rows.keys()].find((top) => Math.abs(top - card.top) <= 1) ?? card.top;
    rows.set(key, [...(rows.get(key) ?? []), card]);
  }
  let shared = 0;
  for (const row of rows.values()) {
    if (row.length < 2) continue;
    shared += 1;
    const [first] = row;
    for (const card of row) {
      expect(Math.abs(card.height - (first?.height ?? 0)), `${card.selector} height`).toBeLessThanOrEqual(1);
      expect(Math.abs(card.footerBottom - (first?.footerBottom ?? 0)), `${card.selector} footer`).toBeLessThanOrEqual(1);
      expect(Math.abs(card.footerBottom - card.bottom), `${card.selector} footer at the bottom`).toBeLessThanOrEqual(2);
    }
  }
  return shared;
}

test("Owner sees the integration forms on desktop and at 360 px and confirms with a password from the keyboard", async ({ session, db, problems }) => {
  const savedBefore = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "IntegrationConfig"`);
  const owner = await session({ as: PEOPLE.owner() });
  const { page } = owner;
  const section = page.getByRole("region", { name: "Integrations" });

  await test.step("the Integrations section lists the three forms and the rate-limits card", async () => {
    await go(page, "/admin/settings", problems);
    for (const title of CARDS) await expect(section.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const payments = page.locator("#integration-payments");
    await expect(payments.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(payments.getByRole("button", { name: "Test Razorpay keys" })).toBeVisible();
    for (const label of ["Key secret", "Webhook secret"]) {
      const input = payments.getByLabel(label, { exact: true });
      await expect(input).toHaveAttribute("type", "password");
      // Chrome ignores autocomplete="off" on password inputs and filled the Owner's saved sign-in here.
      await expectNoAutofill(input, "new-password");
      await expect(input).toHaveValue("");
    }
    // The identifiers got the saved Admin email: autocomplete off, ignore attributes, names unlike a sign-in field.
    await expectNoAutofill(payments.getByLabel("Key ID", { exact: true }), "off");
    // The read-only webhook URL and the selects carry the same opt-outs.
    await expectNoAutofill(payments.getByLabel("Webhook URL", { exact: true }), "off");
    await expectNoAutofill(page.locator("#integration-storage").getByLabel("Provider", { exact: true }), "off");
    const storage = page.locator("#integration-storage");
    for (const label of ["Access key ID", "Bucket"]) await expectNoAutofill(storage.getByLabel(label, { exact: true }), "off");
    await expectNoAutofill(page.locator("#integration-email").getByLabel("Username", { exact: true }), "off");
    for (const id of ["#integration-payments", "#integration-storage", "#integration-email"]) await expect(page.locator(id)).toHaveAttribute("autocomplete", "off");
    await expect(page.locator("#integration-redis")).toContainText("Set on the server: a wrong value here would block every sign-in.");
    expect(await noHorizontalScroll(page)).toBe(true);
    await expectNoAxeViolations(page, "admin settings, integrations (desktop)");
  });

  await test.step("the email card switches between SMTP and Amazon SES (API) without saving", async () => {
    const email = page.locator("#integration-email");
    const provider = email.getByLabel("Provider", { exact: true });
    await expect(provider).toHaveValue("smtp");
    await expectNoAutofill(provider, "off");
    await provider.selectOption("ses");
    await expect(email.getByLabel("SMTP host", { exact: true })).toHaveCount(0);
    await expect(email.getByLabel("AWS region", { exact: true })).toHaveValue("ap-south-1");
    await expectNoAutofill(email.getByLabel("Access key ID", { exact: true }), "off");
    const secret = email.getByLabel("Secret access key", { exact: true });
    await expect(secret).toHaveAttribute("type", "password");
    await expectNoAutofill(secret, "new-password");
    await expect(email.getByLabel("Configuration set", { exact: true })).toBeVisible();
    await expect(email).toContainText("Until AWS grants production access, SES only delivers to verified addresses.");
    await expect(email.getByRole("button", { name: "Send test email" })).toBeDisabled();
    await expectNoAxeViolations(page, "admin settings, email provider Amazon SES");
    await provider.selectOption("smtp");
    await expect(email.getByLabel("SMTP host", { exact: true })).toBeVisible();
    await expect(email.getByLabel("AWS region", { exact: true })).toHaveCount(0);
  });

  await test.step("cards of a row share one height and their footers line up (1280 and 1920 px)", async () => {
    expect(await expectEqualRows(page)).toBeGreaterThanOrEqual(2);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1920);
    expect(await expectEqualRows(page)).toBeGreaterThanOrEqual(2);
    const tops = await Promise.all(["#integration-payments", "#integration-storage", "#integration-email"].map(async (id) => (await page.locator(id).boundingBox())?.y));
    expect(new Set(tops.map((y) => Math.round(y ?? -1))).size).toBe(1);
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await test.step("a wrong password stays in the dialog, Escape returns focus to Save, nothing is saved", async () => {
    const email = page.locator("#integration-email");
    await email.getByLabel("SMTP host", { exact: true }).fill("smtp.e2e-check.example");
    await email.getByLabel("Username", { exact: true }).fill("");
    await email.getByLabel("From name", { exact: true }).fill("Axiomatic");
    await email.getByLabel("From address", { exact: true }).fill("no-reply@axiomatic.example");
    const save = email.getByRole("button", { name: "Save", exact: true });
    await save.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "Confirm with your password" })).toBeVisible();
    const password = dialog.getByLabel("Your password");
    await expect(password).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toContainText("Enter your password.");
    await expect(password).toHaveAttribute("aria-invalid", "true");
    await password.fill("not-the-owner-password");
    await page.keyboard.press("Enter");
    await expect(dialog).toContainText("Incorrect password.");
    await expect(password).toBeFocused();
    await expectNoAxeViolations(page, "integration password dialog");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(save).toBeFocused();
    const savedAfter = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM "IntegrationConfig"`);
    expect(savedAfter?.n).toBe(savedBefore?.n ?? 0);
  });

  await test.step("at 360 px the cards are one column and nothing scrolls sideways", async () => {
    await page.setViewportSize({ width: 360, height: 780 });
    await go(page, "/admin/settings", problems);
    for (const title of CARDS) await expect(section.getByRole("heading", { name: title, exact: true })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    const boxes = await Promise.all(SETTINGS_CARDS.map((id) => page.locator(id).boundingBox()));
    // One column: every card starts at the same x and none shares a row (so none is stretched by a neighbour).
    expect(new Set(boxes.map((box) => Math.round(box?.x ?? -1))).size).toBe(1);
    expect(await expectEqualRows(page)).toBe(0);
    await expectNoAxeViolations(page, "admin settings, integrations (360 px)");
  });
});
