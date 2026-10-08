/**
 * Admin-configurable integrations (docs/admin-integrations-design.md): kinds, fields and labels, storage presets, the
 * persisted settings schemas (IntegrationConfig.settings), the save-body schemas of the Admin API and the audit action
 * names.
 *
 * Pure and client-safe: the Admin forms import it, and so does the deploy preflight (through env-source.ts under
 * `node --import tsx`). Relative imports only; no node: modules, no server-only.
 */
import { z } from "zod";
import { isMailboxAddress, isMailboxName } from "../email/address";
import { isPlaceholder } from "../placeholders";

// ---------- Kinds ----------

export const INTEGRATION_KINDS = ["payments", "email", "storage"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
/** The Prisma enum values (IntegrationKind in prisma/schema.prisma). */
export type DbIntegrationKind = "PAYMENTS" | "EMAIL" | "STORAGE";

const DB_KINDS: Readonly<Record<IntegrationKind, DbIntegrationKind>> = { payments: "PAYMENTS", email: "EMAIL", storage: "STORAGE" };

export function isIntegrationKind(value: unknown): value is IntegrationKind {
  return typeof value === "string" && (INTEGRATION_KINDS as readonly string[]).includes(value);
}

export function toDbKind(kind: IntegrationKind): DbIntegrationKind {
  return DB_KINDS[kind];
}

export function fromDbKind(kind: DbIntegrationKind): IntegrationKind {
  return kind === "PAYMENTS" ? "payments" : kind === "EMAIL" ? "email" : "storage";
}

export const INTEGRATION_TITLES: Readonly<Record<IntegrationKind, string>> = {
  payments: "Payment provider",
  email: "Email delivery",
  storage: "Installer storage",
};

/** The env variable NAMES each integration falls back to (never their values). */
export const INTEGRATION_ENV_NAMES = {
  payments: ["PAYMENT_PROVIDER", "PAYMENT_KEY_ID", "PAYMENT_KEY_SECRET", "PAYMENT_WEBHOOK_SECRET"],
  email: [
    "EMAIL_TRANSPORT",
    "EMAIL_FROM",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SES_REGION",
    "SES_ACCESS_KEY_ID",
    "SES_SECRET_ACCESS_KEY",
    "SES_CONFIGURATION_SET",
  ],
  storage: [
    "STORAGE_DRIVER",
    "STORAGE_ENDPOINT",
    "STORAGE_REGION",
    "STORAGE_BUCKET",
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_SECRET_ACCESS_KEY",
    "STORAGE_FORCE_PATH_STYLE",
    "STORAGE_LOCAL_DIR",
  ],
} as const satisfies Record<IntegrationKind, readonly string[]>;

// ---------- Fields and secrets ----------

/** Every secret a kind can hold. Email: `password` (SMTP) or `secretAccessKey` (Amazon SES), by provider. */
export const SECRET_FIELDS = {
  payments: ["keySecret", "webhookSecret"],
  email: ["password", "secretAccessKey"],
  storage: ["secretAccessKey"],
} as const satisfies Record<IntegrationKind, readonly string[]>;
export type SecretFieldOf<K extends IntegrationKind> = (typeof SECRET_FIELDS)[K][number];
export type SecretField = SecretFieldOf<IntegrationKind>;

export function isSecretField<K extends IntegrationKind>(kind: K, field: unknown): field is SecretFieldOf<K> {
  return typeof field === "string" && (SECRET_FIELDS[kind] as readonly string[]).includes(field);
}

/** Shortest accepted value per secret (webhookSecret matches PAYMENT_WEBHOOK_SECRET in lib/env.ts). */
export const SECRET_MIN_LENGTH: Readonly<Record<SecretField, number>> = { keySecret: 8, webhookSecret: 16, password: 1, secretAccessKey: 8 };
export const SECRET_MAX_LENGTH = 512;
/** The last 4 characters are kept for display only when a secret is at least this long (lib/integrations/crypto.ts). */
export const SECRET_LAST4_MIN_LENGTH = 16;

/** Labels of every field: errors, audit details ("Changed: Key ID, Key secret.") and the forms. */
export const FIELD_LABELS = {
  payments: { keyId: "Key ID", keySecret: "Key secret", webhookSecret: "Webhook secret" },
  email: {
    provider: "Provider",
    host: "SMTP host",
    port: "Port",
    security: "Security",
    username: "Username",
    password: "Password",
    region: "AWS region",
    accessKeyId: "Access key ID",
    secretAccessKey: "Secret access key",
    configurationSet: "Configuration set",
    fromName: "From name",
    fromAddress: "From address",
  },
  storage: {
    preset: "Provider",
    endpoint: "Endpoint",
    region: "Region",
    bucket: "Bucket",
    accessKeyId: "Access key ID",
    secretAccessKey: "Secret access key",
    forcePathStyle: "Path-style URLs",
  },
} as const satisfies Record<IntegrationKind, Record<string, string>>;

/** The label of a field key ("keySecret" -> "Key secret"); the key itself when unknown. */
export function fieldLabel(kind: IntegrationKind, field: string): string {
  const labels: Readonly<Record<string, string>> = FIELD_LABELS[kind];
  return labels[field] ?? field;
}

export const REQUIRED_SECRET_MESSAGES: Readonly<Record<SecretField, string>> = {
  keySecret: "Enter the key secret.",
  webhookSecret: "Enter the webhook secret.",
  password: "Enter the password.",
  secretAccessKey: "Enter the secret access key.",
};

/** Why a secret value cannot be stored, or null. Checked on the trimmed value before it is sealed. */
export function secretProblem(field: SecretField, value: string): string | null {
  const v = value.trim();
  const min = SECRET_MIN_LENGTH[field];
  if (v.length < min) return min === 1 ? REQUIRED_SECRET_MESSAGES[field] : `Enter at least ${min} characters.`;
  if (v.length > SECRET_MAX_LENGTH) return `Use at most ${SECRET_MAX_LENGTH} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(v)) return "Remove line breaks and other control characters.";
  if (isPlaceholder(v)) return "This looks like a placeholder. Enter the real value.";
  return null;
}

// ---------- Payments (Razorpay) ----------

/** A Razorpay Key ID; the prefix decides test or live mode. The release-day stand-in "rzp_test_pending" fails it. */
export const RAZORPAY_KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{8,32}$/;
export type PaymentMode = "test" | "live";

/** "rzp_test_..." -> test, "rzp_live_..." -> live, anything else null. */
export function razorpayMode(keyId: string): PaymentMode | null {
  const m = RAZORPAY_KEY_ID_RE.exec(keyId);
  return m ? (m[1] as PaymentMode) : null;
}

// ---------- Email (SMTP or Amazon SES) ----------

/** How email leaves: an SMTP server, or the Amazon SES API (SESv2 SendEmail with the raw MIME message). */
export const EMAIL_PROVIDERS = ["smtp", "ses"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];
export const EMAIL_PROVIDER_LABELS: Readonly<Record<EmailProvider, string>> = { smtp: "SMTP", ses: "Amazon SES (API)" };

/**
 * AWS regions where Amazon SES sends email (commercial partitions; GovCloud and China need separate accounts). The
 * SESv2 client only ever talks to AWS's own endpoint for one of these regions (no custom endpoint), so a saved region
 * cannot point the secret anywhere else. Add a region here when AWS launches SES there.
 */
export const SES_REGIONS = [
  { id: "ap-south-1", name: "Asia Pacific (Mumbai)" },
  { id: "ap-south-2", name: "Asia Pacific (Hyderabad)" },
  { id: "ap-southeast-1", name: "Asia Pacific (Singapore)" },
  { id: "ap-southeast-2", name: "Asia Pacific (Sydney)" },
  { id: "ap-southeast-3", name: "Asia Pacific (Jakarta)" },
  { id: "ap-northeast-1", name: "Asia Pacific (Tokyo)" },
  { id: "ap-northeast-2", name: "Asia Pacific (Seoul)" },
  { id: "ap-northeast-3", name: "Asia Pacific (Osaka)" },
  { id: "us-east-1", name: "US East (N. Virginia)" },
  { id: "us-east-2", name: "US East (Ohio)" },
  { id: "us-west-1", name: "US West (N. California)" },
  { id: "us-west-2", name: "US West (Oregon)" },
  { id: "ca-central-1", name: "Canada (Central)" },
  { id: "sa-east-1", name: "South America (São Paulo)" },
  { id: "eu-central-1", name: "Europe (Frankfurt)" },
  { id: "eu-central-2", name: "Europe (Zurich)" },
  { id: "eu-west-1", name: "Europe (Ireland)" },
  { id: "eu-west-2", name: "Europe (London)" },
  { id: "eu-west-3", name: "Europe (Paris)" },
  { id: "eu-north-1", name: "Europe (Stockholm)" },
  { id: "eu-south-1", name: "Europe (Milan)" },
  { id: "il-central-1", name: "Israel (Tel Aviv)" },
  { id: "me-south-1", name: "Middle East (Bahrain)" },
  { id: "af-south-1", name: "Africa (Cape Town)" },
] as const;
export type SesRegion = (typeof SES_REGIONS)[number]["id"];
export const SES_REGION_IDS = SES_REGIONS.map((r) => r.id) as [SesRegion, ...SesRegion[]];
/** Mumbai: the closest SES region to the business (owner decision 2026-10-08). */
export const DEFAULT_SES_REGION: SesRegion = "ap-south-1";

export function isSesRegion(value: unknown): value is SesRegion {
  return typeof value === "string" && (SES_REGION_IDS as readonly string[]).includes(value);
}

/** AWS access key IDs: 16 to 128 capital letters and digits ("AKIA" + 16 for an IAM user's long-term key). */
export const AWS_ACCESS_KEY_ID_RE = /^[A-Z0-9]{16,128}$/;
/** SES configuration set names: letters, digits, hyphens and underscores, up to 64. */
export const SES_CONFIGURATION_SET_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const EMAIL_SECURITY = ["starttls", "tls"] as const;
export type EmailSecurity = (typeof EMAIL_SECURITY)[number];
export const DEFAULT_SMTP_PORTS: Readonly<Record<EmailSecurity, number>> = { starttls: 587, tls: 465 };

/** Port 465 is implicit TLS; every other port upgrades with STARTTLS (the env file's rule). */
export function securityForPort(port: number): EmailSecurity {
  return port === 465 ? "tls" : "starttls";
}

// ---------- Storage (S3-compatible) ----------

export const STORAGE_PRESETS = ["aws", "r2", "spaces", "other"] as const;
export type StoragePreset = (typeof STORAGE_PRESETS)[number];

export type StoragePresetDefaults = {
  label: string;
  /** Prefilled endpoint ("" = none); null leaves the current value. */
  endpoint: string | null;
  endpointPlaceholder: string;
  region: string | null;
  forcePathStyle: boolean | null;
};

export const STORAGE_PRESET_DEFAULTS: Readonly<Record<StoragePreset, StoragePresetDefaults>> = {
  aws: { label: "AWS S3", endpoint: "", endpointPlaceholder: "", region: "ap-south-1", forcePathStyle: false },
  r2: {
    label: "Cloudflare R2",
    endpoint: "",
    endpointPlaceholder: "https://<account id>.r2.cloudflarestorage.com",
    region: "auto",
    forcePathStyle: true,
  },
  spaces: {
    label: "DigitalOcean Spaces",
    endpoint: "https://blr1.digitaloceanspaces.com",
    endpointPlaceholder: "https://<region>.digitaloceanspaces.com",
    region: "blr1",
    forcePathStyle: false,
  },
  other: { label: "Other S3-compatible", endpoint: null, endpointPlaceholder: "https://", region: null, forcePathStyle: null },
};

/** DigitalOcean Spaces' endpoint follows its region. */
export function spacesEndpoint(region: string): string {
  return `https://${region}.digitaloceanspaces.com`;
}

/** The preset an endpoint most likely belongs to (env prefill). */
export function guessStoragePreset(endpoint: string | null | undefined): StoragePreset {
  if (!endpoint) return "aws";
  let host = "";
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host.endsWith(".r2.cloudflarestorage.com")) return "r2";
  if (host.endsWith(".digitaloceanspaces.com")) return "spaces";
  if (host.endsWith(".amazonaws.com")) return "aws";
  return "other";
}

