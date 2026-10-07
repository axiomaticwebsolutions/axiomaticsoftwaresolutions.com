/**
 * runDestructive() and csvExportResponse() against the database (test-plan "Permissions": destructive admin actions
 * without a reason return 422; successful ones create exactly one AuditLog row): validation before any write,
 * the change and its audit row in one transaction (a failure in either leaves neither), and audited exports.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { User } from "@/generated/prisma/client";
import { runDestructive } from "@/lib/admin/destructive";
import { csvExportResponse } from "@/lib/admin/export";
import { actorFromStaff, audit, type AuditActor } from "@/lib/audit";
import { db, type Tx } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { makeStaff } from "../support/admin-fixtures";

const tag = () => randomBytes(4).toString("hex").toUpperCase();

type Staff = { user: User; staff: { id: string; role: User["staffRole"] & string }; actor: AuditActor };
let finance: Staff;
let support: Staff;
let owner: Staff;
let admin: Staff;

async function staffOf(role: "OWNER" | "ADMIN" | "SUPPORT" | "FINANCE"): Promise<Staff> {
  const user = await makeStaff(role);
  return { user, staff: { id: user.id, role }, actor: actorFromStaff(user, "103.21.44.x") };
}

beforeAll(async () => {
  [owner, admin, support, finance] = await Promise.all([staffOf("OWNER"), staffOf("ADMIN"), staffOf("SUPPORT"), staffOf("FINANCE")]);
});

const auditRows = (targetId: string) => db.auditLog.findMany({ where: { targetId } });

/** A change inside the transaction that the test can look for afterwards. */
async function writeMarker(tx: Tx, id: string): Promise<string> {
  await tx.category.create({ data: { id, name: "Destructive test", tone: "sage", icon: "key" } });
  return id;
}
const markerExists = async (id: string) => (await db.category.findUnique({ where: { id } })) !== null;

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected an ApiError");
}

