/**
 * Owner actions of Admin > Settings > Integrations (docs/admin-integrations-design.md sections 13 to 16): save, clear
 * one saved secret, remove the saved settings, and the three test buttons.
 *
 * Every action needs integrations.manage (the Owner), checked here as well as by the route. Save, clear and remove
 * then re-check the Owner's password: RATE_LIMITS.integrationPassword is counted BEFORE verifying (5 / 15 min, so
 * parallel guesses cannot pass the limit) and cleared on success; a wrong password is 422 `incorrect_password` with
 * fieldErrors.currentPassword and is logged (kind and remaining tries), never audited. The tests are limited by
 * RATE_LIMITS.integrationTest (10 / 10 min, never cleared).
 *
 * The change and its AuditLog row share one transaction; the row names the integration and the changed fields by
 * label, never a value. After the commit the resolver cache of this process is invalidated, so the next request here
 * uses the new configuration (other processes within 30 s). Secret values only pass through on their way into
 * lib/integrations/store.ts (encryption); responses carry hints only (lib/admin/settings/integrations.ts).
 * Server-only.
 */
import "server-only";
import type { StaffRole } from "@/generated/prisma/client";
import { audit, type AuditActor } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import { attempt, clear, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db as defaultDb } from "@/lib/db";
import { getEnv, getLicenseKeySecrets, isProduction } from "@/lib/env";
import { ApiError, errors } from "@/lib/http";
import {
  fieldLabel,
  INTEGRATION_AUDIT_ACTIONS,
  INTEGRATION_SETTINGS_SCHEMAS,
  INTEGRATION_TITLES,
  requiredSecrets,
  splitSaveBody,
  toDbKind,
  type EmailSettings,
  type IntegrationKind,
  type IntegrationSaveBody,
  type PersistedSettings,
  type SecretFieldOf,
  type StorageSettings,
} from "@/lib/integrations/model";
import { probeEmail, probePayments, probeStorage, type EmailProbeOptions, type StorageProbeOptions } from "@/lib/integrations/probes";
import { envFallback, getIntegrationSnapshot, invalidateIntegrations } from "@/lib/integrations/resolver";
import { clearIntegrationSecret, deleteIntegration, writeIntegration } from "@/lib/integrations/store";
import type { ProbeResult } from "@/lib/integrations/types";
import { log } from "@/lib/log";
import { can, roleForbiddenMessage } from "@/lib/rbac";
import { endpointProblem, hostProblem } from "@/lib/security/host-rules";
import { resolvePublicHost, type LookupAll } from "@/lib/security/net-guard";
import { loadIntegrationState, type IntegrationViewEnv } from "./integrations";
import {
  clearedAuditDetail,
  INTEGRATIONS_COPY,
  type IntegrationClearResponse,
  type IntegrationRemoveResponse,
  type IntegrationSaveResponse,
} from "./integrations-model";

export const INCORRECT_PASSWORD_MESSAGE = "Incorrect password.";
export const NOT_SAVED_MESSAGE = "Nothing is saved here.";
export const NOT_CONFIGURED_FOR_TEST_MESSAGE = "Save the settings first.";
export const HOST_BLOCKED_MESSAGE = "This host points to a private network address.";
export const HOST_NOT_FOUND_MESSAGE = "We couldn’t find this host.";

/** The signed-in staff member (adminRoute context) and their audit actor. */
export type IntegrationCaller = {
  staff: { id: string; name: string; email: string; role: StaffRole };
  actor: AuditActor;
};

export type IntegrationActionOptions = {
  client?: typeof defaultDb;
  /** APP_URL (webhook URL), NODE_ENV, REDIS_URL for the returned view (default getEnv()). */
  env?: IntegrationViewEnv;
  /** Apply the production host rules and the save-time DNS check (default: NODE_ENV is production). */
  production?: boolean;
  /** DNS for the save-time check (tests inject one). */
  lookup?: LookupAll;
  /** Input key material (default LICENSE_KEY_ENC_KEY). */
  ikm?: Buffer;
  now?: Date;
};

/** One-off clients of the test buttons (tests inject them; default: the real ones). */
export type ProbeClients = {
  fetch?: typeof fetch;
  transportFactory?: EmailProbeOptions["transportFactory"];
  driverFactory?: StorageProbeOptions["driverFactory"];
};

