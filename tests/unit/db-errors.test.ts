import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { databaseUnavailableReason, isTransientDatabaseError, isTransientSqlState, isUnavailableSqlState } from "@/lib/db-errors";

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`test ${code}`, { code, clientVersion: "test", ...(meta ? { meta } : {}) });
const adapter = (kind: string, originalCode?: string) => ({ driverAdapterError: { cause: { kind, ...(originalCode ? { originalCode } : {}) } } });

describe("isTransientDatabaseError", () => {
  it("retries timeouts, deadlocks, lost connections and exhausted pools", () => {
    for (const code of ["P1001", "P1002", "P1008", "P1017", "P1018", "P2024", "P2028", "P2034", "P2037"]) {
      expect(isTransientDatabaseError(known(code))).toBe(true);
    }
    expect(isTransientDatabaseError(known("P2010", adapter("postgres", "40P01")))).toBe(true);
    expect(isTransientDatabaseError(known("P2039", adapter("postgres", "57014")))).toBe(true);
    expect(isTransientDatabaseError(known("P2039", adapter("postgres", "55P03")))).toBe(true);
    expect(isTransientDatabaseError(known("P2010", adapter("ConnectionClosed")))).toBe(true);
    expect(isTransientDatabaseError(new Prisma.PrismaClientUnknownRequestError("x", { clientVersion: "test" }))).toBe(true);
    expect(isTransientDatabaseError(new Prisma.PrismaClientInitializationError("x", "test"))).toBe(true);
  });

  it("does not retry problems with the data or the code", () => {
    for (const error of [
      known("P2002"),
      known("P2025"),
      known("P2010", adapter("postgres", "23514")),
      known("P2039", adapter("UniqueConstraintViolation", "23505")),
      new Error("boom"),
      new TypeError("x is undefined"),
      "string",
      null,
    ]) {
      expect(isTransientDatabaseError(error)).toBe(false);
    }
  });

  it("knows the transient SQLSTATE classes", () => {
    for (const code of ["08006", "40001", "40P01", "53300", "57014", "57P01", "55P03"]) expect(isTransientSqlState(code)).toBe(true);
    for (const code of ["23505", "22001", "42P01", "55000", "", undefined, 40001]) expect(isTransientSqlState(code)).toBe(false);
  });
});

describe("databaseUnavailableReason", () => {
  it("recognises pool waits, statement timeouts and lost connections (the shapes Prisma 7 + adapter-pg produce)", () => {
    // pg-pool errors reach the caller as plain Errors (checked against the real adapter in tests/db/db-unavailable).
    expect(databaseUnavailableReason(new Error("timeout exceeded when trying to connect"))).toBe("pool_timeout");
    expect(databaseUnavailableReason(new Error("Connection terminated due to connection timeout"))).toBe("connection");
    expect(databaseUnavailableReason(new Error("Connection terminated unexpectedly"))).toBe("connection");
    expect(databaseUnavailableReason(known("P2010", adapter("postgres", "57014")))).toBe("statement_timeout");
    expect(databaseUnavailableReason(known("P2039", adapter("postgres", "57014")))).toBe("statement_timeout");
    expect(databaseUnavailableReason(known("P2024"))).toBe("pool_timeout");
    expect(databaseUnavailableReason(known("P2037"))).toBe("busy");
    expect(databaseUnavailableReason(known("P2010", adapter("postgres", "55P03")))).toBe("busy");
    expect(databaseUnavailableReason(known("P2010", adapter("postgres", "53300")))).toBe("busy");
    expect(databaseUnavailableReason(known("P1001"))).toBe("connection");
    expect(databaseUnavailableReason(known("P2010", adapter("DatabaseNotReachable")))).toBe("connection");
    expect(databaseUnavailableReason(known("P2010", adapter("postgres", "57P01")))).toBe("connection");
    expect(databaseUnavailableReason(known("P2010", adapter("postgres", "08006")))).toBe("connection");
    expect(databaseUnavailableReason(new Prisma.PrismaClientInitializationError("x", "test"))).toBe("connection");
  });

  it("leaves data problems, deadlocks and ordinary errors alone (they stay 409/500)", () => {
    for (const error of [
      known("P2002"),
      known("P2025"),
      known("P2034"),
      known("P2010", adapter("postgres", "40P01")),
      known("P2010", adapter("postgres", "23505")),
      new Error("timeout exceeded when trying to connect to the payment provider"),
      new TypeError("Connection terminated unexpectedly"),
      new Prisma.PrismaClientUnknownRequestError("x", { clientVersion: "test" }),
      "timeout exceeded when trying to connect",
      null,
      undefined,
    ]) {
      expect(databaseUnavailableReason(error)).toBeNull();
    }
  });

  it("knows the unavailable SQLSTATEs", () => {
    for (const code of ["08000", "08006", "53300", "57014", "57P01", "57P02", "57P03", "55P03"]) expect(isUnavailableSqlState(code)).toBe(true);
    for (const code of ["40001", "40P01", "23505", "57P04", "53100", "", undefined]) expect(isUnavailableSqlState(code)).toBe(false);
  });
});
