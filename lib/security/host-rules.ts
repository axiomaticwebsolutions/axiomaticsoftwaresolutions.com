/**
 * SSRF rules for the hosts the server connects to on the Owner's behalf: the SMTP host and the S3-compatible storage
 * endpoint (docs/admin-integrations-design.md section 12, docs/security.md "SSRF guard").
 *
 * - isBlockedAddress(): loopback, private, carrier-grade NAT, link-local, unspecified, benchmarking, multicast and
 *   reserved addresses, IPv4 and IPv6; IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), NAT64 (64:ff9b::/96) and
 *   6to4 (2002::/16) addresses are judged by the IPv4 address they embed.
 * - hostProblem(): every environment refuses empty, over-long and malformed hosts and anything under `.invalid`
 *   (RFC 6761: never resolves; the release-day stand-ins use it). Production also refuses blocked IP literals,
 *   `localhost` and names under .localhost / .local / .internal, and single-label names.
 * - endpointProblem(): an absolute URL with no user info, query or fragment and an empty or "/" path; https only in
 *   production; then hostProblem().
 * Development allows everything else, so MinIO on 127.0.0.1:9000 and Mailpit on localhost:1025 keep working.
 * Messages never echo the host or address. No server-only: the deploy preflight loads it under `node --import tsx`.
 */
import { BlockList, isIP, isIPv4 } from "node:net";
import { isHostLike, normalizeHost } from "../integrations/model";

const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const BLOCKED_V6: ReadonlyArray<readonly [string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

const blockList = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockList.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of BLOCKED_V6) blockList.addSubnet(net, prefix, "ipv6");

/** 8 hextets of an IPv6 address (zone id dropped, embedded dotted IPv4 tail allowed); null when it does not parse. */
function ipv6Hextets(address: string): number[] | null {
  let addr = address.split("%")[0] ?? "";
  const tail: number[] = [];
  const lastColon = addr.lastIndexOf(":");
  const maybeV4 = addr.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (!isIPv4(maybeV4)) return null;
    const o = maybeV4.split(".").map(Number) as [number, number, number, number];
    tail.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
    addr = `${addr.slice(0, lastColon + 1)}0:0`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN)));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array<number>(fill).fill(0), ...rest];
  if (all.length !== 8 || all.some((h) => Number.isNaN(h))) return null;
  if (tail.length === 2) {
    all[6] = tail[0] as number;
    all[7] = tail[1] as number;
  }
  return all;
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** The IPv4 address an IPv6 address embeds (mapped, compatible, NAT64, 6to4), else null. */
function embeddedIPv4(h: number[]): string | null {
  const [a, b, c, d, e, f, g, i] = h as [number, number, number, number, number, number, number, number];
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) return v4From(g, i);
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return v4From(g, i);
  if (a === 0x2002) return v4From(b, c);
  return null;
}

/** True for addresses the server must never connect to for an integration. Not an IP address -> true (fail closed). */
export function isBlockedAddress(address: string): boolean {
  const ip = normalizeHost(address);
  const family = isIP(ip.split("%")[0] ?? "");
  if (family === 4) return blockList.check(ip, "ipv4");
  if (family !== 6) return true;
  const hextets = ipv6Hextets(ip);
  if (!hextets) return true;
  const v4 = embeddedIPv4(hextets);
  if (v4 !== null) return blockList.check(v4, "ipv4");
  const canonical = hextets.map((x) => x.toString(16)).join(":");
  return blockList.check(canonical, "ipv6");
}

export type HostProblemCode = "empty" | "too_long" | "invalid" | "reserved" | "private_address" | "local_name" | "single_label" | "https_required";
export type HostProblem = { code: HostProblemCode; message: string };

const MESSAGES: Readonly<Record<HostProblemCode, string>> = {
  empty: "Enter the host.",
  too_long: "This host name is too long.",
  invalid: "Enter a host name such as smtp.example.com.",
  reserved: "This host can’t be reached (a reserved test name).",
  private_address: "This host points to a private network address.",
  local_name: "Use a public host name, not a local one.",
  single_label: "Use the full host name, such as smtp.example.com.",
  https_required: "Use an https:// address.",
};

const problem = (code: HostProblemCode): HostProblem => ({ code, message: MESSAGES[code] });

/** Static rules for a host name or IP literal (no DNS); null when the host is acceptable. */
export function hostProblem(host: string, opts: { production: boolean }): HostProblem | null {
  const h = normalizeHost(host);
  if (h === "") return problem("empty");
  if (h.length > 253) return problem("too_long");
  if (!isHostLike(h)) return problem("invalid");
  const literal = isIP(h) !== 0;
  if (h.includes(":") && !literal) return problem("invalid");
  if (!literal && (h === "invalid" || h.endsWith(".invalid"))) return problem("reserved");
  if (!opts.production) return null;
  if (literal) return isBlockedAddress(h) ? problem("private_address") : null;
  if (h === "localhost" || /[.](localhost|local|internal)$/.test(h)) return problem("local_name");
  if (!h.includes(".")) return problem("single_label");
  // No top-level domain is numeric: "127.1" or "0x7f.1" are IPv4 shorthands that the system resolver turns into an
  // address (inet_aton), so they are refused here instead of only at connect time.
  const tld = h.slice(h.lastIndexOf(".") + 1);
  if (/^[0-9]+$/.test(tld) || /^0x[0-9a-f]*$/.test(tld)) return problem("invalid");
  return null;
}

/** Static rules for a storage endpoint URL (see the module comment); null when acceptable. */
export function endpointProblem(value: string, opts: { production: boolean }): HostProblem | null {
  const raw = value.trim();
  if (raw === "") return problem("empty");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return problem("invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return problem("invalid");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || /[?#]/.test(raw)) return problem("invalid");
  if (url.pathname !== "" && url.pathname !== "/") return problem("invalid");
  const host = hostProblem(url.hostname, opts);
  if (host) return host;
  if (opts.production && url.protocol !== "https:") return problem("https_required");
  return null;
}
