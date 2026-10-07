/**
 * Guest orders and team invitations (security review, 2026-10-07):
 * - an invited person whom an owner later makes Owner never has their guest orders or licenses claimed into the
 *   account that invited them (claims go to an account the person created: ownAccountId);
 * - an invited address that never accepted can still register (the placeholder user is taken over, the invitation
 *   stays pending), its guest orders go to the account it creates, and the old link cannot reset its password.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as acceptPOST } from "@/app/api/invites/accept/route";
import { PATCH as memberPATCH } from "@/app/api/account/team/[memberId]/route";
import { POST as teamPOST } from "@/app/api/account/team/route";
import { claimGuestOrders } from "@/lib/auth/flows/claim-guest-orders";
import { ownAccountId, ownerAccountId } from "@/lib/auth/flows/common";
import { registerUser } from "@/lib/auth/flows/register";
import { signIn as signInWithPassword } from "@/lib/auth/flows/sign-in";
import { verifyEmailCode } from "@/lib/auth/flows/verify-email";
import { ANON_CSRF_BINDING, issueCsrfToken } from "@/lib/auth/csrf";
import { clear, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import type * as EmailModule from "@/lib/email";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/http";
import { codeIn, lastMail, makeOrder, randomIp, uniqueEmail, type SentMail } from "./auth-fixtures";
import { bodyOf, call, errorOf, makeMember, signIn, type Member } from "./license-actions-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string, options: { maxAge?: number } = {}) => {
      if (options.maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
  headers: async () => new Headers(),
}));

// Verification codes and the team_invite email (sent directly, never stored) are captured.
const mail = vi.hoisted(() => ({ sent: [] as SentMail[] }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof EmailModule>()),
  sendAuthEmail: async (input: SentMail) => {
    mail.sent.push(input);
    return { ok: true };
  },
}));

const NEW_PASSWORD = "Joined2team";
let owner: Member;

beforeEach(async () => {
  mail.sent.length = 0;
  await clear(db, RATE_LIMITS.inviteAcceptIp(null).key);
  owner = await makeMember({ name: "Attacker Owner" });
});

async function invite(email: string, role = "VIEWER"): Promise<{ memberId: string; token: string }> {
  await signIn(jar, owner);
  const res = await call(jar, teamPOST, "/api/account/team", { method: "POST", body: { email, role } });
  expect(res.status).toBe(201);
  const memberId = ((await res.json()) as { member: { id: string } }).member.id;
  const outbox = { text: lastMail(mail.sent, email, "team_invite").vars.invite_url ?? "" };
  const match = /\/invite\?token=([A-Za-z0-9._%-]+)/.exec(outbox.text);
  if (!match?.[1]) throw new Error("no invite link in the email");
  return { memberId, token: decodeURIComponent(match[1]) };
}

async function promoteToOwner(memberId: string): Promise<void> {
  await signIn(jar, owner);
  const res = await call(jar, memberPATCH, `/api/account/team/${memberId}`, { method: "PATCH", body: { role: "OWNER" }, params: { memberId } });
  expect(res.status).toBe(200);
}

function signOut(): void {
  jar.clear();
  jar.set("axs_csrf", issueCsrfToken(ANON_CSRF_BINDING, getEnv().CSRF_SECRET));
}

const accept = (body: Record<string, unknown>) => call(jar, acceptPOST, "/api/invites/accept", { method: "POST", body });

async function signInAs(email: string): Promise<void> {
  const result = await signInWithPassword({ email, password: NEW_PASSWORD, next: undefined }, { ip: randomIp(), userAgent: "Vitest" });
  expect(result.requires2fa).toBe(false);
}

const accountOf = async (order: { id: string }) => (await db.order.findUniqueOrThrow({ where: { id: order.id } })).accountId;
const licenseAccountOf = async (id: string | null) => (await db.license.findUniqueOrThrow({ where: { id: id ?? "" } })).accountId;

describe("an invited person made Owner", () => {
  it("keeps their guest orders and licenses out of the account that invited them", async () => {
    const email = uniqueEmail("victim");
    const guest = await makeOrder(email, { withLicense: true });
    const { memberId, token } = await invite(email);
    signOut();
    expect((await accept({ token, name: "Asha Rao", password: NEW_PASSWORD })).status).toBe(200);
    expect(await accountOf(guest.order)).toBeNull();

    await promoteToOwner(memberId);
    const victim = await db.user.findUniqueOrThrow({ where: { email } });
    expect(await ownerAccountId(db, victim.id)).toBe(owner.accountId);
    expect(await ownAccountId(db, victim.id)).toBeNull();
    await signInAs(email);
    expect(await accountOf(guest.order)).toBeNull();
    expect(await licenseAccountOf(guest.licenseId)).toBeNull();
    expect(await db.$transaction((tx) => claimGuestOrders(tx, victim))).toEqual({ accountId: null, orderIds: [], licenseIds: [] });
    expect(await db.order.count({ where: { accountId: owner.accountId, email } })).toBe(0);
  });
});

describe("an invited address that never accepted", () => {
  it("can still register: the placeholder is taken over and the invitation stays pending", async () => {
    const email = uniqueEmail("invitee");
    const early = await makeOrder(email, { withLicense: true });
    const { memberId, token } = await invite(email, "BILLING");
    const placeholder = await db.user.findUniqueOrThrow({ where: { email } });

    const registered = await registerUser(
      { name: "Asha Rao", email, password: NEW_PASSWORD, businessName: "Rao Traders", next: undefined },
      { ip: randomIp(), userAgent: "Vitest" },
    );
    expect(registered.user).toMatchObject({ id: placeholder.id, name: "Asha Rao", emailVerifiedAt: null });
    expect(registered.account.legalName).toBe("Rao Traders");
    const memberships = await db.accountMember.findMany({ where: { userId: placeholder.id } });
    expect(memberships.find((m) => m.accountId === registered.account.id)).toMatchObject({ role: "OWNER", status: "ACTIVE", invitedAt: null });
    expect(memberships.find((m) => m.id === memberId)).toMatchObject({ accountId: owner.accountId, status: "INVITED" });

    // The old link no longer lets anyone choose a password for this address: they must sign in to accept.
    signOut();
    const anonymous = await accept({ token, name: "Someone Else", password: "Another9pass" });
    expect(anonymous.status).toBe(401);
    expect(errorOf(await bodyOf(anonymous)).code).toBe("sign_in_required");

    // Verifying the email claims the guest order into the account they created.
    const code = codeIn(lastMail(mail.sent, email, "email_verification"));
    const user = await db.user.findUniqueOrThrow({ where: { id: placeholder.id } });
    await verifyEmailCode({ user, session: registered.session }, { code }, { ip: randomIp(), userAgent: "Vitest" });
    expect(await accountOf(early.order)).toBe(registered.account.id);
    expect(await licenseAccountOf(early.licenseId)).toBe(registered.account.id);

    // Joining, then being made Owner of, the (older) inviting account never sends later guest orders there.
    await signIn(jar, { user, accountId: registered.account.id });
    expect((await accept({ token })).status).toBe(200);
    await promoteToOwner(memberId);
    expect(await ownerAccountId(db, user.id)).toBe(owner.accountId);
    const later = await makeOrder(email);
    await signInAs(email);
    expect(await accountOf(later.order)).toBe(registered.account.id);
  });

  it("is still refused (409) once the person has a password", async () => {
    const email = uniqueEmail("joined");
    const { token } = await invite(email);
    signOut();
    expect((await accept({ token, name: "Asha Rao", password: NEW_PASSWORD })).status).toBe(200);
    const error = await registerUser(
      { name: "Mallory", email, password: "Another9pass", businessName: undefined, next: undefined },
      { ip: randomIp(), userAgent: "Vitest" },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "email_taken" });
  });
});