describe("runDestructive", () => {
  const refund = (who: Staff, input: { reason?: unknown; confirmId?: unknown }, orderId: string, marker: string) =>
    runDestructive(
      "orders.refund",
      { staff: who.staff, actor: who.actor, input, targetId: orderId, target: orderId, targetType: "order", detail: (r: string) => `marker ${r}` },
      (tx) => writeMarker(tx, marker),
    );

  it("answers 422 reason_required for a missing reason, before any write", async () => {
    const orderId = `AX-D${tag()}`;
    const marker = `dx-${tag()}`;
    const e = await rejection(refund(finance, { confirmId: orderId }, orderId, marker));
    expect([e.status, e.code, e.message]).toEqual([422, "reason_required", "Add a short reason for the audit log."]);
    expect(e.details).toEqual({ fieldErrors: { reason: ["Add a short reason for the audit log."] }, formErrors: [] });
    expect(await auditRows(orderId)).toHaveLength(0);
    expect(await markerExists(marker)).toBe(false);
  });

  it("answers 422 for a reason shorter than 4 characters (after trimming) or over 500", async () => {
    const orderId = `AX-D${tag()}`;
    expect((await rejection(refund(finance, { reason: "  ab ", confirmId: orderId }, orderId, `dx-${tag()}`))).code).toBe("reason_required");
    expect((await rejection(refund(finance, { reason: "x".repeat(501), confirmId: orderId }, orderId, `dx-${tag()}`))).code).toBe(
      "reason_too_long",
    );
    expect(await auditRows(orderId)).toHaveLength(0);
  });

  it("answers 422 confirm_mismatch for a wrong typed id", async () => {
    const orderId = `AX-D${tag()}`;
    const marker = `dx-${tag()}`;
    const e = await rejection(refund(finance, { reason: "Customer request", confirmId: orderId.toLowerCase() }, orderId, marker));
    expect([e.status, e.code]).toEqual([422, "confirm_mismatch"]);
    expect(e.details).toEqual({ fieldErrors: { confirmId: [`Type ${orderId} exactly to confirm.`] }, formErrors: [] });
    const both = await rejection(refund(finance, {}, orderId, marker));
    expect(both.code).toBe("reason_required");
    expect(Object.keys((both.details?.fieldErrors ?? {}) as object).sort()).toEqual(["confirmId", "reason"]);
    expect(await auditRows(orderId)).toHaveLength(0);
    expect(await markerExists(marker)).toBe(false);
  });

  it("answers 403 for a role without the action's permission", async () => {
    const orderId = `AX-D${tag()}`;
    const e = await rejection(refund(support, { reason: "Customer request", confirmId: orderId }, orderId, `dx-${tag()}`));
    expect([e.status, e.code, e.message]).toEqual([403, "forbidden", "Your role (Support) doesn\u2019t allow this."]);
    expect(await auditRows(orderId)).toHaveLength(0);
  });

  it("commits the change with exactly one audit row", async () => {
    const orderId = `AX-D${tag()}`;
    const marker = `dx-${tag()}`;
    const result = await refund(finance, { reason: "  Customer bought the wrong plan  ", confirmId: ` ${orderId} ` }, orderId, marker);
    expect(result).toBe(marker);
    expect(await markerExists(marker)).toBe(true);
    const rows = await auditRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: finance.user.id,
      actorRole: "finance",
      action: "Issued refund",
      target: orderId,
      targetType: "order",
      targetId: orderId,
      reason: "Customer bought the wrong plan",
      detail: `marker ${marker}`,
      ipPrefix: "103.21.44.x",
    });
  });

  it("writes nothing when the change fails", async () => {
    const licenseId = `LIC-D${tag()}`;
    const marker = `dx-${tag()}`;
    const failing = runDestructive(
      "licenses.revoke",
      { staff: admin.staff, actor: admin.actor, input: { reason: "Chargeback", confirmId: licenseId }, targetId: licenseId, target: licenseId, targetType: "license" },
      async (tx) => {
        await writeMarker(tx, marker);
        throw new ApiError(409, "already_revoked", "This license is already revoked.");
      },
    );
    expect((await rejection(failing)).code).toBe("already_revoked");
    expect(await markerExists(marker)).toBe(false);
    expect(await auditRows(licenseId)).toHaveLength(0);
  });

  it("rolls the change back when the audit row cannot be written", async () => {
    const licenseId = `LIC-D${tag()}`;
    const marker = `dx-${tag()}`;
    const ghost: AuditActor = { id: `missing-staff-${tag()}`, role: "admin", ipPrefix: null };
    await expect(
      runDestructive(
        "licenses.suspend",
        { staff: admin.staff, actor: ghost, input: { reason: "Payment dispute" }, targetId: licenseId, target: licenseId, targetType: "license" },
        (tx) => writeMarker(tx, marker),
      ),
    ).rejects.toThrow();
    expect(await markerExists(marker)).toBe(false);
    expect(await auditRows(licenseId)).toHaveLength(0);
  });
});

describe("runDestructive options", () => {
  it("needs no typed id for actions without one, and takes a custom label and detail", async () => {
    const licenseId = `LIC-D${tag()}`;
    await runDestructive(
      "licenses.extend",
      {
        staff: support.staff,
        actor: support.actor,
        input: { reason: "Goodwill extension" },
        targetId: licenseId,
        target: `Medical Store Billing · ${licenseId}`,
        targetType: "license",
        action: "Extended license +30 days",
        detail: "Ends 2027-01-06",
      },
      async () => undefined,
    );
    const rows = await auditRows(licenseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "Extended license +30 days", target: `Medical Store Billing · ${licenseId}`, detail: "Ends 2027-01-06" });
  });

  it("checks the typed id against confirmValue when the target id differs", async () => {
    const couponId = `cpn-${tag()}`;
    const code = `TEST${tag()}`;
    const opts = { staff: finance.staff, actor: finance.actor, targetId: couponId, target: code, targetType: "coupon", confirmValue: code };
    expect((await rejection(runDestructive("coupons.delete", { ...opts, input: { reason: "Expired promo", confirmId: couponId } }, async () => 0))).code).toBe(
      "confirm_mismatch",
    );
    await runDestructive("coupons.delete", { ...opts, input: { reason: "Expired promo", confirmId: code } }, async () => 0);
    expect(await auditRows(couponId)).toHaveLength(1);
  });

  it("masks license keys pasted into the reason", async () => {
    const licenseId = `LIC-D${tag()}`;
    await runDestructive(
      "licenses.suspend",
      {
        staff: owner.staff,
        actor: owner.actor,
        input: { reason: "Shared key MED-ABCD-EFGH-JKLM-NPQR on a forum" },
        targetId: licenseId,
        target: licenseId,
        targetType: "license",
      },
      async () => undefined,
    );
    const [row] = await auditRows(licenseId);
    expect(row?.reason).not.toContain("ABCD-EFGH-JKLM");
  });

  it("lets a self-auditing service write the single row (selfAudited)", async () => {
    const licenseId = `LIC-D${tag()}`;
    await runDestructive(
      "licenses.reset_devices",
      { staff: support.staff, actor: support.actor, input: { reason: "PC crash" }, targetId: licenseId, target: licenseId, targetType: "license", selfAudited: true },
      async (tx, ctx) => {
        expect(ctx.reason).toBe("PC crash");
        await audit(tx, ctx.actor, { action: "Reset devices", target: licenseId, targetType: "license", targetId: licenseId, reason: ctx.reason });
      },
    );
    expect(await auditRows(licenseId)).toHaveLength(1);
  });
});

