/**
 * lib/software/view.ts (GET /api/account/software): per licensed product, the license that unlocks the newest
 * release, latest vs eligible release, "Included" / "Needs renewal" per release and the reason when nothing is
 * downloadable. Dates mirror the seeded Sharma Medicals account.
 */
import { describe, expect, it } from "vitest";
import { type LicenseStatus, type PlanType } from "@/generated/prisma/enums";
import { formatDateIST } from "@/lib/dates";
import { toDownloadFile } from "@/lib/downloads/model";
import { ENTITLEMENT_MESSAGES } from "@/lib/licensing/entitlement";
import { buildSoftwareView, type SoftwareLicenseInput, type SoftwareProductInput } from "@/lib/software/view";

const now = new Date("2026-10-07T06:00:00.000Z");
const d = (s: string) => new Date(`${s}T18:30:00.000Z`);

const rel = (productId: string, version: string, date: string, platforms = ["windows"]) => ({
  id: `${productId}-${version}`,
  version,
  releasedAt: d(date),
  notes: [`Notes for ${version}`],
  files: platforms.map((p) =>
    toDownloadFile({ id: `${productId}-${version}-${p}`, platform: p, fileName: `${version}-${p}`, sizeBytes: 64 * 1024 * 1024 }),
  ),
});

function product(id: string, rank: number, releases: SoftwareProductInput["releases"]): SoftwareProductInput {
  return { id, name: `Product ${id}`, shortName: id.toUpperCase(), icon: "receipt_long", tone: "sage", rank, platforms: ["windows", "macos"], releases };
}

let seq = 0;
function lic(productId: string, planType: PlanType, status: LicenseStatus, expiresAt: Date | null, updatesUntil: Date): SoftwareLicenseInput {
  seq += 1;
  return { id: `LIC-${seq}`, productId, planName: `${planType} plan`, planType, status, expiresAt, updatesUntil };
}

const cheque = product("cheque", 3, [rel("cheque", "3.1.0", "2026-08-03", ["windows", "macos"]), rel("cheque", "3.0.0", "2026-04-09")]);
const general = product("general", 2, [rel("general", "5.0.2", "2026-09-28"), rel("general", "5.0.0", "2026-06-16"), rel("general", "4.8.1", "2026-01-20")]);
const medical = product("medical", 1, [
  rel("medical", "4.2.1", "2026-09-13"),
  rel("medical", "4.2.0", "2026-06-30"),
  rel("medical", "4.1.3", "2026-03-18"),
  rel("medical", "4.3.0", "2026-12-01"),
]);

function view(licenses: SoftwareLicenseInput[], canDownload = true) {
  return buildSoftwareView({ licenses, products: [cheque, general, medical], now, canDownload });
}