let probeOverride: ProbeClients | null = null;

/** Tests only: the clients the test buttons use when the caller passes none (like setStorage / setEmailTransport). */
export function setIntegrationProbeClientsForTests(clients: ProbeClients | null): void {
  probeOverride = clients;
}

function assertCanManage(by: IntegrationCaller): void {
  if (!can(by.staff.role, "integrations.manage")) throw errors.forbidden(roleForbiddenMessage(by.staff.role));
}

export function incorrectPassword(): ApiError {
  return new ApiError(422, "incorrect_password", INCORRECT_PASSWORD_MESSAGE, {
    details: { fieldErrors: { currentPassword: [INCORRECT_PASSWORD_MESSAGE] }, formErrors: [] },
  });
}

/**
 * The Owner's password re-entry: counted before verifying (a refused attempt is not counted), the hash re-read (the
 * session's copy may be stale), cleared on success.
 */
async function confirmPassword(client: typeof defaultDb, by: IntegrationCaller, kind: IntegrationKind, password: string, now: Date): Promise<void> {
  const rule = RATE_LIMITS.integrationPassword(by.staff.id);
  const counted = await attempt(client, rule, now);
  if (!counted.allowed) {
    log.warn("integration_password_limited", { kind, userId: by.staff.id });
    throw errors.rateLimited(counted.retryAfterSec);
  }
  const user = await client.user.findUnique({ where: { id: by.staff.id }, select: { passwordHash: true } });
  if (!(await verifyPassword(password, user?.passwordHash))) {
    log.info("integration_password_denied", { kind, userId: by.staff.id, remaining: counted.remaining });
    throw incorrectPassword();
  }
  await clear(client, rule.key);
}

/**
 * Save-time host checks (section 12): the static rules (production: no private literals, local or single-label names,
 * https only), then in production a DNS lookup of the host: refused when ANY address is private or the name does not
 * exist. Other DNS errors pass (connect time still guards). Messages never echo the host or an address.
 */
async function hostFieldErrors(
  kind: IntegrationKind,
  settings: PersistedSettings[IntegrationKind],
  opts: { production: boolean; lookup?: LookupAll },
): Promise<Record<string, string>> {
  let field: "host" | "endpoint";
  let host: string;
  if (kind === "email") {
    const email = settings as EmailSettings;
    // Amazon SES has no host to check: the AWS endpoint follows the region (model.ts SES_REGIONS).
    if (email.provider !== "smtp") return {};
    host = email.host;
    const problem = hostProblem(host, { production: opts.production });
    if (problem) return { host: problem.message };
    field = "host";
  } else if (kind === "storage") {
    const endpoint = (settings as StorageSettings).endpoint;
    if (endpoint === null) return {};
    const problem = endpointProblem(endpoint, { production: opts.production });
    if (problem) return { endpoint: problem.message };
    field = "endpoint";
    host = new URL(endpoint).hostname;
  } else {
    return {};
  }
  if (!opts.production) return {};
  const resolved = await resolvePublicHost(host, { lookup: opts.lookup });
  if (resolved.ok || resolved.reason === "dns_error") return {};
  return { [field]: resolved.reason === "blocked" ? HOST_BLOCKED_MESSAGE : HOST_NOT_FOUND_MESSAGE };
}

const auditTarget = (kind: IntegrationKind) => ({
  target: `Integrations · ${INTEGRATION_TITLES[kind]}`,
  targetType: "settings",
  targetId: `integrations.${kind}`,
});

const labelsOf = (kind: IntegrationKind, fields: readonly string[]) => fields.map((f) => fieldLabel(kind, f)).join(", ");

