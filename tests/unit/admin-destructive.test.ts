import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DESTRUCTIVE_AUDIT_ACTIONS,
  destructiveBodySchema,
  destructiveFields,
  runDestructive,
  validateDestructive,
  type DestructiveClient,
} from "@/lib/admin/destructive";
import type { AuditActor } from "@/lib/audit";
import type { Tx } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { DESTRUCTIVE_ACTIONS, STAFF_ROLES, can, type DestructiveActionKey } from "@/lib/rbac";

const ACTION_KEYS = Object.keys(DESTRUCTIVE_ACTIONS) as DestructiveActionKey[];

function thrown(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected an ApiError");
}

describe("validateDestructive", () => {
  const finance = { role: "FINANCE" as const };

  it.each(ACTION_KEYS.flatMap((key) => STAFF_ROLES.map((role) => [key, role] as const)))("%s as %s follows the action's permission", (key, role) => {
    const check = () => validateDestructive(key, { staff: { role }, input: { reason: "Valid reason", confirmId: "X-1" }, confirmValue: "X-1" });
    if (can(role, DESTRUCTIVE_ACTIONS[key].perm)) expect(check()).toEqual({ reason: "Valid reason" });
    else expect(thrown(check).status).toBe(403);
  });

  it("requires a reason of 4 to 500 characters for every action", () => {
    for (const key of ACTION_KEYS) {
      const check = (reason: unknown) => () =>
        validateDestructive(key, { staff: { role: "OWNER" }, input: { reason, confirmId: "X-1" }, confirmValue: "X-1" });
      for (const reason of [undefined, null, "", "   ", "abc", 42, { text: "long enough" }]) {
        expect(thrown(check(reason)).code, `${key} ${JSON.stringify(reason)}`).toBe("reason_required");
      }
      expect(thrown(check("x".repeat(501))).code).toBe("reason_too_long");
      expect(check("  four  ")()).toEqual({ reason: "four" });
    }
  });

  it("requires the typed id exactly for refund, revoke and coupon delete only", () => {
    for (const key of ACTION_KEYS) {
      const check = (confirmId: unknown) => () =>
        validateDestructive(key, { staff: { role: "OWNER" }, input: { reason: "Valid reason", confirmId }, confirmValue: "AX-10301" });
      if (DESTRUCTIVE_ACTIONS[key].typedId) {
        const e = thrown(check("ax-10301"));
        expect([e.status, e.code, e.message]).toEqual([422, "confirm_mismatch", "Type AX-10301 exactly to confirm."]);
        expect(e.details).toEqual({ fieldErrors: { confirmId: ["Type AX-10301 exactly to confirm."] }, formErrors: [] });
        expect(thrown(check(undefined)).code).toBe("confirm_mismatch");
        expect(check(" AX-10301 ")()).toEqual({ reason: "Valid reason" });
      } else {
        expect(check(undefined)()).toEqual({ reason: "Valid reason" });
      }
    }
  });

  it("reports both fields when both are wrong", () => {
    const e = thrown(() => validateDestructive("orders.refund", { staff: finance, input: {}, confirmValue: "AX-1" }));
    expect(e.code).toBe("reason_required");
    expect(e.details).toEqual({
      fieldErrors: { reason: ["Add a short reason for the audit log."], confirmId: ["Type AX-1 exactly to confirm."] },
      formErrors: [],
    });
  });

  it("checks the permission before the input", () => {
    const e = thrown(() => validateDestructive("orders.refund", { staff: { role: "SUPPORT" }, input: {}, confirmValue: "AX-1" }));
    expect([e.status, e.message]).toEqual([403, "Your role (Support) doesn\u2019t allow this."]);
  });
});

