/**
 * Ticket attachments (docs/decisions.md Phase 5 "Tickets"; api-contracts section 5 POST /api/account/uploads).
 *
 * Flow: (1) createUpload() checks the file (PNG/JPEG/PDF/TXT whose extension matches, 1 byte-10 MB), stores an Upload
 * row (PENDING) and returns a presigned PUT (5 minutes) for `uploads/<accountId>/<uuid>/<sanitised name>`; the
 * content type and the declared size are part of the signature (S3 refuses any other Content-Length; the dev route
 * refuses larger bodies). (2) The browser PUTs the bytes straight to storage. (3) confirmUpload() checks head(): the
 * object exists and has exactly the declared size; a mismatch drops the row and deletes the object. (4) Creating a
 * ticket or a reply attaches up to 5 of the user's own pending uploads; the head() check runs again at that moment.
 * Downloads are presigned GETs of at most 10 minutes for members who can view tickets, only for attachments of
 * customer-visible messages of their own account (or the uploader's own pending file).
 *
 * Storage keys never leave the server except inside a signed URL. Server-only; routes authorize first.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { PrismaClient, Upload } from "@/generated/prisma/client";
import { db as defaultDb, type Db, type Tx } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import { clampTtl, getStorage, isStorageKey, type StorageDriver } from "@/lib/storage";
import { formatFileSize } from "@/lib/storefront/derive";
import {
  fileExtension,
  MAX_ATTACHMENT_BYTES,
  TICKET_ERRORS,
  type AttachmentContentType,
  type UploadRequestInput,
} from "@/lib/validation/tickets";

/**
 * Presigned PUT lifetime. The browser uploads right after asking for the URL, and S3 checks the expiry when the upload
 * starts, so 5 minutes is ample; it also bounds how long the uploader could replace the file (same size) afterwards.
 */
export const UPLOAD_PUT_TTL_SECONDS = 300;
/** Attachment download links: 10 minutes (decisions.md), also capped by DOWNLOAD_LINK_TTL_SECONDS. */
export const ATTACHMENT_LINK_TTL_SECONDS = 600;
/** A pending upload must be attached within this time; afterwards it is treated as abandoned. */
export const PENDING_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Unattached uploads one user may hold in an account at a time (within PENDING_UPLOAD_MAX_AGE_MS). */
export const PENDING_UPLOADS_PER_USER = 25;
const SAFE_NAME_MAX = 80;

export const UPLOAD_MESSAGES = {
  unavailable: "We can’t accept attachments right now. Please try again in a few minutes.",
  tooManyPending: "You have too many files waiting to be sent. Send your message, or try again tomorrow.",
  attached: "This file is already attached to a message.",
  missing: "We didn’t receive this file. Try attaching it again.",
  mismatch: "This file doesn’t match what was uploaded. Try attaching it again.",
  downloadUnavailable: "This attachment can’t be downloaded right now. Please try again in a few minutes.",
} as const;

export type UploadStatusKey = "pending" | "ready" | "attached";

export type UploadDto = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** "214 KB" */
  sizeLabel: string;
  status: UploadStatusKey;
};

export type PresignedUpload = {
  url: string;
  method: "PUT";
  /** Send exactly these headers with the PUT, or storage rejects the signature. */
  headers: Record<string, string>;
  expiresAt: string;
};

function toDto(upload: Pick<Upload, "id" | "fileName" | "contentType" | "sizeBytes" | "status">, status?: UploadStatusKey): UploadDto {
  return {
    id: upload.id,
    fileName: upload.fileName,
    contentType: upload.contentType,
    sizeBytes: upload.sizeBytes,
    sizeLabel: formatFileSize(upload.sizeBytes),
    status: status ?? (upload.status === "ATTACHED" ? "attached" : "pending"),
  };
}

/**
 * The last key segment: ASCII letters, digits, ".", "_" and "-" only (accents dropped, everything else becomes "-"),
 * starting with a letter or digit, at most 80 characters before the extension, which is kept ("file.png" fallback).
 */
