# Admin-configurable integrations: design

Date: 2026-10-08. Owner decision: "make it configurable from admin dashboard". The Razorpay keys, SMTP email and the
S3-compatible installer storage move from env-only configuration to Admin > Settings > Integrations. This document is
the implementation design and ships with the change. The dated entry in `docs/decisions.md` summarises it.

Contents: 1 Outcome · 2 Scope · 3 Precedence · 4 Data model · 5 Encryption · 6 Modules · 7 Resolver · 8 Consumers ·
9 Not configured · 10 Env and deploy scripts · 11 CSP · 12 SSRF guard · 13 RBAC and rate limits · 14 API · 15 Audit
and logs · 16 Test probes · 17 UI · 18 Tests · 19 Docs · 20 Order of work · 21 Open points

## 1. Outcome in brief

- The Owner edits Razorpay keys, SMTP and the bucket in Admin > Settings > Integrations. Rate limits (Redis) stay
  env-only and show as a read-only card.
- Each integration has one effective configuration, resolved on the server. A configuration saved in Admin wins as a
  whole. The env file is only the fallback when Admin has none. Otherwise the integration is "Not configured". Admin
  and env fields are never mixed.
- Production starts with no payment, email or storage variables at all. When an integration is not configured:
  - checkout says payments are not available yet;
  - emails fail with a logged reason under the outbox's retry rules;
  - uploads and downloads answer 503.
- Secrets at rest use AES-256-GCM. The key comes from HKDF-SHA256 over `LICENSE_KEY_ENC_KEY` with its own info label,
  and the associated data binds the integration kind and field. Secrets are never returned, rendered, logged or
  audited. The API returns only "set", the last 4 characters (long secrets only), when it was changed and by whom.
- A new permission, `integrations.manage`, is held by the Owner only.
  - Save, clear and remove need the Owner's password (rate limited), CSRF and same-origin.
  - Every save that changes something, every clear of a saved secret, every remove and every test writes an AuditLog
    row that names fields, never values (a save with no changes and a clear of an unset secret write none).
- One server-only resolver keeps a 30 s in-process cache on `globalThis`. A save invalidates it immediately in the
  process that saved. Every consumer reads the resolver.
- CSP: the middleware moves to the Node.js runtime and covers every page.
  - It adds the runtime bucket origin to both the strict nonce policy and the static policy. The origin is always
    exact, never a wildcard.
  - `next.config.ts` no longer bakes a bucket origin, so a storage change no longer needs a rebuild.
- Three test buttons are Owner only, rate limited and audited: Razorpay keys, a test email, and a bucket probe.
- An SSRF guard applies in production to SMTP hosts and storage endpoints. It runs at save time, at resolve time and
  at connect time.

## 2. Scope

| | |
|---|---|
| In | Payments: Razorpay only. The mock stays env-only, for development and tests. |
| | Email: SMTP. The console transport stays env-only, for development. |
| | Installer and attachment storage: S3-compatible. The local driver stays env-only, for development. |
| Out (unchanged) | `REDIS_URL`, `DOWNLOAD_LINK_TTL_SECONDS`, `LICENSE_*` and every other variable. Cashfree (no adapter). |
| Not edited | `docs/server-runbook.md` (the lead updates it). |

## 3. Effective configuration and precedence

For each kind (`payments`, `email`, `storage`), the resolver returns exactly one of the outcomes below.

| Source | When |
|---|---|
| `admin` | An `IntegrationConfig` row exists for the kind, its settings are valid in this environment, and every required secret decrypts. |
| `none` (`admin_incomplete`, `admin_invalid`, `admin_unreadable`) | A row exists but is incomplete (a required secret was cleared), invalid here (e.g. a private host in production) or unreadable (decryption or JSON validation failed). The env file is NOT consulted. |
| `env` | No row exists, and the env file holds a complete, usable configuration of that kind. |
| `none` (`env_incomplete`, `env_invalid`, `missing`, `unsupported_provider`) | No row exists, and the env file has nothing usable. |

Whether a row exists decides the source. "Remove saved settings" is an explicit Owner action: it deletes the row and
brings back the env fallback.

Development defaults (any `NODE_ENV` other than production): when the env file does not select a driver, the env
source is the development driver, as today:

- `PAYMENT_PROVIDER` unset → mock;
- `EMAIL_TRANSPORT` unset → console;
- `STORAGE_DRIVER` unset → local.

In production an unset selector means `missing`. Admin can never choose a development driver.

Env completeness (`lib/integrations/env-source.ts`):

| Kind | Env selects | Complete when | Otherwise |
|---|---|---|---|
| payments | `razorpay` | `PAYMENT_KEY_ID` matches the key format, plus `PAYMENT_KEY_SECRET` and `PAYMENT_WEBHOOK_SECRET` | `env_incomplete` (names) or `env_invalid` (`PAYMENT_KEY_ID`) |
| payments | `mock` (not production) | `PAYMENT_KEY_SECRET` and `PAYMENT_WEBHOOK_SECRET` (key id defaults to `mock_key`) | `env_incomplete` |
| payments | `cashfree` | never | `unsupported_provider` |
| email | `smtp` | `SMTP_HOST` is usable, and `EMAIL_FROM` parses as `Name <address>` or `address` | `env_incomplete` or `env_invalid` |
| email | `console` (not production) | always; the From defaults to `Axiomatic Software (dev) <no-reply@localhost>` | — |
| storage | `s3` | `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, plus a usable `STORAGE_ENDPOINT` when set | `env_incomplete` or `env_invalid` |
| storage | `local` (not production) | always (`STORAGE_LOCAL_DIR`) | — |

"Usable" applies the same host rules as the Admin form (section 12).

- In every environment, a host under `.invalid` is refused (RFC 6761: such names never resolve).
- In production, the following are also refused: loopback, private, link-local and unspecified literals; `localhost`
  names; single-label names; and http storage endpoints.

The release-day stand-ins therefore classify as `env_invalid`: `rzp_test_pending` fails the key format,
`smtp-pending.invalid` and `https://r2-pending.invalid` are `.invalid` hosts. Those integrations show "Not configured"
and name the variables, instead of "From the server file" with values that cannot work. Checkout says payments are not
available yet instead of failing at Razorpay with a 401.

- SMTP security from env: port 465 → `tls`; any other port → `starttls` (as today).
- Payment mode: a key id starting `rzp_test_` → test; `rzp_live_` → live; the mock → test.
- Key id format: `RAZORPAY_KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{8,32}$/`.

## 4. Data model and migration

Prisma (`prisma/schema.prisma`). The change is additive only.

```prisma
enum IntegrationKind {
  PAYMENTS
  EMAIL
  STORAGE
}

// Admin > Settings > Integrations (docs/admin-integrations-design.md). One row per integration the Owner saved; no row
// = the env file is the fallback. Non-secret fields only; secrets live in IntegrationSecret, encrypted.
model IntegrationConfig {
  kind        IntegrationKind     @id
  settings    Json // non-secret fields, validated with Zod (lib/integrations/model.ts INTEGRATION_SETTINGS_SCHEMAS)
  revision    Int                 @default(1) // +1 on every save and secret clear; optimistic concurrency for the form
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt
  updatedById String?
  updatedBy   User?               @relation("IntegrationConfigUpdatedBy", fields: [updatedById], references: [id], onDelete: SetNull)
  secrets     IntegrationSecret[]
}

// One encrypted secret of an integration (lib/integrations/crypto.ts). Never returned, logged or audited.
model IntegrationSecret {
  kind        IntegrationKind
  field       String // keySecret | webhookSecret (PAYMENTS), password (EMAIL), secretAccessKey (STORAGE)
  ciphertext  String // "v1.<iv>.<tag>.<ct>", base64url, AES-256-GCM
  last4       String? // last 4 characters, only for secrets of 16+ characters; display only
  updatedAt   DateTime          @updatedAt
  updatedById String?
  updatedBy   User?             @relation("IntegrationSecretUpdatedBy", fields: [updatedById], references: [id], onDelete: SetNull)
  config      IntegrationConfig @relation(fields: [kind], references: [kind], onDelete: Cascade)

  @@id([kind, field])
}
```

- `User` gets back-relations only (no columns):
  - `integrationConfigsUpdated IntegrationConfig[] @relation("IntegrationConfigUpdatedBy")`
  - `integrationSecretsUpdated IntegrationSecret[] @relation("IntegrationSecretUpdatedBy")`
- `Payment` gets `providerKeyId String? // key id the provider order was created with (Razorpay key id, "mock_key"); null = before 2026-10-08`.
  A key change (test to live, or another Razorpay account) makes earlier provider orders unusable. Reopen, reconcile
  and refunds therefore need to know which keys an attempt belongs to (section 8).
- API and AAD use lowercase kinds (`payments`, `email`, `storage`). `toDbKind()` and `fromDbKind()` in
  `lib/integrations/model.ts` map them to the enum.

Migration:

1. Run `pnpm exec prisma migrate dev --create-only --name integration_configs` against the dev database. The role
   `axiomatic` has CREATEDB for the shadow database.
2. Check that the SQL contains only `CREATE TYPE`, `CREATE TABLE`, `ADD COLUMN` and `ADD CONSTRAINT`. Expected SQL:

```sql
CREATE TYPE "IntegrationKind" AS ENUM ('PAYMENTS', 'EMAIL', 'STORAGE');
ALTER TABLE "Payment" ADD COLUMN "providerKeyId" TEXT;
CREATE TABLE "IntegrationConfig" (
    "kind" "IntegrationKind" NOT NULL,
    "settings" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    CONSTRAINT "IntegrationConfig_pkey" PRIMARY KEY ("kind")
);
CREATE TABLE "IntegrationSecret" (
    "kind" "IntegrationKind" NOT NULL,
    "field" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "last4" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    CONSTRAINT "IntegrationSecret_pkey" PRIMARY KEY ("kind","field")
);
ALTER TABLE "IntegrationConfig" ADD CONSTRAINT "IntegrationConfig_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IntegrationSecret" ADD CONSTRAINT "IntegrationSecret_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IntegrationSecret" ADD CONSTRAINT "IntegrationSecret_kind_fkey" FOREIGN KEY ("kind") REFERENCES "IntegrationConfig"("kind") ON DELETE CASCADE ON UPDATE CASCADE;
```

3. Apply it with `prisma migrate dev`, then run `prisma generate`.

Where the migration runs:

- Test database: picked up automatically, because `tests/db/global-setup.ts` runs `prisma migrate deploy` into a fresh
  schema on every run.
- Production: `deploy.sh` runs `prisma migrate deploy` after the preflight. The preflight therefore treats a missing
  `IntegrationConfig` table as "no Admin settings yet".

Persisted `settings` JSON per kind. It is Zod-validated on write and on every read, and extra keys are rejected.

| Kind | `settings` |
|---|---|
| PAYMENTS | `{ provider: "razorpay", keyId }` |
| EMAIL | `{ host, port, security: "starttls" \| "tls", username: string \| null, fromName, fromAddress }` |
| STORAGE | `{ preset: "aws" \| "r2" \| "spaces" \| "other", endpoint: string \| null, region, bucket, accessKeyId, forcePathStyle }` |

Secrets per kind:

| Kind | Secret | Required |
|---|---|---|
| PAYMENTS | `keySecret` | always |
| PAYMENTS | `webhookSecret` | always |
| EMAIL | `password` | when `username` is set; otherwise kept but unused |
| STORAGE | `secretAccessKey` | always |

