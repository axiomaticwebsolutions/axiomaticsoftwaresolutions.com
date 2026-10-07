import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RATE_LIMITS } from "@/lib/auth/rate-limit";
import { ApiError } from "@/lib/http";
import {
  activationLimitMessage,
  activationPlan,
  EXPIRED_TOKEN_REFRESH_DAYS,
  LAST_SEEN_WRITE_INTERVAL_MS,
  requireAppId,
  VALIDATION_FAILURE_CODES,
} from "@/lib/licensing/activation";

const id = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

describe("activationPlan", () => {
  it("maps plan types to the contract names", () => {
    expect(activationPlan("ANNUAL", "ACTIVE", new Date())).toBe("annual");
    expect(activationPlan("SUBSCRIPTION", "ACTIVE", new Date())).toBe("subscription");
    expect(activationPlan("ONE_TIME", "ACTIVE", null)).toBe("one_time");
    expect(activationPlan("TRIAL", "TRIAL", new Date())).toBe("trial");
  });

  it("reads a TRIAL license as trial whatever its plan, and falls back on the terms", () => {
    expect(activationPlan("ANNUAL", "TRIAL", new Date())).toBe("trial");
    expect(activationPlan("MAINTENANCE", "ACTIVE", null)).toBe("one_time");
    expect(activationPlan("DEVICE_ADDON", "ACTIVE", new Date())).toBe("annual");
  });
});

describe("messages and codes", () => {
  it("words the activation limit like the docs troubleshooting copy", () => {
    expect(activationLimitMessage(3)).toBe("All 3 device slots are in use. Deactivate a computer from your account, or add one.");
    expect(activationLimitMessage(1)).toMatch(/^The license\u2019s only device slot is in use\./);
  });

  it("marks only definitive failures as valid:false", () => {
    expect([...VALIDATION_FAILURE_CODES].sort()).toEqual(
      [
        "device_deactivated",
        "fingerprint_mismatch",
        "invalid_token",
        "license_expired",
        "license_revoked",
        "license_suspended",
        "token_expired",
        "wrong_product",
      ].sort(),
    );
    for (const code of ["too_many_attempts", "validation_failed", "invalid_app_id", "internal_error"]) {
      expect(VALIDATION_FAILURE_CODES.has(code)).toBe(false);
    }
  });

  it("uses the decided throttle and refresh windows", () => {
    expect(LAST_SEEN_WRITE_INTERVAL_MS).toBe(12 * 3_600_000);
    expect(EXPIRED_TOKEN_REFRESH_DAYS).toBe(30);
  });
});

describe("requireAppId", () => {
  it("returns the upper-cased product code or throws 400 invalid_app_id", () => {
    expect(requireAppId(new Headers({ "X-App-Id": "med" }))).toBe("MED");
    for (const headers of [new Headers(), new Headers({ "x-app-id": "MEDICAL" })]) {
      let error: unknown = null;
      try {
        requireAppId(headers);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 400, code: "invalid_app_id" });
    }
  });
});

describe("device API rate limits", () => {
  it("match the Phase 4 decisions", () => {
    const ip = "103.21.44.17";
    expect(RATE_LIMITS.activateKey("hash")).toEqual({ key: `activate:key:${id("hash")}`, limit: 10, windowSec: 60 });
    expect(RATE_LIMITS.activateIp(ip)).toEqual({ key: `activate:ip:${id(ip)}`, limit: 60, windowSec: 60 });
    expect(RATE_LIMITS.validateLicense("LIC-1")).toEqual({ key: `validate:license:${id("LIC-1")}`, limit: 30, windowSec: 60 });
    expect(RATE_LIMITS.validateIp(ip)).toEqual({ key: `validate:ip:${id(ip)}`, limit: 60, windowSec: 60 });
    expect(RATE_LIMITS.deactivateLicense("LIC-1")).toEqual({ key: `deactivate:license:${id("LIC-1")}`, limit: 30, windowSec: 60 });
    expect(RATE_LIMITS.deactivateIp(ip)).toEqual({ key: `deactivate:ip:${id(ip)}`, limit: 60, windowSec: 60 });
  });
});
