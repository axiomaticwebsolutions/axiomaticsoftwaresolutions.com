/**
 * Admin > Settings > Integrations as the Owner (docs/admin-integrations-design.md sections 17 and 18): the cards on
 * desktop and at 360 px without horizontal scrolling and without axe violations, write-only secret inputs, and the
 * keyboard path through the password dialog (an empty and a wrong password show their error inside the dialog; Escape
 * closes it and returns focus to Save).
 *
 * Non-mutating on purpose: a saved storage or email configuration would replace the development drivers under the
 * other specs (global setup refuses to start when one exists). The wrong password is refused before anything is
 * written, which the test checks in the database. Status-only cards are covered by unit tests; saving and the CSP
 * follow-up by the DB tests, the middleware unit tests and the production-build check.
 */
import type { Page } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { PEOPLE } from "./support/env";
import { expect, test } from "./support/fixtures";
import { go } from "./support/guard";

const CARDS = ["Payment provider", "Installer storage", "Email delivery", "Rate limits"];

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
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
      await expect(input).toHaveAttribute("autocomplete", "off");
      await expect(input).toHaveAttribute("data-lpignore", "true");
      await expect(input).toHaveValue("");
    }
    await expect(page.locator("#integration-redis")).toContainText("Set on the server: a wrong value here would block every sign-in.");
    expect(await noHorizontalScroll(page)).toBe(true);
    await expectNoAxeViolations(page, "admin settings, integrations (desktop)");
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
    const boxes = await Promise.all(["#integration-payments", "#integration-storage"].map((id) => page.locator(id).boundingBox()));
    expect(boxes[0]?.x).toBe(boxes[1]?.x);
    await expectNoAxeViolations(page, "admin settings, integrations (360 px)");
  });
});
