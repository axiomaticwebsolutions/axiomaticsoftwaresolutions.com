/**
 * User.securityEpoch (docs/decisions.md Phase 7): a trusted-device cookie skips the emailed sign-in code only while the
 * epoch it carries is current. Each event that bumps the epoch (password reset, password change, turning two-step off,
 * staff deactivation and reactivation, staff role change) makes an old cookie ask for a code again, while a cookie
 * trusted afterwards works.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/generated/prisma/client";
import { changeStaffRole, deactivateStaff, reactivateStaff, type StaffActor } from "@/lib/admin/staff/service";
import { actorFromStaff } from "@/lib/audit";
import { changePassword } from "@/lib/auth/flows/change-password";
import { requestPasswordReset } from "@/lib/auth/flows/forgot-password";
import { verifyLoginCode } from "@/lib/auth/flows/login-code";
import { resetPassword } from "@/lib/auth/flows/reset-password";
import { signIn } from "@/lib/auth/flows/sign-in";
import { createSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import type * as emailModule from "@/lib/email";
import { ApiError } from "@/lib/http";
import { setTwoStep } from "@/lib/portal/profile";
import { makeStaff } from "../support/admin-fixtures";
import { codeIn, lastMail, makeUser, OTHER_PASSWORD, PASSWORD, randomIp, resetTokenIn, type SentMail } from "./auth-fixtures";

const mail = vi.hoisted(() => ({ sent: [] as SentMail[] }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof emailModule>()),
  sendAuthEmail: async (input: SentMail) => {
    mail.sent.push(input);
    return { ok: true };
  },
}));

const T0 = new Date("2026-10-07T06:30:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ctx = (now: Date = T0) => ({ ip: randomIp(), userAgent: "Vitest", now });

beforeEach(() => {
  mail.sent.length = 0;
});

/** Signs in with the emailed code and "trust this device"; returns the axs_td cookie value. */
async function trustDevice(email: string, password: string = PASSWORD, now: Date = T0): Promise<string> {
  const first = await signIn({ email, password }, ctx(now));
  if (!first.requires2fa) throw new Error("expected a two-step challenge");
  const code = codeIn(lastMail(mail.sent, email, "login_code"));
  const done = await verifyLoginCode({ challengeId: first.challengeId, code, trustDevice: true }, ctx(now));
  if (!done.trustedDevice) throw new Error("expected a trusted-device cookie");
  return done.trustedDevice.value;
}

/** True when a password sign-in with this cookie skips the code (and signs in). */
async function skipsCode(email: string, cookie: string, password: string = PASSWORD, now: Date = at(1)): Promise<boolean> {
  const result = await signIn({ email, password }, { ...ctx(now), trustedDevice: cookie });
  return result.requires2fa === false;
}

const epochOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { securityEpoch: true } })).securityEpoch;

function actorOf(user: User): StaffActor {
  if (!user.staffRole) throw new Error("staff only");
  return { staff: { id: user.id, name: user.name, role: user.staffRole }, actor: actorFromStaff(user, "103.21.44.x") };
}

