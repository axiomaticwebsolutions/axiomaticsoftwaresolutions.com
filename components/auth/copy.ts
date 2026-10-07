/**
 * Copy of the auth pages, verbatim from design_handoff_axiomatic/prototype/Account.dc.html (modes signin | register |
 * verify | forgot | reset). Lines the prototype does not have (two-step step, invalid reset link, signed-out verify,
 * password toggle, resend countdown) are marked "new". Server messages (wrong password, attempts left, lockout,
 * expired codes) come from the API (lib/auth/flows/common.ts AUTH_MESSAGES) and are shown as they arrive.
 * Pure and client-safe.
 */
import type { IconName } from "@/components/icons/icon";

export const AUTH_BRAND = "Axiomatic";

export const AUTH_ASIDE = {
  headline: "Your licenses, downloads and invoices in one place.",
  bullets: [
    { icon: "key", text: "See keys and the computers using them" },
    { icon: "download", text: "Download the versions you’re eligible for" },
    { icon: "receipt_long", text: "Get GST invoices and renew in a few clicks" },
  ] as const satisfies ReadonlyArray<{ icon: IconName; text: string }>,
} as const;

export const AUTH_COPY = {
  busy: "Please wait…",
  signedIn: {
    pre: "You’re signed in as",
    goToAccount: "Go to your account",
    signOut: "Sign out",
  },
  /** new: password visibility toggle (aria-pressed carries the state). */
  showPassword: "Show password",
  strength: {
    weak: "At least 8 characters with letters and a number",
    good: "Good password",
  },
  signIn: {
    title: "Sign in",
    subtitle: "Access your licenses, downloads and invoices.",
    email: "Email",
    password: "Password",
    forgot: "Forgot password?",
    cta: "Sign in",
    footerPre: "New to Axiomatic?",
    footerLink: "Create an account",
    resetNotice: "Password updated. Sign in with your new password.",
  },
  /** new: the two-step step after the password (API returns requires2fa). */
  twoStep: {
    title: "Enter your sign-in code",
    subtitle: (hint: string) => `We sent a 6-digit code to ${hint}. It expires in 10 minutes.`,
    code: "Sign-in code",
    trust: "Trust this device for 30 days",
    trustHint: "We won’t ask for a code on this browser for 30 days. Leave it unticked on a shared computer.",
    cta: "Sign in",
    resendPre: "Didn’t get it?",
    resend: "Resend code",
    resent: "A new code has been sent.",
    back: "Back to sign in",
  },
  register: {
    title: "Create your account",
    trialTitle: "Start your free trial",
    subtitle: "Bought as a guest? Use the same email and your purchases will appear automatically.",
    trialNotice: "Create a free account to start your trial. No payment needed.",
    name: "Full name",
    business: "Business name (optional)",
    email: "Email",
    password: "Password",
    cta: "Create account",
    trialCta: "Create account & start trial",
    footerPre: "Already have an account?",
    footerLink: "Sign in",
    /** Shown on /verify after registering. */
    created: "Account created. Check your email for a verification code.",
    /** The 409 email_taken message is split so "Sign in instead." can be a link. */
    emailTakenLead: "An account with this email already exists.",
    emailTakenLink: "Sign in instead.",
  },
  verify: {
    title: "Verify your email",
    subtitle: (email: string | null) => `We sent a 6-digit code to ${email || "your email"}. It expires in 15 minutes.`,
    code: "Verification code",
    cta: "Verify email",
    resendPre: "Didn’t get it?",
    resend: "Resend code",
    resent: "A new code has been sent.",
    signedOut: "Sign in again to verify your email.",
    signInCta: "Sign in",
  },
  forgot: {
    title: "Reset your password",
    subtitle: "Enter your account email and we’ll send a reset link.",
    email: "Email",
    cta: "Send reset link",
    footerPre: "Remembered it?",
    footerLink: "Back to sign in",
    sent: (email: string) => `If an account exists for ${email}, a reset link is on its way.`,
  },
  reset: {
    title: "Choose a new password",
    subtitle: (email: string | null) => `For ${email || "your account"}. Other sessions will be signed out.`,
    password: "New password",
    confirm: "Confirm password",
    cta: "Update password",
    back: "Back to sign in",
    mismatch: "Passwords don’t match.",
    /** new: invalid, used or expired link. */
    invalidSubtitle: "Reset links work once and expire 30 minutes after they are sent.",
    requestNew: "Request a new link",
  },
  /** new: resend cooldown label, e.g. "Resend code in 27s". */
  resendIn: (seconds: number) => `Resend code in ${seconds}s`,
} as const;
