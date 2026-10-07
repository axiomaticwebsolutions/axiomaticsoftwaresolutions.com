/**
 * Admin Software releases (Admin Console.dc.html #releases; decisions.md Phase 6 "Releases"): list (with the derived
 * "Latest"), detail, create a draft, edit, delete a draft, installer uploads (see ./installers.ts), publish (status
 * PUBLISHED + releasedAt; the route then notifies entitled accounts, ./release-notify.ts) and withdraw (reason).
 * Published installers are immutable: to change one, withdraw the release and publish a new version. Every change is
 * audited in its transaction and revalidates the storefront catalog. Server-only; routes authorize first.
 */
import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { runDestructive } from "@/lib/admin/destructive";
import { ADMIN_EXPORT_MAX_ROWS } from "@/lib/admin/export";
import { pageResult, searchWhere, type ListPage } from "@/lib/admin/list-query";
import { audit, requireReason } from "@/lib/audit";
import { db as defaultDb, type Prisma, type Tx } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import { formatFileSize } from "@/lib/storefront/derive";
import { getStorage, type StorageDriver } from "@/lib/storage";
import {
  hashStoredObject,
  INSTALLER_CONTENT_TYPE,
  INSTALLER_PUT_TTL_SECONDS,
  signUploadToken,
  UPLOAD_TOKEN_TTL_SECONDS,
  uploadNonce,
  verifyUploadToken,
} from "./installers";
import type { CatalogListQuery, ReleaseSort } from "./list-config";
import { installerExtensionError, installerStorageKey, PLATFORM_LABELS, platformList, releaseStatusKey, releaseStoragePrefix, safeInstallerName, shortSha256 } from "./model";
import type { CatalogActor, StatusChangeContext } from "./products";
import { revalidateCatalog } from "./revalidate";
import { CUSTOMER_CHANNEL, latestReleaseIds, releaseTitle } from "./rules";
import type { InstallerUploadInput, ReleaseCreateInput, ReleaseUpdateInput } from "./schemas";
import type {
  AdminReleaseDetail,
  AdminReleaseFile,
  AdminReleaseRow,
  CatalogPlatform,
  InstallerConfirmResult,
  InstallerUploadTicket,
  ReleaseRawStatus,
} from "./types";

export type ReleaseFilterKey = "product" | "status";
export type ReleaseListQuery = CatalogListQuery<ReleaseFilterKey, ReleaseSort>;

export const RELEASE_MESSAGES = {
  product: "Choose a product.",
  versionTaken: (v: string) => `Version ${v} already exists for this product.`,
  notDraft: "Only a draft release can be changed this way.",
  publishedFixed: "A published release keeps its version and channel. Withdraw it and create a new release instead.",
  versionHasFiles: "Remove the installers before changing the version.",
  notesLocked: "A withdrawn release can\u2019t be edited.",
  platform: (product: string, platform: CatalogPlatform) =>
    `${product} isn\u2019t offered for ${PLATFORM_LABELS[platform]}. Add the platform to the product first.`,
  uploadUnavailable: "We can\u2019t accept uploads right now. Please try again in a few minutes.",
  uploadInvalid: "This upload has expired or isn\u2019t valid. Choose the file again.",
  uploadMissing: "We didn\u2019t receive this file. Try uploading it again.",
  uploadMismatch: "The uploaded file doesn\u2019t match the file you chose. Try uploading it again.",
  releaseChanged: "This release changed while the file was uploading. Upload the file again.",
  noInstallers: "Upload at least one installer before publishing.",
  notPublished: "Only a published release can be withdrawn.",
} as const;

const PLATFORM_ORDER: readonly CatalogPlatform[] = ["windows", "macos", "android"];

const releaseInclude = {
  product: { select: { name: true, shortName: true, code: true, platforms: true } },
  files: { select: { id: true, platform: true, fileName: true, sizeBytes: true, sha256: true } },
} satisfies Prisma.ReleaseInclude;
type ReleaseWithFiles = Prisma.ReleaseGetPayload<{ include: typeof releaseInclude }>;

function asPlatform(value: string): CatalogPlatform | null {
  return (PLATFORM_ORDER as readonly string[]).includes(value) ? (value as CatalogPlatform) : null;
}

function sortedFiles(files: ReleaseWithFiles["files"]): ReleaseWithFiles["files"] {
  const rank = (p: string) => PLATFORM_ORDER.indexOf(p as CatalogPlatform);
  return [...files].sort((a, b) => rank(a.platform) - rank(b.platform));
}