describe("customer events", () => {
  it("password reset: the old trusted device asks for a code again; one trusted afterwards skips it", async () => {
    const { user } = await makeUser({ twoStep: true });
    const cookie = await trustDevice(user.email);
    expect(await skipsCode(user.email, cookie)).toBe(true);

    await requestPasswordReset({ email: user.email }, ctx(at(2)));
    await resetPassword({ token: resetTokenIn(lastMail(mail.sent, user.email, "password_reset")), password: OTHER_PASSWORD }, ctx(at(3)));
    expect(await epochOf(user.id)).toBe(user.securityEpoch + 1);
    expect(await skipsCode(user.email, cookie, OTHER_PASSWORD, at(4))).toBe(false);

    const fresh = await trustDevice(user.email, OTHER_PASSWORD, at(5));
    expect(await skipsCode(user.email, fresh, OTHER_PASSWORD, at(6))).toBe(true);
  });

  it("password change: the old trusted device asks for a code again", async () => {
    const { user, accountId } = await makeUser({ twoStep: true });
    const cookie = await trustDevice(user.email);
    expect(await skipsCode(user.email, cookie)).toBe(true);

    const { session } = await createSession(db, { userId: user.id, kind: "CUSTOMER", activeAccountId: accountId, now: T0 });
    await changePassword({ user, session }, { current: PASSWORD, next: OTHER_PASSWORD }, { now: at(2) });
    expect(await epochOf(user.id)).toBe(user.securityEpoch + 1);
    expect(await skipsCode(user.email, cookie, OTHER_PASSWORD, at(3))).toBe(false);
  });

  it("turning two-step off (then on again): the old trusted device asks for a code; turning it on bumps nothing", async () => {
    const { user, accountId } = await makeUser({ twoStep: true });
    const cookie = await trustDevice(user.email);
    expect(await skipsCode(user.email, cookie)).toBe(true);
    const auth = { user, session: { activeAccountId: accountId } };

    await setTwoStep(auth, { enabled: false, password: PASSWORD }, { client: db, now: at(2) });
    expect(await epochOf(user.id)).toBe(user.securityEpoch + 1);
    await setTwoStep(auth, { enabled: true }, { client: db, now: at(3) });
    expect(await epochOf(user.id)).toBe(user.securityEpoch + 1);
    expect(await skipsCode(user.email, cookie, PASSWORD, at(4))).toBe(false);
  });

  it("a wrong password when turning two-step off changes nothing", async () => {
    const { user, accountId } = await makeUser({ twoStep: true });
    const cookie = await trustDevice(user.email);
    const error = await setTwoStep({ user, session: { activeAccountId: accountId } }, { enabled: false, password: "Wrong1password" }, { client: db }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(await epochOf(user.id)).toBe(user.securityEpoch);
    expect(await skipsCode(user.email, cookie)).toBe(true);
  });
});

describe("staff events", () => {
  it("deactivation and reactivation: no trusted device from before skips the code", async () => {
    const owner = await makeStaff("OWNER");
    const { user: staff } = await makeUser({ kind: "STAFF", twoStep: true });
    const cookie = await trustDevice(staff.email);
    expect(await skipsCode(staff.email, cookie)).toBe(true);

    await deactivateStaff(actorOf(owner), staff.id, { reason: "Left the team" });
    expect(await epochOf(staff.id)).toBe(staff.securityEpoch + 1);
    const blocked = await signIn({ email: staff.email, password: PASSWORD }, { ...ctx(at(2)), trustedDevice: cookie }).catch((e: unknown) => e);
    expect(blocked).toMatchObject({ status: 401, code: "invalid_credentials" });

    await reactivateStaff(actorOf(owner), staff.id, { reason: "Back from leave" });
    expect(await epochOf(staff.id)).toBe(staff.securityEpoch + 2);
    expect(await skipsCode(staff.email, cookie, PASSWORD, at(3))).toBe(false);
  });

  it("a cookie trusted while deactivated-then-reactivated is still refused after the second bump", async () => {
    const owner = await makeStaff("OWNER");
    const { user: staff } = await makeUser({ kind: "STAFF", twoStep: true });
    await deactivateStaff(actorOf(owner), staff.id, { reason: "Left the team" });
    await reactivateStaff(actorOf(owner), staff.id, { reason: "Back from leave" });
    const cookie = await trustDevice(staff.email, PASSWORD, at(1));
    expect(await skipsCode(staff.email, cookie, PASSWORD, at(2))).toBe(true);
    await deactivateStaff(actorOf(owner), staff.id, { reason: "Left again" });
    await reactivateStaff(actorOf(owner), staff.id, { reason: "Rehired" });
    expect(await skipsCode(staff.email, cookie, PASSWORD, at(3))).toBe(false);
  });

  it("role change: the old trusted device asks for a code again", async () => {
    const owner = await makeStaff("OWNER");
    const { user: staff } = await makeUser({ kind: "STAFF", twoStep: true });
    const cookie = await trustDevice(staff.email);
    expect(await skipsCode(staff.email, cookie)).toBe(true);

    await changeStaffRole(actorOf(owner), staff.id, { role: "ADMIN", reason: "Promoted" });
    expect(await epochOf(staff.id)).toBe(staff.securityEpoch + 1);
    expect(await skipsCode(staff.email, cookie, PASSWORD, at(2))).toBe(false);
  });

  it("failed staff actions leave the epoch alone", async () => {
    const owner = await makeStaff("OWNER");
    const { user: staff } = await makeUser({ kind: "STAFF", twoStep: true });
    await expect(changeStaffRole(actorOf(owner), staff.id, { role: "SUPPORT", reason: "Same role" })).rejects.toMatchObject({ code: "role_unchanged" });
    await expect(reactivateStaff(actorOf(owner), staff.id, { reason: "Not deactivated" })).rejects.toMatchObject({ code: "not_deactivated" });
    await expect(deactivateStaff(actorOf(owner), staff.id, { reason: "" })).rejects.toMatchObject({ status: 422 });
    expect(await epochOf(staff.id)).toBe(staff.securityEpoch);
  });
});
