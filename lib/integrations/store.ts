/**
 * Database primitives of the Admin-saved integrations (IntegrationConfig + IntegrationSecret;
 * docs/admin-integrations-design.md section 6). No authorization, password check or audit here: the Admin service
 * (lib/admin/settings/integration-actions.ts) wraps these with them and calls invalidateIntegrations() after commit.
 *
 * - loadIntegrationRows(): every saved integration with its sealed secrets and the names of who changed them.
 * - writeIntegration(): advisory lock per kind, revision check (409 integration_changed), merge with the stored
 *   secrets, required-secret check (422 naming the field), encryption, upserts. Never clears a secret; a save that
 *   changes nothing writes nothing. A save that changes where the secrets go (model.ts DESTINATION_FIELDS: the SMTP
 *   server, the storage endpoint) must enter every stored secret of the kind again (422 naming each), so a kept
 *   secret can never be sent to a server the Owner just typed in.
 * - clearIntegrationSecret(), deleteIntegration(): under the same lock.
 * Secret values only ever exist here on their way into sealIntegrationSecret().
 */
import "server-only";
import { isDeepStrictEqual } from "node:util";
import { db as defaultDb, type Db, type Tx } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { sealIntegrationSecret, secretLast4 } from "./crypto";
import {
  destinationChanged,
  fromDbKind,
  INTEGRATION_SETTINGS_SCHEMAS,
  isSecretField,
  REQUIRED_SECRET_MESSAGES,
  requiredSecrets,
  SECRET_REENTRY_MESSAGES,
  secretProblem,
  toDbKind,
  type IntegrationKind,
  type PersistedSettings,
  type SecretFieldOf,
} from "./model";
import type { IntegrationRow } from "./types";

export const INTEGRATION_CHANGED_MESSAGE = "These settings changed since you opened the page. Reload and try again.";

const WHO = { select: { id: true, name: true } } as const;

/** Every saved integration with its sealed secrets (one query). */
export async function loadIntegrationRows(client: Db = defaultDb): Promise<IntegrationRow[]> {
  const rows = await client.integrationConfig.findMany({
    include: { updatedBy: WHO, secrets: { include: { updatedBy: WHO }, orderBy: { field: "asc" } } },
    orderBy: { kind: "asc" },
  });
  return rows.map((row) => ({
    kind: fromDbKind(row.kind),
    settings: row.settings,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ? { id: row.updatedBy.id, name: row.updatedBy.name } : null,
    secrets: row.secrets.map((s) => ({
      field: s.field,
      ciphertext: s.ciphertext,
      last4: s.last4,
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy ? { id: s.updatedBy.id, name: s.updatedBy.name } : null,
    })),
  }));
}