/** PUT /api/admin/settings/integrations/:kind (body already parsed with INTEGRATION_SAVE_SCHEMAS[kind]). */
export async function saveIntegration<K extends IntegrationKind>(
  by: IntegrationCaller,
  kind: K,
  body: IntegrationSaveBody<K>,
  opts: IntegrationActionOptions = {},
): Promise<IntegrationSaveResponse> {
  assertCanManage(by);
  const client = opts.client ?? defaultDb;
  const production = opts.production ?? isProduction();
  await confirmPassword(client, by, kind, (body as { currentPassword: string }).currentPassword, opts.now ?? new Date());

  const { settings, secrets } = splitSaveBody(kind, body);
  const hostErrors = await hostFieldErrors(kind, settings, { production, lookup: opts.lookup });
  if (Object.keys(hostErrors).length > 0) throw errors.validation(hostErrors);

  const replacesEnv = envFallback(kind).usable;
  const ikm = opts.ikm ?? getLicenseKeySecrets().encKey;
  const revision = (body as { revision: number | null }).revision;
  const written = await client.$transaction(async (tx) => {
    const result = await writeIntegration(tx, { kind, settings, secrets, actorId: by.staff.id, expectedRevision: revision, ikm });
    if (result.changed.length > 0 || result.removed.length > 0) {
      const labels = labelsOf(kind, result.changed);
      let detail = result.created ? `Saved: ${labels}${replacesEnv ? " (replaces the server file)" : ""}.` : `Changed: ${labels}.`;
      if (result.removed.length > 0) detail += ` Removed: ${labelsOf(kind, result.removed)}.`;
      await audit(tx, by.actor, { action: INTEGRATION_AUDIT_ACTIONS.saved, ...auditTarget(kind), detail });
    }
    return result;
  });
  if (written.changed.length > 0 || written.removed.length > 0) {
    invalidateIntegrations();
    log.info("integration_saved", { kind, fields: written.changed, removed: written.removed, by: by.staff.id });
  }
  return { integration: await loadIntegrationState(client, kind, opts.env ?? getEnv()), changed: written.changed };
}

/** DELETE /api/admin/settings/integrations/:kind/secrets/:field. */
export async function clearSecret<K extends IntegrationKind>(
  by: IntegrationCaller,
  kind: K,
  field: SecretFieldOf<K>,
  currentPassword: string,
  opts: IntegrationActionOptions = {},
): Promise<IntegrationClearResponse> {
  assertCanManage(by);
  const client = opts.client ?? defaultDb;
  await confirmPassword(client, by, kind, currentPassword, opts.now ?? new Date());
  const cleared = await client.$transaction(async (tx) => {
    const result = await clearIntegrationSecret(tx, { kind, field, actorId: by.staff.id });
    if (result === null) throw errors.conflict("integration_not_saved", NOT_SAVED_MESSAGE);
    if (!result.cleared) return false;
    const row = await tx.integrationConfig.findUnique({ where: { kind: toDbKind(kind) }, select: { settings: true } });
    const parsed = INTEGRATION_SETTINGS_SCHEMAS[kind].safeParse(row?.settings);
    const required = parsed.success ? requiredSecrets(kind, parsed.data as PersistedSettings[K]).includes(field) : true;
    await audit(tx, by.actor, { action: INTEGRATION_AUDIT_ACTIONS.secretCleared, ...auditTarget(kind), detail: clearedAuditDetail(kind, field, required) });
    return true;
  });
  if (cleared) {
    invalidateIntegrations();
    log.info("integration_secret_cleared", { kind, field, by: by.staff.id });
  }
  return { integration: await loadIntegrationState(client, kind, opts.env ?? getEnv()), cleared };
}

/** DELETE /api/admin/settings/integrations/:kind: the env file becomes the fallback again. */
export async function removeIntegration(
  by: IntegrationCaller,
  kind: IntegrationKind,
  currentPassword: string,
  opts: IntegrationActionOptions = {},
): Promise<IntegrationRemoveResponse> {
  assertCanManage(by);
  const client = opts.client ?? defaultDb;
  await confirmPassword(client, by, kind, currentPassword, opts.now ?? new Date());
  const fallback = envFallback(kind);
  await client.$transaction(async (tx) => {
    if (!(await deleteIntegration(tx, kind))) throw errors.conflict("integration_not_saved", NOT_SAVED_MESSAGE);
    await audit(tx, by.actor, {
      action: INTEGRATION_AUDIT_ACTIONS.removed,
      ...auditTarget(kind),
      detail: fallback.usable ? "Now using the server file." : "Now not configured.",
    });
  });
  invalidateIntegrations();
  log.info("integration_removed", { kind, fallback: fallback.usable ? "env" : "none", by: by.staff.id });
  return { integration: await loadIntegrationState(client, kind, opts.env ?? getEnv()) };
}

// ---------- Test buttons ----------