function toFile(f: ReleaseWithFiles["files"][number]): AdminReleaseFile {
  return { id: f.id, platform: asPlatform(f.platform) ?? "windows", fileName: f.fileName, sizeBytes: Number(f.sizeBytes), sha256: f.sha256 };
}

function toReleaseRow(r: ReleaseWithFiles, latest: ReadonlyMap<string, string>): AdminReleaseRow {
  const files = sortedFiles(r.files);
  const main = files.find((f) => f.platform === "windows") ?? files[0];
  return {
    id: r.id,
    productId: r.productId,
    productName: r.product.shortName,
    productCode: r.product.code,
    version: r.version,
    channel: r.channel,
    status: releaseStatusKey(r.status as ReleaseRawStatus, latest.get(r.productId) === r.id),
    rawStatus: r.status as ReleaseRawStatus,
    releasedAt: r.releasedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    firstNote: r.notes[0] ?? null,
    platforms: files.map((f) => asPlatform(f.platform)).filter((p): p is CatalogPlatform => p !== null),
    installerBytes: main ? Number(main.sizeBytes) : null,
    fileCount: files.length,
  };
}

function toReleaseDetail(r: ReleaseWithFiles, latest: ReadonlyMap<string, string>): AdminReleaseDetail {
  const row = toReleaseRow(r, latest);
  const productPlatforms = PLATFORM_ORDER.filter((p) => r.product.platforms.includes(p));
  return {
    ...row,
    productFullName: r.product.name,
    productPlatforms,
    notes: r.notes,
    files: sortedFiles(r.files).map(toFile),
    missingPlatforms: productPlatforms.filter((p) => !row.platforms.includes(p)),
    storagePrefix: releaseStoragePrefix(r.productId, r.version),
  };
}

/** product id -> id of its latest release (PUBLISHED stable, highest version). */
export async function loadLatestReleaseIds(client: PrismaClient | Tx, productId?: string): Promise<Map<string, string>> {
  const published = await client.release.findMany({
    where: { status: "PUBLISHED", channel: CUSTOMER_CHANNEL, releasedAt: { not: null }, ...(productId ? { productId } : {}) },
    select: { id: true, productId: true, version: true, releasedAt: true, channel: true, status: true },
  });
  return latestReleaseIds(published);
}

function releaseWhere(query: Pick<ReleaseListQuery, "q" | "filters">, latest: ReadonlyMap<string, string>): Prisma.ReleaseWhereInput {
  const latestIds = [...latest.values()];
  const status = query.filters.status;
  const byStatus: Prisma.ReleaseWhereInput =
    status === "latest"
      ? { id: { in: latestIds } }
      : status === "published"
        ? { status: "PUBLISHED", id: { notIn: latestIds } }
        : status === "draft"
          ? { status: "DRAFT" }
          : status === "withdrawn"
            ? { status: "WITHDRAWN" }
            : {};
  return {
    ...(query.filters.product ? { productId: query.filters.product } : {}),
    ...byStatus,
    ...(searchWhere<Prisma.ReleaseWhereInput>(query.q, ["version", "product.name", "product.shortName", "product.code"]) ?? {}),
  };
}

function releaseOrderBy(sort: { id: ReleaseSort; desc: boolean }): Prisma.ReleaseOrderByWithRelationInput[] {
  const dir = sort.desc ? "desc" : "asc";
  if (sort.id === "release") return [{ product: { name: dir } }, { createdAt: dir }, { id: dir }];
  // Drafts have no release date yet: newest-first lists show them on top, oldest-first at the end.
  return [{ releasedAt: { sort: dir, nulls: sort.desc ? "first" : "last" } }, { createdAt: dir }, { id: dir }];
}

