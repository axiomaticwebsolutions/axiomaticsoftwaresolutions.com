import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvError, getEnv, getLicenseKeySecrets, isPlaceholder, parseEnv, resetEnvCache } from "@/lib/env";

function keyPair() {
  return generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

const pair = keyPair();
/** As written by `pnpm secrets`: one line with escaped (backslash + n) line breaks. */
const escaped = (pem: string) => pem.trim().replace(/\r?\n/g, "\x5Cn");

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    APP_URL: "http://localhost:3000/",
    NODE_ENV: "development",
    SESSION_SECRET: randomBytes(64).toString("base64url"),
    CSRF_SECRET: randomBytes(32).toString("base64url"),
    ORDER_TOKEN_SECRET: randomBytes(32).toString("base64url"),
    CRON_SECRET: randomBytes(32).toString("base64url"),
    DATABASE_URL: "postgresql://axiomatic:axiomatic@localhost:5432/axiomatic?schema=public",
    LICENSE_KEY_PEPPER: randomBytes(32).toString("hex"),
    LICENSE_KEY_ENC_KEY: randomBytes(32).toString("base64"),
    LICENSE_SIGNING_PRIVATE_KEY: escaped(pair.privateKey),
    LICENSE_SIGNING_PUBLIC_KEY: escaped(pair.publicKey),
    LICENSE_OFFLINE_GRACE_DAYS: "7",
    PAYMENT_PROVIDER: "mock",
    PAYMENT_KEY_ID: "mock_key",
    PAYMENT_KEY_SECRET: randomBytes(24).toString("base64url"),
    PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString("base64url"),
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: ".storage",
    STORAGE_ACCESS_KEY_ID: "",
    STORAGE_SECRET_ACCESS_KEY: "",
    DOWNLOAD_LINK_TTL_SECONDS: "600",
    EMAIL_TRANSPORT: "console",
    EMAIL_FROM: "Axiomatic Software <no-reply@axiomatic.example>",
    SMTP_HOST: "localhost",
    SMTP_PORT: "1025",
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    REDIS_URL: "",
    ...overrides,
  };
}

const productionEnv = (overrides: Record<string, string | undefined> = {}) =>
  validEnv({
    NODE_ENV: "production",
    APP_URL: "https://axiomatic.example",
    PAYMENT_PROVIDER: "razorpay",
    PAYMENT_KEY_ID: "rzp_live_AbCdEf123456",
    STORAGE_DRIVER: "s3",
    STORAGE_REGION: "ap-south-1",
    STORAGE_BUCKET: "axiomatic-installers",
    STORAGE_ACCESS_KEY_ID: "AKIAEXAMPLEKEY",
    STORAGE_SECRET_ACCESS_KEY: randomBytes(30).toString("base64url"),
    EMAIL_TRANSPORT: "smtp",
    SMTP_HOST: "smtp.example.com",
    TRUSTED_PROXY_HOPS: "2",
    REDIS_URL: "rediss://cache.axiomatic.example:6379",
    ...overrides,
  });

function problemsOf(source: Record<string, string | undefined>): readonly string[] {
  try {
    parseEnv(source);
  } catch (e) {
    if (e instanceof EnvError) return e.problems;
    throw e;
  }
  throw new Error("expected parseEnv to throw");
}

