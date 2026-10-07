import { describe, expect, it } from "vitest";
import { DEFAULT_POOL_SETTINGS, parseDatabaseUrl, poolSettingsFromEnv } from "@/lib/db";

describe("parseDatabaseUrl", () => {
  it("moves ?schema= into the adapter schema and the session search_path", () => {
    const r = parseDatabaseUrl("postgresql://u:p@localhost:5432/axiomatic_test?schema=test_123_abc");
    expect(r.schema).toBe("test_123_abc");
    expect(r.options).toBe('-c search_path="test_123_abc"');
    expect(r.connectionString).toBe("postgresql://u:p@localhost:5432/axiomatic_test");
  });

  it("keeps mixed-case schema names quoted", () => {
    expect(parseDatabaseUrl("postgresql://h/db?schema=Test_X").options).toBe('-c search_path="Test_X"');
  });

  it("leaves URLs without a schema untouched", () => {
    const r = parseDatabaseUrl("postgresql://u@h:5432/db?sslmode=require");
    expect(r).toEqual({ connectionString: "postgresql://u@h:5432/db?sslmode=require", options: undefined, schema: undefined });
  });

  it("treats an empty schema as absent", () => {
    expect(parseDatabaseUrl("postgresql://h/db?schema=").schema).toBeUndefined();
  });

  it("combines an existing options parameter with the search_path", () => {
    const r = parseDatabaseUrl("postgresql://h/db?schema=public&options=-c%20statement_timeout%3D5000");
    expect(r.options).toBe('-c statement_timeout=5000 -c search_path="public"');
  });

  it("rejects schema names that are not plain identifiers", () => {
    expect(() => parseDatabaseUrl('postgresql://h/db?schema=x"%20-c%20y')).toThrow(/plain identifier/);
    expect(() => parseDatabaseUrl("postgresql://h/db?schema=1abc")).toThrow(/plain identifier/);
  });
});

describe("poolSettingsFromEnv", () => {
  it("bounds the pool wait and statements by default (pg-pool alone waits forever)", () => {
    expect(poolSettingsFromEnv({})).toEqual({ max: 10, connectionTimeoutMillis: 5_000, statementTimeoutMs: 5_000 });
    expect(DEFAULT_POOL_SETTINGS.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it("reads DATABASE_POOL_MAX, DATABASE_POOL_TIMEOUT_MS and DATABASE_STATEMENT_TIMEOUT_MS (0 = server setting)", () => {
    expect(
      poolSettingsFromEnv({ DATABASE_POOL_MAX: "25", DATABASE_POOL_TIMEOUT_MS: " 3000 ", DATABASE_STATEMENT_TIMEOUT_MS: "0" }),
    ).toEqual({ max: 25, connectionTimeoutMillis: 3_000, statementTimeoutMs: 0 });
    expect(poolSettingsFromEnv({ DATABASE_POOL_MAX: "" }).max).toBe(10);
  });

  it("refuses values outside the documented ranges", () => {
    expect(() => poolSettingsFromEnv({ DATABASE_POOL_MAX: "0" })).toThrow(/DATABASE_POOL_MAX must be a whole number from 1 to 200/);
    expect(() => poolSettingsFromEnv({ DATABASE_POOL_TIMEOUT_MS: "50" })).toThrow(/DATABASE_POOL_TIMEOUT_MS/);
    expect(() => poolSettingsFromEnv({ DATABASE_STATEMENT_TIMEOUT_MS: "1.5" })).toThrow(/DATABASE_STATEMENT_TIMEOUT_MS/);
    expect(() => poolSettingsFromEnv({ DATABASE_POOL_MAX: "ten" })).toThrow(/DATABASE_POOL_MAX/);
  });
});
