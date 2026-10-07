/**
 * The signed-in user's own settings (portal Security page and the business switcher; decisions.md Phase 5):
 * - Profile: name (person-name rule) and Indian mobile. No activity entry (the prototype logs none for "Save profile").
 * - Two-step verification on/off. Turning it on needs a verified email and sends nothing (codes are emailed at
 *   sign-in); turning it off needs the account password, checked under a 5 per 15 minutes per user limit that is
 *   counted before verifying and cleared on success. Changes log "Turned on|off two-step verification" (security,
 *   target = the user's email) on the active business account, with the actor's id.
 * - Active business account: must be one of the user's ACTIVE memberships; stored on the session (server side).
 */
import "server-only";
import type { Session, TeamRole, User } from "@/generated/prisma/client";
import { activeAccountIdFor } from "@/lib/auth/flows/activity";
import { verifyPassword } from "@/lib/auth/password";
import { attempt, clear, enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db as defaultDb } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { incorrectPassword } from "@/lib/licensing/reveal";
import { log } from "@/lib/log";
import { actorLabel, recordAccountActivity } from "@/lib/portal/activity";
import type { ProfilePatch, TwoStepInput } from "@/lib/validation/portal";

export const TWO_STEP_ON_ACTION = "Turned on two-step verification";
export const TWO_STEP_OFF_ACTION = "Turned off two-step verification";
/** New copy (the prototype has no unverified state on the Security page). */
export const TWO_STEP_UNVERIFIED_MESSAGE = "Verify your email before turning on two-step verification.";
export const ACCOUNT_NOT_FOUND_MESSAGE = "Business not found.";

export type ProfileView = { id: string; name: string; email: string; phone: string | null; emailVerified: boolean; twoStepEnabled: boolean };

function toProfileView(user: Pick<User, "id" | "name" | "email" | "phone" | "emailVerifiedAt" | "twoStepEnabled">): ProfileView {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    emailVerified: user.emailVerifiedAt !== null,
    twoStepEnabled: user.twoStepEnabled,
  };
}

/** PATCH /api/me: saves the name and/or mobile of the signed-in user. */
export async function updateProfile(
  user: Pick<User, "id">,
  patch: ProfilePatch,
  opts: { now?: Date; client?: typeof defaultDb } = {},
): Promise<ProfileView> {
  const client = opts.client ?? defaultDb;
  enforce(await hit(client, RATE_LIMITS.profileUpdate(user.id), opts.now));
  const updated = await client.user.update({
    where: { id: user.id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
    },
    select: { id: true, name: true, email: true, phone: true, emailVerifiedAt: true, twoStepEnabled: true },
  });
  log.info("profile_updated", { userId: user.id, fields: Object.keys(patch).filter((k) => patch[k as keyof ProfilePatch] !== undefined) });
  return toProfileView(updated);
}

export type TwoStepResult = { twoStepEnabled: boolean; changed: boolean };

/**
 * POST /api/me/two-step. 403 `email_unverified` when turning it on without a verified email; 429 when the password
 * checks or changes are rate limited; 422 `incorrect_password` (fieldErrors.password) when turning it off with a wrong
 * password. Asking for the state the user already has changes nothing and logs nothing (`changed: false`).
 */
export async function setTwoStep(
  auth: { user: Pick<User, "id" | "kind" | "name">; session: Pick<Session, "activeAccountId"> },
  input: TwoStepInput,
  opts: { now?: Date; client?: typeof defaultDb } = {},
): Promise<TwoStepResult> {
  const client = opts.client ?? defaultDb;
  const now = opts.now ?? new Date();
  // Re-read the user: the session's copy may be stale (a password change, another tab's toggle).
  const user = await client.user.findUnique({
    where: { id: auth.user.id },
    select: { id: true, name: true, email: true, kind: true, passwordHash: true, emailVerifiedAt: true, twoStepEnabled: true },
  });
  if (!user) throw errors.unauthorized();

  if (input.enabled) {
    if (!user.emailVerifiedAt) throw new ApiError(403, "email_unverified", TWO_STEP_UNVERIFIED_MESSAGE);
  } else {
    const rule = RATE_LIMITS.twoStepOff(user.id);
    const counted = await attempt(client, rule, now);
    if (!counted.allowed) throw errors.rateLimited(counted.retryAfterSec);
    if (!(await verifyPassword(input.password ?? "", user.passwordHash))) {
      log.info("two_step_off_denied", { userId: user.id, remaining: counted.remaining });
      throw incorrectPassword();
    }
    await clear(client, rule.key);
  }
  if (user.twoStepEnabled === input.enabled) return { twoStepEnabled: user.twoStepEnabled, changed: false };
  enforce(await hit(client, RATE_LIMITS.twoStepToggle(user.id), now));

  const changed = await client.$transaction(async (tx) => {
    // Conditional update: of two concurrent identical requests only one changes the flag and logs it.
    const { count } = await tx.user.updateMany({
      where: { id: user.id, twoStepEnabled: !input.enabled },
      // Turning it off bumps the security epoch: trusted-device cookies from before stop skipping the code if it is
      // turned on again (lib/auth/trusted-device.ts).
      data: input.enabled ? { twoStepEnabled: true } : { twoStepEnabled: false, securityEpoch: { increment: 1 } },
    });
    if (count === 0) return false;
    const accountId = await activeAccountIdFor(tx, user, auth.session);
    if (accountId) {
      await recordAccountActivity(tx, {
        accountId,
        actor: { id: user.id, name: actorLabel(user) },
        action: input.enabled ? TWO_STEP_ON_ACTION : TWO_STEP_OFF_ACTION,
        target: user.email,
        kind: "security",
        at: now,
      });
    }
    return true;
  });
  log.info(input.enabled ? "two_step_enabled" : "two_step_disabled", { userId: user.id, changed });
  return { twoStepEnabled: input.enabled, changed };
}

export type ActiveAccountResult = { account: { id: string; legalName: string }; role: TeamRole };

/**
 * POST /api/me/active-account: switches the session's active business account. 404 unless the user is an ACTIVE
 * member of it (invited memberships, other people's accounts and unknown ids read the same).
 */
export async function setActiveAccount(
  auth: { user: Pick<User, "id" | "kind">; session: Pick<Session, "id"> },
  accountId: string,
  client: typeof defaultDb = defaultDb,
): Promise<ActiveAccountResult> {
  if (auth.user.kind !== "CUSTOMER") throw errors.notFound("Business");
  const membership = await client.accountMember.findFirst({
    where: { accountId, userId: auth.user.id, status: "ACTIVE" },
    select: { role: true, account: { select: { id: true, legalName: true } } },
  });
  if (!membership) throw new ApiError(404, "not_found", ACCOUNT_NOT_FOUND_MESSAGE);
  await client.session.update({ where: { id: auth.session.id }, data: { activeAccountId: membership.account.id } });
  return { account: membership.account, role: membership.role };
}
