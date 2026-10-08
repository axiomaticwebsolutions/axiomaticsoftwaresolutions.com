/**
 * The ONE place that combines Admin-saved integrations with the env-file fallback (docs/admin-integrations-design.md
 * sections 3 and 7). Every consumer (payments, webhooks, reconcile, email, storage, CSP, Admin status) reads it.
 *
 * Precedence per kind, as a whole (Admin and env fields are never mixed):
 * - an IntegrationConfig row exists -> it decides: `admin` when its settings are valid here and every required secret
 *   decrypts, else `none` (admin_incomplete / admin_invalid / admin_unreadable). The env file is NOT consulted.
 * - no row -> `env` when the env file holds a complete, usable configuration (env-source.ts), else `none`.
 *
 * Cache: one slot on globalThis (Symbol.for("axs.integrations.v1")), so the copies of this module that Next.js bundles
 * into route handlers, instrumentation and the middleware share one snapshot and one invalidation. A snapshot lives 30 s;
 * concurrent callers share one load; invalidateIntegrations() (called by the saving request right after its commit)
 * drops it at once in this process, and a load that started before the invalidation is not stored. `fresh: true`
 * (Admin views, probes) always loads; `allowStale: true` (middleware) answers from an expired snapshot and reloads in the
 * background. A failed load keeps the last good snapshot and backs off 5 s; with no snapshot the error propagates.
 *
 * Fingerprints (SHA-256 of the canonical config) are in-memory cache keys for adapters, transports and drivers; they are
 * never logged, returned or stored. Logs carry kinds, reasons and NAMES only.
 */
import "server-only";
import { createHash } from "node:crypto";
import { getLicenseKeySecrets } from "@/lib/env";
import { log } from "@/lib/log";
import { endpointProblem, hostProblem } from "@/lib/security/host-rules";
import { openIntegrationSecret } from "./crypto";
import { classifyEnvIntegrations, type EnvClassification, type IntegrationEnvInput } from "./env-source";
import {
  applicableSecrets,
  INTEGRATION_SETTINGS_SCHEMAS,
  isSecretField,
  razorpayMode,
  requiredSecrets,
  type EmailSettings,
  type IntegrationKind,
  type PaymentsSettings,
  type PersistedSettings,
  type SecretField,
  type StorageSettings,
} from "./model";
import { integrationSlot as slot, invalidateIntegrations, type Inflight, type IntegrationSlot as Slot, type RowsLoader } from "./slot";
import { loadIntegrationRows } from "./store";
import type {
  AdminIntegrationState,
  AdminSecretHint,
  EmailConfig,
  IntegrationConfigs,
  IntegrationRow,
  IntegrationSnapshot,
  NotConfiguredReason,
  PaymentsConfig,
  Resolved,
  StorageConfig,
} from "./types";

export type { IntegrationEnvInput } from "./env-source";
export type * from "./types";

export const INTEGRATION_CACHE_TTL_MS = 30_000;
export const INTEGRATION_FAILURE_BACKOFF_MS = 5_000;
const LOG_EVERY_MS = 60_000;

const NOT_CONFIGURED_MESSAGES: Readonly<Record<IntegrationKind, string>> = {
  payments: "Payments are not configured.",
  email: "Email delivery is not configured.",
  storage: "File storage is not configured.",
};

/** A consumer needed an integration that resolves to `none`. Carries the kind, the reason and NAMES only. */
export class IntegrationNotConfiguredError extends Error {
  readonly code = "not_configured";
  readonly kind: IntegrationKind;
  readonly reason: NotConfiguredReason;
  readonly names: readonly string[];

  constructor(kind: IntegrationKind, reason: NotConfiguredReason, names: readonly string[] = []) {
    super(NOT_CONFIGURED_MESSAGES[kind]);
    this.name = "IntegrationNotConfiguredError";
    this.kind = kind;
    this.reason = reason;
    this.names = names;
  }
}