export async function listReleases(query: ReleaseListQuery, client: PrismaClient = defaultDb): Promise<ListPage<AdminReleaseRow>> {
  const latest = await loadLatestReleaseIds(client);
  const where = releaseWhere(query, latest);
  const [rows, total] = await Promise.all([
    client.release.findMany({
      where,
      include: releaseInclude,
      orderBy: releaseOrderBy(query.sort),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    client.release.count({ where }),
  ]);
  return pageResult(rows.map((r) => toReleaseRow(r, latest)), total, query);
}

/** Up to ADMIN_EXPORT_MAX_ROWS + 1 rows for the CSV. */
export async function releaseExportRows(query: Pick<ReleaseListQuery, "q" | "filters" | "sort">, client: PrismaClient = defaultDb): Promise<AdminReleaseRow[]> {
  const latest = await loadLatestReleaseIds(client);
  const rows = await client.release.findMany({
    where: releaseWhere(query, latest),
    include: releaseInclude,
    orderBy: releaseOrderBy(query.sort),
    take: ADMIN_EXPORT_MAX_ROWS + 1,
  });
  return rows.map((r) => toReleaseRow(r, latest));
}

export async function getReleaseDetail(id: string, client: PrismaClient | Tx = defaultDb): Promise<AdminReleaseDetail | null> {
  const release = await client.release.findUnique({ where: { id }, include: releaseInclude });
  if (!release) return null;
  return toReleaseDetail(release, await loadLatestReleaseIds(client, release.productId));
}

async function requireRelease(id: string, client: PrismaClient | Tx): Promise<AdminReleaseDetail> {
  const release = await getReleaseDetail(id, client);
  if (!release) throw errors.notFound("Release");
  return release;
}

async function lockRelease(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Release" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw errors.notFound("Release");
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "P2002";
}

/** New DRAFT release. 422 for an unknown product or a version the product already has. */
export async function createRelease(input: ReleaseCreateInput, ctx: CatalogActor, client: PrismaClient = defaultDb): Promise<AdminReleaseDetail> {
  try {
    return await client.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: input.productId }, select: { shortName: true } });
      if (!product) throw errors.validation({ productId: RELEASE_MESSAGES.product });
      const taken = await tx.release.findUnique({ where: { productId_version: { productId: input.productId, version: input.version } } });
      if (taken) throw errors.validation({ version: RELEASE_MESSAGES.versionTaken(input.version) });
      const created = await tx.release.create({
        data: { productId: input.productId, version: input.version, channel: input.channel, notes: input.notes, status: "DRAFT" },
      });
      await audit(tx, ctx.actor, {
        action: "Created release draft",
        target: releaseTitle(product.shortName, input.version),
        targetType: "release",
        targetId: created.id,
        detail: input.channel === CUSTOMER_CHANNEL ? null : `Channel ${input.channel}`,
      });
      return requireRelease(created.id, tx);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw errors.validation({ version: RELEASE_MESSAGES.versionTaken(input.version) });
    throw e;
  }
}

export type ReleaseUpdateResult = { release: AdminReleaseDetail; changed: boolean };

/**
 * Drafts: version (while no installer is uploaded), channel and notes. Published releases: notes only (409
 * `release_published` for the rest). Withdrawn releases are read-only (409 `release_withdrawn`).
 */
export async function updateRelease(id: string, patch: ReleaseUpdateInput, ctx: CatalogActor, client: PrismaClient = defaultDb): Promise<ReleaseUpdateResult> {
  let result: ReleaseUpdateResult;
  try {
    result = await client.$transaction(async (tx) => {
      await lockRelease(tx, id);
      const current = await requireRelease(id, tx);
      const changed: string[] = [];
      const data: Prisma.ReleaseUpdateInput = {};
      if (patch.version !== undefined && patch.version !== current.version) {
        changed.push(`Version ${current.version} \u2192 ${patch.version}`);
        data.version = patch.version;
      }
      if (patch.channel !== undefined && patch.channel !== current.channel) {
        changed.push(`Channel ${current.channel} \u2192 ${patch.channel}`);
        data.channel = patch.channel;
      }
      if (patch.notes !== undefined && JSON.stringify(patch.notes) !== JSON.stringify(current.notes)) {
        changed.push("Release notes");
        data.notes = patch.notes;
      }
      if (changed.length === 0) return { release: current, changed: false };
      if (current.rawStatus === "WITHDRAWN") throw errors.conflict("release_withdrawn", RELEASE_MESSAGES.notesLocked);
      if (current.rawStatus === "PUBLISHED" && (data.version !== undefined || data.channel !== undefined)) {
        throw errors.conflict("release_published", RELEASE_MESSAGES.publishedFixed);
      }
      if (data.version !== undefined) {
        if (current.fileCount > 0) throw errors.conflict("has_installers", RELEASE_MESSAGES.versionHasFiles);
        const taken = await tx.release.findUnique({ where: { productId_version: { productId: current.productId, version: patch.version as string } } });
        if (taken && taken.id !== id) throw errors.validation({ version: RELEASE_MESSAGES.versionTaken(patch.version as string) });
      }
      await tx.release.update({ where: { id }, data });
      await audit(tx, ctx.actor, {
        action: "Updated release",
        target: releaseTitle(current.productName, patch.version ?? current.version),
        targetType: "release",
        targetId: id,
        detail: changed.join(" \u00B7 "),
      });
      return { release: await requireRelease(id, tx), changed: true };
    });
  } catch (e) {
    if (isUniqueViolation(e) && patch.version) throw errors.validation({ version: RELEASE_MESSAGES.versionTaken(patch.version) });
    throw e;
  }
  if (result.changed && result.release.rawStatus === "PUBLISHED") revalidateCatalog();
  return result;
}