describe("parseEnv", () => {
  it("accepts a generated development environment and applies coercion and defaults", () => {
    const env = parseEnv(validEnv({ LICENSE_OFFLINE_GRACE_DAYS: undefined }));
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.LICENSE_OFFLINE_GRACE_DAYS).toBe(7);
    expect(env.DOWNLOAD_LINK_TTL_SECONDS).toBe(600);
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.STORAGE_FORCE_PATH_STYLE).toBe(false);
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.TRUSTED_PROXY_HOPS).toBe(0);
  });

  it("turns escaped backslash-n sequences in PEM values into newlines", () => {
    const source = validEnv();
    expect(source.LICENSE_SIGNING_PRIVATE_KEY).not.toContain("\n");
    const env = parseEnv(source);
    expect(env.LICENSE_SIGNING_PRIVATE_KEY).toContain("\n");
    expect(env.LICENSE_SIGNING_PRIVATE_KEY).not.toContain("\x5Cn");
    expect(env.LICENSE_SIGNING_PRIVATE_KEY.trim()).toBe(pair.privateKey.trim());
  });

  it("refuses the .env.example placeholders and reports every problem at once", () => {
    const problems = problemsOf(
      validEnv({
        SESSION_SECRET: "change-me-64-random-bytes",
        CSRF_SECRET: "change-me",
        LICENSE_KEY_ENC_KEY: "change-me-32-bytes-base64",
        LICENSE_SIGNING_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\x5Cn...\x5Cn-----END PRIVATE KEY-----",
        PAYMENT_WEBHOOK_SECRET: "xxxxxxxx",
      }),
    );
    const keys = problems.map((p) => p.split(":")[0]);
    expect(keys).toEqual(
      expect.arrayContaining([
        "SESSION_SECRET",
        "CSRF_SECRET",
        "LICENSE_KEY_ENC_KEY",
        "LICENSE_SIGNING_PRIVATE_KEY",
        "PAYMENT_WEBHOOK_SECRET",
      ]),
    );
    expect(problems.find((p) => p.startsWith("SESSION_SECRET"))).toMatch(/placeholder/);
    // One line per variable, even when several rules fail.
    expect(keys.filter((k) => k === "CSRF_SECRET")).toHaveLength(1);
  });

  it("reports missing required variables", () => {
    const problems = problemsOf(validEnv({ SESSION_SECRET: undefined, DATABASE_URL: "", EMAIL_FROM: "   " }));
    expect(problems).toEqual(
      expect.arrayContaining([
        "SESSION_SECRET: is required",
        "DATABASE_URL: is required",
        "EMAIL_FROM: is required",
      ]),
    );
  });

  it("never echoes secret values in the error", () => {
    const shortSecret = "tooShortButSecret42";
    let message = "";
    try {
      parseEnv(validEnv({ SESSION_SECRET: shortSecret, CRON_SECRET: "change-me-cron" }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("SESSION_SECRET: must be at least 32 characters");
    expect(message).not.toContain(shortSecret);
    expect(message).not.toContain("change-me-cron");
  });

  it("requires LICENSE_KEY_ENC_KEY to decode to exactly 32 bytes", () => {
    expect(problemsOf(validEnv({ LICENSE_KEY_ENC_KEY: randomBytes(16).toString("base64") }))).toEqual([
      "LICENSE_KEY_ENC_KEY: must be exactly 32 random bytes, base64-encoded",
    ]);
    expect(problemsOf(validEnv({ LICENSE_KEY_ENC_KEY: "not base64 at all!" }))).toHaveLength(1);
  });

  it("rejects a public key that does not belong to the private key", () => {
    const other = keyPair();
    expect(problemsOf(validEnv({ LICENSE_SIGNING_PUBLIC_KEY: escaped(other.publicKey) }))).toEqual([
      "LICENSE_SIGNING_PUBLIC_KEY: does not match LICENSE_SIGNING_PRIVATE_KEY",
    ]);
  });

  it("caps DOWNLOAD_LINK_TTL_SECONDS at 600 and rejects non-numbers", () => {
    expect(parseEnv(validEnv({ DOWNLOAD_LINK_TTL_SECONDS: "3600" })).DOWNLOAD_LINK_TTL_SECONDS).toBe(600);
    expect(parseEnv(validEnv({ DOWNLOAD_LINK_TTL_SECONDS: "120" })).DOWNLOAD_LINK_TTL_SECONDS).toBe(120);
    expect(problemsOf(validEnv({ DOWNLOAD_LINK_TTL_SECONDS: "ten" }))[0]).toMatch(/^DOWNLOAD_LINK_TTL_SECONDS:/);
    expect(problemsOf(validEnv({ LICENSE_OFFLINE_GRACE_DAYS: "90" }))[0]).toMatch(/^LICENSE_OFFLINE_GRACE_DAYS:/);
  });
});

describe("database pool settings", () => {
  it("defaults to a bounded pool (10 connections, 5 s wait, 5 s statements) and accepts overrides", () => {
    const env = parseEnv(validEnv());
    expect([env.DATABASE_POOL_MAX, env.DATABASE_POOL_TIMEOUT_MS, env.DATABASE_STATEMENT_TIMEOUT_MS]).toEqual([10, 5_000, 5_000]);
    const tuned = parseEnv(validEnv({ DATABASE_POOL_MAX: "20", DATABASE_POOL_TIMEOUT_MS: "2000", DATABASE_STATEMENT_TIMEOUT_MS: "0" }));
    expect([tuned.DATABASE_POOL_MAX, tuned.DATABASE_POOL_TIMEOUT_MS, tuned.DATABASE_STATEMENT_TIMEOUT_MS]).toEqual([20, 2_000, 0]);
  });

  it("reports values outside the ranges lib/db.ts accepts", () => {
    expect(problemsOf(validEnv({ DATABASE_POOL_MAX: "0", DATABASE_POOL_TIMEOUT_MS: "abc", DATABASE_STATEMENT_TIMEOUT_MS: "700000" }))).toEqual([
      "DATABASE_POOL_MAX: must be between 1 and 200",
      "DATABASE_POOL_TIMEOUT_MS: must be a whole number of milliseconds",
      "DATABASE_STATEMENT_TIMEOUT_MS: must be between 0 and 600000",
    ]);
  });
});

describe("production rules", () => {
  it("accepts a complete production environment", () => {
    const env = parseEnv(productionEnv());
    expect(env.NODE_ENV).toBe("production");
    expect(env.PAYMENT_PROVIDER).toBe("razorpay");
  });

  it("refuses the mock provider, local storage, console email and plain http", () => {
    const problems = problemsOf(
      productionEnv({
        APP_URL: "http://axiomatic.example",
        PAYMENT_PROVIDER: "mock",
        STORAGE_DRIVER: "local",
        EMAIL_TRANSPORT: "console",
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "PAYMENT_PROVIDER: mock is not allowed when NODE_ENV=production",
        expect.stringMatching(/^STORAGE_DRIVER: local is not allowed/),
        expect.stringMatching(/^EMAIL_TRANSPORT: console is not allowed/),
        "APP_URL: must use https when NODE_ENV=production",
      ]),
    );
  });

  it("requires TRUSTED_PROXY_HOPS of at least 1, so clientIp() never trusts a forged header or returns null", () => {
    expect(parseEnv(productionEnv()).TRUSTED_PROXY_HOPS).toBe(2);
    expect(problemsOf(productionEnv({ TRUSTED_PROXY_HOPS: undefined }))).toEqual([
      "TRUSTED_PROXY_HOPS: is required when NODE_ENV=production",
    ]);
    expect(problemsOf(productionEnv({ TRUSTED_PROXY_HOPS: "0" }))).toEqual([
      expect.stringMatching(/^TRUSTED_PROXY_HOPS: must be at least 1 when NODE_ENV=production/),
    ]);
    expect(problemsOf(validEnv({ TRUSTED_PROXY_HOPS: "1.5" }))[0]).toMatch(/^TRUSTED_PROXY_HOPS:/);
    expect(problemsOf(validEnv({ TRUSTED_PROXY_HOPS: "11" }))[0]).toMatch(/^TRUSTED_PROXY_HOPS:/);
    expect(parseEnv(validEnv({ TRUSTED_PROXY_HOPS: "1" })).TRUSTED_PROXY_HOPS).toBe(1);
  });

  it("requires REDIS_URL in production only (shared rate-limit store)", () => {
    expect(parseEnv(productionEnv()).REDIS_URL).toBe("rediss://cache.axiomatic.example:6379");
    expect(problemsOf(productionEnv({ REDIS_URL: undefined }))).toEqual([
      expect.stringMatching(/^REDIS_URL: is required when NODE_ENV=production/),
    ]);
    expect(problemsOf(productionEnv({ REDIS_URL: "  " }))).toEqual([expect.stringMatching(/^REDIS_URL: is required/)]);
    expect(problemsOf(productionEnv({ REDIS_URL: "http://cache:6379" }))[0]).toMatch(/^REDIS_URL: must be a redis/);
    expect(parseEnv(validEnv({ REDIS_URL: undefined })).REDIS_URL).toBeUndefined();
    expect(parseEnv(validEnv({ REDIS_URL: "redis://127.0.0.1:6379" })).REDIS_URL).toBe("redis://127.0.0.1:6379");
  });

  it("allows mock, local and console outside production", () => {
    expect(() => parseEnv(validEnv({ NODE_ENV: "test" }))).not.toThrow();
  });
});

describe("conditional requirements", () => {
  it("requires S3 credentials only when STORAGE_DRIVER=s3", () => {
    expect(() => parseEnv(validEnv({ STORAGE_ACCESS_KEY_ID: "", STORAGE_SECRET_ACCESS_KEY: "" }))).not.toThrow();
    const problems = problemsOf(validEnv({ STORAGE_DRIVER: "s3", STORAGE_REGION: "ap-south-1", STORAGE_BUCKET: "axiomatic-installers" }));
    expect(problems).toEqual([
      "STORAGE_ACCESS_KEY_ID: is required when STORAGE_DRIVER=s3",
      "STORAGE_SECRET_ACCESS_KEY: is required when STORAGE_DRIVER=s3",
    ]);
  });

  it("refuses placeholder S3 credentials", () => {
    const problems = problemsOf(
      validEnv({
        STORAGE_DRIVER: "s3",
        STORAGE_REGION: "ap-south-1",
        STORAGE_BUCKET: "axiomatic-installers",
        STORAGE_ACCESS_KEY_ID: "xxxxxxxx",
        STORAGE_SECRET_ACCESS_KEY: "xxxxxxxx",
      }),
    );
    expect(problems.map((p) => p.split(":")[0])).toEqual(["STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"]);
  });

  it("requires provider keys only for a real payment provider", () => {
    expect(() => parseEnv(validEnv({ PAYMENT_KEY_ID: undefined, PAYMENT_KEY_SECRET: undefined }))).not.toThrow();
    const problems = problemsOf(validEnv({ PAYMENT_PROVIDER: "razorpay", PAYMENT_KEY_ID: "rzp_test_xxxxxxxx", PAYMENT_KEY_SECRET: undefined }));
    expect(problems).toEqual([
      expect.stringMatching(/^PAYMENT_KEY_ID: is a placeholder/),
      "PAYMENT_KEY_SECRET: is required when PAYMENT_PROVIDER=razorpay",
    ]);
  });

  it("requires SMTP_HOST for the smtp transport", () => {
    expect(problemsOf(validEnv({ EMAIL_TRANSPORT: "smtp", SMTP_HOST: "" }))).toEqual([
      "SMTP_HOST: is required when EMAIL_TRANSPORT=smtp",
    ]);
  });
});

describe("getEnv / getLicenseKeySecrets", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  function stubAll(source: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(source)) vi.stubEnv(k, v ?? "");
  }

  it("parses process.env once and caches it until reset", () => {
    stubAll(validEnv({ LICENSE_OFFLINE_GRACE_DAYS: "5" }));
    resetEnvCache();
    expect(getEnv().LICENSE_OFFLINE_GRACE_DAYS).toBe(5);
    vi.stubEnv("LICENSE_OFFLINE_GRACE_DAYS", "9");
    expect(getEnv().LICENSE_OFFLINE_GRACE_DAYS).toBe(5);
    resetEnvCache();
    expect(getEnv().LICENSE_OFFLINE_GRACE_DAYS).toBe(9);
  });

  it("decodes the license encryption key to 32 bytes", () => {
    const encKey = randomBytes(32);
    const source = validEnv({ LICENSE_KEY_ENC_KEY: encKey.toString("base64") });
    stubAll(source);
    resetEnvCache();
    const secrets = getLicenseKeySecrets();
    expect(secrets.pepper).toBe(source.LICENSE_KEY_PEPPER);
    expect(secrets.encKey).toHaveLength(32);
    expect(secrets.encKey.equals(encKey)).toBe(true);
  });
});

describe("isPlaceholder", () => {
  it("matches the example values only", () => {
    expect(isPlaceholder("change-me")).toBe(true);
    expect(isPlaceholder("CHANGEME")).toBe(true);
    expect(isPlaceholder("rzp_test_xxxxxxxx")).toBe(true);
    expect(isPlaceholder("-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----")).toBe(true);
    expect(isPlaceholder(randomBytes(32).toString("base64url"))).toBe(false);
  });
});
