/**
 * Activity log routes: Owner only, 10 per page newest first, kind filter and search, the 24-month window, account
 * scoping, and the CSV export (header, BOM, formula guard, row count, filters).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as exportGET } from "@/app/api/account/activity/export.csv/route";
import { GET as activityGET } from "@/app/api/account/activity/route";
import { db } from "@/lib/db";
import { recordAccountActivity } from "@/lib/portal/activity";
import { call, makeMember, signIn, type Member } from "./license-actions-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string, options: { maxAge?: number } = {}) => {
      if (options.maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
  headers: async () => new Headers(),
}));

const DAY = 86_400_000;
let owner: Member;

type Page = { events: { action: string; target: string; kind: string; actorName: string; actorId: string | null }[]; total: number; page: number; pageCount: number; pageSize: number };

beforeEach(async () => {
  owner = await makeMember({ name: "Priya Sharma" });
  await signIn(jar, owner);
  const actor = { id: owner.user.id, name: "Priya Sharma" };
  const kinds = ["license", "security", "billing", "team", "ticket", "download"] as const;
  for (let i = 0; i < 12; i++) {
    await recordAccountActivity(db, {
      accountId: owner.accountId,
      actor: i % 2 === 0 ? actor : { id: null, name: "System" },
      action: `Action ${i}`,
      target: `Item ${i}`,
      kind: kinds[i % kinds.length] ?? "license",
      at: new Date(Date.now() - i * 60_000),
    });
  }
  await recordAccountActivity(db, { accountId: owner.accountId, actor, action: "Ancient", target: "Old", kind: "team", at: new Date(Date.now() - 800 * DAY) });
  await recordAccountActivity(db, { accountId: owner.accountId, actor, action: "Exported", target: "=HYPERLINK(\"x\")", kind: "billing", at: new Date(Date.now() - 2 * DAY) });
});

const page = (query = "") => call(jar, activityGET, `/api/account/activity${query ? `?${query}` : ""}`);
const csv = (query = "", headers?: Record<string, string>) =>
  call(jar, exportGET, `/api/account/activity/export.csv${query ? `?${query}` : ""}`, { headers });

describe("list", () => {
  it("is Owner only", async () => {
    for (const role of ["BILLING", "TECHNICAL", "VIEWER"] as const) {
      const m = await makeMember({ accountId: owner.accountId, role });
      await signIn(jar, m);
      expect((await page()).status, role).toBe(403);
      expect((await csv()).status, role).toBe(403);
    }
  });

  it("pages 10 at a time, newest first, within 24 months, with the actor", async () => {
    const first = (await (await page()).json()) as Page;
    expect(first).toMatchObject({ total: 13, page: 1, pageSize: 10, pageCount: 2 });
    expect(first.events.map((e) => e.action).slice(0, 3)).toEqual(["Action 0", "Action 1", "Action 2"]);
    expect(first.events[0]).toMatchObject({ actorName: "Priya Sharma", actorId: owner.user.id });
    expect(first.events[1]).toMatchObject({ actorName: "System", actorId: null });
    const second = (await (await page("page=2")).json()) as Page;
    expect(second.events.map((e) => e.action)).toEqual(["Action 10", "Action 11", "Exported"]);
    expect(JSON.stringify([first, second])).not.toContain("Ancient");
  });

  it("filters by kind and searches person, action and item (case-insensitive)", async () => {
    const team = (await (await page("kind=team")).json()) as Page;
    expect(team.events.every((e) => e.kind === "team")).toBe(true);
    expect(team.total).toBe(2);
    expect(((await (await page("q=item%2011")).json()) as Page).events.map((e) => e.action)).toEqual(["Action 11"]);
    expect(((await (await page("q=SYSTEM")).json()) as Page).total).toBe(6);
    expect(((await (await page("q=action%201&kind=security")).json()) as Page).events.map((e) => e.action)).toEqual(["Action 1"]);
    expect((await page("kind=nope")).status).toBe(422);
  });

  it("never shows another account's entries", async () => {
    const stranger = await makeMember();
    await signIn(jar, stranger);
    expect(((await (await page()).json()) as Page).total).toBe(0);
  });
});

describe("CSV export", () => {
  it("exports the filtered rows with a BOM, quoted cells and the formula guard", async () => {
    const res = await csv("kind=billing");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv;charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain('attachment; filename="activity-log.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-row-count")).toBe("3");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe('"When","Who","Action","Item","Type"');
    expect(lines).toHaveLength(5);
    expect(lines.some((l) => l.includes(`"'=HYPERLINK(""x"")"`))).toBe(true);
    expect(lines.slice(1, 4).every((l) => l.endsWith('"billing"'))).toBe(true);
  });

  it("refuses cross-site requests (403) before they count against the export limit", async () => {
    const crossSite = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    for (let i = 0; i < 11; i++) {
      const res = await csv("", crossSite);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-disposition")).toBeNull();
    }
    const sameSite = await csv("", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" });
    expect(sameSite.status).toBe(200);
    expect(sameSite.headers.get("content-disposition")).toContain("activity-log.csv");
  });
});
