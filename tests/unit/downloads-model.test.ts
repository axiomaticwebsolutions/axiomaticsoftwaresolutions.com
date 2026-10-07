/**
 * lib/downloads/model.ts: the client-side choice of the release a license may download (order page), file labels and
 * link copy. The server repeats the same entitlement rule (lib/licensing/entitlement) when a link is requested.
 */
import { describe, expect, it } from "vitest";
import { LicenseStatus } from "@/generated/prisma/enums";
import {
  compareReleasesNewestFirst,
  downloadButtonLabel,
  downloadLinkCreatedMessage,
  downloadLinkNote,
  downloadOptionFor,
  linkMinutes,
  minutesText,
  primaryFile,
  RELEASE_FILE_ID_RE,
  sortDownloadFiles,
  toDownloadFile,
  toEntitlementLicense,
  type DownloadReleaseView,
} from "@/lib/downloads/model";
import { ENTITLEMENT_MESSAGES } from "@/lib/licensing/entitlement";

const now = new Date("2026-10-07T06:00:00.000Z");
const day = 86_400_000;
const iso = (offsetDays: number) => new Date(now.getTime() + offsetDays * day).toISOString();

const file = (id: string, platform: string, sizeBytes = 148 * 1024 * 1024) =>
  toDownloadFile({ id, platform, fileName: `App-${id}.${platform === "windows" ? "exe" : "bin"}`, sizeBytes });

const RELEASES: DownloadReleaseView[] = [
  { id: "r421", version: "4.2.1", releasedAt: iso(-24), files: [file("f421w", "windows"), file("f421m", "macos")] },
  { id: "r420", version: "4.2.0", releasedAt: iso(-99), files: [file("f420w", "windows")] },
  { id: "r413", version: "4.1.3", releasedAt: iso(-203), files: [file("f413w", "windows")] },
];

describe("downloadOptionFor", () => {
  it("offers the newest release to an active license", () => {
    const option = downloadOptionFor({ status: "active", expiresAt: iso(300), updatesUntil: iso(300) }, RELEASES, now);
    expect(option).toMatchObject({ ok: true, release: { id: "r421", version: "4.2.1" } });
  });

  it("offers the newest covered release when updates ended between releases (one-time license)", () => {
    const option = downloadOptionFor({ status: "active", expiresAt: null, updatesUntil: iso(-60) }, RELEASES, now);
    expect(option).toMatchObject({ ok: true, release: { id: "r420" } });
  });

  it("answers updates_ended when updates ended before every release", () => {
    const option = downloadOptionFor({ status: "active", expiresAt: null, updatesUntil: iso(-400) }, RELEASES, now);
    expect(option).toEqual({ ok: false, reason: "updates_ended", message: ENTITLEMENT_MESSAGES.updates_ended });
  });

  it("refuses revoked, suspended and expired licenses (derived or stored status)", () => {
    const base = { expiresAt: iso(300), updatesUntil: iso(300) };
    expect(downloadOptionFor({ ...base, status: "revoked" }, RELEASES, now)).toMatchObject({ ok: false, reason: "revoked" });
    expect(downloadOptionFor({ ...base, status: LicenseStatus.SUSPENDED }, RELEASES, now)).toMatchObject({ ok: false, reason: "suspended" });
    const expired = downloadOptionFor({ status: "expired", expiresAt: iso(-1), updatesUntil: iso(-1) }, RELEASES, now);
    expect(expired).toEqual({ ok: false, reason: "expired", message: ENTITLEMENT_MESSAGES.expired });
  });

  it("lets trials download while they run", () => {
    expect(downloadOptionFor({ status: "trial", expiresAt: iso(10), updatesUntil: iso(10) }, RELEASES, now)).toMatchObject({ ok: true });
  });

  it("answers not_released when nothing is published (or only future releases)", () => {
    const license = { status: "active" as const, expiresAt: iso(300), updatesUntil: iso(300) };
    expect(downloadOptionFor(license, [], now)).toMatchObject({ ok: false, reason: "not_released" });
    const future = [{ id: "r5", version: "5.0.0", releasedAt: iso(3), files: [] }];
    expect(downloadOptionFor(license, future, now)).toMatchObject({ ok: false, reason: "not_released" });
  });
});

