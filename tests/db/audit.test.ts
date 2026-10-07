import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR, actorFromStaff, audit, requireReason } from "@/lib/audit";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";

const KEY = "MED-7Q4K-9XTP-W2HD-K8NM";

beforeEach(async () => {
  await db.auditLog.deleteMany({});
});

async function staffUser() {
  return db.user.create({
    data: {
      email: `vikram.${randomBytes(4).toString("hex")}@axiomatic.example`,
      name: "Vikram Rao",
      kind: "STAFF",
      staffRole: "ADMIN",
      staffStatus: "ACTIVE",
    },
  });
}

describe("audit", () => {
  it("writes exactly one row with the actor, target and masked text", async () => {
    const user = await staffUser();
    await db.$transaction((tx) =>
      audit(tx, actorFromStaff(user, "103.21.44.x"), {
        action: "Revoked license",
        target: "LIC-24200",
        targetType: "license",
        targetId: "LIC-24200",
        reason: `Fraud: key ${KEY} was posted publicly`,
        detail: `Customer quoted ${KEY.toLowerCase()} in a ticket`,
      }),
    );
    const rows = await db.auditLog.findMany({});
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      actorId: user.id,
      actorRole: "admin",
      action: "Revoked license",
      target: "LIC-24200",
      targetType: "license",
      targetId: "LIC-24200",
      ipPrefix: "103.21.44.x",
    });
    expect(row?.reason).not.toContain(KEY);
    expect(row?.reason).toContain("K8NM");
    expect(row?.detail?.toUpperCase()).not.toContain(KEY);
  });

  it("records system actions without an actor id", async () => {
    await db.$transaction((tx) => audit(tx, SYSTEM_ACTOR, { action: "Webhook processed", target: "payment.captured AX-10294" }));
    const rows = await db.auditLog.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: null, actorRole: "system", reason: null, detail: null, ipPrefix: null });
  });

  it("writes nothing when the surrounding transaction rolls back", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await audit(tx, SYSTEM_ACTOR, { action: "Issued refund", target: "AX-10288" });
        throw new Error("provider refund failed");
      }),
    ).rejects.toThrow("provider refund failed");
    expect(await db.auditLog.count()).toBe(0);
  });

  it("maps every staff role and refuses non-staff actors", () => {
    const roles = [
      ["OWNER", "owner"],
      ["ADMIN", "admin"],
      ["SUPPORT", "support"],
      ["FINANCE", "finance"],
    ] as const;
    for (const [staffRole, role] of roles) expect(actorFromStaff({ id: "u1", staffRole }).role).toBe(role);
    expect(() => actorFromStaff({ id: "u1", staffRole: null })).toThrow();
  });
});

describe("requireReason", () => {
  it("returns the trimmed reason", () => {
    expect(requireReason("  PC crash  ")).toBe("PC crash");
  });

  it("throws 422 reason_required with the admin copy for short or missing reasons", () => {
    for (const input of ["", "   ", "abc", " ab ", undefined, null, 42]) {
      let caught: unknown = null;
      try {
        requireReason(input);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(422);
      expect((caught as ApiError).code).toBe("reason_required");
      expect((caught as ApiError).message).toBe("Add a short reason for the audit log.");
    }
  });
});
