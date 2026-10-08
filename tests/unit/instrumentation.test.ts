/**
 * instrumentation.ts register(): a production server with an invalid environment must exit (PM2 then counts restarts
 * and stops at max_restarts) instead of staying "online" and answering 500 to every request.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";
import { resetEnvCache } from "@/lib/env";
import { integrationSlot, invalidateIntegrations } from "@/lib/integrations/slot";

beforeEach(() => {
  resetEnvCache();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("REDIS_URL", undefined);
  vi.stubEnv("SESSION_SECRET", "short-secret-value-0123");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

describe("instrumentation register()", () => {
  it("ends a production process whose environment is invalid, naming the variables but no values", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    const printed = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("Invalid environment configuration");
    expect(printed).toContain("REDIS_URL");
    expect(printed).toContain("SESSION_SECRET");
    expect(printed).not.toContain("short-secret-value-0123");
  });

  it("keeps a development server running and only warns", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await register();
    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("warms the integration settings cache once the environment is valid", async () => {
    const pair = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const env: Record<string, string> = {
      APP_URL: "http://localhost:3000",
      NODE_ENV: "development",
      SESSION_SECRET: randomBytes(48).toString("base64url"),
      CSRF_SECRET: randomBytes(32).toString("base64url"),
      ORDER_TOKEN_SECRET: randomBytes(32).toString("base64url"),
      CRON_SECRET: randomBytes(32).toString("base64url"),
      DATABASE_URL: "postgresql://axiomatic:axiomatic@localhost:5432/axiomatic?schema=public",
      LICENSE_KEY_PEPPER: randomBytes(32).toString("hex"),
      LICENSE_KEY_ENC_KEY: randomBytes(32).toString("base64"),
      LICENSE_SIGNING_PRIVATE_KEY: pair.privateKey,
      LICENSE_SIGNING_PUBLIC_KEY: pair.publicKey,
    };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const slot = integrationSlot();
    const previous = slot.loader;
    const loader = vi.fn(async () => []);
    slot.loader = loader;
    invalidateIntegrations();
    try {
      await register();
      expect(loader).toHaveBeenCalledTimes(1);
      expect(slot.snapshot).not.toBeNull();
    } finally {
      slot.loader = previous;
      invalidateIntegrations();
    }
  });

  it("does nothing during next build or in the edge runtime", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await register();
    vi.stubEnv("NEXT_PHASE", undefined);
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(exit).not.toHaveBeenCalled();
  });
});
