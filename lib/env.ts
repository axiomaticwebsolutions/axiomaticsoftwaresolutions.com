/**
 * Validated environment configuration.
 *
 * Every variable in `.env.example` is parsed here once and cached. Problems are collected and reported together
 * (variable names and rules only; secret values are never echoed). Placeholder secrets from `.env.example`
 * ("change-me", "xxxxxxxx", "...") are refused so a copied example file can never boot a real deployment.
 *
 * Deliberately free of `server-only` so scripts (seed, secrets) and tests can import it.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { z } from "zod";
import { parseMailbox } from "./email/address";
import { isPlaceholder } from "./placeholders";

export { isPlaceholder };

const SECRETS_HINT = "run `pnpm secrets` to generate development values";

function secret(minLength: number) {
  return z
    .string()
    .refine((v) => !isPlaceholder(v), `is a placeholder value; ${SECRETS_HINT}`)
    .refine((v) => v.length >= minLength, `must be at least ${minLength} characters`);
}

function decodedLength(base64: string): number {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(base64)) return -1;
  return Buffer.from(base64, "base64").length;
}

function parseKey(pem: string, kind: "private" | "public"): KeyObject | null {
  try {
    return kind === "private" ? createPrivateKey(pem) : createPublicKey(pem);
  } catch {
    return null;
  }
}

function ed25519Pem(kind: "private" | "public") {
  const label = kind === "private" ? "PRIVATE KEY" : "PUBLIC KEY";
  return z
    .string()
    .refine((v) => !isPlaceholder(v), `is a placeholder value; ${SECRETS_HINT}`)
    .refine(
      (v) => v.includes(`-----BEGIN ${label}-----`) && parseKey(v, kind)?.asymmetricKeyType === "ed25519",
      `must be an Ed25519 ${kind} key in PEM format (escaped \x5Cn line breaks are accepted)`,
    );
}

const optionalSecret = (minLength: number) => secret(minLength).optional();

const booleanFlag = z
  .enum(["true", "false", "1", "0", "yes", "no"], "must be true or false")
  .transform((v) => v === "true" || v === "1" || v === "yes");

function wholeNumber(unit: string, min: number, max: number) {
  return z.coerce
    .number(`must be a whole number of ${unit}`)
    .int(`must be a whole number of ${unit}`)
    .min(min, `must be between ${min} and ${max}`)
    .max(max, `must be between ${min} and ${max}`);
}

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\/\S+$/, "must be a postgresql:// connection URL");

const envSchema = z.object({
  // ---- App
  APP_URL: z
    .url({ protocol: /^https?$/, error: "must be an absolute http(s) URL" })
    .transform((v) => v.replace(/\/+$/, "")),
  NODE_ENV: z.enum(["development", "test", "production"], "must be development, test or production").default("development"),
  SESSION_SECRET: secret(32),
  CSRF_SECRET: secret(32),
  ORDER_TOKEN_SECRET: secret(32),
  CRON_SECRET: secret(32),

  // ---- Database
  DATABASE_URL: postgresUrl,
  TEST_DATABASE_URL: postgresUrl.optional(),
  // Pool bounds read by lib/db.ts (poolSettingsFromEnv, same ranges and defaults); validated here so a bad value stops
  // the server at start-up. See docs/scaling.md "Connection pooling".
  DATABASE_POOL_MAX: wholeNumber("connections", 1, 200).default(10),
  DATABASE_POOL_TIMEOUT_MS: wholeNumber("milliseconds", 100, 60_000).default(5_000),
  DATABASE_STATEMENT_TIMEOUT_MS: wholeNumber("milliseconds", 0, 600_000).default(5_000),

  // ---- Licensing
  LICENSE_KEY_PEPPER: secret(32),
  LICENSE_KEY_ENC_KEY: secret(1).refine((v) => decodedLength(v) === 32, "must be exactly 32 random bytes, base64-encoded"),
  LICENSE_SIGNING_PRIVATE_KEY: ed25519Pem("private"),
  LICENSE_SIGNING_PUBLIC_KEY: ed25519Pem("public"),
  LICENSE_OFFLINE_GRACE_DAYS: z.coerce
    .number("must be a whole number of days")
    .int("must be a whole number of days")
    .min(1, "must be between 1 and 30")
    .max(30, "must be between 1 and 30")
    .default(7),

  // ---- Integrations: payments, storage and email are normally saved in Admin > Settings > Integrations
  // (docs/admin-integrations-design.md). These variables are only the fallback when nothing is saved there, so none of
  // them is required; lib/integrations/env-source.ts decides whether they form a usable configuration. When present,
  // they are still validated here (placeholders refused; development drivers refused in production).
  // Unset selectors mean: the development driver outside production (mock / local / console), "not configured" in it.

  // ---- Payments (fallback)
  PAYMENT_PROVIDER: z.enum(["razorpay", "cashfree", "mock"], "must be razorpay, cashfree or mock").optional(),
  PAYMENT_KEY_ID: optionalSecret(4),
  PAYMENT_KEY_SECRET: optionalSecret(8),
  PAYMENT_WEBHOOK_SECRET: optionalSecret(16),

  // ---- Protected file storage (fallback; STORAGE_LOCAL_DIR and DOWNLOAD_LINK_TTL_SECONDS stay env-only)
  STORAGE_DRIVER: z.enum(["local", "s3"], "must be local or s3").optional(),
  STORAGE_LOCAL_DIR: z.string().default(".storage"),
  STORAGE_ENDPOINT: z.url({ protocol: /^https?$/, error: "must be an absolute http(s) URL" }).optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "must be a valid bucket name").optional(),
  STORAGE_ACCESS_KEY_ID: optionalSecret(4),
  STORAGE_SECRET_ACCESS_KEY: optionalSecret(8),
  STORAGE_FORCE_PATH_STYLE: booleanFlag.default(false),
  DOWNLOAD_LINK_TTL_SECONDS: z.coerce
    .number("must be a whole number of seconds")
    .int("must be a whole number of seconds")
    .min(30, "must be at least 30 seconds")
    .default(600)
    // Presigned download links never live longer than 10 minutes, whatever the env says.
    .transform((v) => Math.min(v, 600)),

  // ---- Email (fallback)
  EMAIL_TRANSPORT: z.enum(["console", "smtp"], "must be console or smtp").optional(),
  EMAIL_FROM: z
    .string()
    .refine((v) => parseMailbox(v) !== null, "must be a sender such as \"Name <no-reply@example.com>\"")
    .optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number("must be a port number").int("must be a port number").min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: optionalSecret(1),

  // ---- Rate limiting: Redis store (instrumentation.ts). Optional in development (Postgres buckets when unset);
  // required when NODE_ENV=production (crossFieldProblems).
  REDIS_URL: z.string().regex(/^rediss?:\/\/\S+$/, "must be a redis:// or rediss:// URL").optional(),
  // Reverse proxies in front of the app that append the peer address to X-Forwarded-For (ALB = 1,
  // CloudFront + ALB = 2). 0 trusts no forwarding header, so clientIp() returns null. Required (>= 1) in production.
  TRUSTED_PROXY_HOPS: z.coerce
    .number("must be a whole number of proxies")
    .int("must be a whole number of proxies")
    .min(0, "must be between 0 and 10")
    .max(10, "must be between 0 and 10")
    .default(0),

  // ---- Security headers: Strict-Transport-Security adds `includeSubDomains; preload` when true (turn on before live
  // sales, once every subdomain serves HTTPS). Read by next.config.ts at build time (lib/security/headers.ts); a change
  // needs a deploy. Validated here so a typo stops the server too.
  SECURITY_HSTS_STRICT: booleanFlag.default(false),

  // ---- Storefront catalog source: "fixtures" serves prisma/seed-data without a database (dev and test only).
  CATALOG_SOURCE: z.enum(["db", "fixtures"], "must be db or fixtures").default("db"),

  // ---- Seed (dev only)
  SEED_OWNER_EMAIL: z.email("must be an email address").optional(),
  SEED_OWNER_PASSWORD: optionalSecret(8),
  SEED_DEMO_PASSWORD: optionalSecret(8),
});

export type Env = z.output<typeof envSchema>;
type EnvKey = keyof z.input<typeof envSchema>;
type RawEnv = Partial<Record<EnvKey, string>>;

const ENV_KEYS = Object.keys(envSchema.shape) as EnvKey[];
const PEM_KEYS = new Set<EnvKey>(["LICENSE_SIGNING_PRIVATE_KEY", "LICENSE_SIGNING_PUBLIC_KEY"]);

/** Thrown when the environment is invalid. `problems` lists every problem, one line each, without values. */
export class EnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    const plural = problems.length === 1 ? "" : "s";
    super(
      `Invalid environment configuration (${problems.length} problem${plural}):\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\nSee .env.example. For local development, `pnpm secrets` writes a valid .env.local.",
    );
    this.name = "EnvError";
    this.problems = problems;
  }
}

function normalize(source: Record<string, string | undefined>): RawEnv {
  const out: RawEnv = {};
  for (const key of ENV_KEYS) {
    const raw = source[key];
    if (typeof raw !== "string") continue;
    let v = raw.trim();
    // docker --env-file and some hosts keep surrounding quotes literally.
    const first = v.charAt(0);
    if (v.length >= 2 && (first === '"' || first === "'") && v.endsWith(first)) v = v.slice(1, -1).trim();
    if (PEM_KEYS.has(key)) v = v.replace(/\x5Cn/g, "\n");
    if (v !== "") out[key] = v;
  }
  return out;
}

/** Rules that span several variables. Reads the normalized raw values so they run even when other fields failed. */
function crossFieldProblems(raw: RawEnv): string[] {
  const problems: string[] = [];
  const nodeEnv = raw.NODE_ENV ?? "development";

  if (nodeEnv === "production") {
    // Unset is fine (Admin > Settings > Integrations, or "not configured"); an explicit development driver is not.
    if (raw.PAYMENT_PROVIDER === "mock") problems.push("PAYMENT_PROVIDER: mock is not allowed when NODE_ENV=production");
    if (raw.STORAGE_DRIVER === "local") problems.push("STORAGE_DRIVER: local is not allowed when NODE_ENV=production (use s3, or set storage in Admin)");
    if (raw.EMAIL_TRANSPORT === "console") {
      problems.push("EMAIL_TRANSPORT: console is not allowed when NODE_ENV=production (use smtp, or set email in Admin)");
    }
    if (raw.CATALOG_SOURCE === "fixtures") problems.push("CATALOG_SOURCE: fixtures is not allowed when NODE_ENV=production (use db)");
    if (raw.APP_URL !== undefined && !raw.APP_URL.startsWith("https://")) {
      problems.push("APP_URL: must use https when NODE_ENV=production");
    }
    // Every app server must count against the same buckets; the Postgres bucket store is for development only.
    if (raw.REDIS_URL === undefined) {
      problems.push(
        "REDIS_URL: is required when NODE_ENV=production (rate limits need a shared Redis, e.g. rediss://host:6379; Postgres buckets are for development only)",
      );
    }
    // Per-IP rate limits and audit IP prefixes depend on it; with 0 every client would share one bucket.
    if (raw.TRUSTED_PROXY_HOPS === undefined) {
      problems.push("TRUSTED_PROXY_HOPS: is required when NODE_ENV=production");
    } else if (/^0+$/.test(raw.TRUSTED_PROXY_HOPS)) {
      problems.push(
        "TRUSTED_PROXY_HOPS: must be at least 1 when NODE_ENV=production (run behind a proxy that appends X-Forwarded-For)",
      );
    }
  }
  // No "required when" rules for the integrations: a half-filled fallback no longer stops the server. Whether the
  // variables form a usable configuration is decided by lib/integrations/env-source.ts (shown in Admin and by the
  // deploy preflight).

  const priv = raw.LICENSE_SIGNING_PRIVATE_KEY ? parseKey(raw.LICENSE_SIGNING_PRIVATE_KEY, "private") : null;
  const pub = raw.LICENSE_SIGNING_PUBLIC_KEY ? parseKey(raw.LICENSE_SIGNING_PUBLIC_KEY, "public") : null;
  if (priv?.asymmetricKeyType === "ed25519" && pub?.asymmetricKeyType === "ed25519") {
    const derived = createPublicKey(priv).export({ type: "spki", format: "der" });
    if (!derived.equals(pub.export({ type: "spki", format: "der" }))) {
      problems.push("LICENSE_SIGNING_PUBLIC_KEY: does not match LICENSE_SIGNING_PRIVATE_KEY");
    }
  }
  return problems;
}

/** Parses an environment record. Throws EnvError listing every problem. Exposed for tests; use getEnv() in app code. */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const raw = normalize(source);
  const problems: string[] = [];
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const seen = new Set<string>();
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? "(root)");
      if (seen.has(key)) continue; // the first problem per variable is enough
      seen.add(key);
      const missing = raw[key as EnvKey] === undefined;
      problems.push(`${key}: ${missing ? "is required" : issue.message}`);
    }
  }
  problems.push(...crossFieldProblems(raw));
  if (problems.length > 0 || !result.success) throw new EnvError(problems);
  return result.data;
}

let cached: Env | null = null;

/** The validated environment (parsed once per process). */
export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

/** Drops the cached environment (tests that change process.env). */
export function resetEnvCache(): void {
  cached = null;
}

/** NODE_ENV check that never throws (safe for loggers and error paths). */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Structurally identical to LicenseKeySecrets in lib/licensing/crypto.ts (declared here to avoid an import cycle). */
type LicenseKeySecrets = { pepper: string; encKey: Buffer };

/** HMAC pepper and AES-256-GCM key for license keys. Returns a fresh Buffer on every call. */
export function getLicenseKeySecrets(): LicenseKeySecrets {
  const env = getEnv();
  return { pepper: env.LICENSE_KEY_PEPPER, encKey: Buffer.from(env.LICENSE_KEY_ENC_KEY, "base64") };
}
