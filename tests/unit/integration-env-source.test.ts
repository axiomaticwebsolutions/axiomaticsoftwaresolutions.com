/**
 * The env-file fallback (lib/integrations/env-source.ts; docs/admin-integrations-design.md section 3).
 */
import { describe, expect, it } from "vitest";
import { classifyEnvIntegrations, DEV_EMAIL_FROM } from "@/lib/integrations/env-source";

const PROD = { production: true } as const;
const DEV = { production: false } as const;
const verdict = (env: Record<string, string | undefined>, opts: { production: boolean }) => {
  const c = classifyEnvIntegrations(env, opts);
  return Object.fromEntries(
    (["payments", "email", "storage"] as const).map((k) => [k, c[k].result.ok ? "ok" : `${c[k].result.reason}:${c[k].result.names.join(",")}`]),
  );
};

const RAZORPAY = {
  PAYMENT_PROVIDER: "razorpay",
  PAYMENT_KEY_ID: "rzp_test_1DP5mmOlF5G5ag",
  PAYMENT_KEY_SECRET: "key-secret-value-01",
  PAYMENT_WEBHOOK_SECRET: "webhook-secret-value-01",
};
const SMTP = {
  EMAIL_TRANSPORT: "smtp",
  EMAIL_FROM: "Axiomatic <no-reply@axiomatic.example>",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "mailer",
  SMTP_PASSWORD: "smtp-password-01",
};
const S3 = {
  STORAGE_DRIVER: "s3",
  STORAGE_ENDPOINT: "https://acc123.r2.cloudflarestorage.com/",
  STORAGE_REGION: "auto",
  STORAGE_BUCKET: "axs-files",
  STORAGE_ACCESS_KEY_ID: "a1b2c3d4e5f6",
  STORAGE_SECRET_ACCESS_KEY: "storage-secret-01",
  STORAGE_FORCE_PATH_STYLE: "true",
};

describe("classifyEnvIntegrations: drivers", () => {
  it("uses the development drivers when nothing selects one outside production", () => {
    const c = classifyEnvIntegrations({ PAYMENT_KEY_SECRET: "dev-secret-123", PAYMENT_WEBHOOK_SECRET: "dev-webhook-secret-123" }, DEV);
    expect(c.payments.result).toEqual({
      ok: true,
      config: { provider: "mock", keyId: "mock_key", keySecret: "dev-secret-123", webhookSecret: "dev-webhook-secret-123", mode: "test" },
    });
    expect(c.email.result).toEqual({ ok: true, config: { transport: "console", from: DEV_EMAIL_FROM } });
    expect(c.storage.result).toEqual({ ok: true, config: { driver: "local", dir: ".storage" } });
    expect(verdict({}, DEV).payments).toBe("env_incomplete:PAYMENT_KEY_SECRET,PAYMENT_WEBHOOK_SECRET");
  });

  it("is missing in production when nothing is set, and refuses the development drivers there", () => {
    expect(verdict({}, PROD)).toEqual({ payments: "missing:", email: "missing:", storage: "missing:" });
    expect(verdict({ PAYMENT_PROVIDER: "mock", EMAIL_TRANSPORT: "console", STORAGE_DRIVER: "local" }, PROD)).toEqual({
      payments: "env_invalid:PAYMENT_PROVIDER",
      email: "env_invalid:EMAIL_TRANSPORT",
      storage: "env_invalid:STORAGE_DRIVER",
    });
  });

  it("names the missing selector in production when the other variables are set (never ignored silently)", () => {
    const strip = (env: Record<string, string>, name: string) => Object.fromEntries(Object.entries(env).filter(([k]) => k !== name));
    expect(verdict({ ...strip(RAZORPAY, "PAYMENT_PROVIDER"), ...strip(SMTP, "EMAIL_TRANSPORT"), ...strip(S3, "STORAGE_DRIVER") }, PROD)).toEqual({
      payments: "env_incomplete:PAYMENT_PROVIDER",
      email: "env_incomplete:EMAIL_TRANSPORT",
      storage: "env_incomplete:STORAGE_DRIVER",
    });
    // One variable is enough; STORAGE_LOCAL_DIR only tunes the development driver.
    expect(verdict({ EMAIL_FROM: SMTP.EMAIL_FROM, STORAGE_LOCAL_DIR: "/srv/files" }, PROD)).toEqual({
      payments: "missing:",
      email: "env_incomplete:EMAIL_TRANSPORT",
      storage: "missing:",
    });
    // Outside production the development drivers still apply.
    expect(verdict({ EMAIL_FROM: SMTP.EMAIL_FROM, STORAGE_LOCAL_DIR: "/srv/files" }, DEV)).toMatchObject({ email: "ok", storage: "ok" });
  });

  it("reports cashfree as unsupported and an unknown selector as invalid", () => {
    expect(verdict({ PAYMENT_PROVIDER: "cashfree" }, PROD).payments).toBe("unsupported_provider:PAYMENT_PROVIDER");
    expect(verdict({ PAYMENT_PROVIDER: "paypal", EMAIL_TRANSPORT: "ses", STORAGE_DRIVER: "gcs" }, DEV)).toEqual({
      payments: "env_invalid:PAYMENT_PROVIDER",
      email: "env_invalid:EMAIL_TRANSPORT",
      storage: "env_invalid:STORAGE_DRIVER",
    });
  });
});

