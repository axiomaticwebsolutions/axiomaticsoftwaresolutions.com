/**
 * The env-file fallback of each integration (docs/admin-integrations-design.md section 3): whether the PAYMENT_*,
 * EMAIL_* / SMTP_* / SES_* and STORAGE_* variables form a complete, usable configuration. The resolver uses it only when no
 * Admin row exists for the kind; the deploy preflight prints its verdict (names only).
 *
 * - Selectors: PAYMENT_PROVIDER, EMAIL_TRANSPORT (console | smtp | ses), STORAGE_DRIVER. Unset means the development
 *   driver (mock, console, local) outside production; in production `missing` when none of the kind's variables is
 *   set, else `env_incomplete` naming the selector. The development drivers are refused in production.
 * - Values are read raw (trimmed, surrounding quotes dropped, like lib/env.ts) and checked again: key id format,
 *   secret lengths and placeholders, bucket and region, the host and endpoint rules of lib/security/host-rules.ts,
 *   the Amazon SES region list and AWS access key ID format (EMAIL_TRANSPORT=ses: SES_REGION, SES_ACCESS_KEY_ID,
 *   SES_SECRET_ACCESS_KEY, optional SES_CONFIGURATION_SET, plus EMAIL_FROM).
 *   The release-day stand-ins (rzp_test_pending, smtp-pending.invalid, https://r2-pending.invalid) are `env_invalid`.
 * Results name variables, never values; only `config` (server-side) holds them.
 *
 * No server-only and relative imports only: deploy/preflight.mjs loads it under `node --import tsx`.
 */
import { parseMailbox } from "../email/address";
import { isPlaceholder } from "../placeholders";
import { endpointProblem, hostProblem } from "../security/host-rules";
import {
  AWS_ACCESS_KEY_ID_RE,
  BUCKET_RE,
  guessStoragePreset,
  isSesRegion,
  INTEGRATION_ENV_NAMES,
  normalizeEndpoint,
  normalizeHost,
  RAZORPAY_KEY_ID_RE,
  razorpayMode,
  REGION_RE,
  SECRET_MIN_LENGTH,
  securityForPort,
  SES_CONFIGURATION_SET_RE,
  type IntegrationKind,
} from "./model";
import type { EmailConfig, EnvIntegrationState, NotConfiguredReason, PaymentsConfig, StorageConfig } from "./types";

export type IntegrationEnvInput = Readonly<Record<string, string | undefined>>;

export type EnvVerdict<C> = { ok: true; config: C } | { ok: false; reason: NotConfiguredReason; names: readonly string[] };
export type EnvClassification<C> = EnvIntegrationState & { result: EnvVerdict<C> };
export type EnvIntegrations = {
  payments: EnvClassification<PaymentsConfig>;
  email: EnvClassification<EmailConfig>;
  storage: EnvClassification<StorageConfig>;
};

export const DEV_EMAIL_FROM = { name: "Axiomatic Software (dev)", address: "no-reply@localhost" } as const;
export const MOCK_ENV_KEY_ID = "mock_key";

/** Trimmed, surrounding quotes dropped (docker --env-file keeps them), "" -> undefined. Same rule as lib/env.ts. */
function reader(source: IntegrationEnvInput): (name: string) => string | undefined {
  return (name) => {
    const raw = source[name];
    if (typeof raw !== "string") return undefined;
    let v = raw.trim();
    const first = v.charAt(0);
    if (v.length >= 2 && (first === '"' || first === "'") && v.endsWith(first)) v = v.slice(1, -1).trim();
    return v === "" ? undefined : v;
  };
}

const usableSecret = (value: string, min: number) => value.length >= min && !isPlaceholder(value);
const fail = <C>(reason: NotConfiguredReason, names: readonly string[]): EnvVerdict<C> => ({ ok: false, reason, names });

function namesSet(kind: IntegrationKind, read: (name: string) => string | undefined): string[] {
  return INTEGRATION_ENV_NAMES[kind].filter((name) => read(name) !== undefined);
}

/** Variables that only tune the development driver; set alone, they do not make a production configuration. */
const DEV_ONLY_NAMES = new Set(["STORAGE_LOCAL_DIR"]);

