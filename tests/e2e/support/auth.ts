/**
 * Sign-in and registration helpers.
 *
 * - signInHttp / signInAs: seeded people (staff and the demo customer) sign in through POST /api/auth/sign-in; people
 *   with two-step on (the seeded staff) confirm with the code emailed to /dev/mailbox (POST /api/auth/sign-in/verify).
 *   Only the session cookie reaches the browser context, so seeded passwords and codes never appear in traces or
 *   reports.
 * - registerCustomerHttp: a throwaway customer (register + verification code from /dev/mailbox), signed in and verified.
 * - waitForHydration: typing before React hydrates a form makes dev builds log a hydration mismatch and can lose the
 *   input; wait until React owns the element (scripts/check-portal.mjs).
 */
import { randomBytes } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import type { Person } from "./env";
import { errorCode, HttpClient } from "./http";
import { codeFrom, mailIds, waitForCode, waitForMail } from "./mailbox";

export const SIGN_IN_CODE = /sign-in code/i;
export const VERIFICATION_CODE = /verification code/i;

/** A throwaway password for a customer this run creates (memory only). */
export function throwawayPassword(): string {
  return `E2e${randomBytes(8).toString("hex")}9!`;
}

/** Signs `person` in over HTTP (two-step code from /dev/mailbox when asked). Throws naming the step, never a secret. */
export async function signInHttp(person: Pick<Person, "email" | "password">): Promise<HttpClient> {
  const client = new HttpClient();
  const before = await mailIds();
  const res = await client.api<{ requires2fa?: boolean; challengeId?: string }>("POST", "/api/auth/sign-in", {
    email: person.email,
    password: person.password,
  });
  if (res.status !== 200) throw new Error(`sign-in of ${person.email} answered ${res.status} ${errorCode(res.body)}`);
  if (res.body?.requires2fa) {
    const challengeId = res.body.challengeId;
    if (!challengeId) throw new Error(`sign-in of ${person.email} asked for a code without a challenge`);
    // The dev server is shared: another run may sign the same person in at the same moment, so a code email newer than
    // `before` can belong to that other challenge. A refused code is skipped for the next new one (at most 3 tries).
    const tried = new Set(before);
    for (let attempt = 1; ; attempt++) {
      const mail = await waitForMail(person.email, SIGN_IN_CODE, { exclude: tried, timeoutMs: attempt === 1 ? 45_000 : 15_000 });
      tried.add(mail.id);
      const verified = await client.api("POST", "/api/auth/sign-in/verify", { challengeId, code: codeFrom(mail), trustDevice: false });
      if (verified.status === 200) break;
      if (verified.status !== 422 || attempt >= 3) {
        throw new Error(`two-step code of ${person.email} answered ${verified.status} ${errorCode(verified.body)}`);
      }
    }
  }
  if (!client.has("axs_session")) throw new Error(`sign-in of ${person.email} set no session cookie`);
  return client;
}

/** Signs `person` in and gives the browser context that session. Returns the HTTP client (same session). */
export async function signInAs(context: BrowserContext, person: Pick<Person, "email" | "password">): Promise<HttpClient> {
  const client = await signInHttp(person);
  await client.exportTo(context);
  return client;
}

export type NewCustomer = { email: string; name: string; password: string; businessName: string };

/** Registers a throwaway customer and verifies the email with the code from /dev/mailbox. Signed in afterwards. */
export async function registerCustomerHttp(customer: NewCustomer): Promise<HttpClient> {
  const client = new HttpClient();
  const before = await mailIds();
  const res = await client.api("POST", "/api/auth/register", {
    name: customer.name,
    email: customer.email,
    password: customer.password,
    businessName: customer.businessName,
  });
  if (res.status !== 201) throw new Error(`registering ${customer.email} answered ${res.status} ${errorCode(res.body)}`);
  const code = await waitForCode(customer.email, VERIFICATION_CODE, before);
  const verified = await client.api("POST", "/api/auth/verify-email", { code });
  if (verified.status !== 200) throw new Error(`verifying ${customer.email} answered ${verified.status} ${errorCode(verified.body)}`);
  return client;
}

/** Revokes the session the client carries (POST /api/auth/sign-out). Best effort: resolves to the status. */
export async function signOutHttp(client: HttpClient): Promise<number> {
  if (!client.has("axs_session")) return 0;
  const res = await client.api("POST", "/api/auth/sign-out", {});
  return res.status;
}

/** Waits until React has hydrated the element (its DOM node carries a React fiber). */
export async function waitForHydration(page: Page, selector: string, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber"));
    },
    selector,
    { timeout },
  );
}