export function sanitizeUploadName(fileName: string): string {
  const ext = fileExtension(fileName);
  const base = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
  const cleaned = base
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, SAFE_NAME_MAX)
    .replace(/[._-]+$/, "");
  const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
  return `${cleaned || "file"}${safeExt}`;
}

/** "uploads/<accountId>/<uuid>/<sanitised name>"; throws for an account id that cannot be a key segment. */
export function uploadStorageKey(accountId: string, fileName: string, uuid: string = randomUUID()): string {
  const key = `uploads/${accountId}/${uuid}/${sanitizeUploadName(fileName)}`;
  if (!isStorageKey(key)) throw new RangeError("Upload key is not a valid storage key.");
  return key;
}

function pendingSince(now: Date): Date {
  return new Date(now.getTime() - PENDING_UPLOAD_MAX_AGE_MS);
}

export type CreateUploadInput = {
  accountId: string;
  userId: string;
  file: UploadRequestInput;
  now?: Date;
};

/** Step 1: an Upload row (PENDING) and the presigned PUT for it. 429 `too_many_uploads`, 503 `upload_unavailable`. */
export async function createUpload(
  input: CreateUploadInput,
  client: PrismaClient = defaultDb,
  storage?: StorageDriver,
): Promise<{ upload: UploadDto; put: PresignedUpload }> {
  const now = input.now ?? new Date();
  const pending = await client.upload.count({
    where: { accountId: input.accountId, uploadedById: input.userId, status: "PENDING", createdAt: { gte: pendingSince(now) } },
  });
  if (pending >= PENDING_UPLOADS_PER_USER) throw new ApiError(429, "too_many_uploads", UPLOAD_MESSAGES.tooManyPending);

  const storageKey = uploadStorageKey(input.accountId, input.file.fileName);
  let put;
  try {
    put = await (storage ?? (await getStorage())).presignPut(storageKey, {
      ttlSec: UPLOAD_PUT_TTL_SECONDS,
      contentType: input.file.contentType,
      maxBytes: input.file.sizeBytes,
    });
  } catch (error) {
    log.error("upload_presign_failed", { accountId: input.accountId, error });
    throw new ApiError(503, "upload_unavailable", UPLOAD_MESSAGES.unavailable);
  }
  const upload = await client.upload.create({
    data: {
      accountId: input.accountId,
      uploadedById: input.userId,
      storageKey,
      fileName: input.file.fileName,
      contentType: input.file.contentType,
      sizeBytes: input.file.sizeBytes,
      status: "PENDING",
      createdAt: now,
    },
  });
  log.info("upload_presigned", { uploadId: upload.id, accountId: input.accountId, sizeBytes: upload.sizeBytes });
  return {
    upload: toDto(upload),
    put: { url: put.url, method: put.method, headers: put.headers, expiresAt: put.expiresAt.toISOString() },
  };
}

/** The given driver, else the effective one; storage not configured (or unreachable) -> 503 `upload_unavailable`. */
async function uploadDriver(storage: StorageDriver | undefined): Promise<StorageDriver> {
  if (storage) return storage;
  try {
    return await getStorage();
  } catch (error) {
    log.error("upload_storage_unavailable", { error });
    throw new ApiError(503, "upload_unavailable", UPLOAD_MESSAGES.unavailable);
  }
}

async function headSize(storage: StorageDriver, key: string): Promise<number | null> {
  try {
    const head = await storage.head(key);
    return head ? head.sizeBytes : null;
  } catch (error) {
    log.error("upload_head_failed", { error });
    throw new ApiError(503, "upload_unavailable", UPLOAD_MESSAGES.unavailable);
  }
}

/** Best effort: a refused object must not stay in the bucket, but a storage hiccup must not hide the 422 either. */
async function deleteStoredObject(storage: StorageDriver, key: string, uploadId: string): Promise<void> {
  try {
    await storage.delete(key);
  } catch (error) {
    log.error("upload_delete_failed", { uploadId, error });
  }
}