/** Best effort: an object left behind is only wasted space, so a storage hiccup never fails the request. */
async function deleteObjects(storage: StorageDriver | undefined, keys: readonly string[], context: Record<string, unknown>): Promise<void> {
  if (keys.length === 0) return;
  const driver = storage ?? getStorage();
  for (const key of keys) {
    try {
      await driver.delete(key);
    } catch (error) {
      log.error("release_object_delete_failed", { ...context, error });
    }
  }
}

/**
 * Deletes a DRAFT release and its uploaded installers (409 `not_draft` otherwise). Destructive rule "releases.delete":
 * a reason (422 `reason_required`) and exactly one audit row "Deleted release draft" in the same transaction.
 */
export async function deleteDraftRelease(id: string, ctx: StatusChangeContext, client: PrismaClient = defaultDb, storage?: StorageDriver): Promise<void> {
  const existing = await client.release.findUnique({ where: { id }, select: { version: true, product: { select: { shortName: true } } } });
  if (!existing) throw errors.notFound("Release");
  const keys = await runDestructive(
    "releases.delete",
    {
      staff: ctx.staff,
      actor: ctx.actor,
      input: ctx.input,
      targetId: id,
      target: releaseTitle(existing.product.shortName, existing.version),
      targetType: "release",
      detail: (removed: string[]) => (removed.length > 0 ? `${removed.length} installer${removed.length === 1 ? "" : "s"} removed` : null),
      client,
    },
    async (tx) => {
      await lockRelease(tx, id);
      const current = await tx.release.findUniqueOrThrow({ where: { id }, include: { files: { select: { storageKey: true } } } });
      if (current.status !== "DRAFT") throw errors.conflict("not_draft", RELEASE_MESSAGES.notDraft);
      await tx.release.delete({ where: { id } });
      return current.files.map((f) => f.storageKey);
    },
  );
  await deleteObjects(storage, keys, { releaseId: id });
}

// ---------- Installer uploads ----------

export type UploadContext = CatalogActor & { staffId: string; now?: Date };

/** Step 1: a presigned PUT and its upload token for one installer of a DRAFT release. */
export async function createInstallerUpload(
  id: string,
  input: InstallerUploadInput,
  ctx: UploadContext,
  client: PrismaClient = defaultDb,
  storage?: StorageDriver,
): Promise<InstallerUploadTicket> {
  const release = await requireRelease(id, client);
  if (release.rawStatus !== "DRAFT") throw errors.conflict("not_draft", RELEASE_MESSAGES.notDraft);
  if (!release.productPlatforms.includes(input.platform)) {
    throw errors.validation({ platform: RELEASE_MESSAGES.platform(release.productName, input.platform) });
  }
  const extensionError = installerExtensionError(input.platform, input.fileName);
  if (extensionError) throw errors.validation({ fileName: extensionError });

  const now = ctx.now ?? new Date();
  const name = safeInstallerName(input.fileName);
  const key = installerStorageKey(release.productId, release.version, uploadNonce(), name);
  let put;
  try {
    put = await (storage ?? getStorage()).presignPut(key, {
      ttlSec: INSTALLER_PUT_TTL_SECONDS,
      contentType: INSTALLER_CONTENT_TYPE,
      maxBytes: input.sizeBytes,
    });
  } catch (error) {
    log.error("installer_presign_failed", { releaseId: id, error });
    throw new ApiError(503, "upload_unavailable", RELEASE_MESSAGES.uploadUnavailable);
  }
  const uploadToken = signUploadToken({
    r: id,
    v: release.version,
    p: input.platform,
    k: key,
    n: name,
    s: input.sizeBytes,
    u: ctx.staffId,
    e: Math.floor(now.getTime() / 1000) + UPLOAD_TOKEN_TTL_SECONDS,
  });
  log.info("installer_presigned", { releaseId: id, platform: input.platform, sizeBytes: input.sizeBytes });
  return { upload: { url: put.url, method: put.method, headers: put.headers, expiresAt: put.expiresAt.toISOString() }, uploadToken };
}

