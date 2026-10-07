/**
 * License issuance inside the caller's transaction: the paid-order webhook (through fulfil.ts), free trials and
 * staff manual issue all come through issueLicense(), so every license gets the same key handling, id and terms.
 *
 * Only keyHash, keyCiphertext and keyLast4 are stored. The plaintext key is returned to the caller for one-time
 * delivery and is never logged or written anywhere else.
 */
import { PlanType, type License, type Plan } from "@/generated/prisma/client";
import { nextLicenseId } from "@/lib/counters";
import { istCalendarYear } from "@/lib/dates";
import type { Tx } from "@/lib/db";
import { getLicenseKeySecrets } from "@/lib/env";
import { ApiError, errors } from "@/lib/http";
import { sealLicenseKey, type LicenseKeySecrets, type SealedLicenseKey } from "./crypto";
import { generateLicenseKey, redactLicenseKeys } from "./keys";
import { newLicenseTerms } from "./terms";

/** Key generation attempts before giving up (a collision needs 2^40 keys per product code to become likely). */
export const MAX_KEY_ATTEMPTS = 3;

export type IssueLicenseInput = {
  /** null for an unclaimed guest purchase (decisions.md section 1). */
  accountId: string | null;
  product: { id: string; code: string };
  plan: Plan;
  /** Item quantity; for per-unit plans it is the number of device slots (terminals). */
  qty: number;
  /** Term base: Order.paidAt for purchases, the request time for trials and manual issue. */
  at: Date;
  orderId?: string | null;
  /** LicenseEvent.actor: "System", a user's name or a staff name. */
  actor: string;
  /** Defaults to the status the plan implies (TRIAL for trial plans, otherwise ACTIVE). */
  status?: "ACTIVE" | "TRIAL";
  eventType?: "issued" | "trial_started";
  eventDetail?: string;
  /** Defaults to getLicenseKeySecrets() from lib/env. */
  secrets?: LicenseKeySecrets;
};

export type IssuedLicense = { license: License; key: string };

/** Thrown when every generated key collided with an existing keyHash (practically unreachable). */
export class LicenseKeyCollisionError extends Error {
  constructor() {
    super(`Could not generate a unique license key after ${MAX_KEY_ATTEMPTS} attempts`);
    this.name = "LicenseKeyCollisionError";
  }
}

/**
 * Generates and seals a key whose hash is not in use yet. Checking before the INSERT (instead of catching the
 * unique violation) keeps the caller's transaction usable: a failed statement aborts a Postgres transaction.
 */
async function freshKey(tx: Tx, productCode: string, secrets: LicenseKeySecrets): Promise<{ key: string; sealed: SealedLicenseKey }> {
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
    const key = generateLicenseKey(productCode);
    const sealed = sealLicenseKey(key, secrets);
    const taken = await tx.license.findUnique({ where: { keyHash: sealed.keyHash }, select: { id: true } });
    if (!taken) return { key, sealed };
  }
  throw new LicenseKeyCollisionError();
}

/**
 * Creates a License and its first LicenseEvent. Throws RangeError for an invalid product code, Error when the plan
 * belongs to another product, and LicenseTermsError (terms.ts) for plans that need a target license.
 */
export async function issueLicense(tx: Tx, input: IssueLicenseInput): Promise<IssuedLicense> {
  if (input.plan.productId !== input.product.id) {
    throw new Error(`Plan ${input.plan.id} does not belong to product ${input.product.id}`);
  }
  // Pure checks first, so a bad plan or quantity never consumes a license id.
  const terms = newLicenseTerms(input.plan, input.qty, input.at);
  const status = input.status ?? terms.status;
  const secrets = input.secrets ?? getLicenseKeySecrets();

  const { key, sealed } = await freshKey(tx, input.product.code, secrets);
  // The counter row stays locked until commit, so allocate it as late as possible.
  const id = await nextLicenseId(tx);
  const orderId = input.orderId ?? null;

  const license = await tx.license.create({
    data: {
      id,
      accountId: input.accountId,
      productId: input.product.id,
      planId: input.plan.id,
      orderId,
      keyHash: sealed.keyHash,
      keyCiphertext: sealed.keyCiphertext,
      keyLast4: sealed.keyLast4,
      status,
      issuedAt: input.at,
      expiresAt: terms.expiresAt,
      updatesUntil: terms.updatesUntil,
      deviceLimit: terms.deviceLimit,
      selfServiceResets: 0,
      resetsYear: istCalendarYear(input.at),
    },
  });

  const detail = input.eventDetail ?? (orderId ? `Order ${orderId}` : null);
  await tx.licenseEvent.create({
    data: {
      licenseId: id,
      type: input.eventType ?? (status === "TRIAL" ? "trial_started" : "issued"),
      actor: input.actor,
      // Details are free text from callers; never let a key-shaped string reach the table.
      detail: detail === null ? null : redactLicenseKeys(detail),
    },
  });

  return { license, key };
}

export const TRIAL_USED_MESSAGE = "You\u2019ve already used the free trial for this product.";
export const TRIAL_EMAIL_UNVERIFIED_MESSAGE = "Verify your email to start a free trial.";
export const TRIAL_UNAVAILABLE_MESSAGE = "This product doesn\u2019t offer a free trial.";

export type StartTrialInput = {
  /** The caller's server-side active account (requireAccountRole); membership is not re-checked here. */
  accountId: string;
  productId: string;
  user: { id: string; name: string; emailVerifiedAt: Date | null };
  at: Date;
  secrets?: LicenseKeySecrets;
};

/**
 * Starts the one free trial an account gets per product (decisions.md section 6).
 * 403 `email_unverified`, 404 when the account or a published product is missing, 422 `trial_unavailable` when the
 * product has no live trial plan, 409 `trial_used` when the account already had a trial for it (including a trial
 * that was later upgraded to a paid plan, which keeps its `trial_started` event).
 */
export async function startTrial(tx: Tx, input: StartTrialInput): Promise<IssuedLicense> {
  if (!input.user.emailVerifiedAt) {
    throw new ApiError(403, "email_unverified", TRIAL_EMAIL_UNVERIFIED_MESSAGE);
  }

  // Serialises concurrent trial starts for the same account, so the check below cannot race.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "BusinessAccount" WHERE "id" = ${input.accountId} FOR UPDATE`;
  if (locked.length === 0) throw errors.notFound("Account");

  const product = await tx.product.findUnique({
    where: { id: input.productId },
    select: {
      id: true,
      code: true,
      status: true,
      plans: { where: { type: PlanType.TRIAL, archived: false }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 1 },
    },
  });
  if (!product || product.status !== "PUBLISHED") throw errors.notFound("Product");
  const plan = product.plans[0];
  if (!plan) throw new ApiError(422, "trial_unavailable", TRIAL_UNAVAILABLE_MESSAGE);

  const previous = await tx.license.findFirst({
    where: {
      accountId: input.accountId,
      productId: product.id,
      OR: [{ plan: { type: PlanType.TRIAL } }, { status: "TRIAL" }, { events: { some: { type: "trial_started" } } }],
    },
    select: { id: true },
  });
  if (previous) throw errors.conflict("trial_used", TRIAL_USED_MESSAGE);

  return issueLicense(tx, {
    accountId: input.accountId,
    product,
    plan,
    qty: 1,
    at: input.at,
    orderId: null,
    actor: input.user.name,
    status: "TRIAL",
    eventType: "trial_started",
    secrets: input.secrets,
  });
}
