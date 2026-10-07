/**
 * Database errors that say nothing about the data: the same work can succeed when it is retried (a transaction that
 * timed out waiting for a lock, a deadlock or serialization failure, a lost or refused connection, an exhausted pool,
 * a statement timeout). Payment fulfilment rethrows these instead of sending a paid order to REVIEW, so the
 * provider's redelivery or reconciliation applies the event later.
 *
 * With the node-postgres driver adapter (Prisma 7), model queries map known driver failures to P1xxx/P2034/P2037 and
 * report other Postgres errors as P2039, raw queries as P2010; both keep the driver error in
 * `meta.driverAdapterError.cause` (`kind`, `originalCode` = SQLSTATE).
 */
import { Prisma } from "@/generated/prisma/client";

/** P1001 unreachable, P1002 timed out, P1008 operation timed out, P1017 connection closed, P1018 transaction already
 * closed, P2024 connection pool timeout, P2028 transaction API error (expired interactive transaction), P2034 write
 * conflict or deadlock, P2037 too many connections. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["P1001", "P1002", "P1008", "P1017", "P1018", "P2024", "P2028", "P2034", "P2037"]);

const TRANSIENT_ADAPTER_KINDS: ReadonlySet<string> = new Set([
  "TransactionWriteConflict",
  "TransactionAlreadyClosed",
  "ConnectionClosed",
  "SocketTimeout",
  "DatabaseNotReachable",
  "TooManyConnections",
  "TlsConnectionError",
]);

/** SQLSTATE classes 08 (connection), 40 (serialization failure, deadlock), 53 (insufficient resources), 57 (statement
 * timeout, shutdown), and 55P03 (lock not available). */
export function isTransientSqlState(code: unknown): boolean {
  return typeof code === "string" && (/^(08|40|53|57)[0-9A-Z]{3}$/.test(code) || code === "55P03");
}

function adapterCause(meta: unknown): { kind?: unknown; originalCode?: unknown } | null {
  if (!meta || typeof meta !== "object") return null;
  const adapterError = (meta as Record<string, unknown>).driverAdapterError;
  if (!adapterError || typeof adapterError !== "object") return null;
  const cause = (adapterError as { cause?: unknown }).cause;
  return cause && typeof cause === "object" ? (cause as { kind?: unknown; originalCode?: unknown }) : null;
}

/** True when `error` is database infrastructure trouble worth retrying rather than a problem with the data. */
export function isTransientDatabaseError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientUnknownRequestError
  ) {
    return true;
  }
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (TRANSIENT_CODES.has(error.code)) return true;
  const cause = adapterCause(error.meta);
  if (!cause) return false;
  return (typeof cause.kind === "string" && TRANSIENT_ADAPTER_KINDS.has(cause.kind)) || isTransientSqlState(cause.originalCode);
}

// ---------- Database unavailable (503) ----------

/** Prisma codes meaning the database could not be reached or answered in time: unreachable, timed out, closed,
 * pool timeout, too many connections. */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2037"]);
const UNAVAILABLE_ADAPTER_KINDS: ReadonlySet<string> = new Set([
  "DatabaseNotReachable",
  "SocketTimeout",
  "ConnectionClosed",
  "TooManyConnections",
]);
/** pg-pool and pg errors raised before any SQL ran; Prisma passes them through unchanged as plain Errors. */
const POOL_ERROR_MESSAGES: readonly RegExp[] = [
  /^timeout exceeded when trying to connect$/i,
  /^Connection terminated due to connection timeout$/i,
  /^Connection terminated unexpectedly$/i,
];

/** SQLSTATE that says the server is busy or going away, not that the request is wrong: 08xxx connection exceptions,
 * 53300 too many connections, 57014 query canceled (statement_timeout), 57P01-57P03 shutdown / cannot connect now,
 * 55P03 lock not available (lock_timeout). Deadlocks and serialization failures (class 40) are not included. */
export function isUnavailableSqlState(code: unknown): boolean {
  return typeof code === "string" && (/^08[0-9A-Z]{3}$/.test(code) || /^(53300|57014|57P0[1-3]|55P03)$/.test(code));
}

/** pool_timeout: no pooled connection in time; statement_timeout: 57014; busy: too many connections or a lock timeout;
 * connection: unreachable, refused, closed or shutting down. */
export type DatabaseUnavailableReason = "pool_timeout" | "statement_timeout" | "busy" | "connection";

/**
 * Why `error` means "the database is unavailable right now" (pool exhausted, statement timeout, connection lost or
 * refused), or null for anything else. errorResponse() turns these into 503 `unavailable` with Retry-After instead of
 * a 500, so device apps and browsers back off (docs/scaling.md "Horizontal scaling": load shedding). Structural checks
 * (error names and codes, not instanceof), so errors from another copy of the Prisma runtime are recognised too.
 */
export function databaseUnavailableReason(error: unknown): DatabaseUnavailableReason | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { name?: unknown; message?: unknown; code?: unknown; meta?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  if (e.name === "Error" || e.name === undefined) {
    if (POOL_ERROR_MESSAGES[0]?.test(message)) return "pool_timeout";
    if (POOL_ERROR_MESSAGES.some((re) => re.test(message))) return "connection";
    return null;
  }
  if (e.name === "PrismaClientInitializationError") return "connection";
  if (e.name !== "PrismaClientKnownRequestError") return null;
  if (e.code === "P2024") return "pool_timeout";
  const cause = adapterCause(e.meta);
  const sqlState = cause?.originalCode;
  if (sqlState === "57014") return "statement_timeout";
  if (e.code === "P2037" || sqlState === "53300" || sqlState === "55P03") return "busy";
  if (typeof e.code === "string" && UNAVAILABLE_CODES.has(e.code)) return "connection";
  if (typeof cause?.kind === "string" && UNAVAILABLE_ADAPTER_KINDS.has(cause.kind)) return "connection";
  return isUnavailableSqlState(sqlState) ? "connection" : null;
}