The Razorpay Key ID and the storage access key ID are not secret. The Key ID goes to the browser by design
(`components/checkout/razorpay.ts`), and AWS treats access key IDs as identifiers. Both are stored in `settings` and
shown to the Owner.

## 5. Secret encryption

`lib/integrations/crypto.ts` uses `node:crypto` and never reads env. The caller passes the input key.

| Item | Value |
|---|---|
| Input key material | `getLicenseKeySecrets().encKey` (`LICENSE_KEY_ENC_KEY`, 32 random bytes) |
| Key derivation | HKDF-SHA256, salt empty (RFC 5869 then uses HashLen zero bytes), info UTF-8 `axs:integration-secrets:v1`, length 32: `Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), "axs:integration-secrets:v1", 32))` |
| Cipher | AES-256-GCM, a fresh `randomBytes(12)` IV (96 bits) per write, 16-byte tag |
| Associated data | UTF-8 `axs:integration-secret:v1:<kind>:<field>` with the kind in lower case, e.g. `axs:integration-secret:v1:payments:webhookSecret` |
| Encoding | `v1.<iv>.<tag>.<ciphertext>`, each part base64url without padding. Decoding is strict (canonical base64url, exact IV and tag lengths), as in `lib/licensing/crypto.ts`. |

Key separation:

- License keys use `LICENSE_KEY_ENC_KEY` directly, with AAD `axs:license-key:v1`.
- The integration key is derived, so it is never the raw env key.
- A license ciphertext can never open as an integration secret, and an integration ciphertext never opens as a license
  key.
- The associated data also stops a ciphertext from being copied to another kind or field.

API:

```ts
export function deriveIntegrationKey(ikm: Buffer): Buffer; // throws unless ikm is 32 bytes
export function sealIntegrationSecret(kind: IntegrationKind, field: string, plaintext: string, ikm: Buffer): string;
export function openIntegrationSecret(kind: IntegrationKind, field: string, payload: string, ikm: Buffer): string;
export function secretLast4(plaintext: string): string | null;
export class IntegrationSecretError extends Error {} // message "Integration secret could not be decrypted"
```

- `openIntegrationSecret` throws the same `IntegrationSecretError` for every failure: malformed, unknown version, wrong
  key, tampered, wrong kind or field. The error carries no detail, payload or plaintext.
- `secretLast4` returns the last 4 characters only when the secret has 16 or more characters, else null. A short SMTP
  password would otherwise lose a quarter or more of its length. The UI then shows "Set".
- Plaintext rules, checked before sealing: trimmed, 1–512 characters, no control characters, and not a placeholder
  (`isPlaceholder` from `lib/env.ts`).

Minimum lengths:

| Secret | Minimum |
|---|---|
| `keySecret` | 8 |
| `webhookSecret` | 16 (same as `PAYMENT_WEBHOOK_SECRET` in env) |
| `password` | 1 |
| `secretAccessKey` | 8 |

Failure and rotation:

- Fail closed: if any secret fails to open, the integration is `none` (`admin_unreadable`). The env file is not used
  instead. The resolver logs `integration_secret_unreadable { kind, field }` once per process.
- Rotation: `LICENSE_KEY_ENC_KEY` is already permanent, because license keys depend on it. If it ever changes, the
  saved integration secrets show as unreadable and the Owner enters them again. Nothing else breaks.
- A database copy without the env file reveals no integration secret.

## 6. Module layout

| File | Runtime | Content |
|---|---|---|
| `lib/integrations/model.ts` | pure, client-safe | kinds, `toDbKind`, field lists and labels, `SECRET_FIELDS`, `STORAGE_PRESETS`, persisted-settings schemas, request-body schemas, `razorpayMode()`, `RAZORPAY_KEY_ID_RE`, `INTEGRATION_AUDIT_ACTIONS` |
| `lib/integrations/types.ts` | types only | `PaymentsConfig`, `EmailConfig`, `StorageConfig`, `Resolved<C>`, `NotConfiguredReason`, `IntegrationSnapshot`, `IntegrationRow` |
| `lib/integrations/crypto.ts` | Node, no env | section 5 |
| `lib/security/host-rules.ts` | Node (`node:net`), no `server-only` | `isBlockedAddress()`, `hostProblem()`, `endpointProblem()` |
| `lib/security/net-guard.ts` | server-only | `guardedLookup()`, `smtpSocketGuard()`, `resolvePublicHost()`, `BlockedAddressError` |
| `lib/integrations/env-source.ts` | no `server-only` (the preflight imports it) | `classifyEnvIntegrations(env, { production })` |
| `lib/email/address.ts` | pure | `parseMailbox("Name <a@b>")` → `{ name, address } \| null` |
| `lib/integrations/store.ts` | server-only | `loadIntegrationRows()`, `writeIntegration()`, `clearIntegrationSecret()`, `deleteIntegration()` |
| `lib/integrations/resolver.ts` | server-only | section 7 |
| `lib/integrations/csp-origin.ts` | server-only | `uploadOriginForCsp()` for the middleware |
| `lib/integrations/probes.ts` | server-only | `probePayments()`, `probeEmail()`, `probeStorage()` |
| `lib/admin/settings/integrations.ts` | server-only (rewritten) | the views for GET and the page |
| `lib/admin/settings/integration-actions.ts` | server-only | save, clear secret, remove and test, with password check, rate limits, audit and invalidation |

`server-only` throws outside the React Server bundle. Modules the preflight loads under `node --import tsx`
(`env-source.ts`, `host-rules.ts`, `model.ts`, `address.ts`) must therefore never import it.

Store primitives (CORE; the ADMIN service layer wraps them with authorization, the password check and audit):

```ts
export type IntegrationRow = {
  kind: IntegrationKind; settings: unknown; revision: number; createdAt: Date; updatedAt: Date;
  updatedBy: { id: string; name: string } | null;
  secrets: { field: string; ciphertext: string; last4: string | null; updatedAt: Date; updatedBy: { id: string; name: string } | null }[];
};
export function loadIntegrationRows(client?: Db): Promise<IntegrationRow[]>;
/** Advisory lock, revision check, merge, required-secret check, encryption, upserts. Never clears a secret. */
export function writeIntegration(tx: Tx, input: {
  kind: IntegrationKind; settings: PersistedSettings; secrets: Partial<Record<string, string>>;
  actorId: string; expectedRevision: number | null; ikm: Buffer;
}): Promise<{ revision: number; created: boolean; changed: string[] }>; // changed = field keys
export function clearIntegrationSecret(tx: Tx, input: { kind; field; actorId }): Promise<{ revision: number; cleared: boolean } | null>;
export function deleteIntegration(tx: Tx, kind: IntegrationKind): Promise<boolean>;
```

`writeIntegration` behaviour:

- It takes `SELECT pg_advisory_xact_lock(hashtext('integration:' || <kind>))` first, so two first saves cannot race.
- A revision mismatch throws `ApiError 409 integration_changed`.
- A required secret that is neither stored nor provided throws a validation `ApiError` (422) naming the field.

## 7. Resolver

`lib/integrations/resolver.ts` is the only code that combines Admin rows and env.

```ts
export type PaymentsConfig =
  | { provider: "razorpay"; keyId: string; keySecret: string; webhookSecret: string; mode: "test" | "live" }
  | { provider: "mock"; keyId: string; keySecret: string; webhookSecret: string; mode: "test" };
export type EmailConfig =
  | { transport: "smtp"; host: string; port: number; security: "starttls" | "tls";
      auth: { user: string; pass: string } | null; from: { name: string; address: string } }
  | { transport: "console"; from: { name: string; address: string } };
export type StorageConfig =
  | { driver: "s3"; endpoint: string | null; region: string; bucket: string; forcePathStyle: boolean;
      accessKeyId: string; secretAccessKey: string }
  | { driver: "local"; dir: string };
export type NotConfiguredReason =
  | "missing" | "admin_incomplete" | "admin_invalid" | "admin_unreadable"
  | "env_incomplete" | "env_invalid" | "unsupported_provider";
export type Resolved<C> =
  | { source: "admin" | "env"; config: C; fingerprint: string }
  | { source: "none"; reason: NotConfiguredReason; names: readonly string[] }; // field keys or env NAMES, never values

export const INTEGRATION_CACHE_TTL_MS = 30_000;
export function getIntegrationSnapshot(opts?: { fresh?: boolean; allowStale?: boolean; maxWaitMs?: number }): Promise<IntegrationSnapshot>;
export function resolvePayments(): Promise<Resolved<PaymentsConfig>>;
export function resolveEmail(): Promise<Resolved<EmailConfig>>;
export function resolveStorage(): Promise<Resolved<StorageConfig>>;
export function invalidateIntegrations(): void;
export class IntegrationNotConfiguredError extends Error { kind; reason; names } // "Payments are not configured." (no values)
// Tests only, like setStorage / setEmailTransport / setDbClient:
export function setIntegrationRowsLoader(loader: (() => Promise<IntegrationRow[]>) | null): void;
export function setIntegrationEnvForTests(env: IntegrationEnvInput | null): void;
```

`IntegrationSnapshot` contains:

- `loadedAt`;
- `payments`, `email` and `storage`, each a `Resolved`;
- `admin`: per kind, `{ revision, createdAt, updatedAt, updatedByName, settings | null, secrets }` or null, where
  `secrets` maps each field to `{ last4, updatedAt, updatedByName }`;
- `env`: per kind, `{ selector, namesSet, prefill }`, where `prefill` holds the non-secret env values only.

Cache:

- **Shared slot.** One slot lives on `globalThis` under `Symbol.for("axs.integrations.v1")`:
  `{ snapshot, generation, inflight, failedAt }`. Next.js loads route handlers, instrumentation and the middleware as
  separate module graphs in one process. The precedents are `lib/auth/rate-limit.ts` `STORE_SLOT` and `lib/db.ts`
  `__axsPrisma`. Every copy of the module therefore sees the same snapshot and the same invalidation.
- **Default read.** `getIntegrationSnapshot()` returns the snapshot when it is younger than 30 s. Otherwise it loads:
  one `findMany` including secrets and `updatedBy` names, then env classification and decryption. It then stores the
  result. Concurrent callers share one in-flight promise.
- **`fresh: true`** always loads, then stores. Admin views, probes and tests use it, so a save made on another PM2
  process shows at once on the Settings page.
- **`allowStale: true`** (the middleware) returns an expired snapshot at once and starts a background reload. It waits,
  for at most `maxWaitMs`, only when there is no snapshot at all.
- **`invalidateIntegrations()`** adds 1 to the generation and drops the snapshot. A load that started before the
  invalidation still answers its own caller but does not store its result. The saving request calls it right after
  its transaction commits, so the saving process uses the new configuration at once. Other PM2 processes
  (`AXS_INSTANCES` > 1) pick it up within 30 s; the UI says "within 30 seconds".
- **Failure.** A failed load keeps the last good snapshot (served stale) and records `failedAt`; no new load starts
  for 5 s. Log `integration_load_failed { error: <name> }` at most once a minute.
  - With no snapshot at all, the error propagates. A database outage already answers 503 `unavailable` through
    `errorResponse`.
  - The exception is the middleware, which never throws (section 11).
- **Warm-up.** `instrumentation.ts` `register()` (Node runtime, not during `next build`) calls
  `getIntegrationSnapshot()` with a 3 s cap and ignores errors. The first request then rarely waits.
- **Fingerprint.** The SHA-256 hex of the canonical JSON of `{ kind, source, config }`, computed once per load.
  - It is an in-memory cache key: adapters, transports and drivers are rebuilt when it changes.
  - It is never logged, returned, stored or compared across processes.