describe("csvExportResponse", () => {
  type Row = { id: string; total: number; note: string };
  const columns = [
    { header: "Order", value: (r: Row) => r.id },
    { header: "Total (Rs)", value: (r: Row) => r.total },
    { header: "Note", value: (r: Row) => r.note },
  ];
  const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `AX-${10000 + i}`, total: 5898.82, note: i === 0 ? "=SUM(A1)" : "ok" }));

  it("returns the CSV and writes one 'Exported report' audit row", async () => {
    const fileName = `orders-${tag()}.csv`;
    const res = await csvExportResponse({
      staff: finance.staff,
      actor: finance.actor,
      perm: "reports.export",
      fileName,
      rows: rows(2),
      columns,
      auditTarget: "Orders",
      auditDetail: "status: paid",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv;charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain(fileName);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-row-count")).toBe("2");
    expect(res.headers.get("x-truncated")).toBeNull();
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)], "UTF-8 byte order mark").toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith(`"Order","Total (Rs)","Note"\r\n`)).toBe(true);
    expect(text).toContain(`"'=SUM(A1)"`);
    const audits = await auditRows(fileName);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: finance.user.id,
      action: "Exported report",
      target: "Orders",
      targetType: "report",
      detail: "CSV · 2 rows · status: paid",
    });
  });

  it("cuts the file at maxRows and says so", async () => {
    const fileName = `orders-${tag()}.csv`;
    const res = await csvExportResponse({ staff: owner.staff, actor: owner.actor, perm: "reports.export", fileName, rows: rows(4), columns, auditTarget: "Orders", maxRows: 3 });
    expect(res.headers.get("x-row-count")).toBe("3");
    expect(res.headers.get("x-truncated")).toBe("1");
    expect((await res.text()).trim().split("\r\n")).toHaveLength(4);
    expect((await auditRows(fileName))[0]?.detail).toBe("CSV · 3 rows (truncated)");
  });

  it("needs the export permission (audit export: audit.view)", async () => {
    const fileName = `audit-${tag()}.csv`;
    const denied = await rejection(
      csvExportResponse({ staff: support.staff, actor: support.actor, perm: "reports.export", fileName, rows: rows(1), columns, auditTarget: "Orders" }),
    );
    expect([denied.status, denied.message]).toEqual([403, "Export needs Owner / Finance"]);
    const adminReports = await rejection(
      csvExportResponse({ staff: admin.staff, actor: admin.actor, perm: "reports.export", fileName, rows: rows(1), columns, auditTarget: "Orders" }),
    );
    expect(adminReports.status).toBe(403);
    expect(await auditRows(fileName)).toHaveLength(0);
    const res = await csvExportResponse({ staff: admin.staff, actor: admin.actor, perm: "audit.view", fileName, rows: rows(1), columns, auditTarget: "Audit log" });
    expect(res.status).toBe(200);
    expect(await auditRows(fileName)).toHaveLength(1);
  });
});