/** S3 bucket names (same rule as STORAGE_BUCKET in lib/env.ts). */
export const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** Regions such as ap-south-1, auto (R2) or blr1 (Spaces); also used for the CSP origin (lib/storage/upload-origin.ts). */
export const REGION_RE = /^[a-z0-9-]{2,32}$/;
const ACCESS_KEY_ID_RE = /^[\x21-\x7e]{4,128}$/;

// ---------- Hosts and endpoints (shape only; lib/security/host-rules.ts applies the network rules) ----------

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)${HOST_LABEL}(?:[.]${HOST_LABEL})*$`);
const IPV6_SHAPE_RE = /^[0-9a-f:.]{2,45}$/;

/** Lower case, without surrounding [ ] (IPv6 literals) and a trailing dot. */
export function normalizeHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

/** A host name or an IP literal by shape (no DNS, no address rules). */
export function isHostLike(value: string): boolean {
  const host = normalizeHost(value);
  if (host === "") return false;
  if (host.includes(":")) return IPV6_SHAPE_RE.test(host);
  return HOSTNAME_RE.test(host);
}

/**
 * An absolute http(s) URL with no user name or password, no query or fragment and an empty or "/" path, normalised to
 * its origin ("https://acc.r2.cloudflarestorage.com"); null for anything else.
 */
export function normalizeEndpoint(value: string): string | null {
  const raw = value.trim();
  if (raw === "" || /[?#\s]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (!isHostLike(url.hostname)) return null;
  return url.origin;
}

// ---------- Persisted settings (IntegrationConfig.settings; validated on write and on every read) ----------

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const hostSchema = z
  .string()
  .max(253)
  .refine((v) => v === normalizeHost(v) && isHostLike(v), "Enter a host name such as smtp.example.com.");
const portSchema = z.number().int().min(1).max(65_535);
const fromNameSchema = z.string().min(1).max(100).refine(isMailboxName, "Use letters, digits and spaces only (no < or >).");
const fromAddressSchema = z.string().refine(isMailboxAddress, "Enter an email address such as no-reply@example.com.");
const accessKeyIdSchema = z
  .string()
  .regex(ACCESS_KEY_ID_RE, "Enter the access key ID.")
  .refine((v) => !isPlaceholder(v), "Enter the real access key ID.");
const endpointSchema = z.string().refine((v) => normalizeEndpoint(v) === v, "Enter an https:// address without a path.");

export const paymentsSettingsSchema = z.strictObject({
  provider: z.literal("razorpay"),
  keyId: z.string().regex(RAZORPAY_KEY_ID_RE),
});

/**
 * Email rows saved before Amazon SES was added (2026-10-08) have no `provider`: they are SMTP. Applied to persisted
 * settings and to save bodies (a body without `provider` is an SMTP body).
 */
function withEmailProvider(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !("provider" in value)) return { provider: "smtp", ...value };
  return value;
}

const PROVIDER_MESSAGE = "Choose SMTP or Amazon SES.";

export const smtpSettingsSchema = z.strictObject({
  provider: z.literal("smtp"),
  host: hostSchema,
  port: portSchema,
  security: z.enum(EMAIL_SECURITY),
  /** null: the server takes mail without signing in (the password is then not used). */
  username: z
    .string()
    .min(1)
    .max(256)
    .refine((v) => !CONTROL_RE.test(v))
    .nullable(),
  fromName: fromNameSchema,
  fromAddress: fromAddressSchema,
});

export const sesSettingsSchema = z.strictObject({
  provider: z.literal("ses"),
  region: z.enum(SES_REGION_IDS),
  accessKeyId: z
    .string()
    .regex(AWS_ACCESS_KEY_ID_RE)
    .refine((v) => !isPlaceholder(v)),
  /** null: no configuration set (SES account defaults). */
  configurationSet: z.string().regex(SES_CONFIGURATION_SET_RE).nullable(),
  fromName: fromNameSchema,
  fromAddress: fromAddressSchema,
});

export const emailSettingsSchema = z.preprocess(
  withEmailProvider,
  z.discriminatedUnion("provider", [smtpSettingsSchema, sesSettingsSchema], { error: PROVIDER_MESSAGE }),
);

export const storageSettingsSchema = z.strictObject({
  preset: z.enum(STORAGE_PRESETS),
  /** null: AWS's own endpoint for the region. */
  endpoint: endpointSchema.nullable(),
  region: z.string().regex(REGION_RE),
  bucket: z.string().regex(BUCKET_RE),
  accessKeyId: accessKeyIdSchema,
  forcePathStyle: z.boolean(),
});

export const INTEGRATION_SETTINGS_SCHEMAS = {
  payments: paymentsSettingsSchema,
  email: emailSettingsSchema,
  storage: storageSettingsSchema,
} as const;

export type PaymentsSettings = z.output<typeof paymentsSettingsSchema>;
export type SmtpEmailSettings = z.output<typeof smtpSettingsSchema>;
export type SesEmailSettings = z.output<typeof sesSettingsSchema>;
export type EmailSettings = SmtpEmailSettings | SesEmailSettings;
export type StorageSettings = z.output<typeof storageSettingsSchema>;
export type PersistedSettings = { payments: PaymentsSettings; email: EmailSettings; storage: StorageSettings };

/**
 * The fields that decide where a stored secret is sent: email the provider and then the SMTP server (host, port,
 * security) or the SES region (the AWS endpoint follows it), storage the endpoint (SigV4 never sends the secret
 * itself, but an endpoint the Owner does not control still sees signatures). Payments have none: the Razorpay API
 * address is fixed. When one of them changes, every secret the new settings use must be entered again in the same
 * save, so a stored secret can never be pointed at another server and read out there
 * (lib/integrations/store.ts writeIntegration; the forms ask for it first).
 */
export const DESTINATION_FIELDS = {
  payments: [],
  email: ["provider", "host", "port", "security", "region"],
  storage: ["endpoint"],
} as const satisfies Record<IntegrationKind, readonly string[]>;

/** The message on each stored secret that must be entered again because the server changed. */
export const SECRET_REENTRY_MESSAGES: Readonly<Record<IntegrationKind, string>> = {
  payments: "Enter it again.",
  email: "Enter it again: the email provider, server or region changed.",
  storage: "Enter it again: the endpoint changed.",
};

/** The email provider of settings or a form draft (no provider = SMTP, like rows saved before SES). */
export function emailProviderOf(values: Readonly<Record<string, unknown>> | null | undefined): EmailProvider {
  return values?.provider === "ses" ? "ses" : "smtp";
}

function destinationValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value).trim();
  if (field === "host") return normalizeHost(raw);
  if (field === "endpoint") return raw === "" ? "" : (normalizeEndpoint(raw) ?? raw);
  if (field === "port") return raw === "" ? "" : String(Number(raw));
  if (field === "region") return raw.toLowerCase();
  return raw;
}

/**
 * Whether `next` sends the kind's secrets somewhere else than `previous` (DESTINATION_FIELDS, compared normalised:
 * host case, endpoint origin, port as a number). Works on persisted settings and on form drafts alike.
 */
export function destinationChanged(kind: IntegrationKind, previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>): boolean {
  if (kind === "email") {
    // Only the fields of the provider in use count (an SMTP draft still carries the SES defaults, and the reverse).
    const before = emailProviderOf(previous);
    const after = emailProviderOf(next);
    if (before !== after) return true;
    const fields = after === "ses" ? ["region"] : ["host", "port", "security"];
    return fields.some((field) => destinationValue(field, previous[field]) !== destinationValue(field, next[field]));
  }
  const fields: readonly string[] = DESTINATION_FIELDS[kind];
  return fields.some((field) => destinationValue(field, previous[field]) !== destinationValue(field, next[field]));
}

/**
 * The secrets settings can use: payments both, storage the secret access key, email the SMTP password or the SES
 * secret access key by provider. A stored secret outside this list is removed by the save that switches provider.
 */
export function applicableSecrets<K extends IntegrationKind>(kind: K, settings: Readonly<Record<string, unknown>>): SecretFieldOf<K>[] {
  if (kind === "email") return [emailProviderOf(settings) === "ses" ? "secretAccessKey" : "password"] as SecretFieldOf<K>[];
  return [...SECRET_FIELDS[kind]] as SecretFieldOf<K>[];
}

/** The secrets a saved configuration needs (SMTP: the password only when a username is set; SES: the secret key). */
export function requiredSecrets<K extends IntegrationKind>(kind: K, settings: PersistedSettings[K]): SecretField[] {
  if (kind === "payments") return ["keySecret", "webhookSecret"];
  if (kind === "storage") return ["secretAccessKey"];
  const email = settings as EmailSettings;
  if (email.provider === "ses") return ["secretAccessKey"];
  return email.username === null ? [] : ["password"];
}

// ---------- Save bodies (PUT /api/admin/settings/integrations/:kind) ----------

export const currentPasswordSchema = z
  .string("Enter your password.")
  .min(1, "Enter your password.")
  .max(1024, "Enter your password.");
const revisionSchema = z.number().int().min(1).nullable();

/** An optional secret: empty or missing keeps the stored one; otherwise trimmed and checked (secretProblem). */
function secretInput(field: SecretField) {
  return z
    .string()
    .max(4096, `Use at most ${SECRET_MAX_LENGTH} characters.`)
    .optional()
    .superRefine((v, ctx) => {
      if (v === undefined || v.trim() === "") return;
      const problem = secretProblem(field, v);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    })
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));
}

const trimmed = (max: number, required: string) => z.string(required).trim().min(1, required).max(max, required);

export const paymentsSaveSchema = z.strictObject({
  currentPassword: currentPasswordSchema,
  revision: revisionSchema,
  keyId: z
    .string("Enter the Key ID.")
    .trim()
    .regex(RAZORPAY_KEY_ID_RE, "Enter a Key ID that starts with rzp_test_ or rzp_live_."),
  keySecret: secretInput("keySecret"),
  webhookSecret: secretInput("webhookSecret"),
});

const PORT_MESSAGE = "Enter a port from 1 to 65535.";

const fromNameInput = trimmed(100, "Enter the sender name.").refine(isMailboxName, "Use letters, digits and spaces only (no < or >).");
const fromAddressInput = trimmed(254, "Enter the From address.").refine(isMailboxAddress, "Enter an email address such as no-reply@example.com.");

/** The SMTP body of PUT .../email (`provider` may be left out: a body without one is SMTP). */
export const smtpSaveSchema = z.strictObject({
  currentPassword: currentPasswordSchema,
  revision: revisionSchema,
  provider: z.literal("smtp"),
  host: trimmed(253, "Enter the SMTP host.")
    .transform(normalizeHost)
    .refine(isHostLike, "Enter a host name such as smtp.example.com."),
  port: z.number(PORT_MESSAGE).int(PORT_MESSAGE).min(1, PORT_MESSAGE).max(65_535, PORT_MESSAGE),
  security: z.enum(EMAIL_SECURITY, "Choose STARTTLS or TLS."),
  username: z
    .string("Enter the username, or leave it empty.")
    .trim()
    .max(256, "Use at most 256 characters.")
    .refine((v) => !CONTROL_RE.test(v), "Remove line breaks and other control characters.")
    .transform((v) => (v === "" ? null : v)),
  password: secretInput("password"),
  fromName: fromNameInput,
  fromAddress: fromAddressInput,
});

const SES_ACCESS_KEY_MESSAGE = "Enter the access key ID: capital letters and digits, usually starting with AKIA.";
const CONFIGURATION_SET_MESSAGE = "Use letters, digits, hyphens and underscores only (up to 64), or leave it empty.";

/** The Amazon SES body of PUT .../email. No endpoint: the AWS endpoint follows the region. */
export const sesSaveSchema = z.strictObject({
  currentPassword: currentPasswordSchema,
  revision: revisionSchema,
  provider: z.literal("ses"),
  region: z
    .string("Choose the AWS region.")
    .trim()
    .toLowerCase()
    .pipe(z.enum(SES_REGION_IDS, "Choose a region where Amazon SES is available.")),
  accessKeyId: z
    .string(SES_ACCESS_KEY_MESSAGE)
    .trim()
    .regex(AWS_ACCESS_KEY_ID_RE, SES_ACCESS_KEY_MESSAGE)
    .refine((v) => !isPlaceholder(v), "Enter the real access key ID."),
  secretAccessKey: secretInput("secretAccessKey"),
  configurationSet: z
    .string(CONFIGURATION_SET_MESSAGE)
    .trim()
    .max(64, CONFIGURATION_SET_MESSAGE)
    .refine((v) => v === "" || SES_CONFIGURATION_SET_RE.test(v), CONFIGURATION_SET_MESSAGE)
    .optional()
    .transform((v) => (v === undefined || v === "" ? null : v)),
  fromName: fromNameInput,
  fromAddress: fromAddressInput,
});

/** PUT .../email: the SMTP or the SES body, chosen by `provider` (missing = SMTP; anything else 422 on provider). */
export const emailSaveSchema = z.preprocess(
  withEmailProvider,
  z.discriminatedUnion("provider", [smtpSaveSchema, sesSaveSchema], { error: PROVIDER_MESSAGE }),
);

const ENDPOINT_MESSAGE = "Enter an https:// address without a path, such as https://s3.ap-south-1.amazonaws.com.";

export const storageSaveSchema = z
  .strictObject({
    currentPassword: currentPasswordSchema,
    revision: revisionSchema,
    preset: z.enum(STORAGE_PRESETS, "Choose a provider."),
    endpoint: z
      .string(ENDPOINT_MESSAGE)
      .trim()
      .max(2048, ENDPOINT_MESSAGE)
      .transform((v, ctx) => {
        if (v === "") return null;
        const origin = normalizeEndpoint(v);
        if (origin === null) {
          ctx.addIssue({ code: "custom", message: ENDPOINT_MESSAGE });
          return z.NEVER;
        }
        return origin;
      }),
    region: z
      .string("Enter the region.")
      .trim()
      .toLowerCase()
      .regex(REGION_RE, "Enter a region such as ap-south-1 or auto."),
    bucket: z
      .string("Enter the bucket name.")
      .trim()
      .regex(BUCKET_RE, "Enter a bucket name: 3 to 63 lower-case letters, digits, dots or hyphens."),
    accessKeyId: z.string("Enter the access key ID.").trim().pipe(accessKeyIdSchema),
    secretAccessKey: secretInput("secretAccessKey"),
    forcePathStyle: z.boolean("Choose whether to use path-style URLs."),
  })
  .superRefine((body, ctx) => {
    if (body.preset !== "aws" && body.endpoint === null) {
      ctx.addIssue({ code: "custom", path: ["endpoint"], message: "Enter the endpoint." });
    }
  });

export const INTEGRATION_SAVE_SCHEMAS = { payments: paymentsSaveSchema, email: emailSaveSchema, storage: storageSaveSchema } as const;
export type IntegrationSaveBody<K extends IntegrationKind> = z.output<(typeof INTEGRATION_SAVE_SCHEMAS)[K]>;

/** DELETE bodies (remove the saved settings, clear one secret): the Owner's password only. */
export const passwordConfirmSchema = z.strictObject({ currentPassword: currentPasswordSchema });
/** POST .../test takes an empty object. */
export const probeBodySchema = z.strictObject({});

type Split<K extends IntegrationKind> = { settings: PersistedSettings[K]; secrets: Partial<Record<SecretFieldOf<K>, string>> };

/** A parsed save body split into the persisted settings and the secrets that were entered (missing = keep). */
export function splitSaveBody<K extends IntegrationKind>(kind: K, body: IntegrationSaveBody<K>): Split<K> {
  const pick = (source: Record<string, unknown>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const field of SECRET_FIELDS[kind]) {
      const value = source[field];
      if (typeof value === "string") out[field] = value;
    }
    return out;
  };
  const b = body as Record<string, unknown>;
  const secrets = pick(b) as Partial<Record<SecretFieldOf<K>, string>>;
  if (kind === "payments") {
    const p = body as IntegrationSaveBody<"payments">;
    return { settings: { provider: "razorpay", keyId: p.keyId } as PersistedSettings[K], secrets };
  }
  if (kind === "email") {
    const e = body as IntegrationSaveBody<"email">;
    const settings: EmailSettings =
      e.provider === "ses"
        ? {
            provider: "ses",
            region: e.region,
            accessKeyId: e.accessKeyId,
            configurationSet: e.configurationSet,
            fromName: e.fromName,
            fromAddress: e.fromAddress,
          }
        : {
            provider: "smtp",
            host: e.host,
            port: e.port,
            security: e.security,
            username: e.username,
            fromName: e.fromName,
            fromAddress: e.fromAddress,
          };
    return { settings: settings as PersistedSettings[K], secrets };
  }
  const s = body as IntegrationSaveBody<"storage">;
  const settings: StorageSettings = {
    preset: s.preset,
    endpoint: s.endpoint,
    region: s.region,
    bucket: s.bucket,
    accessKeyId: s.accessKeyId,
    forcePathStyle: s.forcePathStyle,
  };
  return { settings: settings as PersistedSettings[K], secrets };
}

// ---------- Audit ----------

/** AuditLog actions of Admin > Settings > Integrations (details name fields by label, never values). */
export const INTEGRATION_AUDIT_ACTIONS = {
  saved: "Updated integration settings",
  secretCleared: "Cleared integration secret",
  removed: "Removed integration settings",
  tested: "Tested integration",
} as const;