function logOnce(key: string, event: string, fields: Record<string, unknown>): void {
  const s = slot();
  if (s.logged.has(key)) return;
  s.logged.add(key);
  log.warn(event, fields);
}

/** JSON with object keys sorted at every level (stable fingerprints). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function configured<C>(kind: IntegrationKind, source: "admin" | "env", config: C): Resolved<C> {
  const fingerprint = createHash("sha256").update(canonicalJson({ kind, source, config }), "utf8").digest("hex");
  return { source, config, fingerprint };
}

const none = <C>(reason: NotConfiguredReason, names: readonly string[]): Resolved<C> => ({ source: "none", reason, names });

/** The Admin row's effective configuration (see the module comment). */
function resolveAdmin<K extends IntegrationKind>(
  kind: K,
  row: IntegrationRow,
  production: boolean,
  ikm: () => Buffer,
): Resolved<IntegrationConfigs[K]> {
  const parsed = INTEGRATION_SETTINGS_SCHEMAS[kind].safeParse(row.settings);
  if (!parsed.success) {
    logOnce(`unreadable:${kind}:settings`, "integration_settings_unreadable", { kind });
    return none("admin_unreadable", ["settings"]);
  }
  const settings = parsed.data as PersistedSettings[K];
  if (kind === "email") {
    const e = settings as EmailSettings;
    if (e.provider === "smtp" && hostProblem(e.host, { production })) return none("admin_invalid", ["host"]);
  }
  if (kind === "storage") {
    const endpoint = (settings as StorageSettings).endpoint;
    if (endpoint !== null && endpointProblem(endpoint, { production })) return none("admin_invalid", ["endpoint"]);
  }
  const secrets: Partial<Record<SecretField, string>> = {};
  // Only the secrets these settings use are opened (email: the SMTP password or the SES secret key, by provider).
  const usable: readonly string[] = applicableSecrets(kind, settings as Record<string, unknown>);
  for (const sealed of row.secrets) {
    if (!isSecretField(kind, sealed.field) || !usable.includes(sealed.field)) continue;
    try {
      secrets[sealed.field] = openIntegrationSecret(kind, sealed.field, sealed.ciphertext, ikm());
    } catch {
      logOnce(`unreadable:${kind}:${sealed.field}`, "integration_secret_unreadable", { kind, field: sealed.field });
      return none("admin_unreadable", [sealed.field]);
    }
  }
  const missing = requiredSecrets(kind, settings).filter((field) => secrets[field] === undefined);
  if (missing.length > 0) return none("admin_incomplete", missing);

  if (kind === "payments") {
    const p = settings as PaymentsSettings;
    const mode = razorpayMode(p.keyId);
    if (!mode) return none("admin_invalid", ["keyId"]);
    const config: PaymentsConfig = {
      provider: "razorpay",
      keyId: p.keyId,
      keySecret: secrets.keySecret as string,
      webhookSecret: secrets.webhookSecret as string,
      mode,
    };
    return configured(kind, "admin", config) as Resolved<IntegrationConfigs[K]>;
  }
  if (kind === "email") {
    const e = settings as EmailSettings;
    const config: EmailConfig =
      e.provider === "ses"
        ? {
            transport: "ses",
            region: e.region,
            accessKeyId: e.accessKeyId,
            secretAccessKey: secrets.secretAccessKey as string,
            configurationSet: e.configurationSet,
            from: { name: e.fromName, address: e.fromAddress },
          }
        : {
            transport: "smtp",
            host: e.host,
            port: e.port,
            security: e.security,
            auth: e.username === null ? null : { user: e.username, pass: secrets.password as string },
            from: { name: e.fromName, address: e.fromAddress },
          };
    return configured(kind, "admin", config) as Resolved<IntegrationConfigs[K]>;
  }
  const st = settings as StorageSettings;
  const config: StorageConfig = {
    driver: "s3",
    endpoint: st.endpoint,
    region: st.region,
    bucket: st.bucket,
    forcePathStyle: st.forcePathStyle,
    accessKeyId: st.accessKeyId,
    secretAccessKey: secrets.secretAccessKey as string,
    preset: st.preset,
  };
  return configured(kind, "admin", config) as Resolved<IntegrationConfigs[K]>;
}

