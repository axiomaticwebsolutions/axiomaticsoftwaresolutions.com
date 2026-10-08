/**
 * Issues one protected download (api-contracts section 5, decisions.md Phase 4 "Downloads and software"):
 * 1. the release file must exist (404) and its release must be PUBLISHED, released and on the stable channel (other
 *    channels answer 403 `not_entitled` reason `not_released`: customers are only offered stable releases);
 * 2. the licenses in scope (the account's, or those an order issued) for the release's product are compared with
 *    pickEntitlingLicense(); none entitled -> 403 `not_entitled` with `reason`;
 * 3. a presigned GET for the private object, never longer than 600 s (min(setting, env, 600));
 * 4. DownloadEvent (user, license, file, link expiry) and the account activity entry "Downloaded installer" are
 *    written in one transaction.
 * The URL (it carries a signature) is never logged. Server-only; callers authorize and rate-limit first.
 */
import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/http";
import { ENTITLEMENT_MESSAGES, pickEntitlingLicense, STABLE_CHANNEL, type DownloadDenial } from "@/lib/licensing/entitlement";
import { log } from "@/lib/log";
import { getStorage, MAX_PRESIGN_TTL_SECONDS, type PresignedGet, type StorageDriver } from "@/lib/storage";
import { formatFileSize } from "@/lib/storefront/derive";
import type { DownloadLinkResponse } from "./model";

export const DOWNLOAD_ACTIVITY_ACTION = "Downloaded installer";
export const DOWNLOAD_ACTIVITY_KIND = "download";
export const DOWNLOAD_NOT_FOUND_MESSAGE = "We couldn\u2019t find that download. Refresh the page and try again.";
export const DOWNLOAD_UNAVAILABLE_MESSAGE =
  "This download isn\u2019t available right now. Please try again in a few minutes or contact support.";

/** 403 `not_entitled` with the reason and the customer-facing copy for it. */
export function notEntitledError(reason: DownloadDenial): ApiError {
  return new ApiError(403, "not_entitled", ENTITLEMENT_MESSAGES[reason], { details: { reason } });
}

/** Which licenses may entitle the download: the account's, or only those the order issued (guest downloads). */
export type DownloadScope = { kind: "account"; accountId: string } | { kind: "order"; orderId: string };

export type IssueDownloadInput = {
  fileId: string;
  scope: DownloadScope;
  /** DownloadEvent.userId: the signed-in user's id, or "guest:<orderId>". */
  eventUserId: string;
  /** Account activity actor name. */
  actorName: string;
  /** Link lifetime from downloadTtlSeconds(); capped at 600 s here too. */
  ttlSec: number;
  now?: Date;
  storage?: StorageDriver;
};

export function guestDownloadUserId(orderId: string): string {
  return `guest:${orderId}`;
}

function linkTtl(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) throw new RangeError("Download link TTL must be at least 1 second.");
  return Math.min(Math.floor(requested), MAX_PRESIGN_TTL_SECONDS);
}

export async function issueDownload(db: PrismaClient, input: IssueDownloadInput): Promise<DownloadLinkResponse> {
  const now = input.now ?? new Date();
  const ttlSec = linkTtl(input.ttlSec);

  const file = await db.releaseFile.findUnique({
    where: { id: input.fileId },
    select: {
      id: true,
      platform: true,
      fileName: true,
      storageKey: true,
      sizeBytes: true,
      release: {
        select: {
          version: true,
          channel: true,
          status: true,
          releasedAt: true,
          productId: true,
          product: { select: { shortName: true } },
        },
      },
    },
  });
  if (!file) throw new ApiError(404, "not_found", DOWNLOAD_NOT_FOUND_MESSAGE);
  const { release } = file;
  if (release.channel !== STABLE_CHANNEL) throw notEntitledError("not_released");

  const licenses = await db.license.findMany({
    where:
      input.scope.kind === "account"
        ? { accountId: input.scope.accountId, productId: release.productId }
        : { orderId: input.scope.orderId, productId: release.productId },
    select: { id: true, accountId: true, status: true, expiresAt: true, updatesUntil: true },
  });
  const pick = pickEntitlingLicense(licenses, release, now);
  if (!pick.ok) throw notEntitledError(pick.reason);
  const license = pick.license;

  let link: PresignedGet;
  try {
    link = await (input.storage ?? (await getStorage())).presignGet(file.storageKey, { ttlSec, downloadName: file.fileName });
  } catch (error) {
    log.error("download_presign_failed", { fileId: file.id, error });
    throw new ApiError(503, "download_unavailable", DOWNLOAD_UNAVAILABLE_MESSAGE);
  }

  // Guest downloads of a claimed order still show up in that account's activity log.
  const activityAccountId = input.scope.kind === "account" ? input.scope.accountId : license.accountId;
  await db.$transaction(async (tx) => {
    await tx.downloadEvent.create({
      data: { fileId: file.id, userId: input.eventUserId, licenseId: license.id, expiresAt: link.expiresAt, createdAt: now },
    });
    if (activityAccountId) {
      await tx.accountActivity.create({
        data: {
          accountId: activityAccountId,
          // A signed-in member; downloads through a guest order link have no person to record.
          actorId: input.scope.kind === "order" && input.eventUserId === guestDownloadUserId(input.scope.orderId) ? null : input.eventUserId,
          actorName: input.actorName.slice(0, 200),
          action: DOWNLOAD_ACTIVITY_ACTION,
          target: `${release.product.shortName} v${release.version}`.slice(0, 200),
          kind: DOWNLOAD_ACTIVITY_KIND,
          createdAt: now,
        },
      });
    }
  });
  log.info("download_issued", { fileId: file.id, licenseId: license.id, scope: input.scope.kind, ttlSec });

  return {
    url: link.url,
    expiresAt: link.expiresAt.toISOString(),
    ttlSec,
    fileId: file.id,
    fileName: file.fileName,
    platform: file.platform,
    version: release.version,
    sizeLabel: formatFileSize(file.sizeBytes),
    licenseId: license.id,
  };
}

