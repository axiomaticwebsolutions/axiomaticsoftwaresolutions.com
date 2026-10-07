"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { CardHeading, invalidProps, SECURITY_CARD, SECURITY_INPUT, SECURITY_SUBMIT, SecurityField } from "./security-parts";
import { firstError, SECURITY_COPY, validateProfile, type FieldErrors, type ProfileField, type ProfileValues } from "./security-model";

export type ProfileFormProps = {
  name: string;
  phone: string | null;
  email: string;
  emailVerified: boolean;
};

const FIELDS: readonly ProfileField[] = ["name", "phone"];
const IDS: Record<ProfileField, string> = { name: "profile-name", phone: "profile-phone" };

type ProfileResponse = { user: { name: string; phone: string | null } };

/**
 * "Your profile" (prototype): Full name, Mobile and the read-only email with Verified / Not verified. Saves through
 * PATCH /api/me (no activity entry) and refreshes the shell so the sidebar shows the new name. Toast "Profile saved".
 */
export function ProfileForm({ name, phone, email, emailVerified }: ProfileFormProps) {
  const router = useRouter();
  const [values, setValues] = React.useState<ProfileValues>({ name, phone: phone ?? "" });
  const [errors, setErrors] = React.useState<FieldErrors<ProfileField>>({});
  const [busy, setBusy] = React.useState(false);

  function set(field: ProfileField, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  function focus(field: ProfileField | null) {
    if (field) window.requestAnimationFrame(() => document.getElementById(IDS[field])?.focus());
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const problems = validateProfile(values);
    if (firstError(problems, FIELDS)) {
      setErrors(problems);
      focus(firstError(problems, FIELDS));
      return;
    }
    setBusy(true);
    try {
      const { user } = await apiFetch<ProfileResponse>("/api/me", {
        method: "PATCH",
        body: { name: values.name, phone: values.phone },
      });
      setValues({ name: user.name, phone: user.phone ?? "" });
      setErrors({});
      toast.success(SECURITY_COPY.profileSaved);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiClientError) {
        const fields: FieldErrors<ProfileField> = {};
        for (const field of FIELDS) {
          const message = error.fieldErrors[field]?.[0];
          if (message) fields[field] = message;
        }
        if (firstError(fields, FIELDS)) {
          setErrors(fields);
          focus(firstError(fields, FIELDS));
        } else {
          toast.error(error.message);
        }
      } else {
        toast.error(UNEXPECTED_ERROR_MESSAGE);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form noValidate onSubmit={submit} aria-labelledby="security-profile-heading" className={SECURITY_CARD}>
      <CardHeading id="security-profile-heading">{SECURITY_COPY.profileHeading}</CardHeading>
      <div className="grid gap-3 px-[18px] py-4">
        <SecurityField id={IDS.name} label={SECURITY_COPY.fullName} error={errors.name}>
          <input
            id={IDS.name}
            type="text"
            autoComplete="name"
            maxLength={200}
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
            className={SECURITY_INPUT}
            {...invalidProps(IDS.name, errors.name)}
          />
        </SecurityField>
        <SecurityField id={IDS.phone} label={SECURITY_COPY.mobile} error={errors.phone}>
          <input
            id={IDS.phone}
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            maxLength={20}
            value={values.phone}
            onChange={(event) => set("phone", event.target.value)}
            className={SECURITY_INPUT}
            {...invalidProps(IDS.phone, errors.phone)}
          />
        </SecurityField>
        <div className="grid gap-[5px]">
          <span id="profile-email-label" className="text-[13px] font-bold">
            {SECURITY_COPY.email}
          </span>
          <div
            role="group"
            aria-labelledby="profile-email-label"
            className="flex min-h-10 flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-10 border border-line-subtle bg-bg px-3 py-2 text-[14px] font-semibold"
          >
            <span className="min-w-0 break-all">{email}</span>
            <Badge
              tone={emailVerified ? "sage" : "peach"}
              className="px-2 py-0.5 text-[11.5px] leading-[normal]"
            >
              {emailVerified ? SECURITY_COPY.verified : SECURITY_COPY.notVerified}
            </Badge>
          </div>
        </div>
      </div>
      <div className="flex justify-end border-t border-line-subtle px-[18px] py-3">
        <Button type="submit" loading={busy} className={SECURITY_SUBMIT}>
          {SECURITY_COPY.saveProfile}
        </Button>
      </div>
    </form>
  );
}
