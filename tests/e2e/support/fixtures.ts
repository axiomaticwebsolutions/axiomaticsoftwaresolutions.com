/**
 * The suite's `test`: Playwright's test with
 * - db (worker): PostgreSQL of the app under test (support/db.ts),
 * - created: what the test creates, removed after it (support/cleanup.ts),
 * - problems: page errors, console errors, 404 and 5xx responses of every context; fail the test (support/guard.ts),
 * - context / page: the default context, guarded (and its session signed out at the end),
 * - session(): more browser contexts (another person, a fresh browser), guarded, signed in when `as` is given,
 *   signed out and closed at the end,
 * - tag: a short id unique to this test run, for throwaway emails and labels.
 */
import { randomBytes } from "node:crypto";
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { signInAs, signOutHttp } from "./auth";
import { cleanUp, Created } from "./cleanup";
import { Db } from "./db";
import { BASE_URL, type Person } from "./env";
import { guardContext, Problems } from "./guard";
import { HttpClient } from "./http";

export type Session = { context: BrowserContext; page: Page; http: HttpClient | null };
export type OpenSession = (opts?: { as?: Pick<Person, "email" | "password">; http?: HttpClient }) => Promise<Session>;

async function signOutContext(context: BrowserContext): Promise<void> {
  try {
    const client = await HttpClient.fromContext(context);
    await signOutHttp(client);
  } catch {
    // Best effort: the context may already be closed; sessions also expire on their own.
  }
}

type TestFixtures = { created: Created; problems: Problems; session: OpenSession; tag: string };
type WorkerFixtures = { db: Db };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  db: [
    async ({}, provide) => {
      const db = new Db();
      await provide(db);
      await db.end();
    },
    { scope: "worker" },
  ],

  tag: async ({}, provide) => {
    await provide(`${Date.now().toString(36)}${randomBytes(2).toString("hex")}`);
  },

  created: async ({ db }, provide, testInfo) => {
    const created = new Created();
    await provide(created);
    const report = await cleanUp(db, created);
    const removed = Object.entries(report.removed).map(([t, n]) => `${t} ${n}`).join(", ");
    if (removed || report.skipped) testInfo.annotations.push({ type: "cleanup", description: report.skipped ? `kept (${report.skipped})` : removed });
    if (report.restoreErrors.length) throw new Error(`could not restore shared data: ${report.restoreErrors.join(" | ")}`);
  },

  problems: async ({}, provide, testInfo) => {
    const problems = new Problems(testInfo);
    await provide(problems);
    expect(problems.list, "page errors, console errors, 404 or 5xx responses").toEqual([]);
  },

  context: async ({ context, problems, created }, provide) => {
    void created; // set up first, so clean-up runs after every context is closed
    await guardContext(context, problems);
    await provide(context);
    await signOutContext(context);
  },

  session: async ({ browser, problems, created }, provide, testInfo) => {
    void created;
    const opened: BrowserContext[] = [];
    const options = testInfo.project.use;
    const open: OpenSession = async (opts = {}) => {
      const context = await browser.newContext({
        baseURL: BASE_URL,
        viewport: options.viewport ?? { width: 1280, height: 900 },
        isMobile: options.isMobile,
        hasTouch: options.hasTouch,
        deviceScaleFactor: options.deviceScaleFactor,
        locale: options.locale,
        timezoneId: options.timezoneId,
        reducedMotion: "reduce",
        acceptDownloads: true,
      });
      opened.push(context);
      await guardContext(context, problems);
      let http: HttpClient | null = opts.http ?? null;
      if (opts.as) http = await signInAs(context, opts.as);
      else if (opts.http) await opts.http.exportTo(context);
      const page = await context.newPage();
      return { context, page, http };
    };
    await provide(open);
    for (const context of opened) {
      await signOutContext(context);
      await context.close().catch(() => undefined);
    }
  },
});

export { expect };
