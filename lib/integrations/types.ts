/**
 * Types of the integration resolver (lib/integrations/resolver.ts) and the probes. Types only, so client components
 * may import them too. Configs carry secrets: they never leave the server (no API response, log, audit row or error).
 */
import type { EmailSecurity, IntegrationKind, PaymentMode, PersistedSettings, SecretField, StoragePreset } from "./model";

export type PaymentsConfig =
  | { provider: "razorpay"; keyId: string; keySecret: string; webhookSecret: string; mode: PaymentMode }
  | { provider: "mock"; keyId: string; keySecret: string; webhookSecret: string; mode: "test" };

export type EmailConfig =
  | {
      transport: "smtp";
      host: string;
      port: number;
      security: EmailSecurity;
      auth: { user: string; pass: string } | null;
      from: { name: string; address: string };
    }
  | {
      /** Amazon SES API (SESv2 SendEmail, raw MIME). The endpoint is AWS's own for `region`; there is no custom one. */
      transport: "ses";
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      /** SES configuration set for event publishing; null = none. */
      configurationSet: string | null;
      from: { name: string; address: string };
    }
  | { transport: "console"; from: { name: string; address: string } };

export type StorageConfig =
  | {
      driver: "s3";
      /** Exact origin of an S3-compatible store; null = AWS's endpoint for the region. */
      endpoint: string | null;
      region: string;
      bucket: string;
      forcePathStyle: boolean;
      accessKeyId: string;
      secretAccessKey: string;
      /** Admin form preset (display only; null for the env file). */
      preset?: StoragePreset | null;
    }
  | { driver: "local"; dir: string };

export type IntegrationConfigs = { payments: PaymentsConfig; email: EmailConfig; storage: StorageConfig };

/**
 * Why an integration is not configured. `admin_*`: a saved Admin row decides (env is NOT consulted); `env_*`, `missing`
 * and `unsupported_provider`: no Admin row and nothing usable in the env file.
 */
export type NotConfiguredReason =
  | "missing"
  | "admin_incomplete"
  | "admin_invalid"
  | "admin_unreadable"
  | "env_incomplete"
  | "env_invalid"
  | "unsupported_provider";

export type IntegrationSource = "admin" | "env" | "none";

/** One integration's effective configuration. `names` are Admin field keys or env variable NAMES, never values. */
export type Resolved<C> =
  | { source: "admin" | "env"; config: C; fingerprint: string }
  | { source: "none"; reason: NotConfiguredReason; names: readonly string[] };

/** A saved secret's display facts (never the value). */
export type AdminSecretHint = { last4: string | null; updatedAt: Date; updatedByName: string | null };

/** What the Admin row of an integration holds, without secret values. `settings` is null when it failed validation. */
export type AdminIntegrationState<K extends IntegrationKind> = {
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  updatedByName: string | null;
  settings: PersistedSettings[K] | null;
  secrets: Partial<Record<SecretField, AdminSecretHint>>;
};

/** The env fallback of an integration: the selector, which of its variable NAMES are set, and non-secret prefill. */
export type EnvIntegrationState = {
  selector: string | null;
  namesSet: readonly string[];
  prefill: Readonly<Record<string, string | number | boolean>>;
};

export type IntegrationSnapshot = {
  /** Date.now() when the snapshot was loaded. */
  loadedAt: number;
  payments: Resolved<PaymentsConfig>;
  email: Resolved<EmailConfig>;
  storage: Resolved<StorageConfig>;
  admin: { [K in IntegrationKind]: AdminIntegrationState<K> | null };
  env: { [K in IntegrationKind]: EnvIntegrationState };
};

/** An IntegrationConfig row with its secrets (lib/integrations/store.ts loadIntegrationRows). */
export type IntegrationRow = {
  kind: IntegrationKind;
  settings: unknown;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: { id: string; name: string } | null;
  secrets: {
    field: string;
    ciphertext: string;
    last4: string | null;
    updatedAt: Date;
    updatedBy: { id: string; name: string } | null;
  }[];
};

export type ProbeStepStatus = "ok" | "failed" | "skipped" | "info";
export type ProbeStep = { id: string; label: string; status: ProbeStepStatus; message: string };
/** A test button's result (POST /api/admin/settings/integrations/:kind/test). Messages never echo a value. */
export type ProbeResult = { kind: IntegrationKind; source: "admin" | "env"; ok: boolean; testedAt: string; steps: ProbeStep[] };
