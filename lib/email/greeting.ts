/**
 * The name a customer email greets ("Hi {{customer_name}},"). Names are free text typed by whoever registered, checked
 * out or sent a lead, together with ANY recipient address, so a name that carries a link, an address or a message
 * would turn our emails into a way to send phishing text to strangers from the company's domain. Every customer email
 * greets through greetingName(); such names (and blank ones) become "there". Client-safe and dependency-free.
 */

// Addresses, URLs, markup, paths and bare domains with a common TLD.
const LINK_LIKE_RE =
  /[@/\\:<>]|www\.|\b[a-z0-9-]+\.(com|net|org|in|io|co|info|biz|xyz|app|dev|me|ly|ru|cn|top|site|online|link|shop|click|ai|us|uk|edu|gov|live|store|pro|tech|cloud|support|help|email|page|vip|club|win|icu|tk|cc)\b/i;
// A phone number, or a sentence rather than a name ("Your account is on hold, call ...").
const PHONE_LIKE_RE = /\d{5,}|\d[\d -]{7,}\d/;
const MAX_GREETING_LENGTH = 60;
const MAX_GREETING_WORDS = 6;

/** The name for "Hi {{name}}", or "there" when it looks like a link, an address, a phone number or a message, or is blank. */
export function greetingName(name: string | null | undefined): string {
  const clean = (name ?? "").replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (clean === "" || clean.length > MAX_GREETING_LENGTH || clean.split(" ").length > MAX_GREETING_WORDS) return "there";
  return LINK_LIKE_RE.test(clean) || PHONE_LIKE_RE.test(clean) ? "there" : clean;
}
