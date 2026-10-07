"use client";

import Link from "next/link";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormErrorSummary, type FormError } from "@/components/ui/field";
import { Input, type InputProps } from "@/components/ui/input";
import { CUSTOMER_HOME } from "@/lib/auth/redirect";
import { cn } from "@/lib/utils";
import { AUTH_COPY } from "./copy";
import { codeFromPaste, safeRedirectTarget, sanitizeCode, CODE_LENGTH } from "./auth-model";

/**
 * Leaves the auth page after the session changed (sign-in, verification, reset): a full page load, so every part of
 * the next page (header included) starts from the new session. Only same-origin paths are followed.
 */
export function leaveAuthPage(path: unknown, fallback: string = CUSTOMER_HOME): void {
  window.location.assign(safeRedirectTarget(path, fallback));
}

/** Prototype input: 50px, radius 13, 14px side padding, 15.5px/600 (focus ring and invalid border come from Input). */
export const AUTH_INPUT_CLASS = "h-[50px] rounded-13 px-3.5 text-[15.5px] font-semibold";

/** Prototype links: primary-link colour, underlined, darker on hover. */
export const AUTH_LINK_CLASS =
  "rounded-6 text-primary-link underline decoration-1 underline-offset-[3px] hover:text-primary-link-hover";

export type AuthHeadingProps = {
  title: string;
  subtitle?: React.ReactNode;
  /** Focus the heading on mount (step changes inside one page). */
  headingRef?: React.Ref<HTMLHeadingElement>;
};

/** H1 30px/800 and the 15.5px subtitle. */
export function AuthHeading({ title, subtitle, headingRef }: AuthHeadingProps) {
  return (
    <>
      <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="m-0 text-[30px] font-extrabold tracking-[-0.03em] outline-none">
        {title}
      </h1>
      {subtitle ? <p className="mb-0 mt-2 text-[15.5px] leading-[1.55] text-ink-2">{subtitle}</p> : null}
    </>
  );
}

/** Blue notice (role=status): "Account created…", "A new code has been sent.", trial note. */
export function AuthNotice({ children }: { children: React.ReactNode }) {
  return (
    <Alert
      tone="info"
      icon={null}
      className="mt-[18px] rounded-12 border-0 px-3.5 py-3 text-[14px] font-semibold leading-[normal] [&>div]:gap-0"
    >
      {children}
    </Alert>
  );
}

/** Pink server-error banner (role=alert) with the error icon. */
export function AuthErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <Alert
      tone="danger"
      className="mt-[18px] gap-2 rounded-12 border-0 px-3.5 py-3 text-[14px] font-bold leading-[normal] [&>svg]:mt-0 [&>svg]:size-[19px]"
    >
      {children}
    </Alert>
  );
}

/** Client-side error summary in the banner's place; each entry focuses its field. */
export function AuthErrorSummary({ id, errors }: { id: string; errors: readonly FormError[] }) {
  return (
    <FormErrorSummary
      id={id}
      errors={errors}
      focusOnMount={false}
      className="mt-[18px] gap-2 rounded-12 px-3.5 py-3 text-[14px] [&>svg]:size-[19px]"
    />
  );
}

/** Full-width 52px primary submit; busy shows the spinner and "Please wait…" (keyboard focus stays on it). */
export function AuthSubmit({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <Button
      type="submit"
      size="lg"
      loading={busy}
      loadingText={AUTH_COPY.busy}
      className="h-[52px] w-full gap-2.5 py-0 text-base font-extrabold shadow-none aria-disabled:opacity-100"
    >
      {children}
    </Button>
  );
}

export type AuthFooterItem = { pre?: string; label: string; href?: string; onClick?: () => void; disabled?: boolean };

