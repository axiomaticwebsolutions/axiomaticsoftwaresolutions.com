import { describe, expect, it } from "vitest";
import { isCronAuthorized } from "@/lib/auth/cron";

const SECRET = "cron-secret-for-tests-0123456789abcdef";
const req = (authorization?: string) => ({ headers: new Headers(authorization === undefined ? {} : { authorization }) });

describe("cron bearer auth", () => {
  it("accepts exactly `Bearer <CRON_SECRET>` (scheme case-insensitive, surrounding blanks allowed)", () => {
    expect(isCronAuthorized(req(`Bearer ${SECRET}`), SECRET)).toBe(true);
    expect(isCronAuthorized(req(`bearer ${SECRET}`), SECRET)).toBe(true);
    expect(isCronAuthorized(req(`Bearer \t${SECRET} `), SECRET)).toBe(true);
  });

  it("refuses missing, malformed, wrong or oversized credentials", () => {
    for (const header of [
      undefined,
      "",
      SECRET,
      `Basic ${SECRET}`,
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET.slice(0, -1)}`,
      `Bearer ${SECRET} extra`,
      "Bearer ",
      `Bearer ${"a".repeat(2000)}`,
    ]) {
      expect(isCronAuthorized(req(header), SECRET)).toBe(false);
    }
  });
});
