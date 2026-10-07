/**
 * Test plan E2E 4: a customer with a one-computer Medical Store Billing license reveals the key in the portal (with
 * the password), finds the only slot taken by an old computer, deactivates it in the portal, activates the new
 * computer through POST /api/v1/licenses/activate (as the desktop app does) and sees it in the devices list and the
 * license's history.
 */
import { randomBytes } from "node:crypto";
import { registerCustomerHttp, throwawayPassword } from "./support/auth";
import { buyAsCustomer } from "./support/checkout";
import { expect, test } from "./support/fixtures";
import { BASE_URL } from "./support/env";
import { go } from "./support/guard";

const KEY_RE = /^[A-Z]{3}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;

/** The desktop app's activation call (no cookies, no CSRF; X-App-Id is the product code). */
async function activate(key: string, deviceName: string): Promise<{ status: number; body: { status?: string; error?: { code?: string } } }> {
  const res = await fetch(`${BASE_URL}/api/v1/licenses/activate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-id": "MED" },
    body: JSON.stringify({
      licenseKey: key,
      deviceFingerprint: randomBytes(32).toString("hex"),
      deviceName,
      os: "Windows 11 Pro",
      appVersion: "4.2.1",
    }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { status?: string; error?: { code?: string } } };
}

test("customer swaps computers: deactivates the old one in the portal and activates the new one with the key", async ({
  page,
  context,
  db,
  created,
  tag,
  problems,
}) => {
  const email = created.email(`e2e-${tag}-devices@example.test`);
  const password = throwawayPassword();
  const oldPc = `Old counter PC ${tag}`;
  const newPc = `New counter PC ${tag}`;
  let licenseId = "";
  let key = "";

  await test.step("a verified customer buys a one-computer license", async () => {
    const client = await registerCustomerHttp({ email, name: "Anita Desai", password, businessName: "Desai Pharmacy" });
    await client.exportTo(context);
    const bought = await buyAsCustomer(page, client, db, { email, problems });
    created.order(bought.orderId);
    licenseId = bought.licenseId;
  });

  await test.step("the key is revealed in the portal with the password", async () => {
    await go(page, `/account/licenses/${licenseId}`, problems);
    const card = page.locator("section", { has: page.getByRole("heading", { name: "License key", exact: true }) });
    await card.getByRole("button", { name: "Reveal", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm it’s you" });
    await dialog.getByLabel("Password").fill(password);
    const revealed = page.waitForResponse((r) => r.url().endsWith(`/api/account/licenses/${licenseId}/reveal`) && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Reveal key" }).click();
    expect((await revealed).status()).toBe(200);
    await expect(dialog).toBeHidden();
    key = (await card.locator("code").innerText()).trim();
    expect(KEY_RE.test(key), "the full key is shown").toBe(true);
    await card.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(card.locator("code")).not.toHaveText(key);
  });

  await test.step("the old computer holds the only slot, so the new one is refused", async () => {
    const first = await activate(key, oldPc);
    expect(first.status, first.body.error?.code).toBe(200);
    expect(first.body.status).toBe("activated");
    const refused = await activate(key, newPc);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("activation_limit_reached");
  });

  await test.step("the customer deactivates the old computer in the portal", async () => {
    await go(page, `/account/licenses/${licenseId}?tab=devices`, problems);
    await page.getByRole("button", { name: `Deactivate ${oldPc}`, exact: true }).filter({ visible: true }).first().click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(/deactivat/i);
    await confirm.getByRole("button", { name: "Deactivate", exact: true }).click();
    await expect(confirm).toBeHidden();
    const row = await db.one<{ deactivatedAt: Date | null; deactivatedBy: string | null }>(
      `SELECT "deactivatedAt", "deactivatedBy" FROM "DeviceActivation" WHERE "licenseId" = $1 AND name = $2`,
      [licenseId, oldPc],
    );
    expect(row?.deactivatedAt).not.toBeNull();
    expect(row?.deactivatedBy).toBe("customer");
  });

  await test.step("the new computer activates through the activation API", async () => {
    const res = await activate(key, newPc);
    expect(res.status, res.body.error?.code).toBe(200);
    expect(res.body.status).toBe("activated");
  });

  await test.step("the devices list shows the new computer", async () => {
    await go(page, "/account/devices", problems);
    await expect(page.locator("main").getByText(newPc).filter({ visible: true }).first()).toBeVisible();
    await go(page, `/account/licenses/${licenseId}?tab=devices`, problems);
    await expect(page.getByRole("button", { name: `Deactivate ${newPc}`, exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: `Deactivate ${oldPc}`, exact: true }).filter({ visible: true })).toHaveCount(0);
  });

  await test.step("the license history records both activations and the deactivation", async () => {
    await go(page, `/account/licenses/${licenseId}?tab=activity`, problems);
    const history = page.getByRole("region", { name: "License activity" });
    const deactivated = history.locator("li").filter({ has: page.locator("strong", { hasText: /^Deactivated by you$/ }) });
    await expect(deactivated).toHaveCount(1);
    await expect(deactivated).toContainText(oldPc);
    const activated = history.locator("li").filter({ has: page.locator("strong", { hasText: /^Activated$/ }) });
    await expect(activated.filter({ hasText: newPc })).toHaveCount(1);
    await expect(activated.filter({ hasText: oldPc })).toHaveCount(1);
  });
});