/** The stored object is there and exactly as large as declared (never above the 10 MB limit). */
function sizeMatches(upload: Pick<Upload, "sizeBytes">, stored: number): boolean {
  return stored === upload.sizeBytes && stored >= 1 && stored <= MAX_ATTACHMENT_BYTES;
}

export type UploadRef = { accountId: string; userId: string; uploadId: string; now?: Date };

/**
 * Step 3: checks the uploaded object. 404 for someone else's upload (or another account's), 409 `upload_attached`,
 * 409 `upload_missing` (nothing was PUT yet), 422 `upload_mismatch` (size differs; the row is dropped).
 */
export async function confirmUpload(ref: UploadRef, client: PrismaClient = defaultDb, storage?: StorageDriver): Promise<{ upload: UploadDto }> {
  const now = ref.now ?? new Date();
  const upload = await client.upload.findFirst({ where: { id: ref.uploadId, accountId: ref.accountId, uploadedById: ref.userId } });
  if (!upload) throw errors.notFound("Attachment");
  if (upload.status === "ATTACHED") throw errors.conflict("upload_attached", UPLOAD_MESSAGES.attached);
  if (upload.createdAt.getTime() < pendingSince(now).getTime()) throw errors.conflict("upload_missing", UPLOAD_MESSAGES.missing);
  const driver = await uploadDriver(storage);
  const stored = await headSize(driver, upload.storageKey);
  if (stored === null) throw errors.conflict("upload_missing", UPLOAD_MESSAGES.missing);
  if (!sizeMatches(upload, stored)) {
    const { count } = await client.upload.deleteMany({ where: { id: upload.id, status: "PENDING" } });
    if (count === 1) await deleteStoredObject(driver, upload.storageKey, upload.id);
    log.warn("upload_size_mismatch", { uploadId: upload.id, declared: upload.sizeBytes, stored });
    throw new ApiError(422, "upload_mismatch", UPLOAD_MESSAGES.mismatch);
  }
  return { upload: toDto(upload, "ready") };
}

function unavailableAttachments(): ApiError {
  return errors.validation({ attachmentIds: TICKET_ERRORS.attachmentUnavailable });
}

/**
 * Before a ticket or reply is written: every id must be a recent PENDING upload of this user in this account whose
 * object is in storage with the declared size. Returns them in the given order; 422 `fieldErrors.attachmentIds`
 * otherwise. Runs outside any transaction (storage calls).
 */
