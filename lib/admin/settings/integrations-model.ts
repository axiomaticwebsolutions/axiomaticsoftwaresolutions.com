/**
 * Admin > Settings > Integrations (docs/admin-integrations-design.md sections 14 and 17): the shapes that
 * GET /api/admin/settings and the /api/admin/settings/integrations/:kind routes return, the copy, and the plain
 * problem lines. Pure and client-safe (the forms import it).
 *
 * Nothing here ever carries a secret value. A secret appears only as a SecretHint: whether it is set, the last 4
 * characters of long secrets (16+), when it changed and who changed it. Status-only viewers (no integrations.manage)
 * get `form: null`: no field values and no hints. Problem lines name fields by label or env variables by NAME.
 */
import type { IconName } from "@/components/icons/icon";
import { formatDateIST, formatDateTimeIST } from "@/lib/dates";
import {
  fieldLabel,
  INTEGRATION_TITLES,
  type EmailProvider,
  type EmailSecurity,
  type IntegrationKind,
  type PaymentMode,
  type SecretField,
  type StoragePreset,
} from "@/lib/integrations/model";
import type { NotConfiguredReason } from "@/lib/integrations/types";

// ---------- Shapes ----------

export type IntegrationSourceId = "admin" | "env" | "none";
export type PrefilledFrom = "admin" | "env" | "defaults";

/** A saved secret as the Owner sees it (never the value). `set: false` = nothing saved in Admin for this field. */
export type SecretHint = { set: boolean; last4: string | null; updatedAt: string | null; updatedBy: string | null };

export type PaymentsFormValues = { keyId: string };
/**
 * The email form carries the fields of both providers (the Owner can switch); only the chosen provider's fields are
 * sent and saved. `region` defaults to ap-south-1, `configurationSet` "" means none.
 */
export type EmailFormValues = {
  provider: EmailProvider;
  host: string;
  port: number;
  security: EmailSecurity;
  username: string;
  region: string;
  accessKeyId: string;
  configurationSet: string;
  fromName: string;
  fromAddress: string;
};
export type StorageFormValues = {
  preset: StoragePreset;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  forcePathStyle: boolean;
};

/** The editable form of one integration (Owner only). Values are non-secret; secrets are hints. */
export type IntegrationForm =
  | {
      kind: "payments";
      prefilledFrom: PrefilledFrom;
      values: PaymentsFormValues;
      secrets: { keySecret: SecretHint; webhookSecret: SecretHint };
      /** Where Razorpay sends webhooks: `${APP_URL}/api/webhooks/payments/razorpay`. */
      webhookUrl: string;
      /** The newest razorpay WebhookDelivery with a valid signature (ISO), or null. */
      lastSignedWebhookAt: string | null;
    }
  | { kind: "email"; prefilledFrom: PrefilledFrom; values: EmailFormValues; secrets: { password: SecretHint; secretAccessKey: SecretHint } }
  | { kind: "storage"; prefilledFrom: PrefilledFrom; values: StorageFormValues; secrets: { secretAccessKey: SecretHint } };

export type IntegrationState = {
  id: IntegrationKind;
  title: string;
  description: string;
  icon: IconName;
  /** Where the effective configuration comes from (Admin wins as a whole; the env file is only the fallback). */
  source: IntegrationSourceId;
  /** The mock provider, the console transport or the local disk (env only, never in production). */
  development: boolean;
  /**
   * "Razorpay" | "Mock provider" | "SMTP" | "Amazon SES (API)" | "Console (dev mailbox)" | "S3-compatible bucket" |
   * "Local disk" | "Not set"
   */
  provider: string;
  /** Payments only: the key's mode. */
  mode: PaymentMode | null;
  /** Why it is not configured (a plain sentence naming fields or env variable NAMES), or null. */
  problem: string | null;
  /** The Admin row, when one exists (it decides even when it is incomplete). */
  saved: { revision: number; updatedAt: string; updatedBy: string | null } | null;
  /** The fallback env variable NAMES (never their values). */
  envNames: readonly string[];
  /** null without integrations.manage (status only). */
  form: IntegrationForm | null;
};

