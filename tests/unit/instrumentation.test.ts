/**
 * instrumentation.ts register(): a production server with an invalid environment must exit (PM2 then counts restarts
 * and stops at max_restarts) instead of staying "online" and answering 500 to every request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";
import { resetEnvCache } from "@/lib/env";

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