export async function verifyAttachableUploads(
  input: { accountId: string; userId: string; ids: readonly string[]; now?: Date },
  client: Db = defaultDb,
  storage?: StorageDriver,
): Promise<Upload[]> {
  if (input.ids.length === 0) return [];
  const now = input.now ?? new Date();
  const rows = await client.upload.findMany({
    where: {
      id: { in: [...input.ids] },
      accountId: input.accountId,
      uploadedById: input.userId,
      status: "PENDING",
      createdAt: { gte: pendingSince(now) },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = input.ids.map((id) => byId.get(id));
  if (ordered.some((u) => !u)) throw unavailableAttachments();
  const driver = await uploadDriver(storage);
  const uploads = ordered as Upload[];
  for (const upload of uploads) {
    const stored = await headSize(driver, upload.storageKey);
    if (stored === null || !sizeMatches(upload, stored)) throw unavailableAttachments();
  }
  return uploads;
}

/** TicketMessage.attachments entry. `uploadId` is absent on sample/legacy rows (their files cannot be downloaded). */
export type AttachmentJson = {
  uploadId?: string;
  name: string;
  sizeBytes: number;
  contentType?: string;
  storageKey: string;
};

export function attachmentsJson(uploads: readonly Upload[]): AttachmentJson[] {
  return uploads.map((u) => ({ uploadId: u.id, name: u.fileName, sizeBytes: u.sizeBytes, contentType: u.contentType, storageKey: u.storageKey }));
}

/**
 * Inside the message's transaction: marks the uploads ATTACHED to it. A concurrent request that attached one of them
 * first makes this fail (409 `attachment_unavailable`), which rolls the whole message back.
 */
export async function attachUploads(
  tx: Tx,
  input: { accountId: string; userId: string; ids: readonly string[]; ticketMessageId: string; now: Date },
): Promise<void> {
  if (input.ids.length === 0) return;
  const { count } = await tx.upload.updateMany({
    where: { id: { in: [...input.ids] }, accountId: input.accountId, uploadedById: input.userId, status: "PENDING" },
    data: { status: "ATTACHED", ticketMessageId: input.ticketMessageId, attachedAt: input.now },
  });
  if (count !== input.ids.length) {
    throw new ApiError(409, "attachment_unavailable", TICKET_ERRORS.attachmentUnavailable, {
      details: { fieldErrors: { attachmentIds: [TICKET_ERRORS.attachmentUnavailable] } },
    });
  }
}

export type AttachmentView = {
  /** Upload id for GET /api/account/uploads/:id/download, or null when the file cannot be downloaded (samples). */
  id: string | null;
  name: string;
  sizeBytes: number;
  /** "214 KB" */
  sizeLabel: string;
  contentType: AttachmentContentType | null;
};

const VIEW_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "application/pdf", "text/plain"]);

/** Reads TicketMessage.attachments defensively (it is JSON); never exposes storage keys. */
export function attachmentViews(value: unknown): AttachmentView[] {
  if (!Array.isArray(value)) return [];
  const out: AttachmentView[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== "string") continue;
    const sizeBytes = typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes) ? Math.max(0, Math.floor(entry.sizeBytes)) : 0;
    const type = typeof entry.contentType === "string" && VIEW_TYPES.has(entry.contentType) ? (entry.contentType as AttachmentContentType) : null;
    out.push({
      id: typeof entry.uploadId === "string" ? entry.uploadId : null,
      name: entry.name,
      sizeBytes,
      sizeLabel: formatFileSize(sizeBytes),
      contentType: type,
    });
  }
  return out;
}

export type AttachmentLink = { url: string; expiresAt: string; fileName: string };

/**
 * A 10-minute presigned GET for one attachment. Allowed for an upload of this account that is attached to a
 * customer-visible message of one of its tickets, or for the requesting user's own pending upload. Everything else,
 * including staff-only notes and other accounts' files, is 404.
 */
export async function attachmentDownloadLink(ref: UploadRef, client: PrismaClient = defaultDb, storage?: StorageDriver): Promise<AttachmentLink> {
  const upload = await client.upload.findFirst({ where: { id: ref.uploadId, accountId: ref.accountId } });
  if (!upload) throw errors.notFound("Attachment");
  let allowed = false;
  if (upload.status === "ATTACHED" && upload.ticketMessageId) {
    const message = await client.ticketMessage.findUnique({
      where: { id: upload.ticketMessageId },
      select: { internal: true, ticket: { select: { accountId: true } } },
    });
    allowed = Boolean(message && !message.internal && message.ticket.accountId === ref.accountId);
  } else if (upload.status === "PENDING") {
    allowed = upload.uploadedById === ref.userId;
  }
  if (!allowed) throw errors.notFound("Attachment");

  try {
    const link = await (storage ?? (await getStorage())).presignGet(upload.storageKey, {
      ttlSec: clampTtl(ATTACHMENT_LINK_TTL_SECONDS),
      downloadName: upload.fileName,
    });
    log.info("attachment_link_issued", { uploadId: upload.id, accountId: ref.accountId });
    return { url: link.url, expiresAt: link.expiresAt.toISOString(), fileName: upload.fileName };
  } catch (error) {
    log.error("attachment_presign_failed", { uploadId: upload.id, error });
    throw new ApiError(503, "download_unavailable", UPLOAD_MESSAGES.downloadUnavailable);
  }
}
