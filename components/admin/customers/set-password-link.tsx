"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { adminToast } from "@/components/admin/admin-toaster";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CUSTOMER_RECORD_COPY as COPY } from "@/lib/admin/customers/model";
import { formatDateIST } from "@/lib/dates";

export type OneTimeLink = {
  url: string;
  /** ISO time the link stops working. */
  expiresAt: string;
  emailSent: boolean;
  /** Who it is for ("Priya Sharma"). */
  name: string;
};

/**
 * The one-time set-password link panel (after "New customer" or "Create set-password link"): the read-only link,
 * "Copy link", where it was sent and the sharing warning. It takes focus when it appears. The link lives only in the
 * caller's component state: never in the URL, storage or a toast.
 */
export function SetPasswordLinkPanel({ link, heading, actions }: { link: OneTimeLink; heading?: string; actions?: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const inputId = React.useId();
  React.useEffect(() => {
    ref.current?.focus();
  }, []);
  const date = formatDateIST(new Date(link.expiresAt));

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(link.url);
      adminToast.success(COPY.copied);
    } catch {
      adminToast.error(null, COPY.copyFailed);
    }
  }

  return (
    <Alert ref={ref} tabIndex={-1} data-link-panel="" tone="success" role="status" className="text-[13.5px] focus-visible:outline-2 focus-visible:outline-primary">
      {heading ? <AlertTitle className="text-[14px]">{heading}</AlertTitle> : null}
      <AlertDescription className="grid gap-2.5 text-[13px]">
        <Field size="sm" label={COPY.linkLabel} id={`${inputId}-link`}>
          <Input size="sm" mono readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} className="text-[12.5px]" />
        </Field>
        <div className="flex flex-wrap gap-2">
          <AdminAction size="sm" icon="content_copy" onClick={copy}>
            {COPY.copyLink}
          </AdminAction>
        </div>
        <p className="m-0">{link.emailSent ? COPY.linkSent(link.name, date) : COPY.linkNotSent(link.name, date)}</p>
        <p className="m-0 font-bold">{COPY.linkWarning}</p>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </AlertDescription>
    </Alert>
  );
}
