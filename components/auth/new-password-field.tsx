"use client";

import * as React from "react";
import { Field } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { passwordStrength } from "./auth-model";
import { PasswordInput } from "./auth-ui";
import { AUTH_COPY } from "./copy";

export type NewPasswordFieldProps = {
  id: string;
  /** Form field name (password managers read autocomplete, this is for completeness). */
  name?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  /** Hide the live hint (the confirm field of /reset). */
  showStrength?: boolean;
};

/**
 * New-password field (register, reset): show/hide toggle and the prototype's live hint under it, "At least 8
 * characters with letters and a number" turning into a green "Good password". Before typing starts the hint is not
 * shown (prototype), but the policy is still in the field's description for screen readers.
 */
export function NewPasswordField({
  id,
  name = "password",
  label,
  value,
  onChange,
  error,
  visible,
  onVisibleChange,
  showStrength = true,
}: NewPasswordFieldProps) {
  const strength = passwordStrength(value);
  const policyId = `${id}-policy`;
  const hint =
    showStrength && strength.state !== "empty" ? (
      <span className={cn("font-semibold", strength.state === "good" && "text-sage-fg")}>{strength.message}</span>
    ) : undefined;

  return (
    <Field id={id} label={label} error={error} hint={hint}>
      {(control) => (
        <div className="relative">
          <PasswordInput
            {...control}
            aria-describedby={
              [control["aria-describedby"], showStrength && strength.state === "empty" ? policyId : null].filter(Boolean).join(" ") ||
              undefined
            }
            name={name}
            autoComplete="new-password"
            maxLength={1024}
            visible={visible}
            onVisibleChange={onVisibleChange}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          {showStrength && strength.state === "empty" ? (
            <span id={policyId} className="sr-only">
              {AUTH_COPY.strength.weak}
            </span>
          ) : null}
        </div>
      )}
    </Field>
  );
}
