/**
 * Staff ticket attachments (decisions.md Phase 6 "staff attachments use Upload rows"; Phase 5 "Attachments").
 * A staff member uploads into the ticket's account with the portal's upload service, as the uploader, so:
 * - POST /api/admin/tickets/:id/uploads creates a PENDING Upload of the ticket's account (presigned PUT, 5 minutes,
 *   PNG/JPEG/PDF/TXT up to 10 MB), and .../uploads/:uploadId/confirm checks the stored object;
 * - a reply or note attaches only this staff member's own pending uploads of that account (lib/portal/uploads
 *   verifyAttachableUploads + attachUploads), so another person's file, or a file uploaded for another account's
 *   ticket, is refused (422 `attachmentIds`);
 * - customers download the files of public replies through the portal (GET /api/account/uploads/:id/download), never
 *   those of internal notes.
 * Staff download any attachment of the ticket they are looking at (internal notes included) or their own pending
 * upload for it, through 10-minute presigned links. Storage keys never leave the server. Server-only; routes check
 * `tickets.manage` first.
 */
import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { db as defaultDb } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import {
  ATTACHMENT_LINK_TTL_SECONDS,
  confirmUpload,
  createUpload,
  UPLOAD_MESSAGES,
  type AttachmentLink,
  type PresignedUpload,
  type UploadDto,
} from "@/lib/portal/uploads";
import { clampTtl, getStorage, type StorageDriver } from "@/lib/storage";
import type { UploadRequestInput } from "@/lib/validation/tickets";

async function ticketAccount(client: PrismaClient, ticketId: string): Promise<string> {
  const ticket = await client.supportTicket.findUnique({ where: { id: ticketId }, select: { accountId: true } });
  if (!ticket) throw errors.notFound("Ticket");
  return ticket.accountId;
}

/** Step 1 for a staff attachment: a pending Upload of the ticket's account and its presigned PUT. */
export async function createStaffTicketUpload(
  input: { ticketId: string; staffId: string; file: UploadRequestInput; now?: Date },
  client: PrismaClient = defaultDb,
  storage?: StorageDriver,
): Promise<{ upload: UploadDto; put: PresignedUpload }> {
  const accountId = await ticketAccount(client, input.ticketId);
  return createUpload({ accountId, userId: input.staffId, file: input.file, ...(input.now ? { now: input.now } : {}) }, client, storage);
}

/** Step 3: the object was PUT with the declared size. 404 for anyone else's upload or another account's. */
export async function confirmStaffTicketUpload(
  input: { ticketId: string; staffId: string; uploadId: string; now?: Date },
  client: PrismaClient = defaultDb,
  storage?: StorageDriver,
): Promise<{ upload: UploadDto }> {
  const accountId = await ticketAccount(client, input.ticketId);
  return confirmUpload({ accountId, userId: input.staffId, uploadId: input.uploadId, ...(input.now ? { now: input.now } : {}) }, client, storage);
}

/**
 * A 10-minute download link for staff: a file attached to any message of this ticket (internal notes included), or
 * the staff member's own pending upload in the ticket's account. Everything else is 404.
 */
export async function staffAttachmentLink(
  input: { ticketId: string; staffId: string; uploadId: string },
  client: PrismaClient = defaultDb,
  storage?: StorageDriver,
): Promise<AttachmentLink> {
  const accountId = await ticketAccount(client, input.ticketId);
  const upload = await client.upload.findFirst({ where: { id: input.uploadId, accountId } });
  if (!upload) throw errors.notFound("Attachment");
  let allowed = false;
  if (upload.status === "ATTACHED" && upload.ticketMessageId) {
    const message = await client.ticketMessage.findUnique({ where: { id: upload.ticketMessageId }, select: { ticketId: true } });
    allowed = message?.ticketId === input.ticketId;
  } else if (upload.status === "PENDING") {
    allowed = upload.uploadedById === input.staffId;
  }
  if (!allowed) throw errors.notFound("Attachment");
  try {
    const link = await (storage ?? (await getStorage())).presignGet(upload.storageKey, {
      ttlSec: clampTtl(ATTACHMENT_LINK_TTL_SECONDS),
      downloadName: upload.fileName,
    });
    log.info("admin_attachment_link_issued", { uploadId: upload.id, ticketId: input.ticketId });
    return { url: link.url, expiresAt: link.expiresAt.toISOString(), fileName: upload.fileName };
  } catch (error) {
    log.error("admin_attachment_presign_failed", { uploadId: upload.id, error });
    throw new ApiError(503, "download_unavailable", UPLOAD_MESSAGES.downloadUnavailable);
  }
}
