"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useAdmin } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { DestructiveAction } from "@/components/admin/destructive-action";
import { AdminDrawer, DrawerSubmit } from "@/components/admin/drawer";
import { SectionRow, SectionRows } from "@/components/admin/section";
import { StatusBadge } from "@/components/admin/status-badge";
import { Icon } from "@/components/icons/icon";
import { PLAN_TYPE_LABELS, platformList } from "@/lib/admin/catalog/model";
import type { AdminProductDetail, CatalogFormOptions } from "@/lib/admin/catalog/types";
import { apiFetch } from "@/lib/client/api";
import { formatINR } from "@/lib/money";
import { READ_ONLY_FOR_ROLE } from "@/lib/rbac";
import { ProductContentForm } from "./product-content-form";
import { ListingBasics, ListingDetails, productFormValue, productPayload, type ProductFormValue } from "./product-form";
import { fieldErrorsOf, FormAlert, formErrorOf, useDetail } from "./shared";

const DETAIL_KEYS = ["name", "code", "categoryId", "platforms", "icon", "tone", "rank", "demoEnabled"] as const;

/** The "Storefront listing" edit card: the prototype's three fields, the rest under "More listing details". */
function ListingForm({ product, options, readOnly, onSaved }: { product: AdminProductDetail; options: CatalogFormOptions; readOnly: boolean; onSaved: (p: AdminProductDetail) => void }) {
  const uid = React.useId();
  const [value, setValue] = React.useState<ProductFormValue>(() => productFormValue(product));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [more, setMore] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || readOnly) return;
    setBusy(true);
    setFormError(null);
    try {
      const res = await apiFetch<{ product: AdminProductDetail; changed: boolean }>(`/api/admin/products/${encodeURIComponent(product.id)}`, {
        method: "PATCH",
        body: productPayload(value),
      });
      setErrors({});
      adminToast.success(res.changed ? "Changes saved" : "No changes to save");
      onSaved(res.product);
    } catch (error) {
      const fields = fieldErrorsOf(error);
      setErrors(fields);
      setFormError(formErrorOf(error));
      if (DETAIL_KEYS.some((k) => fields[k])) setMore(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-2.5">
      <ListingBasics value={value} onChange={setValue} errors={errors} idPrefix={uid} />
      <details open={more} onToggle={(e) => setMore(e.currentTarget.open)} className="group rounded-10 border border-line-subtle">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-10 px-3 py-2 text-[12.5px] font-extrabold [&::-webkit-details-marker]:hidden">
          More listing details
          <Icon name="expand_more" size={18} className="text-ink-2 transition-transform group-open:rotate-180" />
        </summary>
        <div className="grid gap-2.5 border-t border-line-subtle p-3">
          <ListingDetails value={value} onChange={setValue} errors={errors} idPrefix={uid} options={options} mode="edit" codeLocked={product.codeLocked} />
        </div>
      </details>
      <FormAlert>{formError}</FormAlert>
      <DrawerSubmit disabled={busy} aria-busy={busy || undefined} />
    </form>
  );
}

function ReadOnlyTag() {
  return (
    <span className="flex items-center gap-1 text-[12.5px] font-extrabold text-danger">
      <Icon name="lock" size={15} />
      {READ_ONLY_FOR_ROLE}
    </span>
  );
}

function planDetail(p: AdminProductDetail["plans"][number]): string {
  const devices = p.deviceLimit ? ` \u00B7 ${p.deviceLimit} device${p.deviceLimit === 1 ? "" : "s"}` : p.perUnit ? ` \u00B7 per ${p.perUnit}` : "";
  return `${PLAN_TYPE_LABELS[p.type]}${devices}${p.archived ? " \u00B7 Archived" : ""}`;
}

type DrawerProps = {
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: CatalogFormOptions;
  /** The list should re-render (after any change). */
  onChanged: () => void;
};

const HIDE_CONSEQUENCE = "It disappears from the catalog and search. Existing customers keep their licenses and downloads.";
const PUBLISH_CONSEQUENCE = "It becomes visible in the catalog.";
const PUBLISH_COMING_SOON_CONSEQUENCE = "It goes on sale: plans, prices, cart and trials appear on its page. The waitlist is not emailed automatically.";
const COMING_SOON_CONSEQUENCE =
  "It appears in the catalog with a \u201cComing soon\u201d badge and a \u201cNotify me\u201d form, without prices. It can\u2019t be bought until you publish it.";

/** "/admin/leads?filter[kind]=waitlist" (Leads inbox, waitlist sign-ups). */
const WAITLIST_LEADS_HREF = "/admin/leads?filter%5Bkind%5D=waitlist";

