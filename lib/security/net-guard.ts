/**
 * Connect-time SSRF guard (production only; docs/admin-integrations-design.md section 12). The static rules in
 * host-rules.ts refuse blocked IP literals; these hooks resolve a host NAME, refuse when ANY of its addresses is
 * blocked, and connect to the checked address, which also closes DNS rebinding between a check and the connection.
 *
 * - guardedLookup(): a `lookup` for net / http(s) agents (the S3 client's request handler). Handles both callback
 *   forms Node uses: (err, address, family) and, with `all: true` (autoSelectFamily), (err, addresses[]).
 * - smtpSocketGuard(): nodemailer's `getSocket` hook. It resolves and checks, opens a TCP socket to the checked address
 *   and hands it over as `{ connection }`. Nodemailer keeps `host` as the name, so SNI and the certificate check still
 *   use the host name (implicit TLS and STARTTLS both upgrade a provided connection).
 * - resolvePublicHost(): the save-time check of the Admin forms.
 * A refused address raises BlockedAddressError (code EBLOCKEDADDRESS). Messages never carry the host or address.
 */
import "server-only";
import { promises as dnsPromises, type LookupAddress, type LookupAllOptions, type LookupOptions } from "node:dns";
import { connect, isIP, type LookupFunction, type Socket } from "node:net";
import { normalizeHost } from "@/lib/integrations/model";
import { isBlockedAddress } from "./host-rules";

export class BlockedAddressError extends Error {
  readonly code = "EBLOCKEDADDRESS";
  constructor() {
    super("Blocked: private network address");
    this.name = "BlockedAddressError";
  }
}

/** Resolves every address of a host (dns.promises.lookup with all: true by default; tests inject one). */
export type LookupAll = (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;
export type GuardOptions = { lookup?: LookupAll };

const defaultLookupAll: LookupAll = (hostname, options) => dnsPromises.lookup(hostname, { ...options, all: true });

function notFoundError(): Error {
  return Object.assign(new Error("Host not found"), { code: "ENOTFOUND" });
}

/** A `lookup` that refuses hosts with any blocked address (see the module comment). */
export function guardedLookup(opts: GuardOptions = {}): LookupFunction {
  const lookupAll = opts.lookup ?? defaultLookupAll;
  const lookup = (hostname: string, options: LookupOptions, callback: (...args: unknown[]) => void): void => {
    const o: LookupOptions = typeof options === "object" && options !== null ? options : {};
    const query: LookupAllOptions = { all: true };
    if (o.family !== undefined) query.family = o.family;
    if (o.hints !== undefined) query.hints = o.hints;
    lookupAll(hostname, query).then(
      (addresses) => {
        if (addresses.length === 0) return callback(notFoundError());
        if (addresses.some((a) => isBlockedAddress(a.address))) return callback(new BlockedAddressError());
        if (o.all) return callback(null, addresses);
        const first = addresses[0] as LookupAddress;
        return callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error),
    );
  };
  return lookup as unknown as LookupFunction;
}

export type HostResolution = { ok: true; addresses: LookupAddress[] } | { ok: false; reason: "blocked" | "not_found" | "dns_error" };

/** Resolves a host and judges every address. IP literals are judged without DNS. */
export async function resolvePublicHost(host: string, opts: GuardOptions = {}): Promise<HostResolution> {
  const h = normalizeHost(host);
  const family = isIP(h);
  if (family !== 0) return isBlockedAddress(h) ? { ok: false, reason: "blocked" } : { ok: true, addresses: [{ address: h, family }] };
  let addresses: LookupAddress[];
  try {
    addresses = await (opts.lookup ?? defaultLookupAll)(h, { all: true });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { ok: false, reason: code === "ENOTFOUND" || code === "ENODATA" ? "not_found" : "dns_error" };
  }
  if (addresses.length === 0) return { ok: false, reason: "not_found" };
  if (addresses.some((a) => isBlockedAddress(a.address))) return { ok: false, reason: "blocked" };
  return { ok: true, addresses };
}

type SocketCallback = (error: Error | null, socketOptions?: { connection: Socket } | false) => void;
export type SmtpSocketGuardOptions = GuardOptions & { connectTimeoutMs?: number; connect?: typeof connect };

/** nodemailer `getSocket`: a TCP connection to a checked address of the SMTP host (see the module comment). */
export function smtpSocketGuard(opts: SmtpSocketGuardOptions = {}): (options: { host?: string; port?: number }, callback: SocketCallback) => void {
  const timeoutMs = opts.connectTimeoutMs ?? 10_000;
  const open = opts.connect ?? connect;
  return (options, callback) => {
    const port = Number(options.port ?? 587);
    resolvePublicHost(options.host ?? "", opts).then(
      (result) => {
        if (!result.ok) {
          if (result.reason === "blocked") return callback(new BlockedAddressError());
          return callback(Object.assign(new Error("SMTP host could not be resolved"), { code: "EDNS" }));
        }
        const target = result.addresses[0] as LookupAddress;
        const socket = open({ host: target.address, port, family: target.family });
        let settled = false;
        const finish = (error: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.removeListener("error", finish);
          if (error) {
            socket.destroy();
            callback(error);
          } else {
            callback(null, { connection: socket });
          }
        };
        const timer = setTimeout(() => finish(Object.assign(new Error("Connection timed out"), { code: "ETIMEDOUT" })), timeoutMs);
        socket.once("connect", () => finish(null));
        socket.once("error", finish);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error("SMTP host lookup failed")),
    );
  };
}