/**
 * Production without a selector: `missing` when none of the kind's variables is set, else `env_incomplete` naming the
 * selector (values without PAYMENT_PROVIDER / EMAIL_TRANSPORT / STORAGE_DRIVER would otherwise be ignored silently).
 */
function noSelector<C>(selectorName: string, set: readonly string[]): EnvVerdict<C> {
  const values = set.filter((name) => name !== selectorName && !DEV_ONLY_NAMES.has(name));
  return values.length > 0 ? fail<C>("env_incomplete", [selectorName]) : fail<C>("missing", []);
}

function classifyPayments(read: (name: string) => string | undefined, production: boolean): EnvClassification<PaymentsConfig> {
  const selector = read("PAYMENT_PROVIDER") ?? null;
  const keyId = read("PAYMENT_KEY_ID");
  const keySecret = read("PAYMENT_KEY_SECRET");
  const webhookSecret = read("PAYMENT_WEBHOOK_SECRET");
  const prefill: Record<string, string | number | boolean> = {};
  if (keyId && RAZORPAY_KEY_ID_RE.test(keyId)) prefill.keyId = keyId;
  const base = { selector, namesSet: namesSet("payments", read), prefill };
  const effective = selector ?? (production ? null : "mock");
  let result: EnvVerdict<PaymentsConfig>;
  if (effective === null) {
    result = noSelector("PAYMENT_PROVIDER", base.namesSet);
  } else if (effective === "mock") {
    const missing = [!keySecret && "PAYMENT_KEY_SECRET", !webhookSecret && "PAYMENT_WEBHOOK_SECRET"].filter((n): n is string => Boolean(n));
    if (production) result = fail("env_invalid", ["PAYMENT_PROVIDER"]);
    else if (missing.length > 0) result = fail("env_incomplete", missing);
    else result = { ok: true, config: { provider: "mock", keyId: keyId ?? MOCK_ENV_KEY_ID, keySecret: keySecret as string, webhookSecret: webhookSecret as string, mode: "test" } };
  } else if (effective === "razorpay") {
    const missing = [!keyId && "PAYMENT_KEY_ID", !keySecret && "PAYMENT_KEY_SECRET", !webhookSecret && "PAYMENT_WEBHOOK_SECRET"].filter(
      (n): n is string => Boolean(n),
    );
    const invalid = [
      keyId && !RAZORPAY_KEY_ID_RE.test(keyId) && "PAYMENT_KEY_ID",
      keySecret && !usableSecret(keySecret, SECRET_MIN_LENGTH.keySecret) && "PAYMENT_KEY_SECRET",
      webhookSecret && !usableSecret(webhookSecret, SECRET_MIN_LENGTH.webhookSecret) && "PAYMENT_WEBHOOK_SECRET",
    ].filter((n): n is string => Boolean(n));
    const mode = keyId ? razorpayMode(keyId) : null;
    if (missing.length > 0) result = fail("env_incomplete", missing);
    else if (invalid.length > 0 || !mode) result = fail("env_invalid", invalid.length > 0 ? invalid : ["PAYMENT_KEY_ID"]);
    else result = { ok: true, config: { provider: "razorpay", keyId: keyId as string, keySecret: keySecret as string, webhookSecret: webhookSecret as string, mode } };
  } else if (effective === "cashfree") {
    result = fail("unsupported_provider", ["PAYMENT_PROVIDER"]);
  } else {
    result = fail("env_invalid", ["PAYMENT_PROVIDER"]);
  }
  return { ...base, result };
}

