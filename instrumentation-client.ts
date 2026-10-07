/**
 * Runs in the browser before the app hydrates (Next.js `instrumentation-client`, loaded ahead of every client module).
 *
 * Zod 4 probes for eval with `Function("")` the first time it builds an object schema, to compile faster parsers. The
 * Content-Security-Policy never allows 'unsafe-eval' in production (docs/security.md), so the probe only produced a
 * CSP violation and a console error on every page. jitless mode skips the probe; client forms keep Zod's interpreted
 * parser, which is plenty fast for their size. Server code is unaffected (no CSP there, JIT stays on).
 *
 * Set on Zod's global config object (`globalThis.__zod_globalConfig`, which Zod reuses when it loads) instead of
 * importing Zod: `import { config } from "zod"` here added 3.8 kB to every page, including the storefront pages that
 * no longer load Zod (docs/performance.md). tests/unit/perf-zod-config.test.ts fails if a Zod upgrade stops reading it.
 */
const zodGlobal = globalThis as typeof globalThis & { __zod_globalConfig?: { jitless?: boolean } };
(zodGlobal.__zod_globalConfig ??= {}).jitless = true;