export type RedisStatus = "configured" | "missing" | "development";

/** Rate limits stay env-only (REDIS_URL): a read-only card. */
export type RedisState = {
  id: "redis";
  title: string;
  description: string;
  icon: IconName;
  status: RedisStatus;
  provider: string;
  note: string;
  envNames: readonly ["REDIS_URL"];
};

/** AdminSettingsData.integrations. */
export type IntegrationsData = { canManage: boolean; items: IntegrationState[]; redis: RedisState };

/** PUT /api/admin/settings/integrations/:kind. `changed` holds field keys (empty: nothing was different). */
export type IntegrationSaveResponse = { integration: IntegrationState; changed: string[] };
/** DELETE .../secrets/:field. `cleared: false`: that secret was not set (nothing changed). */
export type IntegrationClearResponse = { integration: IntegrationState; cleared: boolean };
/** DELETE /api/admin/settings/integrations/:kind. */
export type IntegrationRemoveResponse = { integration: IntegrationState };

// ---------- Copy ----------

export const INTEGRATION_CARD_META: Readonly<Record<IntegrationKind, { description: string; icon: IconName }>> = {
  payments: { description: "Razorpay keys for checkout, refunds and payment webhooks.", icon: "credit_card" },
  email: { description: "SMTP or Amazon SES: sends order, account and support email.", icon: "outgoing_mail" },
  storage: { description: "Private bucket for installers and attachments; signed links only.", icon: "cloud" },
};

/** What stops when an integration is not configured (dialogs and audit details). */
const STOPS: Readonly<Record<IntegrationKind, { stops: string; off: string }>> = {
  payments: { stops: "Payments stop", off: "Payments are off" },
  email: { stops: "Email stops", off: "Email is off" },
  storage: { stops: "Uploads and downloads stop", off: "Uploads and downloads are off" },
};

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

export const INTEGRATIONS_COPY = {
  title: "Integrations",
  description:
    "Payments, email and file storage. What you save here replaces the server file within 30 seconds. Secrets are encrypted and never shown again.",
  sources: { admin: "Saved in Admin", env: "From the server file", none: "Not configured" },
  development: "Development only",
  modes: { test: "Test mode", live: "Live mode" },
  facts: { provider: "Provider", source: "Source", mode: "Mode" },
  save: "Save",
  remove: "Remove saved settings",
  probe: { payments: "Test Razorpay keys", email: "Send test email", storage: "Test bucket" },
  probeResult: "Test result",
  saveFirst: "Save your changes first.",
  setUpFirst: "Save the settings first.",
  noteSaved: (by: string | null, at: string) => (by ? `Saved by ${by} on ${formatDateIST(new Date(at))}` : `Saved on ${formatDateIST(new Date(at))}`),
  noteEnv: "Using the server file. Save here to replace it.",
  noteNone: "Nothing saved yet.",
  envNames: "Server file fallback:",
  webhookUrl: "Webhook URL",
  webhookUrlHint:
    "Add it in the Razorpay Dashboard with the events payment.captured, order.paid, payment.failed, refund.processed and refund.failed.",
  lastWebhook: (at: string) => `Last signed webhook: ${formatDateTimeIST(new Date(at))}.`,
  presetFilled: (label: string) => `Filled in for ${label}. Check the values.`,
  storageHelp: "This page reloads after a change. Reload other open tabs before uploading.",
  sesHelp:
    "Verify the From domain in Amazon SES (Easy DKIM). Until AWS grants production access, SES only delivers to verified addresses.",
  /** Under the email Provider select and in the save dialog when the save deletes the other provider’s saved secret. */
  providerSwitch: (labels: readonly string[]) => `Saving removes the saved ${joinLabels(labels.map(lowerFirst))}.`,
  secret: {
    set: (last4: string | null) => (last4 ? `Set (ends ${last4})` : "Set"),
    changed: (by: string | null, at: string | null) => {
      if (!at) return null;
      const date = formatDateIST(new Date(at));
      return by ? `Changed by ${by} on ${date}` : `Changed on ${date}`;
    },
    replace: "Replace",
    clear: "Clear",
    cancel: "Cancel",
    keep: "Leave empty to keep the saved value.",
    /** Under a saved secret that must be entered again (lib/integrations/model.ts DESTINATION_FIELDS changed). */
    reenter: {
      payments: "The saved value can’t be kept.",
      email: "The provider, server or region changed, so the saved value can’t be kept.",
      storage: "The endpoint changed, so the saved value can’t be kept.",
    } satisfies Record<IntegrationKind, string>,
    inServerFile: "In the server file. Enter it here to save these settings in Admin.",
    unusedWithoutUsername: "Not used without a username.",
  },
  dialog: {
    title: "Confirm with your password",
    body: (title: string) => `${title} changes for everyone within 30 seconds.`,
    label: "Your password",
    empty: "Enter your password.",
    save: "Save",
    clear: "Clear",
    remove: "Remove",
    cancel: "Cancel",
  },
  toasts: {
    saved: (title: string) => `${title} saved`,
    noChanges: "No changes to save",
    cleared: (field: string) => `${field} cleared`,
    removed: "Saved settings removed",
  },
  redis: {
    title: "Rate limits",
    description: "Shared counters for sign-in, activation and API limits.",
    note: "Set on the server: a wrong value here would block every sign-in.",
    statuses: { configured: "Configured", missing: "Not configured", development: "Development only" },
  },
} as const;