- **Logs.** `integration_env_ignored { kind, reason, names }` is logged once per process and fingerprint when env values
  are refused. Values are never logged.

Driver caches stay module-level in each consumer, keyed by fingerprint, one per bundle as today:

| Consumer | Cache | On a new fingerprint |
|---|---|---|
| payments | the latest adapter | build a new adapter |
| email | `{ fingerprint, transport }` | close the old pooled transport (`EmailTransport` gains an optional `close()`) |
| storage | `{ fingerprint, driver }` | destroy the old `S3Client` |

Unit tests never reach the database through the resolver. The unit project gets `setupFiles: ["tests/unit/setup.ts"]`,
which installs `setIntegrationRowsLoader(async () => [])`. Tests that need rows install their own loader.

## 8. Consumers, file by file

### Payments

**Adapters (`lib/payments/*`)**

- `lib/payments/types.ts`: `PaymentProvider` gains `readonly keyId: string`. Both adapters already have one.
- `lib/payments/index.ts`:
  - `createPaymentProvider(config: PaymentsConfig): PaymentProvider`.
    - razorpay: `new RazorpayProvider({ keyId, keySecret, webhookSecret })`, which never reads env.
    - mock: refused in production, else `new MockProvider(config)`.
  - `activePaymentProvider(): Promise<PaymentProvider>` builds from `resolvePayments()` and caches per fingerprint.
    When the source is `none` it throws `PaymentProviderError("not_configured", "Payments are not configured.", null)`.
  - `activePaymentProviderOrNull(): Promise<PaymentProvider | null>`.
  - `getPaymentProvider(key: "mock"): PaymentProvider` stays synchronous, for tests and the dev mock routes. It builds
    the env mock and is refused in production. The default argument (env `PAYMENT_PROVIDER`) is removed, so the type
    checker finds every former call site.
  - `resetPaymentProviders()` also drops the active-adapter cache.
- `lib/payments/razorpay.ts`:
  - The constructor stops reading env; `requireSecret` still requires all three values.
  - New `checkCredentials(): Promise<"ok" | "rejected">` sends `GET /orders?count=1` through `#request`. A 401 answers
    `"rejected"`; other failures throw `PaymentProviderError("provider_error")`. Only the probe uses it.
- `lib/payments/mock.ts`: `signMockReturn` and `signMockWebhook` take their default secrets from the env mock
  configuration (dev only).
- `lib/payments/mock-delivery.ts`:
  - `mockCheckoutEnabled()` becomes `Promise<boolean>`: `!isProduction() && (await resolvePayments())` is the mock.
    Production returns false before touching the resolver.
  - `assertMockCheckoutEnabled()` becomes async.
  - `deliverMockWebhook` signs with the active mock adapter's webhook secret.
  - Callers must await it: `app/dev/mock-checkout/page.tsx`, `components/store/order/order-page-data.ts`
    (`devBankControls`), `app/api/dev/mock-checkout/route.ts`, `app/api/dev/mock-checkout/bank/route.ts` and
    `lib/admin/orders/refund.ts`.

**Checkout and return**

- `lib/checkout/create-order.ts`:
  - Resolve the provider right after the cart checks and BEFORE the register rate-limit hit and the password hash:
    `const provider = ctx.provider ?? (await activePaymentProviderOrNull())`.
  - When it is null, answer `ApiError(503, "payments_unavailable", PAYMENTS_UNAVAILABLE_MESSAGE)`.
  - `Payment.create` writes `providerKeyId: provider.keyId`.
- `lib/checkout/payment-attempt.ts`:
  - `PAYMENTS_UNAVAILABLE_MESSAGE = "Payments aren’t available yet. Please try again later."`
  - `checkoutPayload` drops the env fallback. The key id must come from `providerOrder.checkout.keyId`; an empty one
    throws `not_configured`.
  - `retryPayment` resolves the active provider first; null answers 503 `payments_unavailable`.
    - It reopens the latest CREATED attempt only when `latest.provider === active.key` and
      `(latest.providerKeyId ?? active.keyId) === active.keyId`, passing `{ providerOrderId, checkout: { keyId: active.keyId } }`.
    - Otherwise it creates a fresh attempt with `providerKeyId`.
    - A null `providerKeyId` (attempts made before this change) counts as matching. On the live site no Razorpay order
      could be created with the stand-in keys, so such rows exist only in development data and fixtures.
- `lib/checkout/return.ts`:
  - Pre-resolve once with `await activePaymentProviderOrNull()`, unless `opts.providerFor` is given (that override
    stays synchronous for tests).
  - Match only attempts whose provider equals the active key.
  - Old attempts made with other keys fail the signature check (400 `invalid_signature`), and the webhook settles them
    if the account is the same.
- `app/(checkout)/checkout/page.tsx`: passes `paymentsAvailable = (await resolvePayments()).source !== "none"` to
  `CheckoutView`. The page is already dynamic.
- `components/checkout/checkout-view.tsx`: when `paymentsAvailable` is false, show the notice from section 9 and
  disable Pay.

**Refunds and reconcile**

- `lib/admin/orders/refund.ts`:
  - Resolve `input.provider ?? await activePaymentProviderOrNull()` BEFORE `runDestructive`, so no database read
    happens inside the transaction.
  - No provider → 503 `payments_unavailable`.
  - Inside, when `target.provider !== provider.key`, or `target.providerKeyId` is set and differs from
    `provider.keyId` → 409 `provider_key_changed`: "This payment was taken with different payment keys. Refund it in
    the Razorpay Dashboard."
- `lib/payments/reconcile.ts`:
  - The provider is `opts.provider ?? await activePaymentProviderOrNull()`.
  - When it is null, return `{ provider: null, skipped: "not_configured", checked: 0, results: [], errors: 0 }` and log
    one info line. `ReconcileSummary.provider` becomes `string | null`, and `app/api/cron/reconcile/route.ts` stays
    200.
  - Attempts and refunds are filtered by provider key and
    `(providerKeyId IS NULL OR providerKeyId = active.keyId)`.

**Webhook route** (`app/api/webhooks/payments/[provider]/route.ts`). Checks run in this order:

1. A key that is not a provider key → 404.
2. `const active = await activePaymentProviderOrNull()`.
3. When `active` is null:
   - key `razorpay` → 503 `{ error: { code: "payments_not_configured", message: "Payments are not configured." } }`
     with `Retry-After: 300`. Nothing is recorded. Log `webhook_not_configured` at most once a minute. Razorpay keeps
     retrying, so events wait until the Owner saves keys.
   - any other key → 404.
4. `active.key !== key` → 404, as today.
5. The rest is unchanged: the synchronous `verifyWebhook` runs on the active adapter.

**Admin shell**

- `lib/admin/context.ts`:
  - `isPaymentTestMode(payments: Resolved<PaymentsConfig>) = source !== "none" && config.mode === "test"`.
  - `loadAdminData(client, user, payments = await resolvePayments())`.
  - The top bar pill and the order drawer follow the effective key.
- `prisma/seed-data/bootstrap.ts`: its `isPaymentTestMode` stays on raw env. It runs at bootstrap, before any Admin row
  exists, and only picks the sample-notice wording.

### Email

- `lib/email/transport.ts`:
  - `EmailTransport` gains an optional `close(): void`.
  - `getEmailTransport()`:
    - the override comes first;
    - otherwise `resolveEmail()`; `none` throws `EmailNotConfiguredError` (name `EmailNotConfiguredError`, `code`
      `"email_not_configured"`, message "Email delivery is not configured.");
    - a configured transport is cached per fingerprint, and the previous one is closed.
  - `createEmailTransport(config: EmailConfig, opts?: { pool?: boolean }): Promise<EmailTransport>` serves both
    `getEmailTransport` (pooled) and the probe (not pooled, closed after use).
- `lib/email/transports/smtp.ts`:
  - `smtpOptions(config, { production, pool })` replaces `smtpOptionsFromEnv`:
    - `secure = security === "tls"`;
    - `requireTLS = security === "starttls" && production`;
    - `auth = config.auth`;
    - timeouts unchanged;
    - in production, `getSocket = smtpSocketGuard` (section 12).
  - `createSmtpTransport(options, from: { name, address })` passes `from` as nodemailer's `{ name, address }` object,
    never a concatenated string. Its `close()` calls `mailer.close()`.
- `lib/email/send.ts`: `sendAuthEmail` keeps its shape. For an `EmailNotConfiguredError` it logs
  `email_send_failed { template, reason: "not_configured" }`.
- `lib/email/outbox.ts` `dispatchPendingEmails`:
  - Resolve the transport (`opts.transport ?? getEmailTransport()`) BEFORE claiming.
  - If that throws, still claim, and fail each claimed row through the existing failure path with that error: the
    attempt is counted, backoff applies, the row becomes FAILED after `OUTBOX_MAX_ATTEMPTS`, and `lastError` is
    `EmailNotConfiguredError email_not_configured: Email delivery is not configured.`.
  - No row stays SENDING, and the retry rules do not change. Log one `email_dispatch_not_configured { count }` per run.
- `lib/admin/templates/service.ts` `sendTemplateTest`: `getEmailTransport()` moves inside the try. An
  `EmailNotConfiguredError` answers 409 `email_not_configured`: "Email isn’t set up yet. Set it up in Settings >
  Integrations."
- `app/dev/mailbox/page.tsx`: shows the transport name from `resolveEmail()` (smtp when an Admin or env SMTP
  configuration is active).

### Storage

- `lib/storage/index.ts`:
  - `getStorage()` becomes async and returns `Promise<StorageDriver>`:
    - the override comes first;
    - otherwise `resolveStorage()`; `none` throws `StorageError("not_configured", "File storage is not configured")`;
    - a configured driver is cached per fingerprint.
  - A local driver in production is impossible: env refuses it and Admin cannot choose it.
  - New `createStorageDriver(config)`. `setStorage()` and `clampTtl()` are unchanged.
- `lib/storage/s3.ts`:
  - `s3StorageFromEnv` is removed.
  - The `S3Client` gets `requestHandler: { httpsAgent: new https.Agent({ keepAlive: true, lookup }), httpAgent: new http.Agent({ keepAlive: true, lookup }), connectionTimeout: 10_000 }`,
    with `lookup = guardedLookup()` in production. `NodeHttpHandler.create` accepts these options (verified in
    `@smithy/node-http-handler`), so no new dependency is needed.
  - New `openRead(key)` (a GetObject stream) and `destroy()`.
- `lib/storage/upload-origin.ts`: new pure `uploadOriginFor({ bucket, region, endpoint, forcePathStyle }): string | null`.
  `storageUploadOrigin(env)` stays as a thin wrapper.
- `lib/admin/catalog/installers.ts`: the separate env `S3Client` (`s3Reader`, `s3Client()`) is removed. `openObject`
  uses `driver.openRead()` for S3, so SHA-256 hashing follows the resolver.
- `lib/admin/catalog/releases.ts`:
  - `await getStorage()` moves inside the existing try blocks. `confirmInstallerUpload` with storage not configured
    answers 503 `upload_unavailable`.
  - `deleteObjects` catches `not_configured`, logs `storage_delete_skipped { count }`, and lets the database change go
    ahead.
- `lib/portal/uploads.ts` (`createUpload`, `confirmUpload`, `verifyAttachableUploads`, `attachmentDownloadLink`),
  `lib/admin/tickets/uploads.ts` and `lib/downloads/issue.ts`: `await getStorage()` inside the try. The answers are
  the existing 503 codes `upload_unavailable` and `download_unavailable`, with their existing messages; the log
  carries the reason.
