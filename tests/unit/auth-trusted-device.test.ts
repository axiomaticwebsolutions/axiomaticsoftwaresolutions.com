import { describe, expect, it } from "vitest";
import { DAY_MS } from "@/lib/dates";
import { issueTrustedDevice, TRUSTED_DEVICE_TTL_MS, verifyTrustedDevice } from "@/lib/auth/trusted-device";

const T0 = new Date("2026-10-07T06:30:00.000Z");
const subject = { userId: "user_1", passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb", securityEpoch: 3, secret: "s".repeat(48) };

function issue(over: Partial<typeof subject> = {}, now = T0) {
  const minted = issueTrustedDevice({ ...subject, ...over }, now);
  if (!minted) throw new Error("expected a cookie");
  return minted;
}

describe("trusted-device cookie", () => {
  it("verifies for the same user and password within 30 days", () => {
    const { value, expiresAt } = issue();
    expect(expiresAt.getTime()).toBeLessThanOrEqual(T0.getTime() + TRUSTED_DEVICE_TTL_MS);
    expect(expiresAt.getTime()).toBeGreaterThan(T0.getTime() + TRUSTED_DEVICE_TTL_MS - 1000);
    expect(verifyTrustedDevice(value, subject, new Date(T0.getTime() + 29 * DAY_MS))).toBe(true);
  });

  it("carries nothing identifying", () => {
    const { value } = issue();
    expect(value).not.toContain(subject.userId);
    expect(value.split(".")).toHaveLength(4);
  });

  it("expires after 30 days", () => {
    const { value } = issue();
    expect(verifyTrustedDevice(value, subject, new Date(T0.getTime() + 30 * DAY_MS + 1000))).toBe(false);
  });

  it("is invalidated by a password change", () => {
    const { value } = issue();
    expect(verifyTrustedDevice(value, { ...subject, passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$cccc$dddd" }, T0)).toBe(false);
  });

  it("does not work for another user or another secret", () => {
    const { value } = issue();
    expect(verifyTrustedDevice(value, { ...subject, userId: "user_2" }, T0)).toBe(false);
    expect(verifyTrustedDevice(value, { ...subject, secret: "t".repeat(48) }, T0)).toBe(false);
  });

  it("rejects tampering, forged far-future expiries and junk", () => {
    const { value } = issue();
    const [v, epoch, exp, sig] = value.split(".") as [string, string, string, string];
    expect(verifyTrustedDevice(`${v}.${epoch}.${Number(exp) + 3600}.${sig}`, subject, T0)).toBe(false);
    expect(verifyTrustedDevice(`${v}.${epoch}.${Number(exp) + 400 * 86400}.${sig}`, subject, T0)).toBe(false);
    expect(verifyTrustedDevice(`3.${epoch}.${exp}.${sig}`, subject, T0)).toBe(false);
    for (const junk of [null, undefined, "", "1.2", "1.x.y", "a".repeat(400)]) {
      expect(verifyTrustedDevice(junk, subject, T0)).toBe(false);
    }
  });

  it("is never issued or accepted without a password", () => {
    expect(issueTrustedDevice({ ...subject, passwordHash: null }, T0)).toBeNull();
    const { value } = issue();
    expect(verifyTrustedDevice(value, { ...subject, passwordHash: null }, T0)).toBe(false);
  });
});
