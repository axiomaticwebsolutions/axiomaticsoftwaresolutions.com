"use client";

import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { FieldGrid, type AdminField } from "@/components/admin/field-grid";
import { AdminSection } from "@/components/admin/section";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { READ_ONLY_FOR_ROLE } from "@/lib/rbac";
import { cn } from "@/lib/utils";

export type { AdminField };

export type AdminDrawerEdit = {
  /** Card title, e.g. "Pricing & limits" (default "Edit"). */
  title?: React.ReactNode;
  /** The form (fields + a submit). Rendered inside a fieldset that is disabled when readOnly. */
  form: React.ReactNode;
  /** The role lacks the edit permission: inputs and submit are disabled and the card says why. */
  readOnly: boolean;
  /** Note shown while read only (default "Read only for your role"). */
  readOnlyNote?: React.ReactNode;
};

export type AdminDrawerSection = {
  id: string;
  title: React.ReactNode;
  content: React.ReactNode;
  /** Shown instead of empty content (null, false or []), e.g. "No devices activated." */
  empty?: React.ReactNode;
  /** Small element at the end of the title row. */
  action?: React.ReactNode;
};

export type AdminDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Overline above the title: "Order", "License", "Coupon" (shown in capitals). */
  kind?: string;
  title: React.ReactNode;
  /** Line next to the status badge: "7 Oct, 6:38 am · arjun@spiceroutekitchen.example". */
  subtitle?: React.ReactNode;
  /** Usually a <StatusBadge>. */
  status?: React.ReactNode;
  fields?: readonly AdminField[];
  edit?: AdminDrawerEdit;
  sections?: readonly AdminDrawerSection[];
  /** Footer actions (AdminAction size="sm", DestructiveAction). */
  footer?: React.ReactNode;
  /** Details are loading: skeleton blocks instead of fields and sections. */
  loading?: boolean;
  /** Loading failed or the row does not exist: shown instead of the body (role="alert"). */
  error?: React.ReactNode;
  /** Extra content after the sections. */
  children?: React.ReactNode;
  className?: string;
};

function DrawerSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-4">
      <span role="status" className="sr-only">
        Loading
      </span>
      <div className="grid grid-cols-2 overflow-hidden rounded-12 border border-line-subtle">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="grid gap-1.5 px-3 py-2.5">
            <Skeleton className="h-3 w-16 rounded-6" />
            <Skeleton alt className="h-4 w-28 max-w-full rounded-6" />
          </div>
        ))}
      </div>
      <Skeleton alt className="h-[120px] rounded-12" />
      <Skeleton alt className="h-[96px] rounded-12" />
    </div>
  );
}

/** The edit card: title row (with "Read only for your role" when locked) and the form in a fieldset. */
function EditCard({ edit, id }: { edit: AdminDrawerEdit; id: string }) {
  return (
    <section aria-labelledby={id} className="min-w-0 rounded-12 border border-line-subtle">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line-subtle px-3 py-2.5">
        <h3 id={id} className="m-0 text-[12.5px] font-extrabold leading-[normal]">
          {edit.title ?? "Edit"}
        </h3>
        {edit.readOnly ? (
          <span className="flex items-center gap-1 text-[12.5px] font-extrabold text-danger">
            <Icon name="lock" size={15} />
            {edit.readOnlyNote ?? READ_ONLY_FOR_ROLE}
          </span>
        ) : null}
      </div>
      <fieldset disabled={edit.readOnly} className="m-0 grid min-w-0 gap-2.5 border-0 p-3">
        {edit.form}
      </fieldset>
    </section>
  );
}

/**
 * Admin detail drawer (Admin Console.dc.html): a 560px right Sheet (full width on phones) with the kind overline,
 * title, status badge and sub line, a close button, then the facts grid, an optional edit form (read-only for roles
 * without the permission), sections and footer actions. Radix Dialog underneath: focus moves into the drawer, Tab
 * stays inside, Escape and the scrim close it, and focus returns to the row that opened it. Keep it in the URL
 * with useDrawerParam().
 */
export function AdminDrawer({
  open,
  onOpenChange,
  kind,
  title,
  subtitle,
  status,
  fields,
  edit,
  sections,
  footer,
  loading = false,
  error,
  children,
  className,
}: AdminDrawerProps) {
  const uid = React.useId();
  const hasError = error !== undefined && error !== null && error !== false;
  // Radix warns when a dialog has no description; without a subtitle there is none to point at.
  const describedBy = subtitle ? {} : { "aria-describedby": undefined };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" showClose={false} className={cn("leading-[normal]", className)} {...describedBy}>
        <div className="flex items-start gap-3 border-b border-line-subtle px-[18px] py-4">
          <div className="min-w-0 flex-1">
            {kind ? <p className="m-0 text-[11.5px] font-extrabold uppercase tracking-[0.08em] text-ink-2">{kind}</p> : null}
            <SheetTitle className="mt-0.5 break-words text-[18px] font-extrabold leading-snug tracking-normal">{title}</SheetTitle>
            {status || subtitle ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {status}
                {subtitle ? (
                  <SheetDescription className="m-0 text-[12.5px] font-semibold text-ink-2">{subtitle}</SheetDescription>
                ) : null}
              </div>
            ) : null}
          </div>
          <SheetClose asChild>
            <button
              type="button"
              aria-label="Close"
              className="grid size-[34px] shrink-0 cursor-pointer place-items-center rounded-9 border border-line-alt bg-surface text-ink transition-colors hover:border-line-input hover:bg-bg"
            >
              <Icon name="close" size={19} />
            </button>
          </SheetClose>
        </div>

        <div
          role="region"
          aria-label={kind ? `${kind} details` : "Details"}
          // The body scrolls; read-only drawers can have no control in it, so it must be keyboard reachable itself
          // (WCAG 2.1.1; axe scrollable-region-focusable).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          className="grid min-h-0 flex-1 auto-rows-max content-start gap-4 overflow-y-auto px-[18px] py-4 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
        >
          {hasError ? (
            <div role="alert" className="rounded-12 border border-pink-line bg-pink-soft px-3.5 py-3 text-[13.5px] font-bold text-danger">
              {error}
            </div>
          ) : loading ? (
            <DrawerSkeleton />
          ) : (
            <>
              {fields && fields.length > 0 ? <FieldGrid fields={fields} /> : null}
              {edit ? <EditCard edit={edit} id={`${uid}-edit`} /> : null}
              {sections?.map((section) => (
                <AdminSection key={section.id} id={`${uid}-${section.id}`} title={section.title} empty={section.empty} action={section.action}>
                  {section.content}
                </AdminSection>
              ))}
              {children}
            </>
          )}
        </div>

        {footer ? <div className="flex flex-wrap gap-2 border-t border-line-subtle px-[18px] py-3">{footer}</div> : null}
      </SheetContent>
    </Sheet>
  );
}

/** The edit form's submit button (prototype "Save changes": 7x14px, radius 8, 13px/700, primary). */
export function DrawerSubmit({ children = "Save changes", className, ...props }: Omit<ButtonProps, "variant" | "size" | "type">) {
  return (
    <Button
      type="submit"
      variant="primary"
      size="sm"
      className={cn("justify-self-start px-3.5 py-[7px] text-[13px]", className)}
      {...props}
    >
      {children}
    </Button>
  );
}