- `lib/jobs/maintenance.ts` and `lib/jobs/tasks.ts`:
  - The storage provider becomes `() => Promise<StorageDriver>`.
  - `deleteStaleUploadsBatch` first checks, outside any transaction, whether a stale upload exists (`SELECT 1 ...
    LIMIT 1`, same predicate). Only then does it resolve the driver and open the transaction, so the resolver is never
    called inside it.
  - When storage is not configured, the uploads task is skipped (logged as
    `maintenance_uploads_skipped { reason: "not_configured" }`), not failed.
- `app/api/dev/storage/[...key]/route.ts`:
  `enabled() = !production && (await getStorage().catch(() => null)) instanceof LocalStorageDriver`.

### Other

- `instrumentation.ts`: adds the warm-up from section 7.
- `app/api/health/route.ts`: unchanged on purpose. Health gates PM2 restarts and the deploy, so an integration that is
  not configured must not make the server look down.
- `lib/admin/settings/service.ts`: `getAdminSettings(client, { canManage })` takes integrations from the new view
  builder (section 14).

## 9. Not-configured behaviour

| Area | Behaviour |
|---|---|
| Checkout page | Notice "Payments aren’t switched on yet, so you can’t place an order right now." Pay is disabled. |
| `POST /api/checkout/orders`, order retry | 503 `payments_unavailable` "Payments aren’t available yet. Please try again later.", answered before any account creation, password hash or provider call |
| Refund | 503 `payments_unavailable` |
| Payment webhook `razorpay` | 503 `payments_not_configured`, `Retry-After: 300`, not recorded |
| Reconcile cron | 200 `{ provider: null, skipped: "not_configured", ... }` |
| Outbox | Rows fail through the retry rules, with `lastError` "... Email delivery is not configured." |
| Direct auth and invite emails | `{ ok: false }`; the log says `reason: "not_configured"`; the flows show their existing "couldn’t send" copy |
| Template "Send test" | 409 `email_not_configured` |
| Uploads and downloads | 503 `upload_unavailable` / `download_unavailable` with the existing copy |
| Maintenance | The uploads task is skipped |
| Admin top bar | No Test mode pill |
| CSP | No bucket origin in `connect-src` |

## 10. Env, preflight and deploy scripts

`lib/env.ts`:

- `PAYMENT_PROVIDER`, `STORAGE_DRIVER` and `EMAIL_TRANSPORT` become optional, with no default. `Env` types them as
  possibly undefined, so the type checker finds every remaining direct reader.
- `PAYMENT_WEBHOOK_SECRET` becomes `optionalSecret(16)`.
- `EMAIL_FROM` becomes optional; when set, it must parse (`lib/email/address.ts`).
- Production still refuses an explicit `PAYMENT_PROVIDER=mock`, `STORAGE_DRIVER=local` or `EMAIL_TRANSPORT=console`.
- Placeholders are still refused in every secret that is present. Formats (URLs, bucket, port) are still checked
  when a value is present.
- The conditional "required when" rules are removed: razorpay → key id and secret; s3 → bucket, region and keys;
  smtp → host. Completeness is now the resolver's job, shown in Admin and by the preflight, and a half-filled env no
  longer stops the server.

What an operator must keep in `shared/.env.production`:

- **Required:** `APP_URL`, `SESSION_SECRET`, `CSRF_SECRET`, `ORDER_TOKEN_SECRET`, `CRON_SECRET`, `DATABASE_URL`,
  `CATALOG_SOURCE=db`, `LICENSE_KEY_PEPPER`, `LICENSE_KEY_ENC_KEY` (now also protects the saved integration secrets),
  `LICENSE_SIGNING_PRIVATE_KEY`, `LICENSE_SIGNING_PUBLIC_KEY`, `REDIS_URL` and `TRUSTED_PROXY_HOPS`.
- **Optional:** `DATABASE_POOL_*`, `LICENSE_OFFLINE_GRACE_DAYS`, `SECURITY_HSTS_STRICT` and
  `DOWNLOAD_LINK_TTL_SECONDS`, which have defaults.
- **Fallback only, normally left out:** `PAYMENT_*`, `STORAGE_*` (except `DOWNLOAD_LINK_TTL_SECONDS`), `EMAIL_*` and
  `SMTP_*`.

To remove the release-day stand-ins:

1. Save real settings in Admin. They win at once.
2. Delete the `PAYMENT_*`, `STORAGE_*` (except `DOWNLOAD_LINK_TTL_SECONDS`), `EMAIL_*` and `SMTP_*` lines.
3. Restart.

The cards then show "Saved in Admin". If the Admin settings are removed later, nothing falls back to stand-ins.

Deploy files:

- `deploy/preflight.mjs`:
  - The header comment drops the s3, smtp and real-provider requirement.
  - The "payments / storage / email" part of the success line becomes one line per integration, built from
    `classifyEnvIntegrations()`. Examples:
    - "payments: server file razorpay (test mode)";
    - "email: not in the server file (set it in Admin)";
    - "storage: server file values can't work: STORAGE_ENDPOINT (ignored)".
  - Stand-in values (`env_invalid`) raise a warning, not a failure.
  - With `--db`, it runs `SELECT kind, "updatedAt" FROM "IntegrationConfig"` and prints, e.g., "Admin: payments
    saved <date>". A missing table (42P01) prints "Admin: none yet (migration pending)".
  - It prints names only, never values.
- `scripts/gen-prod-env.mjs`: `PAYMENT_WEBHOOK_SECRET` leaves `generated`, because the operator chooses the secret in
  the Razorpay Dashboard and enters it in Admin. The template check follows. This file and the example below change
  together.
- `deploy/.env.production.example`:
  - The payments, storage and email blocks become commented-out optional fallbacks, under the header "Normally set in
    Admin > Settings > Integrations; these lines are only a fallback when nothing is saved there".
  - `DOWNLOAD_LINK_TTL_SECONDS` stays active.
  - The "STORAGE_* needs a deploy" sentences go.
- `scripts/smoke-prod.mjs` `checkWebhooks`:
  - 503 `payments_not_configured` gives the warning "payments are not configured yet (Admin > Settings >
    Integrations)", not a failure.
  - 401 `invalid_signature` still passes.
  - The mock must still answer 404.
- `deploy/restart.sh`: comment only. A `STORAGE_*` change needs a restart, not a deploy; Admin changes need neither.

## 11. Content-Security-Policy

**How it works today**

- Strict pages get their policy from `middleware.ts` (edge runtime). It reads the bucket origin from `process.env`
  once per process.
- Every other page gets `next.config.ts`'s static policy, whose bucket origin `next build` computes.
- The bucket origin must be on every page, because client-side navigation keeps the first document's policy (see
  docs/security.md). Owner decision S4 keeps storefront links into /account and /admin as client navigations.

**Chosen mechanism: Node.js runtime middleware with the cached resolver, covering every page**

- `middleware.ts` exports `config = { runtime: "nodejs", matcher: [...the 12 current patterns, "/((?!api/|_next/).*)"] }`.
  - That covers every page (prerendered, ISR and dynamic) and `/api/dev/*`, but nothing else under `/api` and no
    `/_next` assets.
  - Next 15.5.27 supports `runtime: "nodejs"` without a flag. Verified in `node_modules`:
    `get-page-static-info` reads `config.runtime`; the build writes `functions-config-manifest` `/_middleware`;
    `next-server` `loadNodeMiddleware()` requires `.next/server/middleware.js` inside the server process.
- The middleware becomes `async (req) => Promise<NextResponse>`. Its order:
  1. The `/api/dev` guard (unchanged).
  2. The signed-out redirect (unchanged, no await).
  3. `const uploadOrigin = await uploadOriginForCsp()`.
  4. On a strict route: the nonce policy as today, plus `uploadOrigin`.
  5. On any other page: `NextResponse.next({ request: { headers } })` with
     `res.headers.set("Content-Security-Policy", contentSecurityPolicy({ dev, uploadOrigin }))`. This is the static
     policy: no nonce and no CSP request header.
- `signedInArea` becomes exact: `/account`, `/account/...` and `/account.<ext>`, and the same for `/admin`. With the
  wide matcher, `/accounting` must not redirect.
- `uploadOriginForCsp()` never throws:
  - it calls `getIntegrationSnapshot({ allowStale: true, maxWaitMs: 1000 })`;
  - storage `s3` → `uploadOriginFor(config)`, an exact origin: the endpoint origin for path-style, or
    `<bucket>.<host>` for virtual-hosted. Never a wildcard.
  - local or `none` → null;
  - any error → null, and log `csp_upload_origin_unavailable` at most once a minute.
- `next.config.ts`: `staticCsp` drops `uploadOrigin` and the `storageUploadOrigin` import.
  - Responses that never reach the middleware (API JSON, `_next` assets) get the static policy without a bucket,
    which is narrower.
  - `next build` no longer reads `STORAGE_*`.

**Why the middleware header wins over next.config**

- Next's `resolve-routes` collects `next.config` `headers()` first and the middleware's response headers after them,
  in the same `resHeaders` object.
- The router then calls `res.setHeader` in that order. `setHeader` is case-insensitive, so the middleware value
  replaces the config value.
- Prerendered and ISR pages served from the full-route cache pass through the middleware first, so they also get the
  runtime policy.
- The strict pages already rely on this mechanism (verified in Chrome on 2026-10-07).

**Shared state**

- Node middleware runs in the server process, not in the edge sandbox. Its `globalThis` is the process global.
- The middleware's copy of the resolver therefore sees the same snapshot and invalidation as the route handlers.
- A save shows on the next page load in the same process, and in other PM2 processes within 30 s.

**The storefront stays independent of the database**

- The middleware waits on the database only once per cold process, for at most 1 s, and the instrumentation warm-up
  usually avoids even that.
- While the database is down, it keeps serving the last known origin.
- If no origin is known at all, it sends no bucket origin. That is narrower: uploads fail visibly, and the page still
  renders.

**Limit:** a tab opened before a change keeps its old policy until it reloads. The Settings page reloads itself after a
storage save, clear or remove (section 24); the storage card's help text asks to reload other open tabs.

**Rejected alternatives**

1. Keep the build-time origin: every storage change needs a rebuild, which is the problem this solves.
2. Drop the bucket from the static policy and make every storefront link into /account and /admin a full page load:
   one missed link breaks uploads, and it goes against S4.
3. Wildcard provider domains (`*.r2.cloudflarestorage.com`, `*.amazonaws.com`): forbidden, because any bucket on that
   provider could receive data.
4. Edge middleware asking an internal API for the origin: an extra HTTP hop on every page, and no shared cache (the
   edge sandbox has its own globals).
5. Rendering storefront pages per request to inject the policy: loses prerendering and ISR.

**Fallback if bundling Prisma into the Node middleware fails in the production build** (checked in CORE step C10):

- The middleware reads the snapshot slot on `globalThis` directly and has no database import.
- The resolver module registers `slot.reload` from the route handlers and instrumentation, and the middleware calls it
  when the snapshot is stale.
- The behaviour is the same; only the import graph differs.

**Verification (CORE)**

- The unit tests in section 18.
- A production build, following the `.shots/review-security/build.sh` pattern with its own `NEXT_DIST_DIR`. Restore
  `tsconfig.json` and `next-env.d.ts` if the build rewrites them, and delete the dist directory afterwards.
