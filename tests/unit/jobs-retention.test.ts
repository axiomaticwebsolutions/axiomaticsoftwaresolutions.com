/**
 * Retention cutoffs of the maintenance job (lib/jobs/retention.ts): the values from docs/decisions.md "Phase 7
 * decisions", the shared constants they come from, and the boundary rules that must agree with the rest of the app.
 */
import { describe, expect, it } from "vitest";
import { closedCutoff, deriveAdminTicketStatus } from "@/lib/admin/tickets/model";
import { addCalendarMonths, DAY_MS } from "@/lib/dates";
import { maintenanceCutoffs, RETENTION } from "@/lib/jobs/retention";
import { PENDING_UPLOAD_MAX_AGE_MS } from "@/lib/portal/uploads";
import { TICKET_AUTO_CLOSE_DAYS } from "@/lib/validation/tickets";

const NOW = new Date("2026-10-07T10:15:30.250Z");
const before = (ms: number) => new Date(NOW.getTime() - ms);

describe("RETENTION", () => {
  it("matches the Phase 7 decisions and reuses the app's own limits", () => {
    expect(RETENTION).toEqual({
      ticketCloseDays: 14,
      pendingUploadMs: 24 * 60 * 60 * 1000,
      sentEmailDays: 30,
      deadSessionDays: 30,
      deadAuthTokenDays: 30,
      activityMonths: 24,
      webhookDeliveryDays: 180,
    });
    expect(RETENTION.ticketCloseDays).toBe(TICKET_AUTO_CLOSE_DAYS);
    expect(RETENTION.pendingUploadMs).toBe(PENDING_UPLOAD_MAX_AGE_MS);
    expect(Object.isFrozen(RETENTION)).toBe(true);
  });
});

describe("maintenanceCutoffs", () => {
  const c = maintenanceCutoffs(NOW);

  it("derives every boundary from the run's clock", () => {
    expect(c.now).toBe(NOW);
    expect(c.ticketsResolvedAtOrBefore).toEqual(before(14 * DAY_MS));
    expect(c.uploadsCreatedBefore).toEqual(before(24 * 3600_000));
    expect(c.emailsSentBefore).toEqual(before(30 * DAY_MS));
    expect(c.rateLimitsResetAtOrBefore).toEqual(NOW);
    expect(c.sessionsDeadBefore).toEqual(before(30 * DAY_MS));
    expect(c.authTokensDeadBefore).toEqual(before(30 * DAY_MS));
    expect(c.webhookDeliveriesReceivedBefore).toEqual(before(180 * DAY_MS));
  });

  it("counts activity retention in calendar months (IST), not 730 days", () => {
    expect(c.activityCreatedBefore).toEqual(new Date("2024-10-07T10:15:30.250Z"));
    expect(c.activityCreatedBefore).toEqual(addCalendarMonths(NOW, -24));
    // The month is taken in IST: 2026-02-28T18:30Z is 1 Mar 2026 in IST, so the cutoff is 1 Mar 2024 IST.
    expect(maintenanceCutoffs(new Date("2026-02-28T18:30:00.000Z")).activityCreatedBefore).toEqual(new Date("2024-02-29T18:30:00.000Z"));
    // Month-end clamping: 29 Feb 2028 IST minus 24 months is 28 Feb 2026 IST.
    expect(maintenanceCutoffs(new Date("2028-02-29T06:00:00.000Z")).activityCreatedBefore).toEqual(new Date("2026-02-28T06:00:00.000Z"));
  });

  it("closes tickets exactly when the console and portal start showing them as closed", () => {
    expect(c.ticketsResolvedAtOrBefore).toEqual(closedCutoff(NOW));
    const atCutoff = { status: "RESOLVED" as const, resolvedAt: c.ticketsResolvedAtOrBefore };
    const justAfter = { status: "RESOLVED" as const, resolvedAt: new Date(c.ticketsResolvedAtOrBefore.getTime() + 1) };
    expect(deriveAdminTicketStatus(atCutoff, NOW)).toBe("closed");
    expect(deriveAdminTicketStatus(justAfter, NOW)).toBe("resolved");
  });

  it("refuses an invalid clock", () => {
    expect(() => maintenanceCutoffs(new Date(Number.NaN))).toThrow(RangeError);
  });
});
