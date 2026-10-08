/**
 * Pure helpers of the Admin > Settings > Integrations forms (unit-tested; the .tsx components only render them):
 * field definitions, drafts, dirty detection, client checks with the server's own Zod schemas, the PUT body (an empty
 * secret is left out, which keeps the stored one), storage presets, the STARTTLS / TLS port switch, the test button
 * state and the status-only facts. Client-safe.
 */
import type { IntegrationForm, IntegrationState, SecretHint } from "@/lib/admin/settings/integrations-model";
import { INTEGRATIONS_COPY } from "@/lib/admin/settings/integrations-model";
import {
  DEFAULT_SMTP_PORTS,
  destinationChanged,
  fieldLabel,
  INTEGRATION_SAVE_SCHEMAS,
  REGION_RE,
  REQUIRED_SECRET_MESSAGES,
  SECRET_FIELDS,
  SECRET_REENTRY_MESSAGES,
  spacesEndpoint,
  STORAGE_PRESET_DEFAULTS,
  STORAGE_PRESETS,
  type EmailSecurity,
  type IntegrationKind,
  type SecretField,
  type StoragePreset,
} from "@/lib/integrations/model";

// ---------- Fields ----------

export type IntegrationFieldKind = "text" | "email" | "number" | "select" | "switch" | "secret";

export type IntegrationFieldDef = {
  key: string;
  label: string;
  kind: IntegrationFieldKind;
  hint?: string;
  mono?: boolean;
  /** Spans the whole form row. */
  wide?: boolean;
  maxLength?: number;
  inputMode?: "text" | "numeric" | "email" | "url";
  options?: readonly { value: string; label: string }[];
};

const field = (kind: IntegrationKind, key: string, def: Omit<IntegrationFieldDef, "key" | "label">): IntegrationFieldDef => ({
  key,
  label: fieldLabel(kind, key),
  ...def,
});

export const SECURITY_OPTIONS: readonly { value: EmailSecurity; label: string }[] = [
  { value: "starttls", label: "STARTTLS (port 587)" },
  { value: "tls", label: "TLS (port 465)" },
];

export const PRESET_OPTIONS: readonly { value: StoragePreset; label: string }[] = STORAGE_PRESETS.map((p) => ({
  value: p,
  label: STORAGE_PRESET_DEFAULTS[p].label,
}));

/** Form fields per integration, in form order (labels from lib/integrations/model.ts FIELD_LABELS). */
export const INTEGRATION_FIELDS: Readonly<Record<IntegrationKind, readonly IntegrationFieldDef[]>> = {
  payments: [
    field("payments", "keyId", { kind: "text", mono: true, wide: true, maxLength: 64, hint: "Starts with rzp_test_ or rzp_live_. Test or live mode follows the key." }),
    field("payments", "keySecret", { kind: "secret" }),
    field("payments", "webhookSecret", { kind: "secret", hint: "The secret you set for the webhook in the Razorpay Dashboard." }),
  ],
  email: [
    field("email", "host", { kind: "text", mono: true, maxLength: 253, inputMode: "url" }),
    field("email", "port", { kind: "number", maxLength: 5, inputMode: "numeric" }),
    field("email", "security", { kind: "select", options: SECURITY_OPTIONS }),
    field("email", "username", { kind: "text", maxLength: 256, hint: "Leave empty if the server needs no sign-in." }),
    field("email", "password", { kind: "secret" }),
    field("email", "fromName", { kind: "text", maxLength: 100 }),
    field("email", "fromAddress", { kind: "email", maxLength: 254, inputMode: "email", hint: "Use an address on a domain your provider has verified (SPF and DKIM)." }),
  ],
  storage: [
    field("storage", "preset", { kind: "select", options: PRESET_OPTIONS }),
    field("storage", "endpoint", { kind: "text", mono: true, wide: true, maxLength: 2048, inputMode: "url", hint: "https only. Leave empty for AWS." }),
    field("storage", "region", { kind: "text", mono: true, maxLength: 32 }),
    field("storage", "bucket", { kind: "text", mono: true, maxLength: 63 }),
    field("storage", "accessKeyId", { kind: "text", mono: true, maxLength: 128 }),
    field("storage", "secretAccessKey", { kind: "secret" }),
    field("storage", "forcePathStyle", { kind: "switch", wide: true, hint: "On for Cloudflare R2 and most S3-compatible stores." }),
  ],
};

