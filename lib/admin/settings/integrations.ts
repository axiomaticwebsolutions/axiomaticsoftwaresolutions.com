/**
 * Views of Admin > Settings > Integrations (docs/admin-integrations-design.md section 14): one IntegrationState per
 * integration, built from a FRESH resolver snapshot (a save on another PM2 process shows at once), plus the read-only
 * Redis card (env-only).
 *
 * - Everyone who may open Settings gets the status: source (Saved in Admin / From the server file / Not configured),
 *   provider kind, payment mode, the problem line and the fallback env variable NAMES.
 * - Only integrations.manage (the Owner) also gets `form`: the non-secret values (from the Admin row, else the env
 *   file's usable non-secret values, else defaults) and a SecretHint per secret saved in Admin.
 * Never returns a secret: Admin secrets appear as hints, env secrets are never described beyond the source.
 * Server-only.
 */
import "server-only";
import type { Db } from "@/lib/db";
import type { Env } from "@/lib/env";
import {
  DEFAULT_SMTP_PORTS,
  INTEGRATION_ENV_NAMES,
  INTEGRATION_TITLES,
  securityForPort,
  STORAGE_PRESET_DEFAULTS,
  STORAGE_PRESETS,
  type EmailSecurity,
  type IntegrationKind,
  type StoragePreset,
} from "@/lib/integrations/model";
import { getIntegrationSnapshot } from "@/lib/integrations/resolver";
import type { AdminSecretHint, IntegrationSnapshot, Resolved } from "@/lib/integrations/types";
import { endpointProblem, hostProblem } from "@/lib/security/host-rules";
import {
  INTEGRATION_CARD_META,
  INTEGRATIONS_COPY,
  integrationProblem,
  type IntegrationForm,
  type IntegrationsData,
  type IntegrationState,
  type PrefilledFrom,
  type RedisState,
  type SecretHint,
} from "./integrations-model";

export type IntegrationViewEnv = Pick<Env, "NODE_ENV" | "REDIS_URL" | "APP_URL">;
export type IntegrationViewOptions = {
  /** integrations.manage: forms and hints; otherwise status only. */
  canManage: boolean;
  env: IntegrationViewEnv;
  /** The newest signed razorpay webhook (payments form only). */
  lastSignedWebhookAt?: Date | null;
};

export const RAZORPAY_WEBHOOK_PATH = "/api/webhooks/payments/razorpay";
/** Card order of the prototype: payments, storage, email (then rate limits). */
export const INTEGRATION_CARD_ORDER: readonly IntegrationKind[] = ["payments", "storage", "email"];

const iso = (d: Date) => d.toISOString();
const NOT_SET: SecretHint = { set: false, last4: null, updatedAt: null, updatedBy: null };

function secretHint(hint: AdminSecretHint | undefined): SecretHint {
  return hint ? { set: true, last4: hint.last4, updatedAt: iso(hint.updatedAt), updatedBy: hint.updatedByName } : { ...NOT_SET };
}

type AnyResolved = Resolved<unknown> & ({ source: "none" } | { source: "admin" | "env"; config: Record<string, unknown> });

function resolvedOf(snapshot: IntegrationSnapshot, kind: IntegrationKind): AnyResolved {
  return snapshot[kind] as AnyResolved;
}

function isDevelopment(kind: IntegrationKind, resolved: AnyResolved): boolean {
  if (resolved.source === "none") return false;
  const c = resolved.config;
  return kind === "payments" ? c.provider === "mock" : kind === "email" ? c.transport === "console" : c.driver === "local";
}

function providerLabel(kind: IntegrationKind, resolved: AnyResolved): string {
  if (resolved.source === "none") return "Not set";
  const dev = isDevelopment(kind, resolved);
  if (kind === "payments") return dev ? "Mock provider" : "Razorpay";
  if (kind === "email") return dev ? "Console (dev mailbox)" : "SMTP";
  return dev ? "Local disk" : "S3-compatible bucket";
}

/**
 * Env prefill kept when the env fallback was rejected as unusable (`env_invalid`, e.g. the release-day stand-ins):
 * provider-shaped choices and the sender only. The rest (Key ID, SMTP host and username, endpoint, bucket, access key
 * ID) is left out, so the Owner never saves a stand-in such as "pending" or "axiomatic-files-pending" by accident.
 */
