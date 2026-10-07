/**
 * lib/validation/portal.ts: billing details (GSTIN/PIN/state rules and the merged GSTIN-state check), locations,
 * email preferences, profile, two-step, active account, trials, mark-read and the query strings.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  activeAccountSchema,
  billingDetailsIssue,
  billingDetailsSchema,
  emailPrefsPatchSchema,
  locationBodySchema,
  markReadSchema,
  parseNotificationListQuery,
  parseOrderListQuery,
  parseSearchQuery,
  PORTAL_ERRORS,
  profilePatchSchema,
  startTrialSchema,
  twoStepSchema,
} from "@/lib/validation/portal";

const issues = (r: { success: boolean; error?: z.core.$ZodError }) =>
  r.error ? r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : [];

describe("billingDetailsSchema", () => {
  it("normalises the GSTIN, cleans text and keeps omitted keys undefined", () => {
    const out = billingDetailsSchema.parse({ legalName: "  Sharma   Medicals ", gstin: " 27abcde1234f1z5 ", pin: " 411001 " });
    expect(out).toEqual({ legalName: "Sharma Medicals", gstin: "27ABCDE1234F1Z5", pin: "411001" });
    expect("state" in out).toBe(false);
  });

  it("clears optional fields with an empty string or null", () => {
    expect(billingDetailsSchema.parse({ gstin: "", address: null, city: "  ", state: "", pin: null })).toEqual({
      gstin: null,
      address: null,
      city: null,
      state: null,
      pin: null,
    });
  });

  it("uses the prototype copy for GSTIN and PIN errors", () => {
    const r = billingDetailsSchema.safeParse({ gstin: "27ABCDE1234F1Z", pin: "4110" });
    expect(issues(r)).toEqual([`gstin: ${PORTAL_ERRORS.gstin}`, `pin: ${PORTAL_ERRORS.pin}`]);
  });

  it("rejects an empty legal name, an unknown state, unknown keys and an empty patch", () => {
    expect(issues(billingDetailsSchema.safeParse({ legalName: "   " }))).toEqual([`legalName: ${PORTAL_ERRORS.legalName}`]);
    expect(issues(billingDetailsSchema.safeParse({ state: "Bombay" }))).toEqual([`state: ${PORTAL_ERRORS.state}`]);
    expect(billingDetailsSchema.safeParse({ legalName: "A", accountId: "x" }).success).toBe(false);
    expect(issues(billingDetailsSchema.safeParse({}))).toEqual([`: ${PORTAL_ERRORS.nothingToUpdate}`]);
  });

  it("checks the GSTIN against the billing state on the merged details", () => {
    expect(billingDetailsIssue({ gstin: null, state: null })).toBeNull();
    expect(billingDetailsIssue({ gstin: "27ABCDE1234F1Z5", state: "Maharashtra" })).toBeNull();
    expect(billingDetailsIssue({ gstin: "27ABCDE1234F1Z5", state: null })).toEqual({ field: "state", message: PORTAL_ERRORS.gstinNeedsState });
    expect(billingDetailsIssue({ gstin: "27ABCDE1234F1Z5", state: "Karnataka" })).toEqual({
      field: "gstin",
      message: "This GSTIN is registered in Maharashtra. Choose Maharashtra as the billing state or check the GSTIN.",
    });
    // "Other Territory" (97) cannot match a billing state, so it is not cross-checked (as at checkout).
    expect(billingDetailsIssue({ gstin: "97ABCDE1234F1Z5", state: "Karnataka" })).toBeNull();
  });
});

describe("small bodies", () => {
  it("locations: trimmed names of 1-60 characters", () => {
    expect(locationBodySchema.parse({ name: "  Andheri   West " })).toEqual({ name: "Andheri West" });
    expect(issues(locationBodySchema.safeParse({ name: " " }))).toEqual([`name: ${PORTAL_ERRORS.locationName}`]);
    expect(issues(locationBodySchema.safeParse({ name: "x".repeat(61) }))).toEqual([`name: ${PORTAL_ERRORS.locationNameTooLong}`]);
  });

  it("email preferences: booleans only, at least one", () => {
    expect(emailPrefsPatchSchema.parse({ offers: true })).toEqual({ offers: true });
    expect(emailPrefsPatchSchema.safeParse({}).success).toBe(false);
    expect(emailPrefsPatchSchema.safeParse({ offers: "yes" }).success).toBe(false);
    expect(emailPrefsPatchSchema.safeParse({ security: false }).success).toBe(false);
  });

  it("profile: person-name rule and Indian mobile, empty phone removes it", () => {
    expect(profilePatchSchema.parse({ name: " Priya  Sharma ", phone: "+91 98200 00000" })).toEqual({
      name: "Priya Sharma",
      phone: "9820000000",
    });
    expect(profilePatchSchema.parse({ phone: "" })).toEqual({ phone: null });
    expect(issues(profilePatchSchema.safeParse({ phone: "12345" }))).toEqual([`phone: ${PORTAL_ERRORS.phone}`]);
    expect(issues(profilePatchSchema.safeParse({ name: "www.spam.example" }))).toEqual([`name: ${PORTAL_ERRORS.nameLink}`]);
    expect(profilePatchSchema.safeParse({ email: "x@y.z" }).success).toBe(false);
  });

  it("two-step: turning it off needs the password", () => {
    expect(twoStepSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(issues(twoStepSchema.safeParse({ enabled: false }))).toEqual([`password: ${PORTAL_ERRORS.password}`]);
    expect(twoStepSchema.parse({ enabled: false, password: "pw" })).toEqual({ enabled: false, password: "pw" });
    expect(twoStepSchema.safeParse({ enabled: "false" }).success).toBe(false);
  });

  it("ids are shape-checked", () => {
    expect(activeAccountSchema.safeParse({ accountId: "cm1abc" }).success).toBe(true);
    expect(activeAccountSchema.safeParse({ accountId: "../x" }).success).toBe(false);
    expect(startTrialSchema.safeParse({ productId: "medical-billing" }).success).toBe(true);
    expect(startTrialSchema.safeParse({ productId: "Medical Billing" }).success).toBe(false);
    expect(markReadSchema.parse({})).toEqual({});
    expect(markReadSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(markReadSchema.safeParse({ ids: Array.from({ length: 101 }, (_, i) => `n${i}`) }).success).toBe(false);
  });
});

describe("query strings", () => {
  it("orders: defaults, descending sort, first value wins, unknown parameters ignored", () => {
    expect(parseOrderListQuery(new URLSearchParams(""))).toEqual({ q: "", status: "all", sort: { key: "date", dir: -1 }, page: 1 });
    expect(parseOrderListQuery(new URLSearchParams("q=+AX-103+&status=refunded&sort=total&page=3&x=1"))).toEqual({
      q: "AX-103",
      status: "refunded",
      sort: { key: "total", dir: 1 },
      page: 3,
    });
    expect(() => parseOrderListQuery(new URLSearchParams("status=paidish"))).toThrow(z.ZodError);
    expect(() => parseOrderListQuery(new URLSearchParams("page=0"))).toThrow(z.ZodError);
    expect(() => parseOrderListQuery(new URLSearchParams("sort=-id"))).toThrow(z.ZodError);
  });

  it("notifications and search", () => {
    expect(parseNotificationListQuery(new URLSearchParams("filter=unread"))).toEqual({ filter: "unread", cursor: null });
    expect(() => parseNotificationListQuery(new URLSearchParams("filter=read"))).toThrow(z.ZodError);
    expect(parseSearchQuery(new URLSearchParams("q=%20k8nm%20"))).toBe("k8nm");
    expect(() => parseSearchQuery(new URLSearchParams(`q=${"a".repeat(101)}`))).toThrow(z.ZodError);
  });
});
