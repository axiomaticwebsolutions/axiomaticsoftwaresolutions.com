import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_TEMPLATES, templateBody } from "@/prisma/seed-data/content";
import { palette } from "@/lib/design/tokens";
import {
  AUTH_EMAIL_TEMPLATE_IDS,
  DIRECT_EMAIL_TEMPLATE_IDS,
  EMAIL_TEMPLATE_DEFAULTS,
  EMAIL_TEMPLATE_IDS,
  isAuthEmailTemplateId,
  isDirectEmailTemplateId,
  missingRequiredVars,
  type EmailBlock,
} from "@/lib/email/defaults";
import { emailDocumentHtml, emailDocumentText, escapeHtml, footerAddress, type EmailFooter } from "@/lib/email/layout";
import {
  defaultUnknownVarMode,
  fillHtml,
  fillText,
  isHttpUrl,
  renderEmail,
  splitParagraphs,
  subjectLine,
  templateVarNames,
  MAX_SUBJECT_LENGTH,
} from "@/lib/email/render";

const APP_URL = "https://axiomaticsoftwaresolutions.com";
const FOOTER: EmailFooter = {
  legalName: "Axiomatic Software Solutions <Pvt> & Co",
  address: "12 MG Road",
  city: "Pune",
  state: "Maharashtra",
  pin: "411001",
  supportEmail: "support@axiomatic.example",
};

function render(subject: string, body: string, blocks: readonly EmailBlock[], vars: Record<string, string>, mode: "keep" | "blank" = "keep") {
  return renderEmail({ subject, body, blocks, vars, footer: FOOTER, appUrl: APP_URL, unknownVars: mode });
}

afterEach(() => vi.unstubAllEnvs());

describe("substitution and escaping", () => {
  it("escapes template text and values in HTML, newlines become <br>", () => {
    expect(fillHtml("<b>Hi</b> {{name}}\nnext", { name: `<script>alert("x")</script> & 'q'` })).toBe(
      "&lt;b&gt;Hi&lt;/b&gt; &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;<br>next",
    );
    expect(fillHtml("{{ name }}", { name: "a\nb" })).toBe("a<br>b");
  });

  it("leaves plain text unescaped but strips control characters", () => {
    expect(fillText("Hi {{name}} <ok>", { name: "A & B\u0000\u0007\r\nC" })).toBe("Hi A & B\nC <ok>");
  });

  it("keeps unknown placeholders visible in development and blanks them in production", () => {
    expect(fillText("Hi {{name}}, {{missing}}!", { name: "Priya" }, "keep")).toBe("Hi Priya, {{missing}}!");
    expect(fillText("Hi {{name}}, {{missing}}!", { name: "Priya" }, "blank")).toBe("Hi Priya, !");
    expect(fillHtml("{{missing}}", {}, "keep")).toBe("{{missing}}");
    expect(defaultUnknownVarMode()).toBe("keep");
    vi.stubEnv("NODE_ENV", "production");
    expect(defaultUnknownVarMode()).toBe("blank");
  });

  it("ignores inherited properties and non-string values", () => {
    const vars = { n: 5 } as unknown as Record<string, string>;
    expect(fillText("{{toString}} {{n}}", vars, "blank")).toBe(" ");
  });

  it("links only http(s) values of *_url variables", () => {
    expect(fillHtml("{{order_url}}", { order_url: "https://x.example/o?a=1&t=2" })).toContain(
      '<a href="https://x.example/o?a=1&amp;t=2"',
    );
    expect(fillHtml("{{order_url}}", { order_url: "javascript:alert(1)" })).toBe("javascript:alert(1)");
    expect(fillHtml("{{message}}", { message: "see https://spam.example" })).not.toContain("<a ");
    expect(isHttpUrl("https://a.example")).toBe(true);
    expect(isHttpUrl("http://a.example/x")).toBe(true);
    expect(isHttpUrl("ftp://a.example")).toBe(false);
    expect(isHttpUrl("https://")).toBe(false);
  });

  it("makes the subject one safe header line", () => {
    expect(subjectLine("Code\r\nBcc: x@evil.example  \t ok ")).toBe("Code Bcc: x@evil.example ok");
    const long = subjectLine("x".repeat(500));
    expect(long).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });

  it("splits paragraphs on blank lines and lists placeholders", () => {
    expect(splitParagraphs("a\r\nb\n \nc\n\n\n")).toEqual(["a\nb", "c"]);
    expect(templateVarNames("{{a}} {{ b }} {{a}} {{9x}}")).toEqual(["a", "b"]);
  });
});