function classifyEmail(read: (name: string) => string | undefined, production: boolean): EnvClassification<EmailConfig> {
  const selector = read("EMAIL_TRANSPORT") ?? null;
  const fromRaw = read("EMAIL_FROM");
  const from = fromRaw ? parseMailbox(fromRaw) : null;
  const host = read("SMTP_HOST");
  const portRaw = read("SMTP_PORT");
  const port = portRaw === undefined ? 587 : /^[0-9]{1,5}$/.test(portRaw) ? Number(portRaw) : Number.NaN;
  const portOk = Number.isInteger(port) && port >= 1 && port <= 65_535;
  const user = read("SMTP_USER");
  const pass = read("SMTP_PASSWORD");
  const sesRegion = read("SES_REGION")?.toLowerCase();
  const sesKeyId = read("SES_ACCESS_KEY_ID");
  const sesSecret = read("SES_SECRET_ACCESS_KEY");
  const sesConfigSet = read("SES_CONFIGURATION_SET");
  const sesKeyIdOk = sesKeyId !== undefined && AWS_ACCESS_KEY_ID_RE.test(sesKeyId) && !isPlaceholder(sesKeyId);
  const prefill: Record<string, string | number | boolean> = {};
  if (selector === "ses") prefill.provider = "ses";
  if (sesRegion && isSesRegion(sesRegion)) prefill.region = sesRegion;
  if (sesKeyIdOk) prefill.accessKeyId = sesKeyId;
  if (sesConfigSet && SES_CONFIGURATION_SET_RE.test(sesConfigSet)) prefill.configurationSet = sesConfigSet;
  if (host) prefill.host = normalizeHost(host);
  if (portOk) {
    prefill.port = port;
    prefill.security = securityForPort(port);
  }
  if (user) prefill.username = user;
  if (from) {
    prefill.fromName = from.name;
    prefill.fromAddress = from.address;
  }
  const base = { selector, namesSet: namesSet("email", read), prefill };
  const effective = selector ?? (production ? null : "console");
  let result: EnvVerdict<EmailConfig>;
  if (effective === null) {
    result = noSelector("EMAIL_TRANSPORT", base.namesSet);
  } else if (effective === "console") {
    result = production ? fail("env_invalid", ["EMAIL_TRANSPORT"]) : { ok: true, config: { transport: "console", from: from ?? { ...DEV_EMAIL_FROM } } };
  } else if (effective === "smtp") {
    const missing = [!host && "SMTP_HOST", !fromRaw && "EMAIL_FROM"].filter((n): n is string => Boolean(n));
    const invalid = [
      host && hostProblem(host, { production }) && "SMTP_HOST",
      !portOk && "SMTP_PORT",
      fromRaw && !from && "EMAIL_FROM",
      pass && isPlaceholder(pass) && "SMTP_PASSWORD",
    ].filter((n): n is string => Boolean(n));
    if (missing.length > 0) result = fail("env_incomplete", missing);
    else if (invalid.length > 0) result = fail("env_invalid", invalid);
    else {
      result = {
        ok: true,
        config: {
          transport: "smtp",
          host: normalizeHost(host as string),
          port,
          security: securityForPort(port),
          auth: user ? { user, pass: pass ?? "" } : null,
          from: from as { name: string; address: string },
        },
      };
    }
  } else if (effective === "ses") {
    // Same production rules as smtp: placeholders refused, nothing development-only. No endpoint variable on purpose:
    // the SESv2 client talks to AWS's own endpoint for the region.
    const missing = [
      !sesRegion && "SES_REGION",
      !sesKeyId && "SES_ACCESS_KEY_ID",
      !sesSecret && "SES_SECRET_ACCESS_KEY",
      !fromRaw && "EMAIL_FROM",
    ].filter((n): n is string => Boolean(n));
    const invalid = [
      sesRegion && !isSesRegion(sesRegion) && "SES_REGION",
      sesKeyId && !sesKeyIdOk && "SES_ACCESS_KEY_ID",
      sesSecret && !usableSecret(sesSecret, SECRET_MIN_LENGTH.secretAccessKey) && "SES_SECRET_ACCESS_KEY",
      sesConfigSet && !SES_CONFIGURATION_SET_RE.test(sesConfigSet) && "SES_CONFIGURATION_SET",
      fromRaw && !from && "EMAIL_FROM",
    ].filter((n): n is string => Boolean(n));
    if (missing.length > 0) result = fail("env_incomplete", missing);
    else if (invalid.length > 0) result = fail("env_invalid", invalid);
    else {
      result = {
        ok: true,
        config: {
          transport: "ses",
          region: sesRegion as string,
          accessKeyId: sesKeyId as string,
          secretAccessKey: sesSecret as string,
          configurationSet: sesConfigSet ?? null,
          from: from as { name: string; address: string },
        },
      };
    }
  } else {
    result = fail("env_invalid", ["EMAIL_TRANSPORT"]);
  }
  return { ...base, result };
}

