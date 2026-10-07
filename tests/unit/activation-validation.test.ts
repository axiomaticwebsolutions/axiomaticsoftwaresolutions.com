import { describe, expect, it } from "vitest";
import {
  activateRequestSchema,
  cleanDeviceText,
  deactivateRequestSchema,
  parseAppId,
  validateRequestSchema,
} from "@/lib/validation/activation";

const FP = "ab".repeat(32);
const body = (extra: Record<string, unknown> = {}) => ({
  licenseKey: "MED-7Q4K-9XTP-W2HD-K8NM",
  deviceFingerprint: FP,
  deviceName: "Billing counter PC",
  os: "Windows 11 Pro",
  appVersion: "4.2.1",
  ...extra,
});

function fieldErrors(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; code: string; keys?: string[] }> } }) {
  return (result.error?.issues ?? []).flatMap((i) => (i.code === "unrecognized_keys" ? (i.keys ?? []) : [i.path.join(".")]));
}

describe("activateRequestSchema", () => {
  it("accepts the contract body and lower-cases the fingerprint", () => {
    const parsed = activateRequestSchema.parse(body({ deviceFingerprint: ` ${FP.toUpperCase()} ` }));
    expect(parsed).toEqual(body());
  });

  it("rejects unknown keys", () => {
    expect(fieldErrors(activateRequestSchema.safeParse(body({ plan: "annual" })))).toEqual(["plan"]);
  });

  it("requires a 64-character hex fingerprint", () => {
    for (const fp of ["", "ab".repeat(31), "ab".repeat(33), `${"ab".repeat(31)}zz`, 42]) {
      expect(fieldErrors(activateRequestSchema.safeParse(body({ deviceFingerprint: fp })))).toEqual(["deviceFingerprint"]);
    }
  });

  it("bounds the license key but leaves malformed keys to the service (404 invalid_key)", () => {
    expect(activateRequestSchema.safeParse(body({ licenseKey: "" })).success).toBe(true);
    expect(activateRequestSchema.safeParse(body({ licenseKey: "not a key" })).success).toBe(true);
    expect(fieldErrors(activateRequestSchema.safeParse(body({ licenseKey: "K".repeat(65) })))).toEqual(["licenseKey"]);
    expect(fieldErrors(activateRequestSchema.safeParse(body({ licenseKey: null })))).toEqual(["licenseKey"]);
  });

  it("cleans the device name and OS, then checks 1-80 characters", () => {
    const parsed = activateRequestSchema.parse(body({ deviceName: "  Counter\n\tPC\u0000 \u202Eevil\u200B  ", os: "Windows\u00A011  Pro" }));
    expect(parsed.deviceName).toBe("Counter PC evil");
    expect(parsed.os).toBe("Windows 11 Pro");
    expect(activateRequestSchema.parse(body({ deviceName: "x".repeat(80) })).deviceName).toHaveLength(80);
    expect(fieldErrors(activateRequestSchema.safeParse(body({ deviceName: "x".repeat(81) })))).toEqual(["deviceName"]);
    expect(fieldErrors(activateRequestSchema.safeParse(body({ deviceName: " \u0007\u200B " })))).toEqual(["deviceName"]);
    expect(fieldErrors(activateRequestSchema.safeParse(body({ os: "" })))).toEqual(["os"]);
  });

  it("accepts semver-like app versions up to 32 characters", () => {
    for (const v of ["4.2", "4.2.1", "4.2.1.1830", "4.3.0-beta.2", "4.3.0-rc.1+20261007", " 4.2.1 "]) {
      expect(activateRequestSchema.safeParse(body({ appVersion: v })).success).toBe(true);
    }
    for (const v of ["4", "v4.2.1", "4.2.1 beta", "4..2", "4.2.1.0.0", `4.2.1-${"a".repeat(30)}`, ""]) {
      expect(fieldErrors(activateRequestSchema.safeParse(body({ appVersion: v })))).toEqual(["appVersion"]);
    }
  });
});

describe("validate and deactivate bodies", () => {
  const token = "eyJhbGciOiJFZERTQSJ9.eyJsaWMiOiJMSUMtMSJ9.c2ln";

  it("are strict and require a bounded token", () => {
    expect(validateRequestSchema.parse({ activationToken: token, deviceFingerprint: FP, appVersion: "4.2.1" })).toEqual({
      activationToken: token,
      deviceFingerprint: FP,
      appVersion: "4.2.1",
    });
    expect(fieldErrors(validateRequestSchema.safeParse({ activationToken: token, deviceFingerprint: FP }))).toEqual(["appVersion"]);
    expect(fieldErrors(validateRequestSchema.safeParse({ activationToken: "", deviceFingerprint: FP, appVersion: "4.2.1" }))).toEqual([
      "activationToken",
    ]);
    expect(
      fieldErrors(validateRequestSchema.safeParse({ activationToken: "a".repeat(4097), deviceFingerprint: FP, appVersion: "4.2.1" })),
    ).toEqual(["activationToken"]);
    expect(deactivateRequestSchema.parse({ activationToken: token, deviceFingerprint: FP.toUpperCase() })).toEqual({
      activationToken: token,
      deviceFingerprint: FP,
    });
    expect(fieldErrors(deactivateRequestSchema.safeParse({ activationToken: token, deviceFingerprint: FP, appVersion: "1.0" }))).toEqual([
      "appVersion",
    ]);
  });
});

describe("cleanDeviceText", () => {
  it("masks key-shaped text and replaces lone surrogates", () => {
    expect(cleanDeviceText("PC MED-7Q4K-9XTP-W2HD-K8NM")).toBe("PC MED-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-K8NM");
    expect(cleanDeviceText("PC \uD800 x")).toBe("PC \uFFFD x");
    expect(cleanDeviceText("Caf\u0065\u0301")).toBe("Caf\u00E9");
  });
});

describe("parseAppId", () => {
  it("accepts three letters in any case and nothing else", () => {
    expect(parseAppId("MED")).toBe("MED");
    expect(parseAppId(" med ")).toBe("MED");
    for (const v of [null, undefined, "", "ME", "MEDI", "M3D", "MED-1", "x".repeat(40)]) expect(parseAppId(v)).toBeNull();
  });
});