describe("renderEmail", () => {
  const blocks: EmailBlock[] = [
    { kind: "details", rows: [{ label: "Order", var: "order_id" }, { label: "Invoice", var: "invoice_number" }] },
    { kind: "button", label: "View your order", urlVar: "order_url" },
    { kind: "note", text: "Order {{order_id}} & more" },
  ];
  const vars = { customer_name: "Priya", order_id: "AX-10312", order_url: "https://app.example/orders/AX-10312?t=a&b=\"c\"" };

  it("places blocks before the sign-off and builds both versions", () => {
    const out = render("Order {{order_id}}", "Hi {{customer_name}},\n\nThanks.\n\nThanks,\nAxiomatic", blocks, vars);
    expect(out.subject).toBe("Order AX-10312");
    expect(out.unknownVars).toEqual([]);
    const html = out.html;
    const order = ["Thanks.", "View your order", "Order AX-10312 &amp; more", "Thanks,<br>Axiomatic"].map((s) => html.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('href="https://app.example/orders/AX-10312?t=a&amp;b=&quot;c&quot;"');
    expect(html).not.toContain("Invoice"); // blank row hidden
    expect(out.text).toBe(
      [
        "Hi Priya,",
        "Thanks.",
        "Order: AX-10312",
        `View your order: ${vars.order_url}`,
        "Order AX-10312 & more",
        "Thanks,\nAxiomatic",
      ].join("\n\n") +
        "\n\n--\nAxiomatic Software Solutions <Pvt> & Co\n12 MG Road, Pune, Maharashtra 411001\nQuestions? Email support@axiomatic.example\nYou received this email because of a request or purchase on axiomaticsoftwaresolutions.com.\n",
    );
  });

  it("appends blocks after short bodies and skips blocks without values", () => {
    const out = render("S", "Just one line", [...blocks, { kind: "code", label: "Code", var: "code" }], { order_url: "not a url" });
    expect(out.html).not.toContain("View your order");
    expect(out.text.startsWith("Just one line\n\nOrder {{order_id}} & more")).toBe(true);
    expect(out.unknownVars).toEqual(["order_id"]);
  });

  it("renders a code box and a quote with escaped multi-line text", () => {
    const out = render("S", "Body", [
      { kind: "code", label: "Verification code", var: "code" },
      { kind: "quote", label: "Message", var: "message" },
    ], { code: "004219", message: "Line <1>\nLine 2" });
    expect(out.html).toContain(">004219<");
    expect(out.html).toContain("Line &lt;1&gt;<br>Line 2");
    expect(out.text).toContain("Verification code: 004219");
    expect(out.text).toContain("Message:\nLine <1>\nLine 2");
  });

  it("uses the first non-greeting paragraph as the hidden preheader", () => {
    const out = render("Subject", "Hi Priya,\n\nYour code is below.\n\nThanks", [], {});
    expect(out.html).toMatch(/display:none[^>]*>Your code is below\.<\/div>/);
  });

  it("blanks unknown placeholders in production mode", () => {
    const out = render("Hi {{x}}", "Hello {{x}}", [], {}, "blank");
    expect(out.subject).toBe("Hi");
    expect(out.html).not.toContain("{{x}}");
    expect(out.unknownVars).toEqual(["x"]);
  });
});

describe("layout", () => {
  const html = emailDocumentHtml({
    subject: "Order <AX-1>",
    preheader: "Preview & more",
    contentHtml: "<p>Body</p>",
    footer: FOOTER,
    appUrl: APP_URL,
  });

  it("is a table-based document with inline styles, no images, styles or scripts", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Order &lt;AX-1&gt;</title>");
    expect(html).toContain('role="presentation"');
    expect(html).not.toMatch(/<img|<style|<script|<link|url\(/i);
    expect(html).toContain("Preview &amp; more");
  });

  it("links only to the app and the support mailbox", () => {
    const urls = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url === APP_URL || url === "mailto:support@axiomatic.example").toBe(true);
  });

  it("uses the token colours and shows the seller details", () => {
    for (const colour of [palette.primary.DEFAULT, palette.ink.DEFAULT, palette.ink["2"], palette.bg.portal]) {
      expect(html).toContain(colour);
    }
    expect(html).toContain("Axiomatic Software Solutions &lt;Pvt&gt; &amp; Co");
    expect(html).toContain("12 MG Road, Pune, Maharashtra 411001");
    expect(html).toContain("You received this email because of a request or purchase on axiomaticsoftwaresolutions.com.");
    expect(footerAddress({ ...FOOTER, address: " ", pin: "" })).toBe("Pune, Maharashtra");
  });

  it("builds the plain-text alternative with the footer", () => {
    expect(emailDocumentText({ contentText: "  Hello\n", footer: FOOTER, appUrl: APP_URL })).toBe(
      "Hello\n\n--\nAxiomatic Software Solutions <Pvt> & Co\n12 MG Road, Pune, Maharashtra 411001\nQuestions? Email support@axiomatic.example\nYou received this email because of a request or purchase on axiomaticsoftwaresolutions.com.\n",
    );
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("template defaults", () => {
  const placeholders = (t: (typeof EMAIL_TEMPLATE_DEFAULTS)[keyof typeof EMAIL_TEMPLATE_DEFAULTS]) => [
    ...templateVarNames(t.subject),
    ...templateVarNames(t.body),
    ...t.blocks.flatMap((b) =>
      b.kind === "note" ? templateVarNames(b.text) : b.kind === "details" ? b.rows.map((r) => r.var) : [b.kind === "button" ? b.urlVar : b.var],
    ),
  ];

  it("declares every placeholder and required variable, and renders its samples completely", () => {
    for (const id of EMAIL_TEMPLATE_IDS) {
      const t = EMAIL_TEMPLATE_DEFAULTS[id];
      expect(t.id).toBe(id);
      for (const name of placeholders(t)) expect(t.vars, `${id}: ${name}`).toContain(name);
      for (const name of t.required) expect(t.vars, `${id}: ${name}`).toContain(name);
      for (const name of t.vars) expect(Object.keys(t.sampleVars), `${id}: ${name}`).toContain(name);
      expect(missingRequiredVars(t.required, t.sampleVars)).toEqual([]);
      const out = render(t.subject, t.body, t.blocks, t.sampleVars, "blank");
      expect(out.unknownVars, id).toEqual([]);
      expect(out.html).not.toMatch(/\{\{/);
      expect(out.text).not.toMatch(/\{\{/);
    }
  });

  it("keeps the auth codes and links in code-defined blocks", () => {
    expect([...AUTH_EMAIL_TEMPLATE_IDS]).toEqual(["email_verification", "password_reset", "login_code"]);
    expect(isAuthEmailTemplateId("login_code")).toBe(true);
    expect(isAuthEmailTemplateId("order_confirmation")).toBe(false);
    expect([...DIRECT_EMAIL_TEMPLATE_IDS]).toEqual(["email_verification", "password_reset", "login_code", "team_invite", "staff_invite"]);
    expect(isDirectEmailTemplateId("order_confirmation")).toBe(false);
    const code = render("S", "Hi,\n\nBody.\n\nBye", EMAIL_TEMPLATE_DEFAULTS.login_code.blocks, { code: "071564" });
    expect(code.html).toContain(">071564<");
    const reset = render("S", "Body", EMAIL_TEMPLATE_DEFAULTS.password_reset.blocks, { reset_url: "https://a.example/reset?token=abc" });
    expect(reset.html).toContain('href="https://a.example/reset?token=abc"');
    expect(reset.text).toContain("Reset password: https://a.example/reset?token=abc");
  });

  it("never puts a full license key in the license email", () => {
    const t = EMAIL_TEMPLATE_DEFAULTS.license_issued;
    expect(t.vars).not.toContain("license_key");
    expect(t.vars).toContain("key_last4");
  });

  it("matches the seeded NotificationTemplate copy", () => {
    expect(NOTIFICATION_TEMPLATES.map((t) => t.id).sort()).toEqual([...EMAIL_TEMPLATE_IDS].sort());
    for (const seed of NOTIFICATION_TEMPLATES) {
      const def = EMAIL_TEMPLATE_DEFAULTS[seed.id as keyof typeof EMAIL_TEMPLATE_DEFAULTS];
      expect(seed.subject, seed.id).toBe(def.subject);
      expect(seed.name, seed.id).toBe(def.name);
      if (seed.body !== undefined) expect(seed.body, seed.id).toBe(def.body);
      // Seeded copy only uses variables the template declares.
      for (const name of templateVarNames(seed.body ?? templateBody(seed.subject))) expect(def.vars, `${seed.id}: ${name}`).toContain(name);
    }
  });
});
