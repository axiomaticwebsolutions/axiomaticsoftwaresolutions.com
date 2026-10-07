/** Route segment helpers for the staff ticket API (404 without a query for ids that cannot exist). Server-only. */
import "server-only";
import { idParam, type AdminParams } from "@/lib/admin/http";
import { errors } from "@/lib/http";
import { isTicketId, isUploadId } from "./schema";

/** The `[id]` segment as a ticket id ("T-3018"), else 404 "Ticket not found.". */
export function ticketIdParam(params: AdminParams): string {
  const id = idParam(params, "id", "Ticket");
  if (!isTicketId(id)) throw errors.notFound("Ticket");
  return id;
}

/** The `[uploadId]` segment as an upload id, else 404 "Attachment not found.". */
export function uploadIdParam(params: AdminParams): string {
  const id = idParam(params, "uploadId", "Attachment");
  if (!isUploadId(id)) throw errors.notFound("Attachment");
  return id;
}