const ENV_INVALID_PREFILL_KEYS = new Set(["preset", "region", "forcePathStyle", "port", "security", "fromName", "fromAddress"]);

/**
 * The env file's non-secret values for the form, without values that cannot work here: a host or endpoint the host
 * rules refuse (e.g. the release-day stand-ins under .invalid) is left out, so the Owner starts from an empty field;
 * when the whole env fallback is unusable (env_invalid) only ENV_INVALID_PREFILL_KEYS are kept.
 */
function envPrefill(snapshot: IntegrationSnapshot, kind: IntegrationKind, production: boolean): Record<string, string | number | boolean> {
  const prefill: Record<string, string | number | boolean> = { ...snapshot.env[kind].prefill };
  const resolved = resolvedOf(snapshot, kind);
  if (resolved.source === "none" && resolved.reason === "env_invalid") {
    for (const key of Object.keys(prefill)) if (!ENV_INVALID_PREFILL_KEYS.has(key)) delete prefill[key];
    // Without the endpoint, an R2 region ("auto") still tells the provider.
    if (kind === "storage" && prefill.region === "auto") prefill.preset = "r2";
    return prefill;
  }
  if (kind === "email" && typeof prefill.host === "string" && hostProblem(prefill.host, { production })) delete prefill.host;
  if (kind === "storage" && typeof prefill.endpoint === "string" && endpointProblem(prefill.endpoint, { production })) {
    delete prefill.endpoint;
    if (prefill.region === "auto") prefill.preset = "r2";
  }
  return prefill;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Env prefill keys that hold something the operator typed (port, security and path style always have a default). */
const DEFAULTED_PREFILL_KEYS = new Set(["preset", "forcePathStyle", "port", "security"]);

function formFor(kind: IntegrationKind, snapshot: IntegrationSnapshot, opts: IntegrationViewOptions): IntegrationForm {
  const production = opts.env.NODE_ENV === "production";
  const admin = snapshot.admin[kind];
  const settings = (admin?.settings ?? null) as Record<string, unknown> | null;
  // A saved row decides as a whole: its form never mixes in env values, even when its settings are unreadable.
  const prefill = admin ? {} : envPrefill(snapshot, kind, production);
  const fromEnv = Object.keys(prefill).some((key) => !DEFAULTED_PREFILL_KEYS.has(key));
  const prefilledFrom: PrefilledFrom = settings ? "admin" : fromEnv ? "env" : "defaults";
  const secrets: Partial<Record<string, AdminSecretHint>> = admin?.secrets ?? {};
  const source = settings ?? prefill;

  if (kind === "payments") {
    return {
      kind,
      prefilledFrom,
      values: { keyId: str(source.keyId) },
      secrets: { keySecret: secretHint(secrets.keySecret), webhookSecret: secretHint(secrets.webhookSecret) },
      webhookUrl: `${opts.env.APP_URL.replace(/\/+$/, "")}${RAZORPAY_WEBHOOK_PATH}`,
      lastSignedWebhookAt: opts.lastSignedWebhookAt ? iso(opts.lastSignedWebhookAt) : null,
    };
  }
  if (kind === "email") {
    const port = typeof source.port === "number" ? source.port : DEFAULT_SMTP_PORTS.starttls;
    const security: EmailSecurity = source.security === "tls" || source.security === "starttls" ? source.security : securityForPort(port);
    return {
      kind,
      prefilledFrom,
      values: {
        host: str(source.host),
        port,
        security,
        username: str(source.username),
        fromName: str(source.fromName),
        fromAddress: str(source.fromAddress),
      },
      secrets: { password: secretHint(secrets.password) },
    };
  }
  const preset: StoragePreset = (STORAGE_PRESETS as readonly unknown[]).includes(source.preset) ? (source.preset as StoragePreset) : "aws";
  const defaults = STORAGE_PRESET_DEFAULTS[preset];
  return {
    kind,
    prefilledFrom,
    values: {
      preset,
      endpoint: str(source.endpoint, settings ? "" : (defaults.endpoint ?? "")),
      region: str(source.region, settings ? "" : (defaults.region ?? "")),
      bucket: str(source.bucket),
      accessKeyId: str(source.accessKeyId),
      forcePathStyle: typeof source.forcePathStyle === "boolean" ? source.forcePathStyle : (defaults.forcePathStyle ?? false),
    },
    secrets: { secretAccessKey: secretHint(secrets.secretAccessKey) },
  };
}

/** One integration's card (status for everyone who may open Settings; the form for integrations.manage only). */
export function integrationState(kind: IntegrationKind, snapshot: IntegrationSnapshot, opts: IntegrationViewOptions): IntegrationState {
  const resolved = resolvedOf(snapshot, kind);
  const admin = snapshot.admin[kind];
  const meta = INTEGRATION_CARD_META[kind];
  return {
    id: kind,
    title: INTEGRATION_TITLES[kind],
    description: meta.description,
    icon: meta.icon,
    source: resolved.source,
    development: isDevelopment(kind, resolved),
    provider: providerLabel(kind, resolved),
    mode: kind === "payments" && resolved.source !== "none" ? (resolved.config.mode === "live" ? "live" : "test") : null,
    problem: resolved.source === "none" ? integrationProblem(kind, resolved.reason, resolved.names, { canManage: opts.canManage }) : null,
    saved: admin ? { revision: admin.revision, updatedAt: iso(admin.updatedAt), updatedBy: admin.updatedByName } : null,
    envNames: kind === "storage" ? INTEGRATION_ENV_NAMES.storage.filter((name) => name !== "STORAGE_LOCAL_DIR") : INTEGRATION_ENV_NAMES[kind],
    form: opts.canManage ? formFor(kind, snapshot, opts) : null,
  };
}

/** The read-only rate-limits card (REDIS_URL stays in the env file). */
export function redisState(env: Pick<Env, "NODE_ENV" | "REDIS_URL">): RedisState {
  const set = typeof env.REDIS_URL === "string" && env.REDIS_URL.trim() !== "";
  return {
    id: "redis",
    title: INTEGRATIONS_COPY.redis.title,
    description: INTEGRATIONS_COPY.redis.description,
    icon: "database",
    status: set ? "configured" : env.NODE_ENV === "production" ? "missing" : "development",
    provider: set ? "Redis" : "Database buckets",
    note: INTEGRATIONS_COPY.redis.note,
    envNames: ["REDIS_URL"],
  };
}

/** AdminSettingsData.integrations from a snapshot. */
export function integrationsData(snapshot: IntegrationSnapshot, opts: IntegrationViewOptions): IntegrationsData {
  return {
    canManage: opts.canManage,
    items: INTEGRATION_CARD_ORDER.map((kind) => integrationState(kind, snapshot, opts)),
    redis: redisState(opts.env),
  };
}

/** When the newest correctly signed Razorpay webhook arrived (null: none yet). */
export async function lastSignedWebhookAt(client: Db): Promise<Date | null> {
  const row = await client.webhookDelivery.findFirst({
    where: { provider: "razorpay", signatureOk: true },
    orderBy: { receivedAt: "desc" },
    select: { receivedAt: true },
  });
  return row?.receivedAt ?? null;
}

/** GET /api/admin/settings and the page: a fresh snapshot (and, for the Owner, the last signed webhook). */
export async function loadIntegrationsData(client: Db, opts: { canManage: boolean; env: IntegrationViewEnv }): Promise<IntegrationsData> {
  const [snapshot, last] = await Promise.all([
    getIntegrationSnapshot({ fresh: true }),
    opts.canManage ? lastSignedWebhookAt(client) : Promise.resolve(null),
  ]);
  return integrationsData(snapshot, { ...opts, lastSignedWebhookAt: last });
}

/** One integration after a save, clear or remove (fresh snapshot; the caller holds integrations.manage). */
export async function loadIntegrationState(client: Db, kind: IntegrationKind, env: IntegrationViewEnv): Promise<IntegrationState> {
  const [snapshot, last] = await Promise.all([
    getIntegrationSnapshot({ fresh: true }),
    kind === "payments" ? lastSignedWebhookAt(client) : Promise.resolve(null),
  ]);
  return integrationState(kind, snapshot, { canManage: true, env, lastSignedWebhookAt: last });
}