/** Keys of the non-secret fields per integration. */
export const VALUE_KEYS: Readonly<Record<IntegrationKind, readonly string[]>> = {
  payments: INTEGRATION_FIELDS.payments.filter((f) => f.kind !== "secret").map((f) => f.key),
  email: INTEGRATION_FIELDS.email.filter((f) => f.kind !== "secret").map((f) => f.key),
  storage: INTEGRATION_FIELDS.storage.filter((f) => f.kind !== "secret").map((f) => f.key),
};

// ---------- Drafts ----------

export type DraftValue = string | boolean;
/** Form state: every value as typed (port as text, the switch as a boolean), every secret "" until entered. */
export type IntegrationDraft = Record<string, DraftValue>;

const text = (v: DraftValue | undefined): string => (typeof v === "string" ? v : "");

/** The draft of a form: saved (or prefilled) values, empty secrets (a secret is never prefilled). */
export function toDraft(form: IntegrationForm): IntegrationDraft {
  const draft: IntegrationDraft = {};
  for (const [key, value] of Object.entries(form.values)) draft[key] = typeof value === "boolean" ? value : String(value);
  for (const f of SECRET_FIELDS[form.kind]) draft[f] = "";
  return draft;
}

function sameValue(a: DraftValue | undefined, b: DraftValue | undefined): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === Boolean(b);
  return text(a).trim() === text(b).trim();
}

/** Changed non-secret fields, then every secret with a new value, in form order. */
export function dirtyKeys(kind: IntegrationKind, baseline: IntegrationDraft, draft: IntegrationDraft): string[] {
  return INTEGRATION_FIELDS[kind]
    .filter((f) => (f.kind === "secret" ? text(draft[f.key]).trim() !== "" : !sameValue(baseline[f.key], draft[f.key])))
    .map((f) => f.key);
}

/** Whether Save has something to do. A first save always does: it moves the integration into Admin. */
export function hasChanges(state: Pick<IntegrationState, "saved">, kind: IntegrationKind, baseline: IntegrationDraft, draft: IntegrationDraft): boolean {
  return state.saved === null || dirtyKeys(kind, baseline, draft).length > 0;
}

/** PUT body. An empty secret is left out: the server keeps the stored one. */
export function bodyFor(kind: IntegrationKind, draft: IntegrationDraft, currentPassword: string, revision: number | null): Record<string, unknown> {
  const body: Record<string, unknown> = { currentPassword, revision };
  for (const key of VALUE_KEYS[kind]) {
    const value = draft[key];
    if (key === "forcePathStyle") body[key] = value === true;
    else if (key === "port") body[key] = text(value).trim() === "" ? 0 : Number(text(value).trim());
    else body[key] = text(value);
  }
  for (const f of SECRET_FIELDS[kind]) {
    const value = text(draft[f]);
    if (value.trim() !== "") body[f] = value;
  }
  return body;
}

/** Secrets the draft needs: payments both, storage the secret key, email the password only with a username. */
export function requiredSecretFields(kind: IntegrationKind, draft: IntegrationDraft): SecretField[] {
  if (kind === "payments") return ["keySecret", "webhookSecret"];
  if (kind === "storage") return ["secretAccessKey"];
  return text(draft.username).trim() === "" ? [] : ["password"];
}

export function secretHintOf(form: IntegrationForm, key: string): SecretHint {
  return (form.secrets as Readonly<Record<string, SecretHint>>)[key] ?? { set: false, last4: null, updatedAt: null, updatedBy: null };
}