describe("toEntitlementLicense", () => {
  it("maps derived statuses to stored ones and parses ISO dates", () => {
    expect(toEntitlementLicense({ status: "expiring", expiresAt: iso(5), updatesUntil: iso(5) })).toEqual({
      status: LicenseStatus.ACTIVE,
      expiresAt: new Date(iso(5)),
      updatesUntil: new Date(iso(5)),
    });
    expect(toEntitlementLicense({ status: "trial", expiresAt: null, updatesUntil: now }).status).toBe(LicenseStatus.TRIAL);
    expect(toEntitlementLicense({ status: LicenseStatus.REVOKED, expiresAt: null, updatesUntil: now }).status).toBe(LicenseStatus.REVOKED);
  });
});

describe("files and releases", () => {
  it("labels files and orders them Windows, macOS, Android", () => {
    expect(file("a", "windows")).toEqual({
      id: "a",
      platform: "windows",
      platformLabel: "Windows",
      fileName: "App-a.exe",
      sizeBytes: 148 * 1024 * 1024,
      sizeLabel: "148 MB",
    });
    const sorted = sortDownloadFiles([file("x", "android"), file("y", "macos"), file("z", "windows"), file("q", "linux")]);
    expect(sorted.map((f) => f.platform)).toEqual(["windows", "macos", "android", "linux"]);
    expect(sorted[3]?.platformLabel).toBe("linux");
    expect(primaryFile([file("m", "macos"), file("w", "windows")])?.id).toBe("w");
    expect(primaryFile([])).toBeNull();
  });

  it("sorts releases newest first by version (semver), then date, undated last", () => {
    const hotfix = [
      { releasedAt: iso(-30), version: "4.2.0" },
      { releasedAt: iso(-5), version: "4.1.5" },
      { releasedAt: iso(-2), version: "4.3.0-beta.1" },
      { releasedAt: iso(-60), version: "4.1.0" },
      { releasedAt: null, version: "5.0.0" },
    ].sort(compareReleasesNewestFirst);
    expect(hotfix.map((r) => r.version)).toEqual(["4.3.0-beta.1", "4.2.0", "4.1.5", "4.1.0", "5.0.0"]);
  });

  it("sorts releases newest first by date, then version", () => {
    const list = [
      { releasedAt: iso(-10), version: "4.9.0" },
      { releasedAt: iso(-1), version: "4.10.0" },
      { releasedAt: iso(-1), version: "4.10.1" },
      { releasedAt: null, version: "9.9.9" },
    ].sort(compareReleasesNewestFirst);
    expect(list.map((r) => r.version)).toEqual(["4.10.1", "4.10.0", "4.9.0", "9.9.9"]);
  });

  it("accepts release file ids of cuid and seed shape only", () => {
    expect(RELEASE_FILE_ID_RE.test("cmg1x2y3z0000abcd1234efgh")).toBe(true);
    expect(RELEASE_FILE_ID_RE.test("seed_file_medical-billing_4.2.1_windows")).toBe(true);
    expect(RELEASE_FILE_ID_RE.test("../etc/passwd")).toBe(false);
    expect(RELEASE_FILE_ID_RE.test("")).toBe(false);
    expect(RELEASE_FILE_ID_RE.test("a".repeat(129))).toBe(false);
  });
});

describe("copy", () => {
  it("rounds link lifetimes down to whole minutes", () => {
    expect(linkMinutes(600)).toBe(10);
    expect(linkMinutes(599)).toBe(9);
    expect(linkMinutes(30)).toBe(1);
    expect(minutesText(1)).toBe("1 minute");
  });

  it("uses the order page wording", () => {
    expect(downloadLinkNote(10)).toBe("Secure link \u00B7 expires 10 minutes after you click");
    expect(downloadLinkCreatedMessage(10)).toBe("Download link created: valid for 10 minutes");
    const f = file("w", "windows");
    expect(downloadButtonLabel("4.2.1", f, false)).toBe("Download v4.2.1 \u00B7 148 MB");
    expect(downloadButtonLabel("4.2.1", f, true)).toBe("Download v4.2.1 for Windows \u00B7 148 MB");
  });
});
