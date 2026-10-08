/**
 * Runs once before the suite:
 * 1. the app answers GET /api/health with { status: "ok" } (database reachable),
 * 2. it is a development server with PAYMENT_PROVIDER=mock (GET /dev/mock-checkout is the mock provider's page; it is
 *    a 404 in production builds and with any other provider) and EMAIL_TRANSPORT=console (GET /dev/mailbox),
 *    No integration may be saved in Admin > Settings > Integrations: a saved payment, email or storage configuration
 *    replaces those development drivers for every spec (docs/admin-integrations-design.md), so the run stops early.
 * 3. the shared "unknown"-IP rate-limit buckets are reset (local servers only; E2E_KEEP_LIMITS=1 skips it),
 * 4. the public routes the journeys use are requested once, so the dev server compiles them before the clock runs (and
 *    the mock webhook route is ready when the first payment's webhook arrives).
 */
import { Db } from "./support/db";
import { BASE_URL } from "./support/env";
import { resetSharedIpBuckets } from "./support/rate-limits";

const WARM_UP = [
  "/",
  "/software",
  "/software/medical-billing",
  "/cart",
  "/checkout",
  "/sign-in",
  "/register",
  "/verify",
  // An unknown order id still compiles the order page (signed-out /account and /admin only reach the middleware).
  "/orders/AX-0",
  "/api/webhooks/payments/mock",
];

async function get(path: string, timeoutMs = 120_000): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await res.text() };
}

async function waitForHealth(): Promise<void> {
  const end = Date.now() + 120_000;
  let last = "no answer";
  while (Date.now() < end) {
    try {
      const res = await get("/api/health", 30_000);
      if (res.status === 200 && /"status":"ok"/.test(res.text)) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${BASE_URL}/api/health is not ok (${last}). Start the dev server (pnpm dev) or set E2E_BASE_URL.`);
}

/** Saved integrations would replace the mock provider, the console mailbox or the local disk under every spec. */
async function assertNoSavedIntegrations(): Promise<void> {
  const db = new Db();
  try {
    const rows = await db.all<{ kind: string }>(`SELECT "kind"::text AS kind FROM "IntegrationConfig" ORDER BY "kind"`);
    if (rows.length > 0) {
      throw new Error(
        `e2e expects the development drivers; remove saved integrations in Admin > Settings (saved: ${rows.map((r) => r.kind.toLowerCase()).join(", ")}).`,
      );
    }
  } catch (error) {
    // 42P01: the table does not exist yet (migration pending), so nothing can be saved.
    if ((error as { code?: unknown }).code !== "42P01") throw error;
  } finally {
    await db.end();
  }
}

export default async function globalSetup(): Promise<void> {
  await waitForHealth();
  const mock = await get("/dev/mock-checkout");
  if (mock.status !== 200 || !mock.text.includes("Test gateway")) {
    throw new Error(
      `${BASE_URL}/dev/mock-checkout answered ${mock.status}: the E2E suite needs a development server with PAYMENT_PROVIDER=mock.`,
    );
  }
  const mailbox = await get("/dev/mailbox");
  if (mailbox.status !== 200) {
    throw new Error(`${BASE_URL}/dev/mailbox answered ${mailbox.status}: the E2E suite needs EMAIL_TRANSPORT=console.`);
  }
  await assertNoSavedIntegrations();
  if (process.env.E2E_KEEP_LIMITS !== "1") {
    const db = new Db();
    try {
      const reset = await resetSharedIpBuckets(db);
      console.info(`E2E: cleared ${reset.postgres} shared local rate-limit bucket(s)${reset.redis ? ` and ${reset.redis} Redis key(s)` : ""}.`);
    } finally {
      await db.end();
    }
  }
  for (const path of WARM_UP) await get(path).catch(() => undefined);
}
