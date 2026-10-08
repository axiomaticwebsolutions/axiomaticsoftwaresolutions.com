/**
 * Connect-time SSRF guard (lib/security/net-guard.ts): the DNS lookup of the S3 client's agents and nodemailer's
 * getSocket hook refuse hosts with any private address, and hand back only checked addresses.
 */
import { EventEmitter } from "node:events";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { BlockedAddressError, guardedLookup, resolvePublicHost, smtpSocketGuard, type LookupAll } from "@/lib/security/net-guard";

const dnsWith = (table: Record<string, LookupAddress[]>): LookupAll =>
  vi.fn(async (hostname: string, _options: LookupAllOptions) => {
    const found = table[hostname];
    if (!found) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return found;
  });

const PUBLIC = [{ address: "52.95.110.1", family: 4 }];
const MIXED = [
  { address: "52.95.110.1", family: 4 },
  { address: "127.0.0.1", family: 4 },
];

function lookupOnce(fn: ReturnType<typeof guardedLookup>, host: string, options: object): Promise<unknown[]> {
  return new Promise((resolve) => (fn as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void)(host, options, (...args) => resolve(args)));
}

describe("guardedLookup", () => {
  const lookup = guardedLookup({ lookup: dnsWith({ "files.example.com": PUBLIC, "rebind.example.com": MIXED, "v6.example.com": [{ address: "::ffff:10.0.0.1", family: 6 }] }) });

  it("hands back a checked public address in the single form and every address in the all form", async () => {
    expect(await lookupOnce(lookup, "files.example.com", {})).toEqual([null, "52.95.110.1", 4]);
    expect(await lookupOnce(lookup, "files.example.com", { all: true })).toEqual([null, PUBLIC]);
  });

  it("refuses a host when ANY of its addresses is blocked, in both forms", async () => {
    for (const options of [{}, { all: true }, { family: 4 }]) {
      const [error] = await lookupOnce(lookup, "rebind.example.com", options);
      expect(error).toBeInstanceOf(BlockedAddressError);
      expect((error as BlockedAddressError).code).toBe("EBLOCKEDADDRESS");
      expect((error as Error).message).not.toContain("127.0.0.1");
    }
    expect((await lookupOnce(lookup, "v6.example.com", { all: true }))[0]).toBeInstanceOf(BlockedAddressError);
  });

  it("passes DNS errors through", async () => {
    const [error] = await lookupOnce(lookup, "missing.example.com", {});
    expect((error as { code?: string }).code).toBe("ENOTFOUND");
  });
});

describe("resolvePublicHost", () => {
  const lookup = dnsWith({ "smtp.example.com": PUBLIC, "rebind.example.com": MIXED });

  it("judges literals without DNS and every resolved address of a name", async () => {
    expect(await resolvePublicHost("8.8.8.8", { lookup })).toEqual({ ok: true, addresses: [{ address: "8.8.8.8", family: 4 }] });
    expect(await resolvePublicHost("127.0.0.1", { lookup })).toEqual({ ok: false, reason: "blocked" });
    expect(await resolvePublicHost("smtp.example.com", { lookup })).toEqual({ ok: true, addresses: PUBLIC });
    expect(await resolvePublicHost("rebind.example.com", { lookup })).toEqual({ ok: false, reason: "blocked" });
    expect(await resolvePublicHost("missing.example.com", { lookup })).toEqual({ ok: false, reason: "not_found" });
    const flaky = vi.fn(async () => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    });
    expect(await resolvePublicHost("smtp.example.com", { lookup: flaky })).toEqual({ ok: false, reason: "dns_error" });
  });
});

describe("smtpSocketGuard", () => {
  function fakeConnect() {
    const calls: { host?: string; port?: number }[] = [];
    const connect = vi.fn((opts: { host?: string; port?: number }) => {
      calls.push(opts);
      const socket = new EventEmitter() as EventEmitter & { destroy: () => void };
      socket.destroy = vi.fn();
      setImmediate(() => socket.emit("connect"));
      return socket as unknown as Socket;
    });
    return { connect, calls };
  }
  const run = (guard: ReturnType<typeof smtpSocketGuard>, host: string) =>
    new Promise<[Error | null, unknown]>((resolve) => guard({ host, port: 587 }, (error, socketOptions) => resolve([error, socketOptions])));

  it("refuses a host that resolves to a private address, before any connection", async () => {
    const { connect } = fakeConnect();
    const guard = smtpSocketGuard({ lookup: dnsWith({ "smtp.example.com": MIXED }), connect: connect as never });
    const [error] = await run(guard, "smtp.example.com");
    expect(error).toBeInstanceOf(BlockedAddressError);
    expect(connect).not.toHaveBeenCalled();
    const [literal] = await run(guard, "127.0.0.1");
    expect(literal).toBeInstanceOf(BlockedAddressError);
  });

  it("connects to the checked address and hands nodemailer the socket (nodemailer keeps the host name for TLS)", async () => {
    const { connect, calls } = fakeConnect();
    const guard = smtpSocketGuard({ lookup: dnsWith({ "smtp.example.com": PUBLIC }), connect: connect as never });
    const [error, socketOptions] = await run(guard, "smtp.example.com");
    expect(error).toBeNull();
    expect(calls).toEqual([{ host: "52.95.110.1", port: 587, family: 4 }]);
    expect(socketOptions).toHaveProperty("connection");
  });

  it("reports an unknown host as a DNS error (EDNS)", async () => {
    const guard = smtpSocketGuard({ lookup: dnsWith({}), connect: fakeConnect().connect as never });
    const [error] = await run(guard, "missing.example.com");
    expect((error as { code?: string }).code).toBe("EDNS");
  });
});
