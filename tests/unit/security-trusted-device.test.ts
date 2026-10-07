/**
 * Trusted-device cookies carry User.securityEpoch (lib/auth/trusted-device.ts; docs/decisions.md Phase 7). The DB test
 * tests/db/security-epoch.test.ts proves each event that bumps the epoch makes an old cookie ask for a code again.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueTrustedDevice, verifyTrustedDevice } from "@/lib/auth/trusted-device";

const T0 = new Date("2026-10-07T06:30:00.000Z");
const subject = { userId: "user_1", passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$aaaa$bbbb", securityEpoch: 4, secret: "s".repeat(48) };

function mint(epoch = subject.securityEpoch): string {
  const minted = issueTrustedDevice({ ...subject, securityEpoch: epoch }, T0);
  if (!minted) throw new Error("expected a cookie");
  return minted.value;
}

describe("trusted-device cookie and the security epoch", () => {
  it("carries the epoch it was issued under and verifies only while it is current", () => {
    const value = mint();
    expect(value.split(".").slice(0, 2)).toEqual(["2", "4"]);
    expect(verifyTrustedDevice(value, subject, T0)).toBe(true);
    expect(verifyTrustedDevice(value, { ...subject, securityEpoch: 5 }, T0)).toBe(false);
    expect(verifyTrustedDevice(value, { ...subject, securityEpoch: 3 }, T0)).toBe(false);
  });

  it("cannot be moved to the new epoch by editing the cookie: the epoch is inside the signature", () => {
    const [v, , exp, sig] = mint(4).split(".") as [string, string, string, string];
    expect(verifyTrustedDevice(`${v}.5.${exp}.${sig}`, { ...subject, securityEpoch: 5 }, T0)).toBe(false);
    expect(verifyTrustedDevice(`${v}.05.${exp}.${sig}`, { ...subject, securityEpoch: 5 }, T0)).toBe(false);
  });

  it("refuses version-1 cookies (no epoch), even with a valid version-1 signature", () => {
    const expSec = Math.floor(T0.getTime() / 1000) + 3600;
    const fingerprint = "0".repeat(64);
    const legacySig = createHmac("sha256", subject.secret).update(`td:1:${subject.userId}:${expSec}:${fingerprint}`).digest("base64url");
    expect(verifyTrustedDevice(`1.${expSec}.${legacySig}`, subject, T0)).toBe(false);
  });

  it("is neither issued nor accepted for a malformed epoch", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(issueTrustedDevice({ ...subject, securityEpoch: bad }, T0)).toBeNull();
      expect(verifyTrustedDevice(mint(), { ...subject, securityEpoch: bad }, T0)).toBe(false);
    }
  });
});
