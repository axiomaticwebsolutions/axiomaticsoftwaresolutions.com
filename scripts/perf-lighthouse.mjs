/**
 * Lighthouse runs against a production server, summarised as one median row per page (docs/performance.md).
 *
 *   node scripts/perf-lighthouse.mjs --base=http://localhost:3150 [--paths=/,/software,...] [--runs=3]
 *     [--preset=mobile|desktop] [--out=<dir for the JSON reports>] [--json]
 *
 * Runs Lighthouse 12 through `npx --yes lighthouse@12` (a one-off download, never a project dependency) with the
 * locally installed Chrome, headless, default mobile settings (Moto G Power emulation, simulated slow 4G and 4x CPU
 * throttling) or the desktop preset. Each page runs --runs times; the row shows the median run by performance score
 * (Lighthouse's own advice for variance) with LCP, CLS, TBT, FCP, Speed Index and the four category scores, plus the
 * machine's benchmark index. Always measure a production build (`next build` + `next start`), never `next dev`.
 * Exits 1 when any page scores below --min (default 90) in a category.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const opt = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);

if (!opt.base) {
  console.error("Usage: --base=<production server URL> [--paths=/,/software] [--runs=3] [--preset=mobile|desktop] [--out=dir]");
  process.exit(2);
}

const BASE = new URL(opt.base).origin;
const PATHS = (opt.paths ?? "/,/software,/software/medical-billing,/pricing,/contact").split(",").map((p) => p.trim()).filter(Boolean);
const RUNS = Math.max(1, Math.min(9, Number(opt.runs ?? 3) || 3));
const PRESET = opt.preset === "desktop" ? "desktop" : "mobile";
const MIN_SCORE = Number(opt.min ?? 90);
const OUT = opt.out ? path.resolve(opt.out) : fs.mkdtempSync(path.join(os.tmpdir(), "axs-lighthouse-"));
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

fs.mkdirSync(OUT, { recursive: true });

function runLighthouse(url, file) {
  const args = [
    "--yes",
    "lighthouse@12",
    url,
    "--quiet",
    "--chrome-flags=--headless=new",
    `--only-categories=${CATEGORIES.join(",")}`,
    "--output=json",
    `--output-path=${file.split(path.sep).join("/")}`,
    ...(PRESET === "desktop" ? ["--preset=desktop"] : []),
  ];
  // One command string (every argument quoted) instead of an argument array with shell: true, which Node 24
  // deprecates (DEP0190); the shell is needed on Windows, where npx is a .cmd file.
  // The program name stays unquoted: cmd.exe /s strips the first and last quote of the whole line.
  const command = ["npx", ...args.map((a) => `"${String(a).split('"').join("")}"`)].join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn(command, { stdio: ["ignore", "ignore", "pipe"], shell: true });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`lighthouse exited ${code}: ${stderr.slice(-400)}`))));
  });
}

function summarise(report) {
  const a = report.audits;
  const score = (id) => Math.round((report.categories[id]?.score ?? 0) * 100);
  // Scored audits under 0.9 (weight > 0), i.e. the ones that move a category score; insights are left out.
  const failing = CATEGORIES.flatMap((c) =>
    report.categories[c].auditRefs
      .filter((ref) => ref.weight > 0)
      .map((ref) => a[ref.id])
      .filter((x) => x.score !== null && x.score < 0.9)
      .map((x) => x.id),
  );
  return {
    performance: score("performance"),
    accessibility: score("accessibility"),
    bestPractices: score("best-practices"),
    seo: score("seo"),
    lcpMs: Math.round(a["largest-contentful-paint"].numericValue),
    cls: Number(a["cumulative-layout-shift"].numericValue.toFixed(3)),
    tbtMs: Math.round(a["total-blocking-time"].numericValue),
    fcpMs: Math.round(a["first-contentful-paint"].numericValue),
    speedIndexMs: Math.round(a["speed-index"].numericValue),
    benchmarkIndex: Math.round(report.environment?.benchmarkIndex ?? 0),
    failing: [...new Set(failing)],
  };
}

function median(runs) {
  const sorted = [...runs].sort((x, y) => x.performance - y.performance || x.lcpMs - y.lcpMs);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

async function main() {
  console.info(`lighthouse: ${BASE}, ${PRESET}, ${RUNS} run(s) per page, reports in ${OUT}`);
  const rows = [];
  for (const p of PATHS) {
    const runs = [];
    for (let i = 1; i <= RUNS; i += 1) {
      const slug = p === "/" ? "home" : p.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-");
      const file = path.join(OUT, `${slug}-${PRESET}-${i}.json`);
      await runLighthouse(BASE + p, file);
      runs.push(summarise(JSON.parse(fs.readFileSync(file, "utf8"))));
    }
    const m = median(runs);
    rows.push({ path: p, ...m, lcpRangeMs: [Math.min(...runs.map((r) => r.lcpMs)), Math.max(...runs.map((r) => r.lcpMs))] });
    console.info(
      `  ${p.padEnd(28)} perf ${m.performance}  a11y ${m.accessibility}  bp ${m.bestPractices}  seo ${m.seo}  ` +
        `LCP ${(m.lcpMs / 1000).toFixed(2)} s  CLS ${m.cls}  TBT ${m.tbtMs} ms  FCP ${(m.fcpMs / 1000).toFixed(2)} s  ` +
        `SI ${(m.speedIndexMs / 1000).toFixed(2)} s  (benchmark ${m.benchmarkIndex})`,
    );
    if (m.failing.length) console.info(`  ${"".padEnd(28)} below 0.9: ${m.failing.join(", ")}`);
  }
  if (opt.json === "true") console.info(JSON.stringify(rows, null, 2));
  const low = rows.filter((r) => Math.min(r.performance, r.accessibility, r.bestPractices, r.seo) < MIN_SCORE);
  if (low.length) console.info(`${low.length} page(s) below ${MIN_SCORE} in at least one category.`);
  return low.length ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`perf-lighthouse failed: ${e?.message ?? e}`);
    process.exitCode = 2;
  });