describe("classifyEnvIntegrations: values", () => {
  it("accepts complete razorpay, smtp and s3 fallbacks", () => {
    const c = classifyEnvIntegrations({ ...RAZORPAY, ...SMTP, ...S3, SMTP_PORT: "465" }, PROD);
    expect(c.payments.result).toEqual({
      ok: true,
      config: { provider: "razorpay", keyId: RAZORPAY.PAYMENT_KEY_ID, keySecret: RAZORPAY.PAYMENT_KEY_SECRET, webhookSecret: RAZORPAY.PAYMENT_WEBHOOK_SECRET, mode: "test" },
    });
    expect(c.email.result).toEqual({
      ok: true,
      config: {
        transport: "smtp",
        host: "smtp.example.com",
        port: 465,
        security: "tls",
        auth: { user: "mailer", pass: SMTP.SMTP_PASSWORD },
        from: { name: "Axiomatic", address: "no-reply@axiomatic.example" },
      },
    });
    expect(c.storage.result).toEqual({
      ok: true,
      config: {
        driver: "s3",
        endpoint: "https://acc123.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "axs-files",
        forcePathStyle: true,
        accessKeyId: "a1b2c3d4e5f6",
        secretAccessKey: "storage-secret-01",
        preset: null,
      },
    });
    const starttls = classifyEnvIntegrations({ ...SMTP, SMTP_USER: undefined, SMTP_PORT: undefined }, PROD).email.result;
    expect(starttls).toMatchObject({ ok: true, config: { port: 587, security: "starttls", auth: null } });
    const live = classifyEnvIntegrations({ ...RAZORPAY, PAYMENT_KEY_ID: "rzp_live_AbCdEf123456" }, PROD).payments.result;
    expect(live).toMatchObject({ config: { mode: "live" } });
  });

  it("names what is missing (env_incomplete)", () => {
    expect(verdict({ ...RAZORPAY, PAYMENT_KEY_SECRET: undefined, PAYMENT_WEBHOOK_SECRET: "" }, PROD).payments).toBe(
      "env_incomplete:PAYMENT_KEY_SECRET,PAYMENT_WEBHOOK_SECRET",
    );
    expect(verdict({ EMAIL_TRANSPORT: "smtp" }, PROD).email).toBe("env_incomplete:SMTP_HOST,EMAIL_FROM");
    expect(verdict({ STORAGE_DRIVER: "s3", STORAGE_BUCKET: "axs-files" }, PROD).storage).toBe(
      "env_incomplete:STORAGE_REGION,STORAGE_ACCESS_KEY_ID,STORAGE_SECRET_ACCESS_KEY",
    );
  });

  it("treats the release-day stand-ins as values that can't work (env_invalid), in every environment", () => {
    const standIns = { ...RAZORPAY, PAYMENT_KEY_ID: "rzp_test_pending", ...SMTP, SMTP_HOST: "smtp-pending.invalid", ...S3, STORAGE_ENDPOINT: "https://r2-pending.invalid" };
    for (const opts of [PROD, DEV]) {
      expect(verdict(standIns, opts)).toEqual({
        payments: "env_invalid:PAYMENT_KEY_ID",
        email: "env_invalid:SMTP_HOST",
        storage: "env_invalid:STORAGE_ENDPOINT",
      });
    }
  });

  it("applies the production host rules to SMTP_HOST and STORAGE_ENDPOINT", () => {
    expect(verdict({ ...SMTP, SMTP_HOST: "127.0.0.1" }, PROD).email).toBe("env_invalid:SMTP_HOST");
    expect(verdict({ ...SMTP, SMTP_HOST: "localhost" }, DEV).email).toBe("ok");
    expect(verdict({ ...S3, STORAGE_ENDPOINT: "http://files.example.com" }, PROD).storage).toBe("env_invalid:STORAGE_ENDPOINT");
    expect(verdict({ ...S3, STORAGE_ENDPOINT: "http://127.0.0.1:9000" }, DEV).storage).toBe("ok");
    expect(verdict({ ...S3, STORAGE_BUCKET: "Bad_Bucket", STORAGE_FORCE_PATH_STYLE: "maybe" }, PROD).storage).toBe(
      "env_invalid:STORAGE_BUCKET,STORAGE_FORCE_PATH_STYLE",
    );
  });
});