/** Audit reasons of a failed "Send test email", by the start of the probe's fixed message (SMTP, then Amazon SES). */
const EMAIL_FAILURE_REASONS: readonly (readonly [string, string])[] = [
  ["The server rejected", "sign-in rejected"],
  ["Couldn’t connect", "couldn’t connect"],
  ["The secure connection", "secure connection failed"],
  ["Blocked", "private network address"],
  ["The server refused", "message refused"],
  ["AWS rejected", "keys rejected"],
  ["Amazon SES refused", "sender or recipient not verified"],
  ["This access key isn’t allowed", "missing permission"],
  ["Amazon SES is throttling", "throttled"],
  ["Sending is paused", "sending paused"],
  ["Amazon SES couldn’t find", "configuration set not found"],
  ["Couldn’t reach Amazon SES", "couldn’t connect"],
];

/**
 * The audit detail of a test ("Test Razorpay keys: accepted.", "Send test email: failed (sign-in rejected).",
 * "Test bucket: upload ok, read ok, delete ok."). Built from step ids and statuses, never from a message that could
 * hold an address.
 */
export function probeAuditDetail(result: ProbeResult): string {
  const label = INTEGRATIONS_COPY.probe[result.kind];
  const step = (id: string) => result.steps.find((s) => s.id === id);
  let outcome: string;
  if (result.kind === "payments") {
    const keys = step("keys");
    if (!keys) outcome = "mock provider, nothing to test";
    else if (keys.status === "ok") outcome = "accepted";
    else outcome = /rejected/i.test(keys.message) ? "rejected" : "couldn’t reach Razorpay";
  } else if (result.kind === "email") {
    const send = step("send");
    if (send?.status === "ok") outcome = "sent";
    else {
      const reason = EMAIL_FAILURE_REASONS.find(([start]) => send?.message.startsWith(start))?.[1] ?? "not sent";
      outcome = `failed (${reason})`;
    }
  } else {
    outcome = (["upload", "read", "delete"] as const).map((id) => `${id} ${step(id)?.status ?? "skipped"}`).join(", ");
  }
  return `${label}: ${outcome}.${result.source === "env" ? " Used the server file." : ""}`;
}

function notConfiguredForTest(): ApiError {
  return errors.conflict("integration_not_configured", NOT_CONFIGURED_FOR_TEST_MESSAGE);
}

/** POST /api/admin/settings/integrations/:kind/test. A failed probe is still a result (ok: false), not an error. */
export async function testIntegration(
  by: IntegrationCaller,
  kind: IntegrationKind,
  opts: IntegrationActionOptions & { probes?: ProbeClients } = {},
): Promise<ProbeResult> {
  assertCanManage(by);
  const client = opts.client ?? defaultDb;
  const counted = await attempt(client, RATE_LIMITS.integrationTest(by.staff.id), opts.now ?? new Date());
  if (!counted.allowed) throw errors.rateLimited(counted.retryAfterSec);
  const snapshot = await getIntegrationSnapshot({ fresh: true });
  const probes = opts.probes ?? probeOverride ?? {};
  let result: ProbeResult;
  if (kind === "payments") {
    const resolved = snapshot.payments;
    if (resolved.source === "none") throw notConfiguredForTest();
    const webhookSecretUpdatedAt = resolved.source === "admin" ? (snapshot.admin.payments?.secrets.webhookSecret?.updatedAt ?? null) : null;
    result = await probePayments(resolved, { fetch: probes.fetch, client, webhookSecretUpdatedAt, now: opts.now });
  } else if (kind === "email") {
    const resolved = snapshot.email;
    if (resolved.source === "none") throw notConfiguredForTest();
    result = await probeEmail(resolved, { to: by.staff.email, transportFactory: probes.transportFactory, now: opts.now });
  } else {
    const resolved = snapshot.storage;
    if (resolved.source === "none") throw notConfiguredForTest();
    result = await probeStorage(resolved, { driverFactory: probes.driverFactory, now: opts.now });
  }
  await client.$transaction((tx) => audit(tx, by.actor, { action: INTEGRATION_AUDIT_ACTIONS.tested, ...auditTarget(kind), detail: probeAuditDetail(result) }));
  log.info("integration_tested", { kind, ok: result.ok, source: result.source, by: by.staff.id });
  return result;
}