/** Clear dialog body: a required secret stops the integration, an optional one does not. */
export function clearDialogBody(kind: IntegrationKind, field: SecretField, required: boolean): string {
  const label = fieldLabel(kind, field);
  return required ? `${label} is removed. ${STOPS[kind].stops} until you save a new one.` : `${label} is removed.`;
}

/** Remove dialog body. */
export function removeDialogBody(kind: IntegrationKind): string {
  return `The site goes back to the server file. If it has no settings, ${lowerFirst(STOPS[kind].stops)}.`;
}

/** Audit detail of a cleared secret ("Cleared: Key secret. Payments are off until a new one is saved."). */
export function clearedAuditDetail(kind: IntegrationKind, field: SecretField, required: boolean): string {
  const label = fieldLabel(kind, field);
  return required ? `Cleared: ${label}. ${STOPS[kind].off} until a new one is saved.` : `Cleared: ${label}.`;
}

/** "A, B and C" */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The problem line of an integration that is not configured. Admin reasons name fields by label, env reasons name
 * variables; neither ever names a value. Status-only viewers get the sentence without the call to action.
 */
export function integrationProblem(
  kind: IntegrationKind,
  reason: NotConfiguredReason,
  names: readonly string[],
  opts: { canManage: boolean },
): string {
  const labels = names.map((n) => fieldLabel(kind, n));
  switch (reason) {
    case "missing":
      return "Not set up yet.";
    case "admin_incomplete": {
      const what = joinLabels(labels) || "A saved secret";
      const many = labels.length > 1;
      const sentence = `${what} ${many ? "were" : "was"} cleared.`;
      if (!opts.canManage) return sentence;
      return `${sentence} ${many ? "Enter new ones" : "Enter a new one"} to turn this back on.`;
    }
    case "admin_invalid":
      return `The saved settings can’t be used here: ${labels.join(", ") || "settings"}.`;
    case "admin_unreadable":
      if (names.includes("settings")) {
        return opts.canManage ? "The saved settings can’t be read. Save them again." : "The saved settings can’t be read.";
      }
      return opts.canManage ? "Saved secrets can’t be read (the server key changed?). Enter them again." : "Saved secrets can’t be read.";
    case "env_incomplete":
      return `The server file is missing ${names.join(", ") || "values"}.`;
    case "env_invalid": {
      const sentence = `The server file has values that can’t work (${names.join(", ") || "values"}).`;
      return opts.canManage ? `${sentence} Enter the details here.` : sentence;
    }
    case "unsupported_provider":
      return "The server file selects a provider that isn’t supported.";
  }
}

export function integrationTitle(kind: IntegrationKind): string {
  return INTEGRATION_TITLES[kind];
}