/**
 * Step 3: verifies the upload and stores it. 422 `upload_invalid` for a bad, expired or foreign token, 409
 * `upload_missing` when nothing was uploaded, 422 `upload_mismatch` when the size differs (the object is deleted),
 * 409 `not_draft` / `release_changed` when the release moved on meanwhile. A file already stored for the platform is
 * replaced (its object deleted after commit). Confirming the same token twice returns the stored file.
 */
export async function confirmInstallerUpload(
  id: string,
  uploadToken: string,
  ctx: UploadContext,
  client: PrismaClient = defaultDb,
  storage?: StorageDriver,
): Promise<InstallerConfirmResult> {
  const now = ctx.now ?? new Date();
  const claims = verifyUploadToken(uploadToken, now);
  if (!claims || claims.r !== id || claims.u !== ctx.staffId) {
    throw new ApiError(422, "upload_invalid", RELEASE_MESSAGES.uploadInvalid);
  }
  const already = await client.releaseFile.findFirst({ where: { releaseId: id, storageKey: claims.k } });
  if (already) return { file: toFile(already), release: await requireRelease(id, client) };

  const driver = storage ?? getStorage();
  let head;
  try {
    head = await driver.head(claims.k);
  } catch (error) {
    log.error("installer_head_failed", { releaseId: id, error });
    throw new ApiError(503, "upload_unavailable", RELEASE_MESSAGES.uploadUnavailable);
  }
  if (!head) throw errors.conflict("upload_missing", RELEASE_MESSAGES.uploadMissing);
  if (head.sizeBytes !== claims.s) {
    await deleteObjects(driver, [claims.k], { releaseId: id });
    log.warn("installer_size_mismatch", { releaseId: id, declared: claims.s, stored: head.sizeBytes });
    throw new ApiError(422, "upload_mismatch", RELEASE_MESSAGES.uploadMismatch);
  }
  let digest: { sha256: string; sizeBytes: number };
  try {
    digest = await hashStoredObject(driver, claims.k);
  } catch (error) {
    log.error("installer_hash_failed", { releaseId: id, error });
    throw new ApiError(503, "upload_unavailable", RELEASE_MESSAGES.uploadUnavailable);
  }
  if (digest.sizeBytes !== claims.s) {
    await deleteObjects(driver, [claims.k], { releaseId: id });
    throw new ApiError(422, "upload_mismatch", RELEASE_MESSAGES.uploadMismatch);
  }

  const outcome = await client.$transaction(async (tx) => {
    await lockRelease(tx, id);
    const release = await tx.release.findUniqueOrThrow({ where: { id }, include: { product: { select: { shortName: true } } } });
    if (release.status !== "DRAFT") throw errors.conflict("not_draft", RELEASE_MESSAGES.notDraft);
    if (release.version !== claims.v) throw errors.conflict("release_changed", RELEASE_MESSAGES.releaseChanged);
    const previous = await tx.releaseFile.findMany({ where: { releaseId: id, platform: claims.p } });
    if (previous.length > 0) await tx.releaseFile.deleteMany({ where: { id: { in: previous.map((f) => f.id) } } });
    const file = await tx.releaseFile.create({
      data: { releaseId: id, platform: claims.p, fileName: claims.n, storageKey: claims.k, sizeBytes: BigInt(claims.s), sha256: digest.sha256 },
    });
    await audit(tx, ctx.actor, {
      action: "Uploaded installer",
      target: releaseTitle(release.product.shortName, release.version),
      targetType: "release",
      targetId: id,
      detail: [PLATFORM_LABELS[claims.p], claims.n, formatFileSize(claims.s), `SHA-256 ${shortSha256(digest.sha256)}`, previous.length > 0 ? "replaced the previous file" : null]
        .filter(Boolean)
        .join(" \u00B7 "),
    });
    return { file, replacedKeys: previous.map((f) => f.storageKey).filter((k) => k !== claims.k) };
  }).catch(async (error: unknown) => {
    // The object belongs to no row: remove it so a refused upload leaves nothing behind.
    if (error instanceof ApiError && error.status === 409) await deleteObjects(driver, [claims.k], { releaseId: id });
    throw error;
  });
  await deleteObjects(driver, outcome.replacedKeys, { releaseId: id });
  return { file: toFile(outcome.file), release: await requireRelease(id, client) };
}