function parseFlag(value: string | undefined): boolean | null {
  if (value === undefined) return false;
  const v = value.toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return null;
}

function classifyStorage(read: (name: string) => string | undefined, production: boolean): EnvClassification<StorageConfig> {
  const selector = read("STORAGE_DRIVER") ?? null;
  const endpointRaw = read("STORAGE_ENDPOINT");
  const endpoint = endpointRaw ? normalizeEndpoint(endpointRaw) : null;
  const region = read("STORAGE_REGION")?.toLowerCase();
  const bucket = read("STORAGE_BUCKET");
  const accessKeyId = read("STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = read("STORAGE_SECRET_ACCESS_KEY");
  const forcePathStyle = parseFlag(read("STORAGE_FORCE_PATH_STYLE"));
  const prefill: Record<string, string | number | boolean> = { preset: guessStoragePreset(endpoint) };
  if (endpoint) prefill.endpoint = endpoint;
  if (region) prefill.region = region;
  if (bucket) prefill.bucket = bucket;
  if (accessKeyId && !isPlaceholder(accessKeyId)) prefill.accessKeyId = accessKeyId;
  if (forcePathStyle !== null) prefill.forcePathStyle = forcePathStyle;
  const base = { selector, namesSet: namesSet("storage", read), prefill };
  const effective = selector ?? (production ? null : "local");
  let result: EnvVerdict<StorageConfig>;
  if (effective === null) {
    result = noSelector("STORAGE_DRIVER", base.namesSet);
  } else if (effective === "local") {
    result = production ? fail("env_invalid", ["STORAGE_DRIVER"]) : { ok: true, config: { driver: "local", dir: read("STORAGE_LOCAL_DIR") ?? ".storage" } };
  } else if (effective === "s3") {
    const missing = [
      !bucket && "STORAGE_BUCKET",
      !region && "STORAGE_REGION",
      !accessKeyId && "STORAGE_ACCESS_KEY_ID",
      !secretAccessKey && "STORAGE_SECRET_ACCESS_KEY",
    ].filter((n): n is string => Boolean(n));
    const invalid = [
      endpointRaw && (endpoint === null || endpointProblem(endpointRaw, { production })) && "STORAGE_ENDPOINT",
      region && !REGION_RE.test(region) && "STORAGE_REGION",
      bucket && !BUCKET_RE.test(bucket) && "STORAGE_BUCKET",
      accessKeyId && !usableSecret(accessKeyId, 4) && "STORAGE_ACCESS_KEY_ID",
      secretAccessKey && !usableSecret(secretAccessKey, SECRET_MIN_LENGTH.secretAccessKey) && "STORAGE_SECRET_ACCESS_KEY",
      forcePathStyle === null && "STORAGE_FORCE_PATH_STYLE",
    ].filter((n): n is string => Boolean(n));
    if (missing.length > 0) result = fail("env_incomplete", missing);
    else if (invalid.length > 0) result = fail("env_invalid", invalid);
    else {
      result = {
        ok: true,
        config: {
          driver: "s3",
          endpoint,
          region: region as string,
          bucket: bucket as string,
          forcePathStyle: forcePathStyle as boolean,
          accessKeyId: accessKeyId as string,
          secretAccessKey: secretAccessKey as string,
          preset: null,
        },
      };
    }
  } else {
    result = fail("env_invalid", ["STORAGE_DRIVER"]);
  }
  return { ...base, result };
}

/** Classifies the env fallback of every integration (see the module comment). `source` is a raw env record. */
export function classifyEnvIntegrations(source: IntegrationEnvInput, opts: { production: boolean }): EnvIntegrations {
  const read = reader(source);
  return {
    payments: classifyPayments(read, opts.production),
    email: classifyEmail(read, opts.production),
    storage: classifyStorage(read, opts.production),
  };
}