function resolveEnv<K extends IntegrationKind>(kind: K, env: EnvClassification<IntegrationConfigs[K]>): Resolved<IntegrationConfigs[K]> {
  const result = env.result;
  if (result.ok) return configured(kind, "env", result.config);
  if (result.reason !== "missing") {
    logOnce(`env:${kind}:${result.reason}:${result.names.join(",")}`, "integration_env_ignored", { kind, reason: result.reason, names: result.names });
  }
  return none(result.reason, result.names);
}

function adminState<K extends IntegrationKind>(kind: K, row: IntegrationRow | undefined): AdminIntegrationState<K> | null {
  if (!row) return null;
  const parsed = INTEGRATION_SETTINGS_SCHEMAS[kind].safeParse(row.settings);
  const secrets: Partial<Record<SecretField, AdminSecretHint>> = {};
  for (const s of row.secrets) {
    if (isSecretField(kind, s.field)) secrets[s.field] = { last4: s.last4, updatedAt: s.updatedAt, updatedByName: s.updatedBy?.name ?? null };
  }
  return {
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedByName: row.updatedBy?.name ?? null,
    settings: parsed.success ? (parsed.data as PersistedSettings[K]) : null,
    secrets,
  };
}

async function buildSnapshot(s: Slot): Promise<IntegrationSnapshot> {
  const rows = await (s.loader ?? (() => loadIntegrationRows()))();
  const envInput: IntegrationEnvInput = s.envOverride ?? process.env;
  const production = envInput.NODE_ENV === "production";
  const env = classifyEnvIntegrations(envInput, { production });
  let ikm: Buffer | null = null;
  const key = () => (ikm ??= s.ikmOverride ?? getLicenseKeySecrets().encKey);
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const pick = <K extends IntegrationKind>(kind: K): Resolved<IntegrationConfigs[K]> => {
    const row = byKind.get(kind);
    return row ? resolveAdmin(kind, row, production, key) : resolveEnv(kind, env[kind] as EnvClassification<IntegrationConfigs[K]>);
  };
  const envState = <K extends IntegrationKind>(kind: K) => ({ selector: env[kind].selector, namesSet: env[kind].namesSet, prefill: env[kind].prefill });
  return {
    loadedAt: Date.now(),
    payments: pick("payments"),
    email: pick("email"),
    storage: pick("storage"),
    admin: { payments: adminState("payments", byKind.get("payments")), email: adminState("email", byKind.get("email")), storage: adminState("storage", byKind.get("storage")) },
    env: { payments: envState("payments"), email: envState("email"), storage: envState("storage") },
  };
}

function logLoadFailure(s: Slot, error: unknown): void {
  const now = Date.now();
  if (now - s.lastFailureLogAt < LOG_EVERY_MS) return;
  s.lastFailureLogAt = now;
  log.error("integration_load_failed", { error: error instanceof Error ? error.name : typeof error });
}

/** Starts (or joins) a load for the current generation; `force` always starts a new one. */
function startLoad(s: Slot, force = false): Promise<IntegrationSnapshot> {
  const current = s.inflight;
  if (!force && current && current.generation === s.generation) return current.promise;
  const generation = s.generation;
  const entry: Inflight = { generation, promise: Promise.resolve(null as unknown as IntegrationSnapshot) };
  entry.promise = (async () => {
    try {
      const snapshot = await buildSnapshot(s);
      if (s.generation === generation) {
        s.snapshot = snapshot;
        s.failedAt = 0;
        s.lastError = null;
      }
      return snapshot;
    } catch (error) {
      if (s.generation === generation) {
        s.failedAt = Date.now();
        s.lastError = error;
      }
      logLoadFailure(s, error);
      throw error;
    } finally {
      if (s.inflight === entry) s.inflight = null;
    }
  })();
  s.inflight = entry;
  return entry.promise;
}