/**
 * Saved secrets the draft must enter again: the draft sends them to another server than the saved settings (the SMTP
 * server or the storage endpoint; lib/integrations/model.ts DESTINATION_FIELDS). The server refuses the save otherwise.
 */
export function secretsToReenter(form: IntegrationForm, draft: IntegrationDraft): SecretField[] {
  const saved = (SECRET_FIELDS[form.kind] as readonly SecretField[]).filter((f) => secretHintOf(form, f).set);
  if (saved.length === 0 || !destinationChanged(form.kind, toDraft(form), draft)) return [];
  return saved;
}

/** The keys of `errors` in form order. */
export function orderedErrorKeys(kind: IntegrationKind, errors: Readonly<Record<string, string>>): string[] {
  return INTEGRATION_FIELDS[kind].map((f) => f.key).filter((key) => Boolean(errors[key]));
}

/**
 * Client checks with the server's own schemas (lib/integrations/model.ts INTEGRATION_SAVE_SCHEMAS) plus the required
 * secrets that are neither saved nor entered. The server checks everything again (and the network rules).
 */
export function clientErrors(form: IntegrationForm, draft: IntegrationDraft, revision: number | null): Record<string, string> {
  const errors: Record<string, string> = {};
  const parsed = INTEGRATION_SAVE_SCHEMAS[form.kind].safeParse(bodyFor(form.kind, draft, "client-check", revision));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key !== "" && key !== "currentPassword" && key !== "revision" && !errors[key]) errors[key] = issue.message;
    }
  }
  for (const f of requiredSecretFields(form.kind, draft)) {
    if (!secretHintOf(form, f).set && text(draft[f]).trim() === "" && !errors[f]) errors[f] = REQUIRED_SECRET_MESSAGES[f];
  }
  for (const f of secretsToReenter(form, draft)) {
    if (text(draft[f]).trim() === "" && !errors[f]) errors[f] = SECRET_REENTRY_MESSAGES[form.kind];
  }
  return errors;
}

/** First message per field of a 422 response (the password error stays in the dialog). */
export function serverFieldErrors(fieldErrors: Readonly<Record<string, readonly string[]>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, messages] of Object.entries(fieldErrors)) {
    const name = key.split(".")[0] ?? key;
    if (name !== "currentPassword" && messages[0] && !out[name]) out[name] = messages[0];
  }
  return out;
}

// ---------- Presets and linked fields ----------

/** Prefills endpoint, region and path style for a storage preset ("Other" changes nothing). Values stay editable. */
export function applyPreset(draft: IntegrationDraft, preset: StoragePreset): IntegrationDraft {
  const defaults = STORAGE_PRESET_DEFAULTS[preset];
  const next: IntegrationDraft = { ...draft, preset };
  if (defaults.endpoint !== null) next.endpoint = defaults.endpoint;
  if (defaults.region !== null) next.region = defaults.region;
  if (defaults.forcePathStyle !== null) next.forcePathStyle = defaults.forcePathStyle;
  return next;
}

/** "Filled in for Cloudflare R2. Check the values." (null for Other, which fills nothing). */
export function presetHint(preset: StoragePreset): string | null {
  return preset === "other" ? null : INTEGRATIONS_COPY.presetFilled(STORAGE_PRESET_DEFAULTS[preset].label);
}

export function endpointPlaceholder(preset: StoragePreset): string {
  return STORAGE_PRESET_DEFAULTS[preset].endpointPlaceholder;
}

/** A new region; DigitalOcean Spaces' endpoint follows it while it still is the region's default endpoint. */
export function applyRegion(draft: IntegrationDraft, region: string): IntegrationDraft {
  const next: IntegrationDraft = { ...draft, region };
  if (draft.preset !== "spaces") return next;
  const before = text(draft.endpoint).trim();
  const followed = before === "" || before === spacesEndpoint(text(draft.region).trim().toLowerCase());
  const wanted = region.trim().toLowerCase();
  if (followed && REGION_RE.test(wanted)) next.endpoint = spacesEndpoint(wanted);
  return next;
}

