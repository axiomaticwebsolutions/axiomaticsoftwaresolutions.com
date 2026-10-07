import { describe, expect, it } from "vitest";
import {
  LICENSE_KEY_ALPHABET,
  LICENSE_KEY_LENGTH,
  LICENSE_KEY_RE,
  generateLicenseKey,
  isLicenseKeyFormat,
  isProductCode,
  keyLast4,
  maskLicenseKey,
  normalizeLicenseKey,
  redactLicenseKeys,
} from "@/lib/licensing/keys";

const SAMPLE_KEYS = ["MED-7Q4K-9XTP-W2HD-K8NM", "CHQ-4MRT-H8ZQ-6PWA-J3XV", "GST-W9KD-2LQN-T7RC-M4EB"];

describe("license key alphabet and format", () => {
  it("uses 32 symbols without I, O, 0 or 1", () => {
    expect(LICENSE_KEY_ALPHABET).toHaveLength(32);
    expect(new Set(LICENSE_KEY_ALPHABET).size).toBe(32);
    expect(LICENSE_KEY_ALPHABET).not.toMatch(/[IO01]/);
  });

  it.each(SAMPLE_KEYS)("accepts the sample key %s", (key) => {
    expect(isLicenseKeyFormat(key)).toBe(true);
    expect(LICENSE_KEY_RE.test(key)).toBe(true);
    expect(key).toHaveLength(LICENSE_KEY_LENGTH);
  });

  it("rejects the prototype trial key, which contains a banned I", () => {
    expect(isLicenseKeyFormat("GST-TRIA-L5HP-8QVM-R2KC")).toBe(false);
  });

  it.each([
    "med-7q4k-9xtp-w2hd-k8nm",
    "MED7Q4K9XTPW2HDK8NM",
    "MED-7Q4K-9XTP-W2HD",
    "MED-7Q4K-9XTP-W2HD-K8NM-AAAA",
    "MED-7Q4K-9XTP-W2HD-K8N0",
    "MED-7Q4K-9XTP-W2HD-K8NO",
    "MED-7Q4K-9XTP-W2HD-K8N1",
    "ME1-7Q4K-9XTP-W2HD-K8NM",
    " MED-7Q4K-9XTP-W2HD-K8NM",
    "",
  ])("rejects non-canonical or invalid %j", (key) => {
    expect(isLicenseKeyFormat(key)).toBe(false);
  });
});

describe("generateLicenseKey", () => {
  it("generates 1,000 well-formed keys that never contain I, O, 0 or 1", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const key = generateLicenseKey("MED");
      expect(key).toMatch(LICENSE_KEY_RE);
      expect(key.startsWith("MED-")).toBe(true);
      expect(key.slice(4)).not.toMatch(/[IO01]/);
      keys.add(key);
    }
    // 80 bits of entropy: a collision in 1,000 draws would mean the generator is broken.
    expect(keys.size).toBe(1000);
  });

  it("maps the random source onto the alphabet", () => {
    let i = 0;
    const key = generateLicenseKey("CHQ", () => i++ % 32);
    expect(key).toBe("CHQ-ABCD-EFGH-JKLM-NPQR");
    expect(generateLicenseKey("GST", () => 31)).toBe("GST-9999-9999-9999-9999");
  });

  it.each(["", "ME", "MEDS", "med", "M3D", "MÉD", "ME-"])("throws on the bad product code %j", (code) => {
    expect(() => generateLicenseKey(code)).toThrow(RangeError);
    expect(isProductCode(code)).toBe(false);
  });

  it("throws when the random source misbehaves", () => {
    expect(() => generateLicenseKey("MED", () => 32)).toThrow(RangeError);
    expect(() => generateLicenseKey("MED", () => -1)).toThrow(RangeError);
    expect(() => generateLicenseKey("MED", () => 1.5)).toThrow(RangeError);
  });
});

describe("normalizeLicenseKey", () => {
  it.each([
    ["med7q4k9xtpw2hdk8nm", "MED-7Q4K-9XTP-W2HD-K8NM"],
    ["med-7q4k-9xtp-w2hd-k8nm", "MED-7Q4K-9XTP-W2HD-K8NM"],
    ["  MED-7Q4K-9XTP-W2HD-K8NM \n", "MED-7Q4K-9XTP-W2HD-K8NM"],
    ["MED 7Q4K 9XTP W2HD K8NM", "MED-7Q4K-9XTP-W2HD-K8NM"],
    ["Med-7Q4K 9xtp-W2HD k8nm", "MED-7Q4K-9XTP-W2HD-K8NM"],
    ["MED-7Q4K9XTP-W2HDK8NM", "MED-7Q4K-9XTP-W2HD-K8NM"],
    ["MED\u20137Q4K\u20139XTP\u2013W2HD\u2013K8NM", "MED-7Q4K-9XTP-W2HD-K8NM"],
    ["ＭＥＤ-7Q4K-9XTP-W2HD-K8NM", "MED-7Q4K-9XTP-W2HD-K8NM"],
  ])("normalises %j", (input, expected) => {
    expect(normalizeLicenseKey(input)).toBe(expected);
    expect(isLicenseKeyFormat(normalizeLicenseKey(input))).toBe(true);
  });

  it("leaves canonical keys unchanged", () => {
    for (const key of SAMPLE_KEYS) expect(normalizeLicenseKey(key)).toBe(key);
  });

  it.each([
    ["not a key", "NOTAKEY"],
    ["med-7q4k", "MED-7Q4K"],
    ["M-ED7Q4K9XTPW2HDK8NM", "M-ED7Q4K9XTPW2HDK8NM"],
    ["MED--7Q4K-9XTP-W2HD-K8NM", "MED--7Q4K-9XTP-W2HD-K8NM"],
    ["MED-7Q4K-9XTP-W2HD-K8NM-ABCD", "MED-7Q4K-9XTP-W2HD-K8NM-ABCD"],
  ])("returns other input cleaned but unchanged: %j", (input, expected) => {
    expect(normalizeLicenseKey(input)).toBe(expected);
    expect(isLicenseKeyFormat(normalizeLicenseKey(input))).toBe(false);
  });

  it("re-dashes a key with banned characters, which then fails the format check", () => {
    const normalized = normalizeLicenseKey("med0q4k9xtpw2hdk8nm");
    expect(normalized).toBe("MED-0Q4K-9XTP-W2HD-K8NM");
    expect(isLicenseKeyFormat(normalized)).toBe(false);
  });
});