describe("buildSoftwareView", () => {
  it("lists only licensed products, by rank", () => {
    const v = view([lic("cheque", "ONE_TIME", "ACTIVE", null, d("2027-10-06")), lic("medical", "ANNUAL", "ACTIVE", d("2027-10-05"), d("2027-10-05"))]);
    expect(v.products.map((p) => p.productId)).toEqual(["medical", "cheque"]);
    expect(v.canDownload).toBe(true);
    expect(buildSoftwareView({ licenses: [], products: [cheque], now, canDownload: true }).products).toEqual([]);
  });

  it("uses the license that unlocks the newest release (two one-time licenses, one with updates ended)", () => {
    const old = lic("cheque", "ONE_TIME", "ACTIVE", null, d("2026-03-25"));
    const fresh = lic("cheque", "ONE_TIME", "ACTIVE", null, d("2027-10-06"));
    const [p] = view([old, fresh]).products;
    expect(p?.license.id).toBe(fresh.id);
    expect(p?.licenseCount).toBe(2);
    expect(p?.latestRelease).toMatchObject({ version: "3.1.0", sizeLabel: "64 MB" });
    expect(p?.eligibleRelease?.version).toBe("3.1.0");
    expect(p?.upToDate).toBe(true);
    expect(p?.eligibility).toEqual({ tag: "up_to_date", label: "Up to date", tone: "sage" });
    expect(p?.eligibleNote).toBe(`Updates until ${formatDateIST(d("2027-10-06"))}`);
    expect(p?.downloadable && p.canDownload).toBe(true);
    expect([p?.reason, p?.reasonMessage, p?.needsRenewal, p?.renewLabel]).toEqual([null, null, false, null]);
    expect(p?.releases.map((r) => [r.version, r.accessLabel])).toEqual([
      ["3.1.0", "Included"],
      ["3.0.0", "Included"],
    ]);
    expect(p?.releases[0]?.files.map((f) => [f.platformLabel, f.fileName, f.sizeLabel])).toEqual([
      ["Windows", "3.1.0-windows", "64 MB"],
      ["macOS", "3.1.0-macos", "64 MB"],
    ]);
    expect(p?.releases[0]?.notes).toEqual(["Notes for 3.1.0"]);
  });

  it("marks newer releases 'Needs renewal' once updates ended, and older ones 'Included'", () => {
    const [p] = view([lic("medical", "ONE_TIME", "ACTIVE", null, d("2026-07-15"))]).products;
    expect(p?.latestRelease?.version).toBe("4.2.1"); // 4.3.0 is future-dated and ignored
    expect(p?.eligibleRelease?.version).toBe("4.2.0");
    expect(p?.upToDate).toBe(false);
    expect(p?.eligibility.label).toBe("Newer version needs renewal");
    expect(p?.eligibleNote).toBe(`Updates ended ${formatDateIST(d("2026-07-15"))}`);
    expect([p?.needsRenewal, p?.renewLabel]).toEqual([true, "Renew maintenance for v4.2.1"]);
    expect(p?.releases.map((r) => [r.version, r.access, r.reason])).toEqual([
      ["4.2.1", "needs_renewal", "updates_ended"],
      ["4.2.0", "included", null],
      ["4.1.3", "included", null],
    ]);
  });

  it("gives the most useful reason when nothing is downloadable (expired trial beats revoked)", () => {
    const trial = lic("general", "TRIAL", "TRIAL", d("2026-09-11"), d("2026-09-11"));
    const revoked = lic("general", "ANNUAL", "REVOKED", d("2027-09-16"), d("2027-09-16"));
    const [p] = view([revoked, trial]).products;
    expect(p?.license.id).toBe(trial.id);
    expect(p?.license.status).toBe("expired");
    expect(p?.eligibleRelease).toBeNull();
    expect([p?.downloadable, p?.canDownload]).toEqual([false, false]);
    expect(p?.reason).toBe("expired");
    expect(p?.reasonMessage).toBe(ENTITLEMENT_MESSAGES.expired);
    expect(p?.eligibility).toMatchObject({ tag: "not_eligible", label: "Not eligible" });
    expect(p?.eligibleNote).toBe(`Ended ${formatDateIST(d("2026-09-11"))}`);
    expect([p?.needsRenewal, p?.renewLabel]).toEqual([true, "Buy a license"]);
    expect(p?.releases.every((r) => r.accessLabel === "Needs renewal" && r.reason === "expired")).toBe(true);
  });

  it("revoked and suspended licenses get no renewal offer", () => {
    const [r] = view([lic("general", "ANNUAL", "REVOKED", d("2027-09-16"), d("2027-09-16"))]).products;
    expect([r?.reason, r?.eligibility.label, r?.eligibleNote, r?.needsRenewal, r?.renewLabel]).toEqual([
      "revoked",
      "No access",
      "License revoked",
      false,
      null,
    ]);
    const [s] = view([lic("general", "ANNUAL", "SUSPENDED", d("2027-09-16"), d("2027-09-16"))]).products;
    expect([s?.reason, s?.eligibility.label, s?.reasonMessage]).toEqual(["suspended", "Not eligible", ENTITLEMENT_MESSAGES.suspended]);
  });

  it("offers 'Renew license' for an expired annual license", () => {
    const [p] = view([lic("medical", "ANNUAL", "ACTIVE", d("2026-09-01"), d("2026-09-01"))]).products;
    expect([p?.reason, p?.renewLabel]).toEqual(["expired", "Renew license"]);
  });

  it("answers not_released when the product has no published release yet", () => {
    const empty = product("empty", 9, []);
    const licenses = [lic("empty", "ANNUAL", "ACTIVE", d("2027-01-01"), d("2027-01-01"))];
    const v = buildSoftwareView({ licenses, products: [empty], now, canDownload: true });
    expect(v.products[0]).toMatchObject({ reason: "not_released", latestRelease: null, eligibleNote: "No release available yet", releases: [] });
  });

  it("lets roles without `downloads` view but not download", () => {
    const v = view([lic("medical", "ANNUAL", "ACTIVE", d("2027-10-05"), d("2027-10-05"))], false);
    expect(v.canDownload).toBe(false);
    expect(v.products[0]).toMatchObject({ downloadable: true, canDownload: false, eligibility: { tag: "up_to_date" } });
  });
});