/** Serialises every write of one integration (two first saves cannot race to create the row). */
export async function lockIntegration(tx: Tx, kind: IntegrationKind): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`integration:${kind}`}::text))`;
}

export type WriteIntegrationInput<K extends IntegrationKind> = {
  kind: K;
  settings: PersistedSettings[K];
  /** Secrets entered in this save (trimmed); a missing field keeps the stored secret. */
  secrets: Partial<Record<SecretFieldOf<K>, string>>;
  actorId: string;
  /** The revision the form loaded; null when nothing was saved yet. */
  expectedRevision: number | null;
  /** Input key material (getLicenseKeySecrets().encKey). */
  ikm: Buffer;
};

export type WriteIntegrationResult = {
  revision: number;
  created: boolean;
  /** Field keys whose value changed (a secret counts whenever a new value was entered). Empty: nothing was written. */
  changed: string[];
};

/** Saves an integration (see the module comment). Throws ApiError 409 / 422. */
export async function writeIntegration<K extends IntegrationKind>(tx: Tx, input: WriteIntegrationInput<K>): Promise<WriteIntegrationResult> {
  const { kind } = input;
  const parsed = INTEGRATION_SETTINGS_SCHEMAS[kind].safeParse(input.settings);
  if (!parsed.success) throw errors.validation({}, ["The settings are not valid."]);
  const settings = parsed.data as PersistedSettings[K];
  const entered = Object.entries(input.secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  for (const [field, value] of entered) {
    if (!isSecretField(kind, field)) throw errors.validation({ [field]: "Unknown field." });
    const problem = secretProblem(field, value);
    if (problem) throw errors.validation({ [field]: problem });
  }

  await lockIntegration(tx, kind);
  const dbKind = toDbKind(kind);
  const existing = await tx.integrationConfig.findUnique({ where: { kind: dbKind }, include: { secrets: { select: { field: true } } } });
  if ((existing?.revision ?? null) !== input.expectedRevision) {
    throw new ApiError(409, "integration_changed", INTEGRATION_CHANGED_MESSAGE);
  }
  const stored = new Set(existing?.secrets.map((s) => s.field) ?? []);
  const provided = new Set(entered.map(([field]) => field));
  const before = existing ? INTEGRATION_SETTINGS_SCHEMAS[kind].safeParse(existing.settings) : null;
  const previous = before?.success ? (before.data as Record<string, unknown>) : null;
  const next = settings as Record<string, unknown>;

  const fieldErrors: Record<string, string> = {};
  for (const field of requiredSecrets(kind, settings)) {
    if (!stored.has(field) && !provided.has(field)) fieldErrors[field] = REQUIRED_SECRET_MESSAGES[field];
  }
  // A stored secret is never sent to a new server (DESTINATION_FIELDS): moving it there needs the value again. An
  // unreadable saved row counts as moved (where its secrets used to go is unknown).
  if (existing && (previous === null || destinationChanged(kind, previous, next))) {
    for (const field of stored) {
      if (isSecretField(kind, field) && !provided.has(field) && !fieldErrors[field]) fieldErrors[field] = SECRET_REENTRY_MESSAGES[kind];
    }
  }
  if (Object.keys(fieldErrors).length > 0) throw errors.validation(fieldErrors);
  const changed = Object.keys(next).filter((key) => key !== "provider" && (previous === null || !isDeepStrictEqual(previous[key], next[key])));
  changed.push(...entered.map(([field]) => field));
  if (existing && changed.length === 0) return { revision: existing.revision, created: false, changed: [] };

  const revision = (existing?.revision ?? 0) + 1;
  const json = settings as unknown as object;
  await tx.integrationConfig.upsert({
    where: { kind: dbKind },
    create: { kind: dbKind, settings: json, revision, updatedById: input.actorId },
    update: { settings: json, revision, updatedById: input.actorId },
  });
  for (const [field, value] of entered) {
    const ciphertext = sealIntegrationSecret(kind, field, value, input.ikm);
    const last4 = secretLast4(value);
    await tx.integrationSecret.upsert({
      where: { kind_field: { kind: dbKind, field } },
      create: { kind: dbKind, field, ciphertext, last4, updatedById: input.actorId },
      update: { ciphertext, last4, updatedById: input.actorId },
    });
  }
  return { revision, created: existing === null, changed };
}

/** Removes one saved secret. null: nothing is saved for the kind; `cleared: false`: that secret was not set. */
export async function clearIntegrationSecret<K extends IntegrationKind>(
  tx: Tx,
  input: { kind: K; field: SecretFieldOf<K>; actorId: string },
): Promise<{ revision: number; cleared: boolean } | null> {
  await lockIntegration(tx, input.kind);
  const dbKind = toDbKind(input.kind);
  const existing = await tx.integrationConfig.findUnique({ where: { kind: dbKind }, include: { secrets: { select: { field: true } } } });
  if (!existing) return null;
  if (!existing.secrets.some((s) => s.field === input.field)) return { revision: existing.revision, cleared: false };
  await tx.integrationSecret.delete({ where: { kind_field: { kind: dbKind, field: input.field } } });
  const updated = await tx.integrationConfig.update({
    where: { kind: dbKind },
    data: { revision: { increment: 1 }, updatedById: input.actorId },
    select: { revision: true },
  });
  return { revision: updated.revision, cleared: true };
}

/** Deletes the saved settings of a kind (secrets cascade); the env file becomes the fallback again. */
export async function deleteIntegration(tx: Tx, kind: IntegrationKind): Promise<boolean> {
  await lockIntegration(tx, kind);
  const { count } = await tx.integrationConfig.deleteMany({ where: { kind: toDbKind(kind) } });
  return count > 0;
}
