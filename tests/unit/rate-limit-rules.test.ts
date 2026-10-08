import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RATE_LIMITS } from "@/lib/auth/rate-limit";

const id = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

describe("Phase 3 rules in RATE_LIMITS", () => {
  // The keys must stay exactly as they were when these rules lived next to their routes, so live buckets carry over.
  it("keeps the keys, limits and windows of the moved rules", () => {
    const ip = "103.21.44.17";
    const cases: Array<[ReturnType<typeof RATE_LIMITS.orderIp>, string, number, number]> = [
      [RATE_LIMITS.changePassword("user_1"), `pwchange:user:${id("user_1")}`, 5, 900],
      [RATE_LIMITS.loginCodeIp(ip), `otp:ip:${id(ip)}`, 30, 900],
      [RATE_LIMITS.orderIp(ip), `checkout-order:ip:${id(ip)}`, 20, 3600],
      [RATE_LIMITS.quoteIp(ip), `checkout-quote:ip:${id(ip)}`, 120, 600],
      [RATE_LIMITS.orderReturnIp(ip), `checkout-return:ip:${id(ip)}`, 30, 600],
      [RATE_LIMITS.orderStatusIp(ip), `order-status:ip:${id(ip)}`, 300, 300],
      [RATE_LIMITS.orderActionIp(ip), `order-action:ip:${id(ip)}`, 30, 600],
      [RATE_LIMITS.invoicePdfIp(ip), `invoice-pdf:ip:${id(ip)}`, 30, 600],
      [RATE_LIMITS.webhookInvalidIp(ip), `webhook:invalid:ip:${id(ip)}`, 30, 600],
    ];
    for (const [rule, key, limit, windowSec] of cases) expect(rule).toEqual({ key, limit, windowSec });
  });

  it("caps email verification guesses per user (10 / 24 h) and per IP (30 / 15 min)", () => {
    expect(RATE_LIMITS.verifyEmailUser("user_1")).toEqual({ key: `verify:user:${id("user_1")}`, limit: 10, windowSec: 86_400 });
    expect(RATE_LIMITS.verifyEmailIp("103.21.44.17")).toEqual({ key: `verify:ip:${id("103.21.44.17")}`, limit: 30, windowSec: 900 });
  });

  it("buckets requests without a trusted client IP together as 'unknown'", () => {
    expect(RATE_LIMITS.orderIp(null).key).toBe(`checkout-order:ip:${id("unknown")}`);
  });

  it("never puts a raw identifier in a key", () => {
    for (const make of Object.values(RATE_LIMITS)) {
      const key = (make as (v: string) => { key: string })("priya@sharmamedicals.example").key;
      expect(key).not.toContain("priya");
      expect(key).toMatch(/^[a-z-]+(:[a-z-]+)+:[0-9a-f]{32}$/);
    }
  });
});

describe("Customer portal rules in RATE_LIMITS (Phase 4 device actions, Phase 5)", () => {
  // Same keys, limits and windows as when these rules lived in lib/portal/* and lib/licensing/account.ts.
  it("keeps the keys, limits and windows of the moved rules", () => {
    const u = "user_1";
    const ip = "103.21.44.17";
    const cases: Array<[ReturnType<typeof RATE_LIMITS.ordersExport>, string, number, number]> = [
      [RATE_LIMITS.accountDevices(u), `account-devices:user:${id(u)}`, 60, 600],
      [RATE_LIMITS.ordersExport(u), `orders-export:user:${id(u)}`, 20, 600],
      [RATE_LIMITS.billingUpdate(u), `billing-update:user:${id(u)}`, 30, 600],
      [RATE_LIMITS.accountLocations(u), `account-locations:user:${id(u)}`, 60, 600],
      [RATE_LIMITS.trialStart(u), `trials:user:${id(u)}`, 10, 3600],
      [RATE_LIMITS.accountSearch(u), `account-search:user:${id(u)}`, 120, 60],
      [RATE_LIMITS.notificationWrites(u), `notifications-write:user:${id(u)}`, 120, 600],
      [RATE_LIMITS.accountExport(u), `account-export:user:${id(u)}`, 5, 3600],
      [RATE_LIMITS.twoStepOff(u), `twostep-off:user:${id(u)}`, 5, 900],
      [RATE_LIMITS.twoStepToggle(u), `twostep:user:${id(u)}`, 20, 3600],
      [RATE_LIMITS.profileUpdate(u), `profile:user:${id(u)}`, 30, 600],
      [RATE_LIMITS.ticketCreate(u), `ticket-create:user:${id(u)}`, 10, 3600],
      [RATE_LIMITS.ticketUpdate(u), `ticket-update:user:${id(u)}`, 60, 3600],
      [RATE_LIMITS.uploadCreate(u), `upload:user:${id(u)}`, 30, 3600],
      [RATE_LIMITS.uploadConfirm(u), `upload-confirm:user:${id(u)}`, 60, 3600],
      [RATE_LIMITS.attachmentDownload(u), `attachment-download:user:${id(u)}`, 120, 3600],
      [RATE_LIMITS.teamInviteUser(u), `team-invite:user:${id(u)}`, 20, 3600],
      [RATE_LIMITS.teamInviteAccount("acct_1"), `team-invite:account:${id("acct_1")}`, 50, 86_400],
      [RATE_LIMITS.teamInviteResend("acct_1", "mem_1"), `team-invite-resend:member:${id("acct_1:mem_1")}`, 3, 3600],
      [RATE_LIMITS.invitePreviewIp(ip), `invite-preview:ip:${id(ip)}`, 60, 600],
      [RATE_LIMITS.inviteAcceptIp(ip), `invite-accept:ip:${id(ip)}`, 20, 900],
      [RATE_LIMITS.teamChange(u), `team-change:user:${id(u)}`, 60, 600],
      [RATE_LIMITS.activityExport(u), `activity-export:user:${id(u)}`, 10, 600],
      [RATE_LIMITS.adminExport(u), `admin-export:user:${id(u)}`, 60, 600],
      [RATE_LIMITS.adminCustomerCreate(u), `admin-customer-create:user:${id(u)}`, 30, 3600],
      [RATE_LIMITS.adminCustomerWrite(u), `admin-customer-write:user:${id(u)}`, 60, 600],
      [RATE_LIMITS.adminSetPasswordLink(u), `admin-set-password:user:${id(u)}`, 5, 3600],
      [RATE_LIMITS.adminOrderQuote(u), `admin-order-quote:user:${id(u)}`, 120, 600],
      [RATE_LIMITS.adminOrderCreate(u), `admin-order-create:user:${id(u)}`, 30, 3600],
      [RATE_LIMITS.adminOrderWrite(u), `admin-order-write:user:${id(u)}`, 60, 600],
    ];
    for (const [rule, key, limit, windowSec] of cases) expect(rule).toEqual({ key, limit, windowSec });
  });

  it("buckets invitation previews and acceptances without a trusted IP as 'unknown'", () => {
    expect(RATE_LIMITS.invitePreviewIp(undefined).key).toBe(`invite-preview:ip:${id("unknown")}`);
    expect(RATE_LIMITS.inviteAcceptIp(null).key).toBe(`invite-accept:ip:${id("unknown")}`);
  });
});
