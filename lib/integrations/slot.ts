/**
 * The process-wide state of the integration resolver (lib/integrations/resolver.ts), kept on globalThis under
 * Symbol.for("axs.integrations.v1"): Next.js bundles route handlers, instrumentation and the middleware as separate
 * module graphs in one server process, and every copy must see the same snapshot and the same invalidation (the
 * precedents are lib/auth/rate-limit.ts STORE_SLOT and lib/db.ts __axsPrisma).
 *
 * Dependency-free on purpose (type imports only), so tests/unit/setup.ts can install the test loader without loading
 * lib/env, lib/db or lib/log before a test file mocks them.
 */
import type { IntegrationEnvInput } from "./env-source";
import type { IntegrationRow, IntegrationSnapshot } from "./types";

export type RowsLoader = () => Promise<IntegrationRow[]>;
export type Inflight = { generation: number; promise: Promise<IntegrationSnapshot> };

export type IntegrationSlot = {
  snapshot: IntegrationSnapshot | null;
  /** +1 on every invalidation; a load started under an older generation is never stored. */
  generation: number;
  inflight: Inflight | null;
  failedAt: number;
  lastError: unknown;
  lastFailureLogAt: number;
  /** Tests: replaces the IntegrationConfig loader (null = the database). */
  loader: RowsLoader | null;
  /** Tests: replaces process.env as the env-fallback source. */
  envOverride: IntegrationEnvInput | null;
  /** Tests: replaces LICENSE_KEY_ENC_KEY as the input key material. */
  ikmOverride: Buffer | null;
  /** Once-per-process log keys (names and reasons only). */
  logged: Set<string>;
};

const SLOT = Symbol.for("axs.integrations.v1");

export function integrationSlot(): IntegrationSlot {
  const holder = globalThis as typeof globalThis & { [SLOT]?: IntegrationSlot };
  holder[SLOT] ??= {
    snapshot: null,
    generation: 0,
    inflight: null,
    failedAt: 0,
    lastError: null,
    lastFailureLogAt: 0,
    loader: null,
    envOverride: null,
    ikmOverride: null,
    logged: new Set(),
  };
  return holder[SLOT];
}

/** Drops the cached snapshot in this process at once (call right after the transaction that saved commits). */
export function invalidateIntegrations(): void {
  const s = integrationSlot();
  s.generation += 1;
  s.snapshot = null;
  s.failedAt = 0;
  s.lastError = null;
}