describe("classifyEnvIntegrations: sender, prefill and names", () => {
  it("parses EMAIL_FROM and refuses one that does not parse", () => {
    expect(verdict({ ...SMTP, EMAIL_FROM: "not an address" }, PROD).email).toBe("env_invalid:EMAIL_FROM");
    expect(classifyEnvIntegrations({ ...SMTP, EMAIL_FROM: "no-reply@axiomatic.example" }, PROD).email.result).toMatchObject({
      config: { from: { name: "", address: "no-reply@axiomatic.example" } },
    });
    expect(classifyEnvIntegrations({ EMAIL_FROM: '"Dev Box" <dev@localhost>' }, DEV).email.result).toMatchObject({
      config: { transport: "console", from: { name: "Dev Box", address: "dev@localhost" } },
    });
  });

  it("prefills non-secret values only, names the variables set, and reads quoted values like lib/env.ts", () => {
    const env = { ...RAZORPAY, ...SMTP, ...S3, EMAIL_FROM: '"Axiomatic <no-reply@axiomatic.example>"', SMTP_HOST: "  smtp.example.com  " };
    const c = classifyEnvIntegrations(env, PROD);
    expect(c.payments.prefill).toEqual({ keyId: RAZORPAY.PAYMENT_KEY_ID });
    expect(c.email.prefill).toEqual({
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: "mailer",
      fromName: "Axiomatic",
      fromAddress: "no-reply@axiomatic.example",
    });
    expect(c.storage.prefill).toEqual({
      preset: "r2",
      endpoint: "https://acc123.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "axs-files",
      accessKeyId: "a1b2c3d4e5f6",
      forcePathStyle: true,
    });
    const text = JSON.stringify([c.payments.prefill, c.email.prefill, c.storage.prefill, c.payments.namesSet, c.email.namesSet, c.storage.namesSet]);
    for (const secret of [RAZORPAY.PAYMENT_KEY_SECRET, RAZORPAY.PAYMENT_WEBHOOK_SECRET, SMTP.SMTP_PASSWORD, S3.STORAGE_SECRET_ACCESS_KEY]) {
      expect(text).not.toContain(secret);
    }
    expect(c.payments.namesSet).toEqual(["PAYMENT_PROVIDER", "PAYMENT_KEY_ID", "PAYMENT_KEY_SECRET", "PAYMENT_WEBHOOK_SECRET"]);
    expect(c.email.selector).toBe("smtp");
    expect(c.storage.selector).toBe("s3");
  });
});