class SnapshotWaitTimeoutError extends Error {
  constructor() {
    super("Integration settings are still loading");
    this.name = "SnapshotWaitTimeoutError";
  }
}

function withCap<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SnapshotWaitTimeoutError()), Math.max(0, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type SnapshotOptions = {
  /** Always load (Admin views, probes, tests). */
  fresh?: boolean;
  /** Answer from an expired snapshot at once and reload in the background (middleware). */
  allowStale?: boolean;
  /** With allowStale and no snapshot at all: wait at most this long for the first load. */
  maxWaitMs?: number;
};

/** The effective configuration of every integration (see the module comment for the cache rules). */
export async function getIntegrationSnapshot(opts: SnapshotOptions = {}): Promise<IntegrationSnapshot> {
  const s = slot();
  if (opts.fresh) return startLoad(s, true);
  const now = Date.now();
  const snap = s.snapshot;
  if (snap && now - snap.loadedAt < INTEGRATION_CACHE_TTL_MS) return snap;
  const backingOff = s.failedAt > 0 && now - s.failedAt < INTEGRATION_FAILURE_BACKOFF_MS;
  if (snap && (backingOff || opts.allowStale)) {
    if (!backingOff) startLoad(s).catch(() => undefined);
    return snap;
  }
  if (backingOff && s.lastError) throw s.lastError;
  const load = startLoad(s);
  if (opts.allowStale && opts.maxWaitMs !== undefined) return withCap(load, opts.maxWaitMs);
  if (!snap) return load;
  // A failed reload keeps the last good snapshot (unless a save invalidated it meanwhile).
  return load.catch((error: unknown) => {
    if (s.snapshot) return s.snapshot;
    throw error;
  });
}

export async function resolvePayments(opts?: SnapshotOptions): Promise<Resolved<PaymentsConfig>> {
  return (await getIntegrationSnapshot(opts)).payments;
}

export async function resolveEmail(opts?: SnapshotOptions): Promise<Resolved<EmailConfig>> {
  return (await getIntegrationSnapshot(opts)).email;
}

export async function resolveStorage(opts?: SnapshotOptions): Promise<Resolved<StorageConfig>> {
  return (await getIntegrationSnapshot(opts)).storage;
}

export { invalidateIntegrations };

/**
 * Whether the env file alone configures `kind`: what "Remove saved settings" falls back to (audit wording, the Admin
 * dialogs). Reads the same env source as the snapshot and returns a verdict and NAMES only, never a value.
 */
export function envFallback(kind: IntegrationKind): { usable: boolean; reason: NotConfiguredReason | null } {
  const envInput: IntegrationEnvInput = slot().envOverride ?? process.env;
  const result = classifyEnvIntegrations(envInput, { production: envInput.NODE_ENV === "production" })[kind].result;
  return result.ok ? { usable: true, reason: null } : { usable: false, reason: result.reason };
}

/** Warms the cache at start-up (instrumentation.ts); never throws. */
export async function warmIntegrations(maxWaitMs = 3_000): Promise<void> {
  await getIntegrationSnapshot({ allowStale: true, maxWaitMs }).catch(() => undefined);
}

// ---------- Tests only (like setStorage / setEmailTransport / setDbClient) ----------

/** Replaces the IntegrationConfig loader (null = the database). Also invalidates. */
export function setIntegrationRowsLoader(loader: RowsLoader | null): void {
  slot().loader = loader;
  invalidateIntegrations();
}

/** Replaces the env record the fallback is read from (null = process.env). Also invalidates. */
export function setIntegrationEnvForTests(env: IntegrationEnvInput | null): void {
  slot().envOverride = env;
  invalidateIntegrations();
}

/** Replaces the input key material for decryption (null = LICENSE_KEY_ENC_KEY). Also invalidates. */
export function setIntegrationKeyForTests(ikm: Buffer | null): void {
  slot().ikmOverride = ikm;
  invalidateIntegrations();
}
