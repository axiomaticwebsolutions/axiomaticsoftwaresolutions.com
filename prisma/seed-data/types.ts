/**
 * Row shapes of the seed plan. Scalar-only Prisma "CreateMany" inputs plus a required id, so one object serves as
 * both the `create` and the `update` side of an upsert.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { PasswordSource } from "./people";

export type WithId<T> = T & { id: string };

export type SeedUser = { row: WithId<Prisma.UserCreateManyInput>; password: PasswordSource };

/** Fixed keys are the prototype's sample keys; random ones are drawn with crypto.randomInt on first insert only. */
export type SeedLicenseKey = { kind: "fixed"; key: string } | { kind: "random"; productCode: string };

export type SeedLicense = {
  row: WithId<Omit<Prisma.LicenseCreateManyInput, "keyHash" | "keyCiphertext" | "keyLast4">>;
  key: SeedLicenseKey;
};

export type DeviceRow = WithId<Prisma.DeviceActivationCreateManyInput>;
export type LicenseEventRow = WithId<Prisma.LicenseEventCreateManyInput>;
export type TicketRow = WithId<Prisma.SupportTicketCreateManyInput>;
export type TicketMessageRow = WithId<Prisma.TicketMessageCreateManyInput>;
export type NotificationRow = WithId<Prisma.NotificationCreateManyInput>;
export type ActivityRow = WithId<Prisma.AccountActivityCreateManyInput>;

/** Ticket attachment JSON ({ name, sizeBytes, storageKey }); sample attachments have no stored object. */
export type AttachmentJson = { name: string; sizeBytes: number; storageKey: string };

/** Devices compute a SHA-256 fingerprint of hardware ids; sample devices hash a label instead. */
export function sampleFingerprint(deviceKey: string): string {
  return createHash("sha256").update(`SAMPLE device ${deviceKey}`, "utf8").digest("hex");
}
