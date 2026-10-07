/**
 * Server side of /account/software?trial=<slug> (decisions.md Phase 3/5: the storefront "Start free trial" continues
 * here through register and verify). Reads what the account may do with the product's trial so the page can show the
 * right notice before anything is posted. The same rules as startTrial() (lib/licensing/issue.ts): a PUBLISHED
 * product, a live (not archived) TRIAL plan, and one trial per product per account (any license of the product that
 * was a trial: TRIAL plan, TRIAL status or a `trial_started` event). POST /api/account/trials re-checks all of it.
 * New: when the account already holds a working paid license of the product, no trial is offered (the API would still
 * issue one; the notice links to the license instead).
 */
import "server-only";
import { LicenseStatus, PlanType, PublishStatus } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import type { TrialOffer, TrialProduct } from "./model";

export async function loadTrialOffer(db: Db, accountId: string, slug: string, now: Date = new Date()): Promise<TrialOffer> {
  const product = await db.product.findUnique({
    where: { id: slug },
    select: {
      id: true,
      name: true,
      shortName: true,
      icon: true,
      tone: true,
      status: true,
      category: { select: { tone: true } },
      plans: {
        where: { type: PlanType.TRIAL, archived: false },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: 1,
        select: { name: true, trialDays: true, deviceLimit: true, perUnit: true },
      },
    },
  });
  if (!product || product.status !== PublishStatus.PUBLISHED) return { state: "not_found", slug };
  const view: TrialProduct = {
    id: product.id,
    name: product.name,
    shortName: product.shortName,
    icon: product.icon,
    tone: product.tone ?? product.category.tone,
  };

  const previous = await db.license.findFirst({
    where: {
      accountId,
      productId: product.id,
      OR: [{ plan: { type: PlanType.TRIAL } }, { status: LicenseStatus.TRIAL }, { events: { some: { type: "trial_started" } } }],
    },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true, expiresAt: true },
  });
  if (previous) {
    const isTrial = previous.status === LicenseStatus.TRIAL;
    const running = isTrial && (previous.expiresAt === null || previous.expiresAt.getTime() > now.getTime());
    const expiresAt = previous.expiresAt ? previous.expiresAt.toISOString() : null;
    return running
      ? { state: "active", slug, product: view, licenseId: previous.id, expiresAt }
      : { state: "used", slug, product: view, licenseId: previous.id, licenseIsTrial: isTrial, expiresAt };
  }

  // A working paid license of the product: a trial adds nothing, so the notice points to that license instead.
  const owned = await db.license.findFirst({
    where: {
      accountId,
      productId: product.id,
      status: LicenseStatus.ACTIVE,
      plan: { type: { not: PlanType.TRIAL } },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    select: { id: true, plan: { select: { name: true } } },
  });
  if (owned) return { state: "owned", slug, product: view, licenseId: owned.id, planName: owned.plan.name };

  const plan = product.plans[0];
  if (!plan) return { state: "unavailable", slug, product: view };
  return {
    state: "ready",
    slug,
    product: view,
    planName: plan.name,
    trialDays: plan.trialDays,
    deviceLimit: plan.deviceLimit ?? 1,
    deviceWord: plan.perUnit ?? "computer",
  };
}