/** STARTTLS / TLS; the port follows while it still holds the other option's default (587 / 465). */
export function applySecurity(draft: IntegrationDraft, security: EmailSecurity): IntegrationDraft {
  const other: EmailSecurity = security === "tls" ? "starttls" : "tls";
  const next: IntegrationDraft = { ...draft, security };
  if (text(draft.port).trim() === String(DEFAULT_SMTP_PORTS[other])) next.port = String(DEFAULT_SMTP_PORTS[security]);
  return next;
}

// ---------- Card state ----------

export type BadgeTone = "sage" | "peach" | "pink" | "lavender" | "blue" | "slate";
export type BadgeSpec = { label: string; tone: BadgeTone };

/** Source badge, "Development only" and Test / Live mode: text first, colour second. */
export function integrationBadges(state: Pick<IntegrationState, "source" | "development" | "mode">): BadgeSpec[] {
  const tone: BadgeTone = state.source === "admin" ? "sage" : state.source === "env" ? "blue" : "pink";
  const badges: BadgeSpec[] = [{ label: INTEGRATIONS_COPY.sources[state.source], tone }];
  if (state.development) badges.push({ label: INTEGRATIONS_COPY.development, tone: "peach" });
  if (state.mode) badges.push({ label: INTEGRATIONS_COPY.modes[state.mode], tone: state.mode === "test" ? "peach" : "sage" });
  return badges;
}

/** Footer note: who saved and when, else the source. */
export function cardNote(state: Pick<IntegrationState, "saved" | "source">): string {
  if (state.saved) return INTEGRATIONS_COPY.noteSaved(state.saved.updatedBy, state.saved.updatedAt);
  return state.source === "env" ? INTEGRATIONS_COPY.noteEnv : INTEGRATIONS_COPY.noteNone;
}

/** The test button: only for a configured integration whose form has no unsaved changes. */
export function testButtonState(state: Pick<IntegrationState, "source">, dirty: boolean): { enabled: boolean; hint: string | null } {
  if (state.source === "none") return { enabled: false, hint: INTEGRATIONS_COPY.setUpFirst };
  if (dirty) return { enabled: false, hint: INTEGRATIONS_COPY.saveFirst };
  return { enabled: true, hint: null };
}

/** A stored secret: "Set (ends 1a2b)" and "Changed by Asha Rao on 8 Oct 2026". */
export function secretSummary(hint: SecretHint): { summary: string; changed: string | null } {
  return { summary: INTEGRATIONS_COPY.secret.set(hint.last4), changed: INTEGRATIONS_COPY.secret.changed(hint.updatedBy, hint.updatedAt) };
}

/** Help under a secret input (`reenter`: the server changed, so the saved value cannot be kept). */
export function secretInputHint(opts: {
  replacing: boolean;
  source: IntegrationState["source"];
  saved: boolean;
  unused: boolean;
  reenter?: boolean;
}): string | null {
  if (opts.reenter) return INTEGRATIONS_COPY.secret.reenter;
  if (opts.unused) return INTEGRATIONS_COPY.secret.unusedWithoutUsername;
  if (opts.replacing) return INTEGRATIONS_COPY.secret.keep;
  if (opts.source === "env" && !opts.saved) return INTEGRATIONS_COPY.secret.inServerFile;
  return null;
}

export type StatusFact = { label: string; value: string };

/** What a status-only card shows (no field values and no secret hints): provider, source and mode. */
export function statusFacts(state: Pick<IntegrationState, "provider" | "source" | "mode">): StatusFact[] {
  const facts: StatusFact[] = [
    { label: INTEGRATIONS_COPY.facts.provider, value: state.provider },
    { label: INTEGRATIONS_COPY.facts.source, value: INTEGRATIONS_COPY.sources[state.source] },
  ];
  if (state.mode) facts.push({ label: INTEGRATIONS_COPY.facts.mode, value: INTEGRATIONS_COPY.modes[state.mode] });
  return facts;
}