function peopleLabel(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/**
 * Product drawer (Admin Console.dc.html products detail): facts, "Storefront listing" (products.manage; read only
 * otherwise), page content and related products, plans, what publishing still needs, the launch waitlist, and Publish /
 * Mark coming soon / Hide (reason, audited) plus "View on site".
 */
export function ProductDrawer({ id, open, onOpenChange, options, onChanged }: DrawerProps) {
  const { can } = useAdmin();
  const canEdit = can("products.manage");
  const detail = useDetail(id ? `/api/admin/products/${encodeURIComponent(id)}` : null, (b) => (b as { product: AdminProductDetail }).product);
  const p = detail.data;
  const saved = (next: AdminProductDetail) => {
    detail.set(next);
    onChanged();
  };
  const formKey = p ? `${p.id}:${p.updatedAt}` : "none";

  async function changeStatus(action: "publish" | "hide" | "coming-soon", reason: string) {
    if (!p) return;
    const res = await apiFetch<{ product: AdminProductDetail }>(`/api/admin/products/${encodeURIComponent(p.id)}/${action}`, { method: "POST", body: { reason } });
    saved(res.product);
  }

  const published = p?.status === "PUBLISHED";
  const comingSoon = p?.status === "COMING_SOON";
  const listed = published || comingSoon;
  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      kind="Product"
      title={p?.name ?? id ?? "Product"}
      subtitle={p ? `${p.code} \u00B7 ${p.id}` : undefined}
      status={p ? <StatusBadge kind="product" status={p.status} /> : undefined}
      loading={detail.loading}
      error={detail.error}
      fields={
        p
          ? [
              { label: "Category", value: p.categoryName },
              { label: "Platforms", value: platformList(p.platforms) },
              { label: "Latest version", value: p.latest ? `v${p.latest.version}` : "No release yet" },
              { label: "License prefix", value: p.code, mono: true },
              { label: "Trial", value: p.hasTrial ? "Yes" : "No" },
              { label: "Demo requests", value: p.demoEnabled ? "Enabled" : "Off" },
              ...(comingSoon || p.waitlistCount > 0 ? [{ label: "Launch waitlist", value: peopleLabel(p.waitlistCount) }] : []),
            ]
          : undefined
      }
      edit={p ? { title: "Storefront listing", readOnly: !canEdit, form: <ListingForm key={formKey} product={p} options={options} readOnly={!canEdit} onSaved={saved} /> } : undefined}
      sections={
        p
          ? [
              ...(p.status !== "PUBLISHED" && p.publishBlockers.length > 0
                ? [
                    {
                      id: "blockers",
                      title: "Before publishing",
                      content: (
                        <SectionRows aria-label="Before publishing">
                          {p.publishBlockers.map((b) => (
                            <SectionRow key={b} title={b} />
                          ))}
                        </SectionRows>
                      ),
                    },
                  ]
                : []),
              ...(comingSoon || p.waitlistCount > 0
                ? [
                    {
                      id: "waitlist",
                      title: "Launch waitlist",
                      // The count is an aggregate for every role; the sign-ups themselves need Leads access.
                      ...(can("leads.view")
                        ? {
                            action: (
                              <AdminAction size="xs" href={WAITLIST_LEADS_HREF} icon="notifications">
                                View sign-ups
                              </AdminAction>
                            ),
                          }
                        : {}),
                      content: (
                        <SectionRows aria-label="Launch waitlist">
                          <SectionRow
                            title={`${peopleLabel(p.waitlistCount)} asked to hear when it launches`}
                            detail={"Sign-ups from the \u201cNotify me\u201d form on its page, in Leads. Emailing them at launch is not automatic yet."}
                          />
                        </SectionRows>
                      ),
                    },
                  ]
                : []),
              {
                id: "plans",
                title: "Plans",
                empty: "No plans yet. Add them under Plans & pricing.",
                action: (
                  <AdminAction size="xs" href={`/admin/plans?filter[product]=${encodeURIComponent(p.id)}`} icon="sell">
                    Manage plans
                  </AdminAction>
                ),
                content:
                  p.plans.length > 0 ? (
                    <SectionRows aria-label="Plans">
                      {p.plans.map((plan) => (
                        <SectionRow
                          key={plan.id}
                          title={plan.name}
                          detail={planDetail(plan)}
                          status={plan.pricePaise > 0 ? formatINR(plan.pricePaise) : "Free"}
                          tone={plan.archived ? "muted" : "default"}
                        />
                      ))}
                    </SectionRows>
                  ) : null,
              },
              {
                id: "content",
                title: "Page content",
                action: canEdit ? undefined : <ReadOnlyTag />,
                content: (
                  <div className="p-3">
                    <ProductContentForm key={formKey} product={p} options={options} readOnly={!canEdit} onSaved={saved} />
                  </div>
                ),
              },
            ]
          : undefined
      }
      footer={
        p ? (
          <>
            {published ? null : (
              <DestructiveAction
                actionKey="products.publish"
                targetId={p.id}
                targetLabel={p.shortName}
                confirmLabel="Confirm"
                consequence={comingSoon ? PUBLISH_COMING_SOON_CONSEQUENCE : PUBLISH_CONSEQUENCE}
                successMessage="Product updated"
                disabledReason={p.publishBlockers[0]}
                onConfirm={({ reason }) => changeStatus("publish", reason)}
              />
            )}
            {listed ? (
              <DestructiveAction
                actionKey="products.hide"
                targetId={p.id}
                targetLabel={p.shortName}
                triggerLabel="Hide from storefront"
                confirmLabel="Confirm"
                consequence={HIDE_CONSEQUENCE}
                successMessage="Product updated"
                onConfirm={({ reason }) => changeStatus("hide", reason)}
              />
            ) : (
              <DestructiveAction
                actionKey="products.coming_soon"
                targetId={p.id}
                targetLabel={p.shortName}
                confirmLabel="Confirm"
                consequence={COMING_SOON_CONSEQUENCE}
                successMessage="Product updated"
                disabledReason={p.comingSoonBlockers[0]}
                onConfirm={({ reason }) => changeStatus("coming-soon", reason)}
              />
            )}
            <AdminAction
              size="sm"
              icon="open_in_new"
              href={`/software/${encodeURIComponent(p.id)}`}
              newTab
              disabledReason={listed ? undefined : "Not on the storefront until it\u2019s published or marked coming soon"}
            >
              View on site
            </AdminAction>
          </>
        ) : undefined
      }
    />
  );
}
