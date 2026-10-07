import { describe, expect, it } from "vitest";
import {
  downloadButtons,
  downloadToast,
  latestNote,
  licenseLine,
  lockNote,
  platformsText,
  productPageHref,
  releaseRows,
  renewHref,
  safeDownloadUrl,
  SOFTWARE_COPY,
  TRIAL_COPY,
  trialSlugFrom,
  trialTerms,
  trialUpgradeHref,
} from "@/components/account/software/model";
import type { SoftwareProductView, SoftwareReleaseView } from "@/lib/software/view";

const file = (platform: string, label: string) => ({
  id: `f-${platform}`,
  platform,
  platformLabel: label,
  fileName: `App-4.2.1-${platform}`,
  sizeBytes: 155_189_248,
  sizeLabel: "148 MB",
});

const release = (id: string, version: string, access: SoftwareReleaseView["access"], files = [file("windows", "Windows")]): SoftwareReleaseView => ({
  id,
  version,
  releasedAt: "2026-09-14T18:30:00.000Z",
  notes: ["Faster search by salt name", "Near-expiry return report"],
  files,
  access,
  accessLabel: access === "included" ? "Included" : "Needs renewal",
  reason: access === "included" ? null : "updates_ended",
});

const product: SoftwareProductView = {
  productId: "medical-billing",
  name: "Medical Store Billing Software",
  shortName: "Medical Store Billing",
  icon: "medication",
  tone: "sage",
  platforms: ["windows", "macos", "android"],
  license: {
    id: "LIC-24017",
    planName: "Annual license",
    planType: "ANNUAL",
    status: "active",
    statusLabel: "Active",
    expiresAt: "2026-11-17T03:32:10.572Z",
    updatesUntil: "2026-11-17T03:32:10.572Z",
  },
  licenseCount: 1,
  latestRelease: { id: "r2", version: "4.2.1", releasedAt: "2026-09-14T18:30:00.000Z", sizeLabel: "148 MB" },
  eligibleRelease: { id: "r2", version: "4.2.1", releasedAt: "2026-09-14T18:30:00.000Z" },
  eligibility: { tag: "up_to_date", label: "Up to date", tone: "sage" },
  eligibleNote: "While license is active",
  upToDate: true,
  downloadable: true,
  canDownload: true,
  reason: null,
  reasonMessage: null,
  needsRenewal: false,
  renewLabel: null,
  releases: [
    release("r2", "4.2.1", "included", [file("windows", "Windows"), file("macos", "macOS"), file("android", "Android")]),
    release("r1", "4.2.0", "included"),
  ],
};

describe("software card model (prototype vSoftware)", () => {
  it("offers one button per installer of the eligible release, Android included", () => {
    expect(downloadButtons(product).map((b) => b.label)).toEqual(["v4.2.1 for Windows", "v4.2.1 for macOS", "v4.2.1 for Android"]);
    expect(downloadButtons(product)[0]).toMatchObject({ fileId: "f-windows", version: "4.2.1" });
    expect(downloadButtons({ ...product, eligibleRelease: null })).toEqual([]);
    expect(downloadButtons({ ...product, eligibleRelease: { id: "gone", version: "1", releasedAt: "" } })).toEqual([]);
  });

  it("uses the eligible release, not the latest, when they differ", () => {
    const older = { ...product, eligibleRelease: { id: "r1", version: "4.2.0", releasedAt: "2026-07-01T18:30:00.000Z" } };
    expect(downloadButtons(older).map((b) => b.label)).toEqual(["v4.2.0 for Windows"]);
  });

  it("writes the lock note, latest-release note, license line and platforms", () => {
    expect(lockNote(product, 10)).toBe("Entitlement-checked \u00b7 links expire in 10 min");
    expect(lockNote({ downloadable: false, reason: "expired" }, 10)).toBe("Downloads need an active license");
    expect(lockNote({ downloadable: false, reason: "revoked" }, 10)).toBe("Downloads need an active license");
    expect(lockNote({ downloadable: false, reason: "not_released" }, 10)).toBe("No release to download yet");
    expect(lockNote({ downloadable: false, reason: "updates_ended" }, 10)).toBe("Newer versions need a maintenance renewal");
    expect(latestNote(product.latestRelease)).toBe("15 Sep 2026 \u00b7 148 MB");
    expect(latestNote({ id: "r2", version: "4.2.1", releasedAt: "2026-09-14T18:30:00.000Z", sizeLabel: "" })).toBe("15 Sep 2026");
    expect(latestNote(null)).toBe("No release yet");
    expect(licenseLine(product)).toBe("Annual license \u00b7 LIC-24017");
    expect(platformsText(product.platforms)).toBe("Windows \u00b7 macOS \u00b7 Android");
    expect(renewHref(product)).toBe("/account/licenses/LIC-24017?tab=renew");
  });

  it("builds release-note rows with joined changes and access labels", () => {
    expect(releaseRows([release("r1", "3.0.0", "needs_renewal")])).toEqual([
      {
        id: "r1",
        version: "v3.0.0",
        date: "15 Sep 2026",
        dateTime: "2026-09-14T18:30:00.000Z",
        changes: "Faster search by salt name \u00b7 Near-expiry return report",
        access: "needs_renewal",
        accessLabel: "Needs renewal",
      },
    ]);
  });

  it("keeps the header copy and the toast without the prototype's '(mock)'", () => {
    expect(SOFTWARE_COPY.description(10)).toBe(
      "Download the latest version each license entitles you to. Links are created on request and expire after 10 minutes.",
    );
    expect(SOFTWARE_COPY.description(1)).toContain("expire after 1 minute.");
    expect(downloadToast("4.2.1", 10)).toBe("Signed download link for v4.2.1 created \u00b7 valid 10 minutes");
  });

  it("only follows http(s) download URLs", () => {
    const base = "http://localhost:3000/account/software";
    expect(safeDownloadUrl("/api/dev/storage/x?exp=1&sig=2", base)).toBe("http://localhost:3000/api/dev/storage/x?exp=1&sig=2");
    expect(safeDownloadUrl("https://cdn.example/x.exe", base)).toBe("https://cdn.example/x.exe");
    expect(safeDownloadUrl("javascript:alert(1)", base)).toBeNull();
    expect(safeDownloadUrl("", base)).toBeNull();
    expect(safeDownloadUrl(42, base)).toBeNull();
  });
});