/** "{pre} {link}" row under the form (14.5px/600, links 800). Items without href render as link-styled buttons. */
export function AuthFooter({ items }: { items: readonly AuthFooterItem[] }) {
  return (
    <div className="mt-[22px] flex flex-wrap gap-x-1.5 gap-y-1 text-[14.5px] font-semibold text-ink-2">
      {items.map((item, index) => (
        // Index keys: labels change (the resend countdown) and a remount would drop keyboard focus.
        <span key={index}>
          {item.pre ? `${item.pre} ` : null}
          {item.href ? (
            <Link href={item.href} className={cn(AUTH_LINK_CLASS, "font-extrabold")}>
              {item.label}
            </Link>
          ) : (
            <LinkButton onClick={item.onClick} disabled={item.disabled}>
              {item.label}
            </LinkButton>
          )}
          {/* The separator trails its item, so a wrapped row never starts with it. */}
          {index < items.length - 1 ? <span aria-hidden="true" className="ml-1.5">·</span> : null}
        </span>
      ))}
    </div>
  );
}

/**
 * A button that looks like the prototype's text links (Resend code, Sign out). `disabled` uses aria-disabled so a
 * focused button keeps focus while a countdown runs.
 */
export function LinkButton({
  className,
  disabled,
  onClick,
  ...props
}: Omit<React.ComponentProps<"button">, "type"> & { disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cn(
        AUTH_LINK_CLASS,
        "cursor-pointer border-0 bg-transparent p-0 font-extrabold",
        "aria-disabled:cursor-default aria-disabled:text-ink-2 aria-disabled:no-underline",
        className,
      )}
      {...props}
    />
  );
}

/** Text input with the prototype's sizing. */
export function AuthInput({ className, ...props }: InputProps) {
  return <Input className={cn(AUTH_INPUT_CLASS, className)} {...props} />;
}

export type PasswordInputProps = Omit<InputProps, "type"> & {
  /** Hide the value again (e.g. on submit, so password managers see a password field). */
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
};

/**
 * Password input with a show/hide toggle inside the right edge (new; not in the prototype). The toggle keeps one
 * name, "Show password", and reports its state with aria-pressed.
 */
export function PasswordInput({ visible, onVisibleChange, className, id, ...props }: PasswordInputProps) {
  return (
    <div className="relative">
      <AuthInput
        id={id}
        type={visible ? "text" : "password"}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        className={cn("pr-12", className)}
        {...props}
      />
      <button
        type="button"
        aria-label={AUTH_COPY.showPassword}
        aria-pressed={visible}
        aria-controls={id}
        onClick={() => onVisibleChange(!visible)}
        className="absolute right-[5px] top-1/2 grid size-10 -translate-y-1/2 cursor-pointer place-items-center rounded-10 border-0 bg-transparent text-ink-2 transition-colors hover:bg-lavender-bg hover:text-lavender-fg"
      >
        <Icon name={visible ? "visibility_off" : "visibility"} size={21} />
      </button>
    </div>
  );
}

export type CodeInputProps = Omit<InputProps, "value" | "onChange" | "type"> & {
  value: string;
  onValueChange: (code: string) => void;
};

/**
 * Six-digit code: numeric keyboard, one-time-code autofill, digits only while typing, and paste of a whole code
 * ("482 913", "Your code: 482913") replaces the field; partial pastes are left to the browser. 22px with .4em tracking (prototype).
 */
export function CodeInput({ value, onValueChange, className, onPaste, ...props }: CodeInputProps) {
  return (
    <AuthInput
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={CODE_LENGTH}
      spellCheck={false}
      value={value}
      onChange={(event) => onValueChange(sanitizeCode(event.target.value))}
      onPaste={(event) => {
        onPaste?.(event);
        const text = event.clipboardData.getData("text");
        const code = codeFromPaste(text);
        if (code.length !== CODE_LENGTH) return;
        event.preventDefault();
        onValueChange(code);
      }}
      className={cn("text-[22px] tracking-[0.4em]", className)}
      {...props}
    />
  );
}