- `next start`, then check that each of these returns exactly one `Content-Security-Policy`:
  - `curl -sI` on `/` and `/pricing` (prerendered);
  - `/software` (dynamic);
  - `/account` (signed-out redirect);
  - `/sign-in` (strict).
- Then insert a storage row for the check, only if none exists. `connect-src` must hold that exact origin without a
  rebuild, and lose it after the row is deleted by kind.

## 12. SSRF guard

Rules (`lib/security/host-rules.ts`, pure Node):

- **Blocked addresses** (`net.BlockList`):
  - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`,
    `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4` and `240.0.0.0/4` (this includes
    `255.255.255.255`).
  - IPv6: `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `fec0::/10` and `ff00::/8`.
  - IPv4-mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses are checked by their
    embedded IPv4 address.
- **`hostProblem(host, { production })`:**
  - every environment: empty, longer than 253 characters, not a hostname or IP literal, or under `.invalid`;
  - production also: a blocked IP literal, `localhost` or a name under `.localhost`, `.local` or `.internal`, or a
    single-label name (no dot).
- **`endpointProblem(url, { production })`:** an absolute URL with no userinfo, query or fragment, and a path that is
  empty or `/`. It is normalised to its origin. Production also requires https. Then `hostProblem` applies.

Enforcement happens in three places:

