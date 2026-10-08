/**
 * SSRF rules for integration hosts (lib/security/host-rules.ts; docs/admin-integrations-design.md section 12).
 */
import { describe, expect, it } from "vitest";
import { endpointProblem, hostProblem, isBlockedAddress } from "@/lib/security/host-rules";

const PROD = { production: true } as const;
const DEV = { production: false } as const;
const code = (p: ReturnType<typeof hostProblem>) => p?.code ?? null;

describe("isBlockedAddress", () => {
  it("blocks loopback, private, CGNAT, link-local, unspecified, reserved and multicast addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "127.255.255.254",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "192.0.0.8",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "fec0::1",
      "ff02::1",
      "[::1]",
      "fe80::1%eth0",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("judges IPv4-mapped, IPv4-compatible, NAT64 and 6to4 addresses by the IPv4 address they embed", () => {
    for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::a00:1", "64:ff9b::10.0.0.1", "2002:7f00:1::", "2002:c0a8:101::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("lets public addresses through and fails closed for anything that is not an IP", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "13.235.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "2404:6800:4009::200e"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
    for (const bad of ["", "localhost", "example.com", "1.2.3", "::g"]) expect(isBlockedAddress(bad), bad).toBe(true);
  });
});

describe("hostProblem", () => {
  it("refuses empty, malformed, over-long and .invalid hosts everywhere (the release-day stand-ins)", () => {
    for (const opts of [PROD, DEV]) {
      expect(code(hostProblem("", opts))).toBe("empty");
      expect(code(hostProblem("smtp example.com", opts))).toBe("invalid");
      expect(code(hostProblem("smtp_host.example.com", opts))).toBe("invalid");
      expect(code(hostProblem(`${"a".repeat(60)}.`.repeat(5) + "com", opts))).toBe("too_long");
      expect(code(hostProblem("smtp-pending.invalid", opts))).toBe("reserved");
      expect(code(hostProblem("invalid", opts))).toBe("reserved");
      expect(hostProblem("smtp.example.com", opts)).toBeNull();
      expect(hostProblem("SMTP.Example.COM.", opts)).toBeNull();
    }
  });

  it("refuses local names, single labels, numeric shorthands and blocked literals in production only", () => {
    for (const host of ["localhost", "db.localhost", "printer.local", "redis.internal"]) {
      expect(code(hostProblem(host, PROD)), host).toBe("local_name");
      expect(hostProblem(host, DEV), host).toBeNull();
    }
    expect(code(hostProblem("mailserver", PROD))).toBe("single_label");
    expect(hostProblem("mailserver", DEV)).toBeNull();
    for (const host of ["127.1", "0x7f.1"]) expect(code(hostProblem(host, PROD)), host).toBe("invalid");
    for (const host of ["127.0.0.1", "10.0.0.5", "[::1]", "169.254.169.254"]) {
      expect(code(hostProblem(host, PROD)), host).toBe("private_address");
      expect(hostProblem(host, DEV), host).toBeNull();
    }
    expect(hostProblem("8.8.8.8", PROD)).toBeNull();
    expect(hostProblem("2606:4700::1111", PROD)).toBeNull();
  });

  it("never echoes the host in its message", () => {
    for (const host of ["127.0.0.1", "smtp-pending.invalid", "localhost", "mailserver"]) {
      expect(hostProblem(host, PROD)?.message).not.toContain(host);
    }
  });
});

describe("endpointProblem", () => {
  it("needs an absolute URL without user info, query, fragment or path", () => {
    for (const opts of [PROD, DEV]) {
      expect(endpointProblem("https://acc123.r2.cloudflarestorage.com", opts)).toBeNull();
      expect(endpointProblem("https://s3.ap-south-1.amazonaws.com/", opts)).toBeNull();
      for (const bad of ["s3.amazonaws.com", "ftp://files.example.com", "https://user:pw@files.example.com", "https://files.example.com/bucket", "https://files.example.com/?x=1", "https://files.example.com/#f", "https://files.example.com?"]) {
        expect(code(endpointProblem(bad, opts)), bad).toBe("invalid");
      }
      expect(code(endpointProblem("https://r2-pending.invalid", opts))).toBe("reserved");
    }
  });

  it("requires https and a public host in production; development allows MinIO on 127.0.0.1 over http", () => {
    expect(code(endpointProblem("http://files.example.com", PROD))).toBe("https_required");
    expect(code(endpointProblem("https://127.0.0.1:9000", PROD))).toBe("private_address");
    expect(code(endpointProblem("https://localhost:9000", PROD))).toBe("local_name");
    expect(endpointProblem("http://127.0.0.1:9000", DEV)).toBeNull();
    expect(endpointProblem("http://files.example.com", DEV)).toBeNull();
  });
});