describe("runDestructive (fake client)", () => {
  const actor: AuditActor = { id: "staff-1", role: "finance", ipPrefix: "103.21.44.x" };

  function fakeClient() {
    const calls: string[] = [];
    const create = vi.fn(async () => {
      calls.push("audit");
      return {};
    });
    const tx = { auditLog: { create } } as unknown as Tx;
    const client: DestructiveClient & { transactions: number } = {
      transactions: 0,
      async $transaction<R>(fn: (t: Tx) => Promise<R>): Promise<R> {
        client.transactions += 1;
        calls.push("begin");
        const result = await fn(tx);
        calls.push("commit");
        return result;
      },
    };
    return { client, calls, create };
  }

  const base = { staff: { id: "staff-1", role: "FINANCE" as const }, actor, targetId: "AX-10301", target: "AX-10301", targetType: "order" };

  it("validates before opening a transaction", async () => {
    const fake = fakeClient();
    await expect(runDestructive("orders.refund", { ...base, input: { reason: "no" }, client: fake.client }, async () => 1)).rejects.toMatchObject({
      status: 422,
    });
    expect(fake.client.transactions).toBe(0);
  });

  it("runs the change, then writes one audit row in the same transaction", async () => {
    const fake = fakeClient();
    const result = await runDestructive(
      "orders.refund",
      { ...base, input: { reason: " Wrong plan ", confirmId: "AX-10301" }, detail: (r: number) => `Rs ${r}`, client: fake.client },
      async (_tx, ctx) => {
        fake.calls.push(`change:${ctx.reason}`);
        return 4128;
      },
    );
    expect(result).toBe(4128);
    expect(fake.calls).toEqual(["begin", "change:Wrong plan", "audit", "commit"]);
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(fake.create).toHaveBeenCalledWith({
      data: {
        actorId: "staff-1",
        actorRole: "finance",
        action: "Issued refund",
        target: "AX-10301",
        targetType: "order",
        targetId: "AX-10301",
        reason: "Wrong plan",
        detail: "Rs 4128",
        ipPrefix: "103.21.44.x",
      },
    });
  });

  it("writes no audit row when the change throws or the service audits itself", async () => {
    const failing = fakeClient();
    await expect(
      runDestructive("orders.refund", { ...base, input: { reason: "Wrong plan", confirmId: "AX-10301" }, client: failing.client }, async () => {
        throw new Error("provider down");
      }),
    ).rejects.toThrow("provider down");
    expect(failing.create).not.toHaveBeenCalled();
    const self = fakeClient();
    await runDestructive("orders.refund", { ...base, input: { reason: "Wrong plan", confirmId: "AX-10301" }, selfAudited: true, client: self.client }, async () => 0);
    expect(self.create).not.toHaveBeenCalled();
  });
});

describe("destructive vocabulary and body fields", () => {
  it("has a past-tense audit label (the prototype's audit vocabulary) for every action", () => {
    expect(DESTRUCTIVE_AUDIT_ACTIONS).toEqual({
      "orders.refund": "Issued refund",
      "licenses.revoke": "Revoked license",
      "licenses.suspend": "Suspended license",
      "licenses.reinstate": "Reinstated license",
      "licenses.extend": "Extended license",
      "licenses.reset_devices": "Reset devices",
      "licenses.deactivate_device": "Deactivated device",
      "licenses.issue_manual": "Issued license",
      "plans.archive": "Archived plan",
      "plans.restore": "Restored plan",
      "products.hide": "Hid product",
      "products.publish": "Published product",
      "categories.delete": "Deleted category",
      "releases.delete": "Deleted release draft",
      "releases.remove_installer": "Removed installer",
      "coupons.delete": "Deleted coupon",
      "faqs.delete": "Deleted FAQ",
      "staff.change_role": "Changed staff role",
      "staff.deactivate": "Deactivated staff",
      "staff.reactivate": "Reactivated staff",
      "staff.revoke_invite": "Revoked staff invitation",
    });
    expect(Object.keys(DESTRUCTIVE_AUDIT_ACTIONS).sort()).toEqual([...ACTION_KEYS].sort());
  });

  it("accepts reason and confirmId (optional, so runDestructive owns the messages) and nothing else", () => {
    expect(destructiveBodySchema.parse({ reason: "Wrong plan", confirmId: "AX-1" })).toEqual({ reason: "Wrong plan", confirmId: "AX-1" });
    expect(destructiveBodySchema.parse({})).toEqual({});
    expect(destructiveBodySchema.safeParse({ reason: "x", amount: 1 }).success).toBe(false);
    const extended = z.strictObject({ ...destructiveFields, days: z.int().min(1).max(365) });
    expect(extended.parse({ reason: "Goodwill", days: 30 })).toEqual({ reason: "Goodwill", days: 30 });
  });
});
