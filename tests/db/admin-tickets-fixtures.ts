/**
 * Fixtures for the staff ticket tests: tickets with messages in a fresh customer account (ids from the shared
 * "ticket" counter), staff of each role and a unique tag for subjects so searches only see this file's rows (DB test
 * files share one schema per run). Not a test file.
 */
import { randomBytes } from "node:crypto";
import type { TicketPriority, TicketStatus, User } from "@/generated/prisma/client";
import { actorFromStaff, type AuditActor } from "@/lib/audit";
import { nextTicketId } from "@/lib/counters";
import { db } from "@/lib/db";
import { makeCustomer, makeStaff } from "../support/admin-fixtures";

export const tag = () => randomBytes(4).toString("hex");

export type TicketMessageSeed = { authorId: string; isStaff?: boolean; internal?: boolean; body?: string; at?: Date; attachments?: unknown[] };

export type TicketSeed = {
  accountId: string;
  openedById?: string | null;
  subject?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  productId?: string | null;
  licenseId?: string | null;
  assigneeId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  resolvedAt?: Date | null;
  firstResponseAt?: Date | null;
  messages?: TicketMessageSeed[];
};

/** A ticket (opened by `openedById` with a first message unless messages are given). Returns its id. */
export async function makeTicket(seed: TicketSeed): Promise<string> {
  const createdAt = seed.createdAt ?? new Date();
  return db.$transaction(async (tx) => {
    const id = await nextTicketId(tx);
    await tx.supportTicket.create({
      data: {
        id,
        accountId: seed.accountId,
        openedById: seed.openedById ?? null,
        subject: seed.subject ?? "Barcode scanner stops working",
        status: seed.status ?? "OPEN",
        priority: seed.priority ?? "NORMAL",
        productId: seed.productId ?? null,
        licenseId: seed.licenseId ?? null,
        assigneeId: seed.assigneeId ?? null,
        resolvedAt: seed.resolvedAt ?? null,
        firstResponseAt: seed.firstResponseAt ?? null,
        createdAt,
        updatedAt: seed.updatedAt ?? createdAt,
      },
    });
    const messages = seed.messages ?? (seed.openedById ? [{ authorId: seed.openedById, body: "Since the update the scanner does nothing." }] : []);
    for (const [i, m] of messages.entries()) {
      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorId: m.authorId,
          isStaff: m.isStaff ?? false,
          internal: m.internal ?? false,
          body: m.body ?? `Message ${i + 1}`,
          attachments: (m.attachments ?? []) as never,
          createdAt: m.at ?? new Date(createdAt.getTime() + i * 1000),
        },
      });
    }
    return id;
  });
}

export type StaffSet = { owner: User; admin: User; support: User; finance: User };

export async function makeStaffSet(): Promise<StaffSet> {
  const [owner, admin, support, finance] = await Promise.all([makeStaff("OWNER"), makeStaff("ADMIN"), makeStaff("SUPPORT"), makeStaff("FINANCE")]);
  return { owner, admin, support, finance };
}

export function actorOf(user: User): AuditActor {
  return actorFromStaff(user, "203.0.113");
}

export function staffOf(user: User): { id: string; name: string } {
  return { id: user.id, name: user.name };
}

export { makeCustomer };