describe("keyLast4 and maskLicenseKey", () => {
  it("takes the last four characters of a key", () => {
    expect(keyLast4("MED-7Q4K-9XTP-W2HD-K8NM")).toBe("K8NM");
    expect(keyLast4("med7q4k9xtpw2hdk8nm")).toBe("K8NM");
  });

  it("refuses to take last4 of something that is not a key", () => {
    expect(() => keyLast4("GST-TRIA-L5HP-8QVM-R2KC")).toThrow(RangeError);
    expect(() => keyLast4("K8NM")).toThrow(RangeError);
  });

  it("masks with U+2022 bullets exactly like the prototype maskKey", () => {
    const protoMaskKey = (k: string) => `${k.slice(0, 4)}\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-${k.slice(-4)}`;
    for (const key of SAMPLE_KEYS) {
      expect(maskLicenseKey(key.slice(0, 3), keyLast4(key))).toBe(protoMaskKey(key));
    }
    expect(maskLicenseKey("MED", "K8NM")).toBe("MED-••••-••••-••••-K8NM");
  });

  it("never shows more than four characters even if handed a full key", () => {
    expect(maskLicenseKey("MED", "MED-7Q4K-9XTP-W2HD-K8NM")).toBe("MED-••••-••••-••••-K8NM");
  });
});

describe("redactLicenseKeys", () => {
  it("masks canonical keys inside text", () => {
    expect(redactLicenseKeys("activate MED-7Q4K-9XTP-W2HD-K8NM failed")).toBe("activate MED-••••-••••-••••-K8NM failed");
  });

  it("masks every key, in any case and with or without dashes", () => {
    const text = 'body={"licenseKey":"med7q4k9xtpw2hdk8nm","other":"chq-4mrt-h8zq-6pwa-j3xv"} GST-W9KD-2LQN-T7RC-M4EB.';
    const out = redactLicenseKeys(text);
    expect(out).toBe(
      'body={"licenseKey":"MED-••••-••••-••••-K8NM","other":"CHQ-••••-••••-••••-J3XV"} GST-••••-••••-••••-M4EB.',
    );
    expect(out).not.toMatch(/7Q4K|9XTP|W2HD|4MRT|H8ZQ|6PWA|W9KD|2LQN|T7RC/i);
  });

  it("also masks mistyped keys that contain banned characters", () => {
    expect(redactLicenseKeys("GST-TRIA-L5HP-8QVM-R2KC")).toBe("GST-••••-••••-••••-R2KC");
    expect(redactLicenseKeys("key MED-0Q4K-9XTP-W2HD-K8NM")).toBe("key MED-••••-••••-••••-K8NM");
  });

  it("leaves ordinary text, ids and masked keys alone", () => {
    const text = "Order AX-10301 for LIC-24017 (MED-••••-••••-••••-K8NM) paid via UPI; invoice AXS/26-27/1181.";
    expect(redactLicenseKeys(text)).toBe(text);
    const sha = "a".repeat(64);
    expect(redactLicenseKeys(`fp=${sha}`)).toBe(`fp=${sha}`);
    expect(redactLicenseKeys("the quick brown fox jumps over")).toBe("the quick brown fox jumps over");
  });

  it("needs the same separator at every group boundary, so hyphenated words and file names survive", () => {
    for (const name of ["license-register-2026-10-07.csv", "renewal-forecast-2026-10-07.csv", "LIC-reportsales-2026-1007"]) {
      expect(redactLicenseKeys(name), name).toBe(name);
    }
    expect(redactLicenseKeys("MED-7Q4K-9XTP-W2HD-K8NM / med7q4k9xtpw2hdk8nm")).toBe("MED-••••-••••-••••-K8NM / MED-••••-••••-••••-K8NM");
  });

  it("does not touch key-like runs embedded in longer tokens", () => {
    const token = "xMED7Q4K9XTPW2HDK8NMx";
    expect(redactLicenseKeys(token)).toBe(token);
  });

  it("is idempotent", () => {
    const once = redactLicenseKeys("MED-7Q4K-9XTP-W2HD-K8NM");
    expect(redactLicenseKeys(once)).toBe(once);
  });
});