1. **Save time (Admin).**
   - Zod, then `hostProblem` / `endpointProblem`.
   - In production, the host is also resolved (`dns.lookup`, all addresses). The save is refused when any address is
     blocked ("This host points to a private network address.") or the name does not exist ("We couldn’t find this
     host.").
   - Other DNS errors do not block the save, because connect time still guards.
   - The service takes an injectable `lookup` and a `production` flag for tests.
   - Messages never echo the address.
2. **Resolve time.** The resolver re-applies the static rules to Admin settings (`admin_invalid`) and to env values
   (`env_invalid`).
3. **Connect time (production only).** This also closes DNS rebinding.
   - S3: the client agents use `guardedLookup()`. It resolves, refuses when any address is blocked, and hands back
     the checked address. It handles both the single-address callback and the `all: true` form that Node uses for
     `autoSelectFamily`. An IP-literal endpoint skips lookup, which is why the static rules refuse blocked literals.
   - SMTP: nodemailer's `getSocket` hook (`smtpSocketGuard`) resolves, checks, runs `net.connect` to the checked IP,
     and returns `{ connection: socket }`.
     - Nodemailer keeps `host` as the name, so SNI and the certificate check still use the hostname. Verified in
       nodemailer 10 `smtp-connection`: `servername` defaults to the non-IP host, and a provided connection is
       upgraded for implicit TLS and STARTTLS.
   - A refused address raises `BlockedAddressError` (`code: "EBLOCKEDADDRESS"`), reported as "Blocked: private network
     address".

In development nothing is blocked, and http endpoints are allowed, so MinIO on 127.0.0.1:9000 and Mailpit on
localhost:1025 keep working. In production, Redis on 127.0.0.1:6380 and every other local service are unreachable
through these features.

## 13. RBAC and rate limits

- `lib/rbac.ts`:
  - New `"integrations.manage": ["OWNER"]` covers save, clear secret, remove and test.
  - Settings stays visible with `settings.manage` (the Owner only today).
  - Any viewer without `integrations.manage` gets the status-only branch: no form, no field values and no secret
    hints. Granting someone Settings later therefore shows them status only.
  - The settings module description becomes: "Company details, tax and invoicing, licensing policy and integrations.
    Secrets are encrypted and never shown in full."
- `lib/admin/staff/model.ts` `PERMISSION_LABELS`:
  - `"settings.manage": "Business settings"`;
  - `"integrations.manage": "Payment, email & storage settings"`.
- `lib/auth/rate-limit.ts` `RATE_LIMITS`:
  - `integrationPassword: (userId) => rule("integration-password:user:<hashedId>", 5, 15 * MINUTE)`. Attempt before
    verifying and clear on success, as `keyReveal` does.
  - `integrationTest: (userId) => rule("integration-test:user:<hashedId>", 10, 10 * MINUTE)`. Attempt before probing;
    never cleared.

## 14. API

Every route uses `adminRoute`: cross-site requests get 403; then `requireStaff`; non-GET methods need CSRF with
session binding and same-origin; responses are `no-store`. Each route is registered in
`lib/admin/routes/staff-audit-settings.ts`. An unknown kind answers 404 before the body is read, so the permission
matrix's dummy segment `perm-test-0000` meets a 404 and nothing is sent or saved.

| Method | Path | Perm | Body | 200 |
|---|---|---|---|---|
| GET | `/api/admin/settings` | settings.manage | — | `AdminSettingsData`, with the new `integrations` shape (below) |
| PUT | `/api/admin/settings/integrations/[kind]` | integrations.manage | save body | `{ integration: IntegrationState }` |
| DELETE | `/api/admin/settings/integrations/[kind]` | integrations.manage | `{ currentPassword }` | `{ integration }`, now env or none |
| DELETE | `/api/admin/settings/integrations/[kind]/secrets/[field]` | integrations.manage | `{ currentPassword }` | `{ integration }` |
| POST | `/api/admin/settings/integrations/[kind]/test` | integrations.manage | `{}` | `ProbeResult` |

`kind` is `payments`, `email` or `storage`. `field` is `keySecret` or `webhookSecret` (payments), `password` (email)
or `secretAccessKey` (storage). Anything else answers 404.

Save bodies are strict objects. An empty or missing secret keeps the stored one. `revision` is the revision the form
loaded, or null when nothing was saved.

```
payments: { currentPassword, revision: number | null, keyId, keySecret?, webhookSecret? }
email:    { currentPassword, revision, host, port, security: "starttls" | "tls", username: string ("" = none),
            password?, fromName, fromAddress }
storage:  { currentPassword, revision, preset: "aws" | "r2" | "spaces" | "other",
            endpoint: string ("" = none; AWS only), region, bucket, accessKeyId, secretAccessKey?, forcePathStyle: boolean }
```

**PUT**, checks in order:

1. Kind → 404.
2. Body schema → 422 with `fieldErrors`.
3. `integrationPassword` attempt → 429.
4. `verifyPassword` against the re-read hash → 422 `incorrect_password`, with `fieldErrors.currentPassword`
   "Incorrect password.".
5. Clear the counter.
6. Host and DNS checks → 422 `fieldErrors`.
7. Transaction (`writeIntegration`): advisory lock; revision check → 409 `integration_changed` "These settings changed
   since you opened the page. Reload and try again."; required secrets present after the merge → 422 "Enter the key
   secret."; encrypt; upsert the config (revision + 1); upsert the secret rows; audit row.
8. Commit, then `invalidateIntegrations()`.
9. Log `integration_saved { kind, fields }`.
10. Return the fresh state.

**DELETE secret:**

1. Kind or field → 404.
2. Password check, as for PUT.
3. Nothing saved in Admin → 409 `integration_not_saved` "Nothing is saved here.". Secret not set → 200, no change, no
   audit.
4. Delete the secret row, add 1 to the revision, write the audit row.
5. Invalidate.

**DELETE integration:**

1. Kind → 404.
2. Password check.
3. No row → 409 `integration_not_saved`.
4. Delete the row (secrets cascade), write the audit row.
5. Invalidate.

**POST test:**

1. Kind → 404.
2. Body `{}` → 422 otherwise.
3. `integrationTest` attempt → 429.
4. Fresh snapshot. Source `none` → 409 `integration_not_configured` "Save the settings first."
5. Probe the effective configuration (Admin or env; the result names the source).
6. Audit row.
7. 200 `ProbeResult`. A failed probe is still 200, with `ok: false`.

Other errors on every route: 401 `unauthorized`; 403 `forbidden` (role, CSRF, cross-site); 503 `unavailable`
(database).

`IntegrationState` (returned by GET and by the mutation routes):

```ts
type SecretHint = { set: boolean; last4: string | null; updatedAt: string | null; updatedBy: string | null };
type IntegrationState = {
  id: "payments" | "email" | "storage";
  title: string; description: string; icon: IconName;
  source: "admin" | "env" | "none";
  development: boolean;            // mock / console / local
  provider: string;                // "Razorpay" | "Mock provider" | "SMTP" | "Console (dev mailbox)" | "S3-compatible bucket" | "Local disk" | "Not set"
  mode: "test" | "live" | null;    // payments
  problem: string | null;          // plain sentence; env NAMES or field labels, never values
  saved: { revision: number; updatedAt: string; updatedBy: string | null } | null;
  envNames: readonly string[];     // the fallback variable names
  form: IntegrationForm | null;    // null without integrations.manage
};
type IntegrationForm =
  | { kind: "payments"; prefilledFrom: "admin" | "env" | "defaults"; values: { keyId: string };
      secrets: { keySecret: SecretHint; webhookSecret: SecretHint }; webhookUrl: string; lastSignedWebhookAt: string | null }
  | { kind: "email"; prefilledFrom: "admin" | "env" | "defaults";
      values: { host: string; port: number; security: "starttls" | "tls"; username: string; fromName: string; fromAddress: string };
      secrets: { password: SecretHint } }
  | { kind: "storage"; prefilledFrom: "admin" | "env" | "defaults";
      values: { preset: StoragePreset; endpoint: string; region: string; bucket: string; accessKeyId: string; forcePathStyle: boolean };
      secrets: { secretAccessKey: SecretHint } };
type RedisState = { id: "redis"; title: string; description: string; icon: IconName;
  status: "configured" | "missing" | "development"; provider: string; note: string; envNames: readonly ["REDIS_URL"] };
// AdminSettingsData.integrations:
type IntegrationsData = { canManage: boolean; items: IntegrationState[]; redis: RedisState };
type ProbeResult = { kind: IntegrationKind; source: "admin" | "env"; ok: boolean; testedAt: string;
  steps: { id: string; label: string; status: "ok" | "failed" | "skipped" | "info"; message: string }[] };
```

Notes on `IntegrationState`:

- Secret hints exist only for secrets saved in Admin. Env secrets are never described beyond what source `env`
  implies.
- When nothing is saved, the form is prefilled with non-secret env values only.
- `webhookUrl` is `${APP_URL}/api/webhooks/payments/razorpay`.
- `lastSignedWebhookAt` is the newest `WebhookDelivery` row with provider `razorpay` and `signatureOk: true`.
- GET and the page read a fresh snapshot.
- `lib/admin/audit/service.ts` `KNOWN_ACTIONS` gains `INTEGRATION_AUDIT_ACTIONS`.

## 15. Audit and logs

Every AuditLog row written by these actions has: actor = the Owner; `targetType` `"settings"`; `targetId`
`"integrations.<kind>"`; `target` "Integrations · <title>". The `detail` holds field LABELS only.

| Action | Detail examples |
|---|---|
| Updated integration settings | "Changed: Key ID, Key secret." A first save: "Saved: Key ID, Key secret, Webhook secret (replaces the server file)." A secret counts as changed whenever a new value was entered. |
| Cleared integration secret | "Cleared: Key secret. Payments are off until a new one is saved." |
| Removed integration settings | "Now using the server file." or "Now not configured." |
| Tested integration | "Test Razorpay keys: accepted." · "Send test email: failed (sign-in rejected)." · "Test bucket: upload ok, read ok, delete ok." |

- No row ever contains an address, host, bucket, key or secret.
- Refused passwords are not audited. They are rate limited and logged as `integration_password_denied { kind, remaining }`.
- `lib/audit.ts` `clean()` does not scrub secrets, so callers pass labels only.
- Log events: `integration_saved`, `integration_secret_cleared`, `integration_removed`, `integration_tested { kind, ok }`,
  `integration_env_ignored`, `integration_secret_unreadable`, `integration_load_failed`,
  `email_dispatch_not_configured`, `webhook_not_configured`, `csp_upload_origin_unavailable`. They carry names, kinds,
  counts and booleans only.
- Errors are summarised by name and code (`sendErrorSummary`, `storageErrorSummary`), never by the message text that
  SMTP, S3 or Razorpay returned.

## 16. Test probes

`lib/integrations/probes.ts`. Each probe builds a one-off client from the effective configuration (never the pooled or
cached one) and disposes of it. Every step has a 10 s timeout; the whole test finishes in under 30 s. Clients are
injectable for tests: `fetch` for Razorpay, a transport factory for email, a driver factory for storage.

**Payments (Razorpay)**

- Step "Keys", from `checkCredentials()`:
  - ok: "Razorpay accepted the keys (test mode)."
  - failed: "Razorpay rejected the Key ID or Key secret."
  - failed: "Couldn’t reach Razorpay. Try again in a minute."
- Step "Webhook secret" (info). It reads the newest signed `razorpay` WebhookDelivery:
  - newer than the secret's `updatedAt`: "Last signed webhook: 8 Oct 2026, 14:02."
  - otherwise: "No signed webhook since this secret was saved. Razorpay sends one with the next payment."
- Mock: one info step, "Mock provider: nothing to test."

**Email**

- It sends to the signed-in Owner's own address (`ctx.staff.email`) with the subject "[Test] Email delivery works".
  The plain-text and HTML body is "This test was sent from Admin > Settings > Integrations on <date>." Templates are
  not involved.
- ok: "Sent to <owner address>. Check that inbox (and spam)."
- Failure messages, by error code:

| Code | Message |
|---|---|
| `EAUTH` / 535 | "The server rejected the username or password." |
| `ECONNECTION` / `ETIMEDOUT` / `EDNS` | "Couldn’t connect to the SMTP host." |
| `ETLS` | "The secure connection failed. Check the port and security setting." |
| `EBLOCKEDADDRESS` | "Blocked: the host points to a private network address." |
| `EENVELOPE` / 5xx | "The server refused the message. Check the From address." |
| anything else | "Couldn’t send the test email." |

- Console transport: "Sent to the dev mailbox (/dev/mailbox)."

**Storage**

- The probe object is `axs-probe/<uuid>.txt`. That is a valid storage key, and the fixed prefix makes any leftover
  easy to recognise. The body is `axs storage probe <iso time>` (text/plain).
- Steps:
  1. "Upload a test file" (`putObject`).
  2. "Read it back" (`head`; the size must match).
  3. "Delete it" (`delete`).
- A failed step skips the steps after it, except "Delete it", which still runs if the upload succeeded.
- Messages:

| Error | Message |
|---|---|
| none | OK |
| 403, AccessDenied, SignatureDoesNotMatch, InvalidAccessKeyId | "Access denied. Check the access key and its bucket permissions." |
| NoSuchBucket | "Bucket not found." |
| network errors | "Couldn’t reach the endpoint." |
| `EBLOCKEDADDRESS` | "Blocked: private network address." |

- Footnote: "Browser uploads also need the bucket’s CORS rule; this test can’t check it."
- The local driver runs the same steps on disk.

## 17. UI

Admin > Settings keeps its grid. The integration cards follow the business-settings cards, using `SettingsCard`,
`SettingsGrid`, `Field`, `Input`, `NativeSelect`, `Switch`, `StatusBadge`, `adminToast` and `apiFetch`.

Components (`components/admin/settings/`):

- `integrations-panel.tsx` (server): one `IntegrationCard` per item, plus `RedisCard` (read-only, with the note).
- `integration-card.tsx` (client) renders `SettingsCard as="form"`:
  - **Header:** icon, title and description, from `SettingsCard`.
  - **Body:**
    - a badge row: the source badge; "Development only" when the driver is a development one; Test mode or Live mode;
    - the problem line (`role="status"`);
    - the fields;
    - read-only facts (the payments webhook URL);
    - the test results.
  - **Footer:**
    - the note: who saved and when, or the source;
    - "Remove saved settings" (source `admin` only, ghost destructive);
    - the test button;
    - Save.
- `secret-field.tsx` (write-only):
  - Stored secret: "Set (ends 1a2b)", "Changed by Asha Rao on 8 Oct 2026", and the buttons Replace and Clear.
  - Replace swaps in an empty input (`type="password"`, `autoComplete="off"` plus the password managers' ignore attributes, `spellCheck={false}`; section 24) with
    Cancel.
  - No stored secret: the input shows directly, marked required when it is.
  - A value is never prefilled, and it is dropped from state after a save.
- `password-dialog.tsx`: an `AlertDialog` in the admin styles of `components/ui/confirm-dialog.tsx`, used for Save,
  Clear and Remove.
  - One password field: `type="password"`, `autoComplete="current-password"`, required.
  - Its error stays in the dialog, tied to the field with `aria-describedby` and `aria-invalid`.
  - Enter submits. Cancel and Escape return focus to the trigger.
- `integration-form-model.ts` (pure): `toDraft(state)`, `dirtyKeys`, client checks with the shared Zod schemas,
  `bodyFor(kind, draft, password, revision)` (an empty secret is omitted, which means keep), and
  `applyPreset(preset, draft)`.

Roles:

- Owner (`canManage`): the forms.
- Others: the same cards read-only, with provider, source, status and mode, plus `READ_ONLY_FOR_ROLE`. No inputs,
  values or hints.

Save flow:

1. Client checks.
2. The password dialog.
3. PUT.
4. On error:
   - 422 field errors appear under their fields, and the first one gets focus;
   - `incorrect_password` stays in the dialog.
5. On success: the state comes from the response, then the toast "<Title> saved", then `router.refresh()`.

Test flow:

- The test button is enabled only when the source is not `none` and the form has no unsaved changes. Otherwise it
  shows the hint "Save your changes first."
- Results replace the previous ones, as a list with an icon and text per step, inside a `role="status"`
  `aria-live="polite"` region.

Storage presets prefill when the preset changes. The values stay editable, and a hint says "Filled in for <preset>.
Check the values."

| Preset | Endpoint | Region | Path-style |
|---|---|---|---|
| AWS S3 | empty (AWS default) | `ap-south-1` | off |
| Cloudflare R2 | empty, with the placeholder `https://<account id>.r2.cloudflarestorage.com` | `auto` | on |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` (follows the region) | `blr1` | off |
| Other S3-compatible | unchanged | unchanged | unchanged |

Email security select: "STARTTLS (port 587)" or "TLS (port 465)". Switching it also changes the port, when the port
still holds the other option's default.

Accessibility:

- Every input is labelled (`Field`), and every error is linked to its field.
- Focus is visible (existing tokens).
- Every action is a button reachable by keyboard. Dialogs trap focus and restore it on close.
- Badges carry text, not colour alone. The existing tokens give 4.5:1 contrast.
- At 360 px the cards are one column, badges and buttons wrap, and nothing scrolls horizontally.

Copy (`INTEGRATIONS_COPY` in `lib/admin/settings/model.ts`; code uses typographic apostrophes like the existing copy):

| Key | Text |
|---|---|
| Section description | Payments, email and file storage. What you save here replaces the server file within 30 seconds. Secrets are encrypted and never shown again. |
| Source badges | Saved in Admin · From the server file · Not configured |
| Development badge | Development only |
| Mode badges | Test mode · Live mode |
| Payments fields | **Key ID** (hint "Starts with rzp_test_ or rzp_live_. Test or live mode follows the key.") · **Key secret** · **Webhook secret** (hint "The secret you set for the webhook in the Razorpay Dashboard.") · **Webhook URL**, read-only (hint "Add it in the Razorpay Dashboard with the events payment.captured, order.paid, payment.failed, refund.processed and refund.failed.") |
| Email fields | **SMTP host** · **Port** · **Security** · **Username** (hint "Leave empty if the server needs no sign-in.") · **Password** · **From name** · **From address** (hint "Use an address on a domain your provider has verified (SPF and DKIM).") |
| Storage fields | **Provider** · **Endpoint** (hint "https only. Leave empty for AWS.") · **Region** · **Bucket** · **Access key ID** · **Secret access key** · **Path-style URLs** (hint "On for Cloudflare R2 and most S3-compatible stores.") · help "This page reloads after a change. Reload other open tabs before uploading." (section 24) |
| Secret field | Set (ends 1a2b) · Set · Changed by <name> on <date> · Replace · Clear · Cancel · "Leave empty to keep the saved value." · "In the server file. Enter it here to save these settings in Admin." · "Not used without a username." |
| Buttons | Save · Test Razorpay keys · Send test email · Test bucket · Remove saved settings |
| Password dialog | Title "Confirm with your password" · body "<Title> changes for everyone within 30 seconds." · label "Your password" · empty error "Enter your password." · buttons Save / Clear / Remove and Cancel |
| Clear dialog body | Required secret: "<Field> is removed. <Integration> stops until you save a new one." Optional secret: "<Field> is removed." |
| Remove dialog body | "The site goes back to the server file. If it has no settings, <integration> stops." |
| Problem: `missing` | Not set up yet. |
| Problem: `admin_incomplete` | <Field> was cleared. Enter a new one to turn this back on. |
| Problem: `admin_invalid` | The saved settings can’t be used here: <fields>. |
| Problem: `admin_unreadable` | Saved secrets can’t be read (the server key changed?). Enter them again. |
| Problem: `env_incomplete` | The server file is missing <NAMES>. |
| Problem: `env_invalid` | The server file has values that can’t work (<NAMES>). Enter the details here. |
| Problem: `unsupported_provider` | The server file selects a provider that isn’t supported. |
| Redis card note | Set on the server: a wrong value here would block every sign-in. |
| Toasts | "<Title> saved" · "No changes to save" · "<Field> cleared" · "Saved settings removed" |
| Checkout notice | Payments aren’t switched on yet, so you can’t place an order right now. |

## 18. Tests

**Unit** (`tests/unit`; `.ts` files only, components rendered with `react-dom/server`):

New files:

- `integration-crypto.test.ts`:
  - the HKDF output is 32 bytes, deterministic, and differs from the input key and from another info label;
  - round trip;
  - two seals of the same value differ (random IV);
  - a wrong input key, a tampered IV, tag or ciphertext, a wrong kind, a wrong field, an unknown version and malformed
    parts all throw the same generic error;
  - the error text never contains the plaintext or the payload;
  - a license-key ciphertext does not open as an integration secret;
  - `secretLast4`: 15 characters → null; 16 → the last 4.
- `host-rules.test.ts` and `net-guard.test.ts`:
  - blocked: 127.0.0.1, 10.1.2.3, 172.16.0.1, 192.168.1.1, 169.254.169.254, 0.0.0.0, 100.64.0.1, ::1, ::, fe80::1,
    fc00::1, ::ffff:127.0.0.1, 64:ff9b::a00:1, 2002:7f00:1::;
  - public: 8.8.8.8, 2606:4700::1111;
  - `hostProblem` and `endpointProblem` in production and in development: the https rule, userinfo, path, `.invalid`,
    `localhost`, single-label names;
  - `guardedLookup` (injected dns) refuses when any address is blocked, in the single and `all` forms, and passes
    public ones;
  - `smtpSocketGuard` refuses a blocked resolution.
- `integration-model.test.ts`: the body schemas (key id format, ports, security, bucket, region, From address, a
  placeholder secret refused, strict objects), the persisted settings schemas, and `razorpayMode`.
- `integration-env-source.test.ts`:
  - development defaults: mock, console, local;
  - production with nothing set → `missing`;
  - complete razorpay, smtp and s3;
  - partial values → `env_incomplete` with the names;
  - the three release-day stand-ins → `env_invalid`;
  - cashfree → `unsupported_provider`;
  - `EMAIL_FROM` parsing;
  - port 465 → tls.
- `integration-resolver.test.ts` (row loader and env injected; fake timers):
  - Admin wins over env;
  - an Admin row that is incomplete, invalid or unreadable → `none`, and env is NOT used even when complete;
  - no row → env;
  - a cache hit within 30 s, a reload after;
  - `invalidateIntegrations()` → immediate reload;
  - a load started before an invalidation is not stored;
  - a failure keeps the last snapshot and backs off for 5 s;
  - `allowStale` returns at once and refreshes in the background;
  - two module instances (`vi.resetModules`) share one snapshot;
  - fingerprints change only when the configuration changes.
- `csp-runtime-origin.test.ts`: `uploadOriginFor` with virtual-hosted, path-style, a dotted bucket, an R2 endpoint, and
  AWS without an endpoint.
- `integration-form-model.test.ts`:
  - draft and body mapping (an empty secret is omitted, which means keep);
  - presets;
  - dirty detection;
  - a static render of a status-only card has no inputs and no "ends" text.

Updated files:

- `env.test.ts`:
  - production parses with none of `PAYMENT_*`, `STORAGE_*`, `EMAIL_*` or `SMTP_*` set;
  - an explicit mock, local or console is still refused in production;
  - placeholders are still refused when present (`PAYMENT_WEBHOOK_SECRET`, `SMTP_PASSWORD` and the rest);
  - the removed conditional rules no longer fail;
  - `EMAIL_FROM` is optional and must parse when set.
- `security-csp.test.ts`:
  - `config.runtime === "nodejs"`;
  - the matcher covers `/`, `/cart`, `/pricing`, `/software/medical-billing`, `/orders`, `/docs/install`, every strict
    path and `/api/dev/x`;
  - it does not cover `/api/v1/licenses/validate`, `/api/auth/sign-in`, `/_next/static/chunks/x.js` or `/_next/image`;
  - the middleware is awaited;
  - a storefront page gets the static policy (no nonce, `'unsafe-inline'`) with the runtime bucket origin, and strict
    pages get it too;
  - after `invalidateIntegrations()` and a different loader result, the next request carries the new origin, without
    reloading modules;
  - no origin when storage is `none`;
  - a throwing loader gives no origin and no exception;
  - `/accounting` and `/administrator` are not redirected;
  - `connect-src` never holds a wildcard host.
- `storage-upload-origin.test.ts` and `security-headers.test.ts`: `next.config`'s static policy has no bucket origin,
  even with `STORAGE_*` set.
- `email-send.test.ts`:
  - `smtpOptions`: tls → secure; starttls → `requireTLS` in production only; `getSocket` in production only;
  - the From object;
  - not configured → `sendAuthEmail` returns `{ ok: false }` and logs the reason.
- `webhook-route.test.ts`: 503 `payments_not_configured` for razorpay when none, 404 otherwise.
- Updated for the new APIs:
  - `razorpay-api.test.ts`, `mock-provider.test.ts`, `checkout-payload.test.ts`, `webhook-mock-delivery.test.ts`;
  - `jobs-maintenance.test.ts`, `downloads-dev-storage.test.ts`, `instrumentation.test.ts`;
  - `admin-settings-model.test.ts` (views: badges, problems, status-only strips the form);
  - `rbac.test.ts` (23 permissions; `integrations.manage` Owner only);
  - `admin-staff-model.test.ts` (labels).

**DB** (`tests/db`). Every test deletes the `IntegrationConfig` rows it created (by kind) and calls
`invalidateIntegrations()` in `afterEach`.

New files:

- `admin-integrations-routes.test.ts`:
  - **Access.** The Owner's GET has forms and hints. ADMIN, SUPPORT, FINANCE, customers and signed-out users get
    403/401 on every new route. Missing CSRF → 403; cross-site → 403.
  - **No secret leaks.** Known secrets, and their ciphertexts, never appear in any response body, AuditLog row or
    captured log output.
  - **Password.** PUT with the right password saves: the ciphertext opens, `last4` is set, revision is 1. A wrong
    password → 422 (`fieldErrors.currentPassword`) and nothing is saved. The 6th wrong try → 429. A success clears the
    counter.
  - **Secrets on save.** An empty secret keeps the stored one; a new value replaces it. A stale revision → 409. A
    first save without a required secret → 422.
  - **Production host rules**, through the service's `production` option and an injected lookup: a private address →
    422; an http endpoint → 422.
  - **Clear and remove.** DELETE secret → `none` (`admin_incomplete`) plus an audit row. DELETE integration → the env
    fallback plus an audit row.
  - **Invalidation.** After a save, the resolver in the same process returns the new configuration immediately.
  - **Test route:**
    - 409 when the integration is `none`;
    - 429 on the 11th call;
    - an audit row "Tested integration" without address or secret;
    - the payments probe with an injected fetch: 200 → accepted, 401 → rejected;
    - the email probe with an injected transport factory: the message goes to the Owner's address;
    - the storage probe with a `LocalStorageDriver` factory: all three steps ok.

- `integrations-not-configured.test.ts`, with the env injected as production-like and empty:
  - checkout order and retry → 503 `payments_unavailable`, with the register bucket untouched and no user created;
  - webhook `razorpay` → 503;
  - reconcile cron skipped;
  - outbox rows fail with the not-configured `lastError`, stay PENDING with backoff, and become FAILED after the 5th
    attempt;
  - `sendAuthEmail` → `{ ok: false }`; the template test → 409;
  - upload create, upload confirm, download and installer confirm → 503;
  - maintenance skips the uploads task;
  - with no row and the dev env, the env fallback gives mock, console and local.

Updated files:

- `admin-settings-routes.test.ts`: the new `integrations` shape; no env leaks.
- `admin-context.test.ts`: `testMode` from the resolver.
- `admin-permissions.test.ts`: the registry entries.
- `reconcile-orders.test.ts`: the summary type.
- `admin-refund-flow.test.ts` and `admin-refund-failures.test.ts`: `provider_key_changed`.
- `checkout-payment-flow.test.ts`: reopen with `providerKeyId`.
- `email-outbox.test.ts`: the not-configured case.
- `admin-templates-service.test.ts`: 409.

**E2E**

- `tests/e2e/global-setup.ts` fails fast when `IntegrationConfig` rows exist: "e2e expects the development drivers;
  remove saved integrations in Admin > Settings".
- `admin-integrations.spec.ts` is non-mutating, because a saved storage or email configuration would change the dev
  drivers under parallel specs. It checks:
  - the Owner sees the cards at 360 px and on desktop, with no horizontal scroll;
  - keyboard through Replace and the password dialog: a wrong password shows the error; Escape restores focus;
  - status-only rendering is covered by unit tests.
- The save → CSP path is covered by the DB tests, the middleware unit tests and the production-build check (section 11).
- `scripts/check-a11y.mjs` covers `/admin/settings`.

## 19. Docs to update

- `docs/decisions.md`:
  - Add a dated entry, "Admin-configurable integrations (owner decision, 2026-10-08)": precedence, encryption, the
    permission, the CSP mechanism with the rejected options, the stand-ins, and `providerKeyId`.
  - Mark as superseded: the Phase 5 build-time `STORAGE_*` note, the Phase 6 "integrations from env" lines, and the
    Phase 7 static CSP origin.
- `docs/security.md`:
  - Secrets: two homes (the env file, and encrypted `IntegrationSecret`); the key derivation; who can change what;
    fail-closed behaviour; `LICENSE_KEY_ENC_KEY` now also protects the integration secrets.
  - A threat-table row: an Owner account takeover could redirect payments and email. Mitigations: password
    re-entry, rate limits, the audit log, and two-step sign-in recommended for the Owner.
  - The CSP section: the middleware on every page, the runtime origin, the Node runtime, the limits.
  - The SSRF guard.
  - Remove the "a change needs a deploy, like the STORAGE_* values" line.
- `docs/api.md`:
  - the new routes with their request and response shapes;
  - the error codes `payments_unavailable`, `payments_not_configured`, `integration_changed`, `integration_not_saved`,
    `integration_not_configured`, `email_not_configured`, `provider_key_changed`, and `incorrect_password` with
    `currentPassword`;
  - the permission table;
  - the webhook section (503 when not configured);
  - the settings response shape.
- `docs/architecture.md`: the integrations resolver; Node.js middleware instead of "Edge middleware"; configuration
  (no build-time `STORAGE_*`); admin modules.
- `deploy/.env.production.example` (section 10).
- `deploy/README.md`:
  - webhook step: the secret goes into Admin;
  - rotation table: rotating payment, SMTP or storage credentials means saving in Admin, with no restart;
  - what stays in the env file.
- `docs/deploy-today.md`:
  - 0.4–0.6 and 4.2 become Admin steps;
  - section 8: replace the `grep PAYMENT_WEBHOOK_SECRET` step;
  - sections 9 and 12.1: update the `STORAGE_*` and CSP lines.
- `docs/go-live-checklist.md`: live keys go into Admin; the `rzp_test` check becomes the Admin Live mode badge;
  removing the stand-ins; the installer upload check.
- `README.md`: the development drivers; `next build` no longer fixes the bucket origin.
- `.env.example`: comment update.
- `deploy/restart.sh`: comment update.
- Not `docs/server-runbook.md`. The lead updates it; it still lists the stand-ins.

## 20. Order of work

**CORE** (server side). The app keeps working with an env-only configuration after every step.

| Step | Work |
|---|---|
| C1 | Schema, migration, `prisma generate` |
| C2 | `crypto` and its tests |
| C3 | `host-rules` and `net-guard`, with tests |
| C4 | `model` (schemas, presets, audit action names) and `lib/email/address.ts`, with tests |
| C5 | `lib/env.ts` relaxation and `env-source`, with tests (`env.test.ts`) |
| C6 | `store` (read and write primitives), the resolver, `tests/unit/setup.ts`, the instrumentation warm-up, with tests |
| C7 | Payments consumers (incl. checkout `paymentsAvailable` and `providerKeyId`), with tests |
| C8 | Email consumers, with tests |
| C9 | Storage consumers, with tests |
| C10 | CSP: `upload-origin`, `csp-origin`, the middleware (Node runtime, matcher, async, `signedInArea`), `next.config.ts`, with tests; then the production build check (section 11) |
| C11 | Probes, with tests (injected clients) |
| C12 | `deploy/preflight.mjs`, `scripts/gen-prod-env.mjs` and `deploy/.env.production.example` (they change together), `scripts/smoke-prod.mjs`, the `deploy/restart.sh` comment |

Checkpoint: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:db`; the production build; the `next start`
curl checks.

**ADMIN** (API routes, UI, their tests, docs):

| Step | Work |
|---|---|
| A1 | `integrations.manage`, the permission labels, the rate-limit rules, with tests |
| A2 | `lib/admin/settings/integrations.ts` (views), `integration-actions.ts` (password, audit, invalidate), the `getAdminSettings` change, `KNOWN_ACTIONS` |
| A3 | Routes and registry entries |
| A4 | UI components, copy, the checkout notice |
| A5 | DB tests, unit tests, the e2e spec, the a11y check |
| A6 | Docs (section 19) |

Checkpoint: the same commands, plus the Playwright admin settings spec at 360 px.

## 21. Open points and residual risks

- **Who sees Settings.** Still the Owner only (`settings.manage`). If Administrators should see the integration status,
  change the module's `viewPerm` to a new `settings.view`; the status-only rendering already exists.
- **Delays.** Other PM2 processes pick up a change within 30 s. Open tabs keep their CSP until they reload.
- **Owner account takeover.** An attacker could redirect payments and email. Mitigations: password re-entry, rate
  limits, the audit log, and two-step sign-in for the Owner (recommended once email works). A possible follow-up: an
  "integration changed" email to every Owner.
- **Changing the webhook secret.** Razorpay retries signed with the old secret get 401 until the Dashboard has the new
  one. Change both together.
- **Switching Razorpay accounts or modes.** Unpaid attempts made with the old keys start fresh. Captured payments made
  with other keys must be refunded in the Razorpay Dashboard (409 `provider_key_changed`).

## 22. CORE implementation notes (2026-10-08)

CORE steps C1 to C12 are implemented as designed. Where the code differs, this is why.

**Deviations**

| Where | Change | Reason |
|---|---|---|
| `lib/placeholders.ts` | `isPlaceholder()` moved here; `lib/env.ts` re-exports it. | `model.ts` is client-safe. Importing `lib/env.ts` would pull `node:crypto` into the browser bundle. |
| `lib/integrations/slot.ts` | The globalThis cache slot and `invalidateIntegrations()` live in a dependency-free module; the resolver re-exports them. | `tests/unit/setup.ts` installs the empty row loader without loading `lib/env`, `lib/db` or `lib/log`. Otherwise a test file's `vi.mock("@/lib/env")` came too late. |
| `resolver.ts` | Adds `setIntegrationKeyForTests(ikm)`. | Unit tests decrypt rows without a full `LICENSE_*` environment. |
| `resolver.ts` | A failed reload answers the caller with the last good snapshot (unless a save invalidated it). The error propagates only when there is no snapshot. | Section 7 says a failure "keeps the last good snapshot". This also covers the caller of the failed load. |
| `lib/payments/index.ts` | `PAYMENTS_UNAVAILABLE_MESSAGE` lives here; `payment-attempt.ts` re-exports it. | Refunds use it too. |
| `getPaymentProvider("mock")` | Accepts only `"mock"`. `createPaymentProvider(config, { fetch, baseUrl, timeoutMs })` takes injectable client options. | The probe needs the injected fetch. |
| `StorageConfig` | Carries `preset` (Admin only, display). | Not used for connections. |
| `middleware.ts` | On static pages it deletes any client-sent `content-security-policy` and `x-nonce` request headers. | Previously those pages never reached the middleware. Now they do, and nothing may hand the renderer a forged nonce. |
| `host-rules.ts` | Production also refuses names whose last label is numeric or hex (`127.1`, `0x7f.1`). | The system resolver turns these IPv4 shorthands into addresses. They are refused statically, not only at connect time. |
| `lib/jobs/tasks.ts` | The stale-upload existence check binds its `LIMIT` (`${1}::int`). | Same statement shape as the others. |
| Email and storage drivers | A replaced pooled SMTP transport or S3 client is closed 60 s later, not at once. | Sends and requests in flight on the old client can finish. |
| Checkout notice | Implemented in CORE: `paymentsAvailable` reaches `CheckoutView`, which shows `CHECKOUT_COPY.paymentsOff` and disables Pay. | It is part of the not-configured behaviour. ADMIN may restyle it. |
| `lib/admin/settings/integrations.ts` | Minimal bridge `integrationStatuses(snapshot, env)`: the existing read-only cards now follow the resolver (source note, mode, stand-ins as "Not configured"). | Keeps Admin truthful until A2 replaces it with the full `IntegrationState` views. |

**Verified**

- Production build with no `PAYMENT_*`, `STORAGE_*`, `EMAIL_*` or `SMTP_*` variables succeeded.
  - `functions-config-manifest` lists `/_middleware` with `runtime: "nodejs"` and the 13 matchers.
  - Prisma bundled into the middleware without the fallback.
- `next start` results:
  - `/`, `/pricing`, `/software`, `/account` (307), `/sign-in`, `/checkout`, `/accounting` and `/api/health` each sent exactly one `Content-Security-Policy`.
  - Checkout received `paymentsAvailable: false`.
  - The Razorpay webhook answered 503 `payments_not_configured` with `Retry-After: 300`.
  - A STORAGE row inserted into the dev database appeared as the exact origin `https://axs-csp-check.acc123.r2.cloudflarestorage.com` in `connect-src` within 31 s (no rebuild). That covered static, ISR, dynamic, strict and Razorpay pages.
  - After the row was deleted by kind, the origin was gone.
- The release-day stand-ins classify as `env_invalid` under `node --import tsx` (the preflight path).

**For the ADMIN steps**

- Store primitives: `lib/integrations/store.ts` (`writeIntegration`, `clearIntegrationSecret`, `deleteIntegration`, `loadIntegrationRows`).
- Schemas and helpers: `lib/integrations/model.ts` (`INTEGRATION_SAVE_SCHEMAS`, `splitSaveBody`, `passwordConfirmSchema`, `probeBodySchema`, `FIELD_LABELS`, `INTEGRATION_AUDIT_ACTIONS`, presets).
- Probes: `lib/integrations/probes.ts` (`probePayments` with `webhookSecretUpdatedAt` from `snapshot.admin.payments.secrets.webhookSecret.updatedAt`; `probeEmail` with `to` set to the Owner's address; `probeStorage`).
- Save-time DNS check: `lib/security/net-guard.ts` `resolvePublicHost()`, plus `host-rules.ts` `hostProblem()` and `endpointProblem()`.
- Status views: `getIntegrationSnapshot({ fresh: true })`, which exposes `admin` and `env` (prefill, names set).
- Not built yet: the routes, the permission, the rate-limit rules, the audit rows and `KNOWN_ACTIONS`.

## 23. ADMIN implementation notes (2026-10-08)

ADMIN steps A1 to A6 are implemented as designed. Where the code differs, this is why.

| Where | Change | Reason |
|---|---|---|
| `lib/admin/settings/integrations-model.ts` | The `IntegrationState` shapes, `INTEGRATIONS_COPY`, the problem lines and the dialog and audit wording live here (client-safe); `lib/admin/settings/model.ts` re-exports `INTEGRATIONS_COPY`, `IntegrationsData` and `IntegrationState`. | Keeps the business-settings model small; both the server views and the client forms import it. |
| PUT response | `{ integration, changed }` (field keys). DELETE secret answers `{ integration, cleared }`. | The form shows "No changes to save" when nothing differed; a clear of a secret that was not set is visible. |
| `lib/integrations/resolver.ts` | New `envFallback(kind)`: whether the env file alone configures the kind (verdict and NAMES only). | Audit wording ("Now using the server file." / "Now not configured.", "(replaces the server file)") is written inside the transaction, before the cache reloads. |
| `lib/admin/settings/integration-actions.ts` | `setIntegrationProbeClientsForTests()`; services take `production`, `lookup`, `ikm` and `env` options. | Route-level DB tests inject one-off clients; the production host rules are tested without a production build. |
| Test audit detail | " Used the server file." is appended when the probe ran on the env configuration. | The audit row names the source without naming a value. |
| Env prefill | A host or endpoint that the host rules refuse (the release-day stand-ins under `.invalid`) is left out of the Owner's form; an R2 region (`auto`) then selects the R2 preset. When the env fallback is `env_invalid` as a whole, only preset, region, path style, port, security and the sender are kept (fix pass, section 24). | The Owner starts from an empty field instead of a stand-in. |
| `components/admin/settings/settings-card.tsx` | `headingLevel` (2 or 3). | The integration cards are h3 under the new "Integrations" h2 of the Settings page. |
| UI files | `integrations-panel.tsx` (server: section, status-only card, rate-limits card), `integration-card.tsx` (client form), `integration-parts.tsx` (server-safe badges, problem line, facts, test steps), `secret-field.tsx`, `password-dialog.tsx`, `integration-form-model.ts`. | As designed, plus the shared parts file. |
| Unit tests of the status-only card | `statusFacts()` plus a source check of `IntegrationStatusCard` (no inputs, values or hints). | Unit tests cannot import `.tsx` (tsconfig `jsx: preserve`), as in `tests/unit/admin-ui-fixes.test.ts`. |
| E2E spec | `tests/e2e/admin-integrations.spec.ts` drives the password dialog from the email card (a wrong password, nothing saved). Replace needs a saved secret, which this non-mutating spec never creates; Replace is covered by the component's source check and the DB tests of keep and replace. | Non-mutating by design (section 18). |
| `scripts/check-a11y.mjs` | The admin scenario also signs in the seeded staff Owner and checks Settings > Integrations at 1280 and 360 px plus the password dialog. | The demo Administrator only sees the locked Settings page. |

Checked: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:db` (new: `tests/db/admin-integrations-routes.test.ts`,
`tests/unit/integration-form-model.test.ts`; updated: `admin-settings-model`, `rbac`, `admin-staff-model`,
`rate-limit-rules`, `admin-settings-routes`).

## 24. Review fixes (2026-10-08)

| Where | Change | Reason |
|---|---|---|
| `lib/integrations/model.ts` `DESTINATION_FIELDS`, `lib/integrations/store.ts` | A save that changes the SMTP host, port or security, or the storage endpoint, must enter every saved secret of the kind again (422 per field, "Enter it again: ..."); an unreadable saved row counts as changed. The form opens those secrets for entry and checks it first. | Otherwise the Owner's session and password were enough to point email at another server, keep the stored password and read it out with "Send test email". |
| `components/admin/settings/secret-field.tsx` | `autocomplete="off"` plus `data-1p-ignore`, `data-lpignore`, `data-bwignore`, `data-form-type="other"` (was `new-password`). | Browsers offered to save or generate these as site passwords. |
| `components/admin/settings/integration-card.tsx` | A storage save, clear or remove reloads the page (success toast handed over in sessionStorage); a repeated test empties the live region first; the test result shows when it ran and "Step: message". | The CSP of an open page kept the old bucket, so the first upload after saving the bucket failed. |
| `lib/admin/settings/integrations.ts` | With an `env_invalid` fallback only preset, region, path style, port, security and the sender are prefilled. | The stand-ins "pending", "axiomatic-files-pending" and "pending-r2" showed as real values. |
| `lib/integrations/env-source.ts` | Production without a selector but with other variables of the kind: `env_incomplete` naming the selector. | Those values were ignored with no warning. |
| `lib/payments/key-scope.ts`, `reconcile.ts`, `lib/admin/orders/refund.ts` | Reconcile and refunds reach other Razorpay key ids of the same mode; "not found" for such a payment is 409 `provider_key_changed` in refunds. | A key regeneration (same account, new Key ID) stopped reconcile and refunds for earlier payments. |
| `prisma/seed-data/bootstrap.ts` | The test-mode notice only with an explicit mock provider or `rzp_test_` key. | Unset meant "test mode" although live keys may be saved in Admin later. |
| Copy and docs | "within 30 seconds" in the section and the dialog; the env variable names show on cards that use the server file; the audit sentence in api.md, decisions.md and section 1 now says that no-op saves and clears write no row; `.env.production.example` and the preflight header say CHANGE-ME still fails. | They disagreed with the code. |