/** Removes one installer from a DRAFT release (object deleted after commit). */
export async function removeInstaller(
  id: string,
  fileId: string,
  ctx: StatusChangeContext,
  client: PrismaClient = defaultDb,
  storage?: StorageDriver,
): Promise<AdminReleaseDetail> {
  const release = await client.release.findUnique({ where: { id }, select: { version: true, product: { select: { shortName: true } } } });
  if (!release) throw errors.notFound("Release");
  const file = await client.releaseFile.findFirst({ where: { id: fileId, releaseId: id }, select: { id: true } });
  if (!file) throw errors.notFound("Installer");
  const removed = await runDestructive(
    "releases.remove_installer",
    {
      staff: ctx.staff,
      actor: ctx.actor,
      input: ctx.input,
      targetId: id,
      target: releaseTitle(release.product.shortName, release.version),
      targetType: "release",
      detail: (r: { detail: string }) => r.detail,
      client,
    },
    async (tx) => {
      await lockRelease(tx, id);
      const current = await tx.release.findUniqueOrThrow({ where: { id }, select: { status: true } });
      const locked = await tx.releaseFile.findFirst({ where: { id: fileId, releaseId: id } });
      if (!locked) throw errors.notFound("Installer");
      if (current.status !== "DRAFT") throw errors.conflict("not_draft", RELEASE_MESSAGES.notDraft);
      await tx.releaseFile.delete({ where: { id: fileId } });
      const platform = asPlatform(locked.platform);
      return { key: locked.storageKey, detail: [platform ? PLATFORM_LABELS[platform] : locked.platform, locked.fileName].join(" \u00B7 ") };
    },
  );
  await deleteObjects(storage, [removed.key], { releaseId: id });
  return requireRelease(id, client);
}

// ---------- Publish / withdraw ----------

/**
 * Publishes a DRAFT release with at least one installer: status PUBLISHED, releasedAt now, audit "Published release"
 * (detail: the platforms). Not a DESTRUCTIVE_ACTIONS rule (the prototype asks no reason). The caller notifies the
 * entitled accounts after the response (notifyReleaseAvailable).
 */
export async function publishRelease(id: string, ctx: CatalogActor & { now?: Date }, client: PrismaClient = defaultDb): Promise<AdminReleaseDetail> {
  const now = ctx.now ?? new Date();
  const release = await client.$transaction(async (tx) => {
    await lockRelease(tx, id);
    const current = await requireRelease(id, tx);
    if (current.rawStatus !== "DRAFT") throw errors.conflict("not_draft", RELEASE_MESSAGES.notDraft);
    if (current.fileCount === 0) throw errors.conflict("no_installers", RELEASE_MESSAGES.noInstallers);
    await tx.release.update({ where: { id }, data: { status: "PUBLISHED", releasedAt: now } });
    await audit(tx, ctx.actor, {
      action: "Published release",
      target: releaseTitle(current.productName, current.version),
      targetType: "release",
      targetId: id,
      detail: [platformList(current.platforms), current.channel === CUSTOMER_CHANNEL ? null : `Channel ${current.channel}`].filter(Boolean).join(" \u00B7 "),
    });
    return requireRelease(id, tx);
  });
  revalidateCatalog();
  return release;
}

/**
 * Withdraws a PUBLISHED release (reason required, 4-500 characters): customers no longer see or download it, and
 * "Latest" moves back to the previous version. Audit "Withdrew release" in the same transaction.
 */
export async function withdrawRelease(id: string, reasonInput: unknown, ctx: CatalogActor, client: PrismaClient = defaultDb): Promise<AdminReleaseDetail> {
  const reason = requireReason(reasonInput);
  const release = await client.$transaction(async (tx) => {
    await lockRelease(tx, id);
    const current = await requireRelease(id, tx);
    if (current.rawStatus !== "PUBLISHED") throw errors.conflict("not_published", RELEASE_MESSAGES.notPublished);
    await tx.release.update({ where: { id }, data: { status: "WITHDRAWN" } });
    await audit(tx, ctx.actor, {
      action: "Withdrew release",
      target: releaseTitle(current.productName, current.version),
      targetType: "release",
      targetId: id,
      reason,
      detail: current.status === "latest" ? "Was the latest release" : null,
    });
    return requireRelease(id, tx);
  });
  revalidateCatalog();
  return release;
}