describe("trial notices (/account/software?trial=<slug>)", () => {
  it("accepts product slugs only", () => {
    expect(trialSlugFrom("medical-billing")).toBe("medical-billing");
    expect(trialSlugFrom(" Medical-Billing ")).toBe("medical-billing");
    expect(trialSlugFrom(["restaurant-billing", "x"])).toBe("restaurant-billing");
    expect(trialSlugFrom("../admin")).toBeNull();
    expect(trialSlugFrom("a--b")).toBeNull();
    expect(trialSlugFrom("")).toBeNull();
    expect(trialSlugFrom(undefined)).toBeNull();
    expect(trialSlugFrom("x".repeat(81))).toBeNull();
  });

  it("describes the trial terms", () => {
    expect(trialTerms({ trialDays: 15, deviceLimit: 1, deviceWord: "computer" })).toBe("All features on 1 computer for 15 days.");
    expect(trialTerms({ trialDays: 7, deviceLimit: 2, deviceWord: "terminal" })).toBe("All features on 2 terminals for 7 days.");
    expect(trialTerms({ trialDays: null, deviceLimit: 0, deviceWord: "" })).toBe("All features on 1 computer.");
    expect(trialTerms({ trialDays: 1, deviceLimit: 1, deviceWord: "computer" })).toBe("All features on 1 computer for 1 day.");
  });

  it("writes the notice copy and links", () => {
    expect(TRIAL_COPY.readyTitle("Restaurant Billing")).toBe("Start your free trial of Restaurant Billing.");
    expect(TRIAL_COPY.dialogBody("Restaurant Billing Software", "All features on 1 computer for 7 days.", "Sharma Medicals")).toBe(
      "Restaurant Billing Software for Sharma Medicals. All features on 1 computer for 7 days. If you buy a license later, it keeps the same key and data.",
    );
    expect(TRIAL_COPY.startedBody("LIC-1", "2026-10-14T05:00:00.000Z")).toBe(
      "LIC-1 runs until 14 Oct 2026. Download the software below, then activate it with the key from the license page.",
    );
    expect(TRIAL_COPY.usedTrialBody("LIC-2", "2026-09-12T03:32:10.572Z")).toBe(
      "Your trial (LIC-2) ended on 12 Sep 2026. Buy a license to continue with the same key and data.",
    );
    expect(TRIAL_COPY.ownedBody("LIC-3", "Annual license")).toBe("LIC-3 (Annual license) is active. Download the software below.");
    expect(TRIAL_COPY.usedTitle).toBe("You\u2019ve already used the free trial for this product.");
    expect(TRIAL_COPY.unavailableTitle).toBe("This product doesn\u2019t offer a free trial.");
    expect(trialUpgradeHref("LIC-2")).toBe("/account/licenses/LIC-2?tab=renew");
    expect(productPageHref("cheque-printing")).toBe("/software/cheque-printing");
  });
});
