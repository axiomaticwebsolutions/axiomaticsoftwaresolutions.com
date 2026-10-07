/**
 * The trial notice of /account/software?trial=<slug> (components/account/software/trial-offer.ts): the same rules as
 * startTrial() (published product, live trial plan, one trial per product per account), plus the portal's "owned"
 * state. Another account's trial never counts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadTrialOffer } from "@/components/account/software/trial-offer";
import { db } from "@/lib/db";
import { DAY, makeCatalog, makeLicense, makeMember, type Catalog } from "./license-actions-fixtures";

let catalog: Catalog;

beforeAll(async () => {
  catalog = await makeCatalog();
});

describe("loadTrialOffer", () => {
  it("offers the trial plan to an account that never had one", async () => {
    const { accountId } = await makeMember();
    const offer = await loadTrialOffer(db, accountId, catalog.product.id);
    expect(offer).toMatchObject({
      state: "ready",
      slug: catalog.product.id,
      product: { id: catalog.product.id, shortName: "Medical", icon: "medication", tone: "sage" },
      trialDays: 15,
      deviceLimit: 1,
      deviceWord: "computer",
    });
  });

  it("reports a running trial, an ended one and one converted to a paid plan", async () => {
    const running = await makeMember();
    const live = await makeLicense(catalog, { accountId: running.accountId, plan: catalog.trial, status: "TRIAL", expiresAt: new Date(Date.now() + 5 * DAY) });
    expect(await loadTrialOffer(db, running.accountId, catalog.product.id)).toMatchObject({ state: "active", licenseId: live.license.id });

    const ended = await makeMember();
    const old = await makeLicense(catalog, { accountId: ended.accountId, plan: catalog.trial, status: "TRIAL", expiresAt: new Date(Date.now() - 5 * DAY) });
    expect(await loadTrialOffer(db, ended.accountId, catalog.product.id)).toMatchObject({
      state: "used",
      licenseId: old.license.id,
      licenseIsTrial: true,
    });

    const converted = await makeMember();
    const paid = await makeLicense(catalog, { accountId: converted.accountId, plan: catalog.annual, status: "ACTIVE" });
    await db.licenseEvent.create({ data: { licenseId: paid.license.id, type: "trial_started", actor: "Priya Sharma" } });
    expect(await loadTrialOffer(db, converted.accountId, catalog.product.id)).toMatchObject({
      state: "used",
      licenseId: paid.license.id,
      licenseIsTrial: false,
    });
  });

  it("points to a working paid license instead of offering a trial, but not to an expired one", async () => {
    const owner = await makeMember();
    const paid = await makeLicense(catalog, { accountId: owner.accountId, plan: catalog.annual });
    expect(await loadTrialOffer(db, owner.accountId, catalog.product.id)).toMatchObject({
      state: "owned",
      licenseId: paid.license.id,
      planName: catalog.annual.name,
    });

    const lapsed = await makeMember();
    await makeLicense(catalog, { accountId: lapsed.accountId, plan: catalog.annual, expiresAt: new Date(Date.now() - DAY) });
    await makeLicense(catalog, { accountId: lapsed.accountId, plan: catalog.annual, status: "REVOKED" });
    expect((await loadTrialOffer(db, lapsed.accountId, catalog.product.id)).state).toBe("ready");
  });

  it("ignores other accounts' trials", async () => {
    const other = await makeMember();
    await makeLicense(catalog, { accountId: other.accountId, plan: catalog.trial, status: "TRIAL" });
    const mine = await makeMember();
    expect((await loadTrialOffer(db, mine.accountId, catalog.product.id)).state).toBe("ready");
  });

  it("has no trial without a live trial plan, and no product unless published", async () => {
    const noTrial = await makeCatalog();
    await db.plan.update({ where: { id: noTrial.trial.id }, data: { archived: true } });
    const { accountId } = await makeMember();
    expect(await loadTrialOffer(db, accountId, noTrial.product.id)).toMatchObject({ state: "unavailable", product: { id: noTrial.product.id } });

    const draft = await makeCatalog();
    await db.product.update({ where: { id: draft.product.id }, data: { status: "DRAFT" } });
    expect(await loadTrialOffer(db, accountId, draft.product.id)).toEqual({ state: "not_found", slug: draft.product.id });
    expect(await loadTrialOffer(db, accountId, "no-such-product-x")).toEqual({ state: "not_found", slug: "no-such-product-x" });
  });
});
