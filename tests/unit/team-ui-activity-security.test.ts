/**
 * Activity log and Security page models (components/account/activity/*, components/account/security/security-model.ts):
 * URL list state, kind visuals, footer and export copy, the download file name, form checks and session labels.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_KIND_OPTIONS,
  ACTIVITY_LIST,
  activityDate,
  activityExportPath,
  activityExportToast,
  activityQueryFromState,
  activityRangeLabel,
  activityVisual,
  rowCountFrom,
} from "@/components/account/activity/activity-model";
import { fileNameFromDisposition } from "@/components/account/activity/download-file";
import {
  exportedToast,
  firstError,
  hasOtherSessions,
  PASSWORD_FIELDS,
  sessionIcon,
  sessionMeta,
  showMoreSessionsLabel,
  signedOutToast,
  validatePasswordChange,
  validateProfile,
} from "@/components/account/security/security-model";
import { csvHeaders } from "@/lib/csv";
import { listStateHref, parseListState } from "@/lib/url-state";

const NOW = new Date("2026-10-07T10:00:00.000Z");

describe("activity list state", () => {
  it("reads ?kind=&q=&page= and falls back for unknown kinds", () => {
    const state = parseListState(new URLSearchParams("kind=team&q=%20Priya%20&page=3"), ACTIVITY_LIST);
    expect(activityQueryFromState(state)).toEqual({ kind: "team", q: "Priya", page: 3 });
    const bad = parseListState(new URLSearchParams("kind=everything&page=-1"), ACTIVITY_LIST);
    expect(activityQueryFromState(bad)).toEqual({ kind: "all", q: "", page: 1 });
    expect(bad.pageSize).toBe(10);
  });

  it("leaves defaults out of the URL", () => {
    const state = parseListState(new URLSearchParams(""), ACTIVITY_LIST);
    expect(listStateHref("/account/activity", { ...state, filters: { kind: "billing" } }, ACTIVITY_LIST)).toBe(
      "/account/activity?kind=billing",
    );
    expect(listStateHref("/account/activity", state, ACTIVITY_LIST)).toBe("/account/activity");
  });

  it("lists the Type options in prototype order", () => {
    expect(ACTIVITY_KIND_OPTIONS.map((o) => o.label)).toEqual([
      "All activity",
      "Licenses & devices",
      "Security",
      "Billing",
      "Team",
      "Support",
      "Downloads",
    ]);
  });
});

describe("activity rows", () => {
  it("maps kinds to the prototype's icon tiles", () => {
    expect(activityVisual("license")).toEqual({ icon: "key", tone: "lavender" });
    expect(activityVisual("ticket")).toEqual({ icon: "support_agent", tone: "blue" });
    expect(activityVisual("team")).toEqual({ icon: "group", tone: "sage" });
    expect(activityVisual("billing")).toEqual({ icon: "receipt_long", tone: "peach" });
    expect(activityVisual("download")).toEqual({ icon: "download", tone: "blue" });
    expect(activityVisual("security")).toEqual({ icon: "shield", tone: "pink" });
    expect(activityVisual("something-new")).toEqual({ icon: "history", tone: "lavender" });
  });

  it("shows dates in IST", () => {
    expect(activityDate("2026-10-06T20:00:00.000Z")).toBe("7 Oct 2026");
  });

  it("words the footer and the export like the prototype", () => {
    expect(activityRangeLabel({ from: 1, to: 10, total: 12 })).toBe("Showing 1–10 of 12 events · kept for 24 months");
    expect(activityRangeLabel({ from: 11, to: 20, total: 12345 })).toBe("Showing 11–20 of 12,345 events · kept for 24 months");
    expect(activityExportToast(12, "activity-log.csv", false)).toBe("Exported 12 rows to activity-log.csv");
    expect(activityExportToast(1, "activity-log.csv", false)).toBe("Exported 1 row to activity-log.csv");
    expect(activityExportToast(20000, "activity-log.csv", true)).toBe("Exported the newest 20,000 rows to activity-log.csv");
  });

  it("exports what the table shows (all pages)", () => {
    expect(activityExportPath({ kind: "all", q: "" })).toBe("/api/account/activity/export.csv");
    expect(activityExportPath({ kind: "team", q: " Priya Sharma " })).toBe("/api/account/activity/export.csv?kind=team&q=Priya+Sharma");
  });

  it("reads the export's row count header", () => {
    expect(rowCountFrom("42")).toBe(42);
    expect(rowCountFrom(null)).toBeNull();
    expect(rowCountFrom("4x")).toBeNull();
  });
});

describe("download names", () => {
  it("takes the server's file name, and never a path", () => {
    expect(fileNameFromDisposition(csvHeaders("activity-log.csv")["Content-Disposition"], "x.csv")).toBe("activity-log.csv");
    expect(fileNameFromDisposition('attachment; filename="account-export-2026-10-07.json"', "x.json")).toBe(
      "account-export-2026-10-07.json",
    );
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.csv", "x.csv")).toBe("résumé.csv");
    expect(fileNameFromDisposition('attachment; filename="../../etc/passwd"', "x")).toBe(".._.._etc_passwd");
    expect(fileNameFromDisposition(null, "fallback.json")).toBe("fallback.json");
    expect(fileNameFromDisposition("attachment", "fallback.json")).toBe("fallback.json");
  });
});

describe("security forms", () => {
  it("checks the profile with the API's schema", () => {
    expect(validateProfile({ name: "Priya Sharma", phone: "+91 98200 00000" })).toEqual({});
    expect(validateProfile({ name: "Priya Sharma", phone: "" })).toEqual({});
    expect(validateProfile({ name: " ", phone: "12345" })).toEqual({
      name: "Enter your name.",
      phone: "Enter a 10-digit mobile number.",
    });
    expect(validateProfile({ name: "priya@example.com", phone: "" }).name).toBe(
      "Enter your name without links or email addresses.",
    );
  });

  it("checks a password change with the prototype's messages and the app's policy", () => {
    expect(validatePasswordChange({ current: "", next: "short", confirm: "other" })).toEqual({
      current: "Enter your current password.",
      next: "Use at least 8 characters with letters and a number.",
      confirm: "Passwords don’t match.",
    });
    expect(validatePasswordChange({ current: "old", next: "12345678", confirm: "12345678" })).toEqual({
      next: "Use at least 8 characters with letters and a number.",
    });
    expect(validatePasswordChange({ current: "old", next: "newpass99", confirm: "newpass99" })).toEqual({});
    expect(firstError({ confirm: "x", next: "y" }, PASSWORD_FIELDS)).toBe("next");
    expect(firstError({}, PASSWORD_FIELDS)).toBeNull();
  });
});

describe("sessions", () => {
  const base = { current: false, mobile: false, ipPrefix: null, lastSeenAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString() };

  it("labels this device and the others", () => {
    expect(sessionMeta({ ...base, current: true }, NOW)).toBe("Active now");
    expect(sessionMeta(base, NOW)).toBe("Last active 3d ago");
    expect(sessionMeta({ ...base, ipPrefix: "103.21.4.x" }, NOW)).toBe("103.21.4.x · Last active 3d ago");
    expect(sessionIcon({ mobile: true })).toBe("smartphone");
    expect(sessionIcon({ mobile: false })).toBe("computer");
  });

  it("offers sign out all others only when there are others", () => {
    expect(hasOtherSessions([{ current: true }])).toBe(false);
    expect(hasOtherSessions([{ current: true }, { current: false }])).toBe(true);
  });

  it("words the toasts and the list toggle", () => {
    expect(signedOutToast("Safari on iOS")).toBe("Signed out Safari on iOS");
    expect(exportedToast("account-export-2026-10-07.json")).toBe("Exported account data to account-export-2026-10-07.json");
    expect(showMoreSessionsLabel(1)).toBe("Show 1 more session");
    expect(showMoreSessionsLabel(4)).toBe("Show 4 more sessions");
  });
});
