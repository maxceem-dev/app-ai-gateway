/**
 * The apps list and the usage summary answer from cheap places: user counts by
 * a loose index scan, month totals from sealed day rows plus the raw events of
 * days not yet sealed. These pin that the answers are the ones the raw events
 * give, whatever state the sealed window is in, and that the reads stay small.
 */
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { prepared } from "../src/db/sql";
import { endUserCounts } from "../src/management/users";
import { organizationMonthUsage, usageMonthTotals } from "../src/management/usage-queries";
import { pruneRejectionEvents } from "../src/diagnostics/rejection-events";
import {
  compactUsageEvents,
  SEAL_DAYS_PER_BATCH,
  sealUsageDays,
} from "../src/usage/usage-retention";
import { QueryBudget } from "../src/core/query-budget";
import { seedApp, TEST_ORGANIZATION_ID } from "./helpers";

const ORIGIN = "https://example.test";
const AUTH = { authorization: "Bearer agw_mgmt_test-admin-secret" };

/** Retention cutoff 2026-03-17, today 2026-06-15: sealed days are [2026-03-17, 2026-06-15). */
const NOW = Date.parse("2026-06-15T12:00:00Z");

const OTHER_ORGANIZATION_ID = "usage-day-other-organization";

async function get(path: string) {
  const response = await exports.default.fetch(`${ORIGIN}${path}`, { headers: AUTH });
  return { status: response.status, body: (await response.json()) as any };
}

let sequence = 0;

async function usage(
  appId: string,
  createdAt: string,
  overrides: Partial<{ user: string | null; cost: number; input: number; status: string; organizationId: string }> = {},
): Promise<string> {
  const eventId = `usage-day-${++sequence}`;
  const {
    user = null,
    cost = 0.01,
    input = 10,
    status = "ok",
    organizationId = TEST_ORGANIZATION_ID,
  } = overrides;
  await env.DB.prepare(
    `INSERT INTO app_usage_event(
       event_id, organization_id, app_id, user_id, provider_type, model, route,
       input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status, created_at
     ) VALUES (?, ?, ?, ?, 'openai', 'gpt-test', 'openai/v1/responses', ?, 2, 1, 5, ?, ?, ?)`,
  ).bind(eventId, organizationId, appId, user, input, cost, status, createdAt).run();
  return eventId;
}

async function rejection(appId: string, user: string | null, createdAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_rejection_event(event_id, app_id, user_id, reason, scope, created_at)
     VALUES (?, ?, ?, 'blocked_user', 'user', ?)`,
  ).bind(`usage-day-rejection-${++sequence}`, appId, user, createdAt).run();
}

async function registered(appId: string, id: string, status: "active" | "blocked" = "active"): Promise<void> {
  await env.DB.prepare("INSERT INTO app_user(app_id, id, status) VALUES (?, ?, ?)").bind(appId, id, status).run();
}

/**
 * What a month adds up to, summed the way the gateway did before day rows
 * existed: every raw event, plus whatever compaction has already moved into the
 * rollup. The yardstick every cheaper answer here is held to.
 */
async function groundTruth(appId: string, month: string) {
  const next = new Date(`${month}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const end = next.toISOString().slice(0, 7);
  return env.DB.prepare(`
    SELECT SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
           SUM(cached_input_tokens) AS cached_input_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd, SUM(errors) AS errors
    FROM (
      SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
             COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd,
             COALESCE(SUM(status = 'provider_error'), 0) AS errors
      FROM app_usage_event WHERE app_id = ?1 AND created_at >= ?2 AND created_at < ?3
      UNION ALL
      SELECT COALESCE(SUM(requests), 0), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(cached_input_tokens), 0),
             COALESCE(SUM(cache_write_tokens), 0), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cost_usd), 0),
             COALESCE(SUM(CASE WHEN status = 'provider_error' THEN requests ELSE 0 END), 0)
      FROM app_usage_rollup WHERE app_id = ?1 AND bucket >= ?2 AND bucket < ?3
    )`).bind(appId, month, end).first<Record<string, number>>();
}

/** Every sealed day row against a fresh sum of the raw events it stands for. */
async function expectDayRowsMatchEvents(): Promise<void> {
  const drift = await env.DB.prepare(`
    SELECT days.app_id, days.day, days.requests, events.requests AS raw_requests
    FROM app_usage_day AS days
    LEFT JOIN (
      SELECT app_id, substr(created_at, 1, 10) AS day, COUNT(*) AS requests,
             SUM(input_tokens) AS input_tokens, SUM(cost_usd) AS cost_usd,
             SUM(status = 'provider_error') AS errors
      FROM app_usage_event GROUP BY app_id, substr(created_at, 1, 10)
    ) AS events ON events.app_id = days.app_id AND events.day = days.day
    WHERE days.requests != COALESCE(events.requests, 0)
       OR days.input_tokens != COALESCE(events.input_tokens, 0)
       OR days.errors != COALESCE(events.errors, 0)
       OR abs(days.cost_usd - COALESCE(events.cost_usd, 0)) > 1e-9`).all();
  expect(drift.results).toEqual([]);
  const outside = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM app_usage_day, app_usage_day_window AS w
    WHERE day < w.sealed_from OR day >= w.sealed_until`).first<{ count: number }>();
  expect(outside?.count).toBe(0);
}

async function window() {
  return env.DB.prepare("SELECT sealed_from, sealed_until FROM app_usage_day_window").first();
}

/** The usage summary's figures: `errors` is reported by the apps list, not by this endpoint. */
function summaryOf(totals: Record<string, number> | null) {
  const { errors: _errors, ...rest } = totals ?? {};
  return rest;
}

function expectTotals(actual: Record<string, number>, expected: Record<string, number>): void {
  const { cost_usd: actualCost, ...actualCounts } = actual;
  const { cost_usd: expectedCost, ...expectedCounts } = expected;
  // Every count exactly; the cost is a float summed in a different grouping,
  // so it agrees to float precision rather than to the last bit.
  expect(actualCounts).toEqual(expectedCounts);
  expect(actualCost).toBeCloseTo(expectedCost ?? 0, 12);
}

/**
 * The database, counting the rows every statement issued through it reads, so
 * a query function that reports no meta of its own can still be measured.
 */
function metered(db: D1Database): { db: D1Database; rowsRead: () => number } {
  let rowsRead = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
    bind: (...values: unknown[]) => wrap(statement.bind(...values)),
    all: async () => {
      const result = await statement.all();
      rowsRead += result.meta.rows_read;
      return result;
    },
    first: async () => {
      const result = await statement.all();
      rowsRead += result.meta.rows_read;
      return result.results[0] ?? null;
    },
  }) as unknown as D1PreparedStatement;
  return {
    db: { prepare: (query: string) => wrap(db.prepare(query)) } as unknown as D1Database,
    rowsRead: () => rowsRead,
  };
}

// One describe around the whole file: in the suite's barrel a top-level hook
// would run before every other file's tests as well.
describe("cheap usage and user reads", () => {
  beforeEach(async () => {
    // An empty window holds no rows; tests seal from it at their own date. The
    // window is emptied before the events go, so deleting them moves no row.
    // Other files in this barrel share the database and clear these tables too.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM app_usage_day"),
      env.DB.prepare("UPDATE app_usage_day_window SET sealed_from = '', sealed_until = ''"),
      env.DB.prepare("DELETE FROM app_usage_event"),
      env.DB.prepare("DELETE FROM app_usage_rollup"),
      env.DB.prepare("DELETE FROM app_rejection_event"),
    ]);
  });

  describe("month totals from sealed days", () => {
    it("adds sealed days, unsealed raw events and the rollup without counting an event twice", async () => {
      const appId = "usage-day-month";
      await seedApp(appId);
      // March: two days to be compacted into the rollup, then the first sealed day.
      await usage(appId, "2026-03-10T08:00:00.000Z", { cost: 1, input: 100 });
      await usage(appId, "2026-03-16T23:59:59.999Z", { cost: 2, status: "provider_error" });
      await usage(appId, "2026-03-17T00:00:00.000Z", { cost: 4 });
      await usage(appId, "2026-03-31 23:59:59", { cost: 8 });
      // The May/June boundary, in both timestamp formats the column has held.
      await usage(appId, "2026-05-31T23:59:59.999Z", { cost: 16, status: "provider_error" });
      await usage(appId, "2026-06-01 00:00:00", { cost: 32 });
      await usage(appId, "2026-06-14T12:00:00.000Z", { cost: 64, input: 7 });
      // Today: never sealed, always read raw.
      await usage(appId, "2026-06-15T09:00:00.000Z", { cost: 128 });
      await usage(appId, "2026-06-15T11:00:00.000Z", { cost: 0.1, user: "someone" });

      const months = ["2026-03", "2026-05", "2026-06"];
      const before = await Promise.all(months.map((month) => groundTruth(appId, month)));

      const sealed = await sealUsageDays(env.DB, NOW, new QueryBudget(100));
      expect(sealed.caughtUp).toBe(true);
      expect(await window()).toEqual({ sealed_from: "2026-03-17", sealed_until: "2026-06-15" });
      const compacted = await compactUsageEvents(env.DB, NOW);
      // Below the window, so moving those events moves no day row.
      expect(compacted.deleted).toBe(2);
      await expectDayRowsMatchEvents();

      for (const [index, month] of months.entries()) {
        const expected = before[index]!;
        // Sealing and compaction moved where the events are, not what they add up to.
        expect(await groundTruth(appId, month)).toEqual(expected);
        const { body } = await get(`/v1/admin/apps/${appId}/usage?month=${month}`);
        const { app_id: _app, month: _month, ...summary } = body;
        expectTotals(summary, summaryOf(expected));
        const list = await get(`/v1/admin/apps?month=${month}`);
        expectTotals(list.body.apps.find((row: any) => row.id === appId).usage, expected);
      }
      expect(before.map((totals) => totals?.requests)).toEqual([4, 1, 4]);
      // The compacted days are in the rollup and nowhere else.
      const days = await env.DB.prepare("SELECT day FROM app_usage_day WHERE app_id = ? ORDER BY day").bind(appId).all();
      expect(days.results.map((row: any) => row.day)).toEqual(["2026-03-17", "2026-03-31", "2026-05-31", "2026-06-01", "2026-06-14"]);
    });

    it("keeps a sealed day exact when an event arrives late, is repriced, moves, or is deleted", async () => {
      const appId = "usage-day-changes";
      await seedApp(appId);
      await usage(appId, "2026-05-20T10:00:00.000Z", { cost: 1 });
      const repriced = await usage(appId, "2026-05-20T11:00:00.000Z", { cost: 2 });
      const deleted = await usage(appId, "2026-05-21T10:00:00.000Z", { cost: 3, status: "provider_error" });
      const moved = await usage(appId, "2026-06-15T08:00:00.000Z", { cost: 5 });
      await sealUsageDays(env.DB, NOW, new QueryBudget(100));

      // A straggler: its timestamp was fixed before a long response finished.
      await usage(appId, "2026-06-14T23:59:59.000Z", { cost: 7, status: "provider_error" });
      // And a first event for a sealed day that had none, which creates its row.
      await usage(appId, "2026-05-02T00:00:00.000Z", { cost: 11 });
      await env.DB.prepare("UPDATE app_usage_event SET cost_usd = 2.5 WHERE event_id = ?").bind(repriced).run();
      await env.DB.prepare("DELETE FROM app_usage_event WHERE event_id = ?").bind(deleted).run();
      // From an unsealed day into a sealed one.
      await env.DB.prepare("UPDATE app_usage_event SET created_at = '2026-05-22T00:00:00.000Z' WHERE event_id = ?").bind(moved).run();

      await expectDayRowsMatchEvents();
      for (const month of ["2026-05", "2026-06"]) {
        const { body } = await get(`/v1/admin/apps/${appId}/usage?month=${month}`);
        const { app_id: _app, month: _month, ...totals } = body;
        expectTotals(totals, summaryOf(await groundTruth(appId, month)));
      }
      const may = await get(`/v1/admin/apps?month=2026-05`);
      expect(may.body.apps.find((row: any) => row.id === appId).usage).toMatchObject({ requests: 4, errors: 0 });
    });

    it("writes no day row for an event of a day that is not sealed", async () => {
      const appId = "usage-day-today";
      await seedApp(appId);
      await sealUsageDays(env.DB, NOW, new QueryBudget(100));
      await usage(appId, "2026-06-15T10:00:00.000Z");
      await usage(appId, "2026-06-16T10:00:00.000Z");
      const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_usage_day WHERE app_id = ?").bind(appId).first<{ count: number }>();
      expect(rows?.count).toBe(0);
      const { body } = await get(`/v1/admin/apps/${appId}/usage?month=2026-06`);
      expect(body.requests).toBe(2);
    });

    it("reads one row per sealed day rather than one per request", async () => {
      const appId = "usage-day-reads";
      await seedApp(appId);
      await env.DB.prepare(`
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2999)
        INSERT INTO app_usage_event(event_id, organization_id, app_id, provider_type, model, route, cost_usd, status, created_at)
        SELECT 'usage-day-bulk-' || i, ?1, ?2, 'openai', 'gpt-test', 'openai/v1/responses', 0.001, 'ok',
               strftime('%Y-%m-%dT%H:%M:%fZ', '2026-05-01', '+' || (i * 14) || ' minutes')
        FROM n`).bind(TEST_ORGANIZATION_ID, appId).run();
      const raw = metered(env.DB);
      expect((await usageMonthTotals(raw.db, appId, "2026-05")).requests).toBe(3000);
      // Unsealed, the month is a range scan over its events.
      expect(raw.rowsRead()).toBeGreaterThanOrEqual(3000);

      await sealUsageDays(env.DB, NOW, new QueryBudget(100));
      const app = metered(env.DB);
      expect((await usageMonthTotals(app.db, appId, "2026-05")).requests).toBe(3000);
      // Thirty-one day rows and the window lookups.
      expect(app.rowsRead()).toBeLessThan(50);
      const organization = metered(env.DB);
      const { results } = await organizationMonthUsage(organization.db, TEST_ORGANIZATION_ID, "2026-05");
      expect(results.find((row) => row.app_id === appId)?.requests).toBe(3000);
      // The same, plus one lookup per app of the test account.
      expect(organization.rowsRead()).toBeLessThan(300);
    });
  });

  describe("sealing the window", () => {
    it("raises its floor with the retention cutoff and drops the rows it passes", async () => {
      const appId = "usage-day-floor";
      await seedApp(appId);
      await usage(appId, "2026-03-17T10:00:00.000Z");
      await usage(appId, "2026-03-18T10:00:00.000Z");
      await sealUsageDays(env.DB, NOW, new QueryBudget(100));

      const nextDay = NOW + 86_400_000;
      const result = await sealUsageDays(env.DB, nextDay, new QueryBudget(100));
      expect(result).toMatchObject({ days: 1, caughtUp: true });
      expect(await window()).toEqual({ sealed_from: "2026-03-18", sealed_until: "2026-06-16" });
      const days = await env.DB.prepare("SELECT day FROM app_usage_day WHERE app_id = ?").bind(appId).all();
      expect(days.results.map((row: any) => row.day)).toEqual(["2026-03-18"]);
      // The day below the floor is read raw until compaction moves it.
      const { body } = await get(`/v1/admin/apps/${appId}/usage?month=2026-03`);
      expect(body.requests).toBe(2);
      await compactUsageEvents(env.DB, nextDay);
      expect((await get(`/v1/admin/apps/${appId}/usage?month=2026-03`)).body.requests).toBe(2);
    });

    it("catches a backlog up a bounded number of days per batch, within its budget", async () => {
      // From an empty window: ninety days to seal, two batches affordable.
      const budget = new QueryBudget(7);
      const result = await sealUsageDays(budget.database(env.DB), NOW, budget);
      expect(budget.spent).toBe(7);
      expect(result).toMatchObject({ days: SEAL_DAYS_PER_BATCH * 2, caughtUp: false });
      expect(await window()).toEqual({ sealed_from: "2026-03-17", sealed_until: "2026-03-31" });
      const rest = await sealUsageDays(env.DB, NOW, new QueryBudget(100));
      expect(rest.caughtUp).toBe(true);
      expect(await window()).toEqual({ sealed_from: "2026-03-17", sealed_until: "2026-06-15" });
    });

    it("refuses a run that read the window before another moved it, even with nothing to sum", async () => {
      const appId = "usage-day-stale";
      await seedApp(appId);
      await usage(appId, "2026-06-10T10:00:00.000Z");
      await sealUsageDays(env.DB, NOW, new QueryBudget(100));
      const before = await window();
      // A second run that read the window while it still ended in April: its
      // first range, the first week of May, has no events and conflicts with
      // no row, so only the window itself can tell it is stale.
      const stale = {
        prepare: (query: string) => query.includes("SELECT sealed_from")
          ? { first: async () => ({ sealedFrom: "2026-03-17", sealedUntil: "2026-05-01" }) }
          : env.DB.prepare(query),
        batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
      } as unknown as D1Database;
      await expect(sealUsageDays(stale, NOW, new QueryBudget(100))).rejects.toThrow();
      expect(await window()).toEqual(before);
      const rows = await env.DB.prepare("SELECT day, requests FROM app_usage_day WHERE app_id = ?").bind(appId).all();
      expect(rows.results).toEqual([{ day: "2026-06-10", requests: 1 }]);
      expect((await get(`/v1/admin/apps/${appId}/usage?month=2026-06`)).body.requests).toBe(1);
    });

    it("refuses to seal a day twice rather than double counting it", async () => {
      const appId = "usage-day-overlap";
      await seedApp(appId);
      await usage(appId, "2026-06-10T10:00:00.000Z");
      await sealUsageDays(env.DB, NOW, new QueryBudget(100));
      // What a second run that read the window before the first one moved it would find.
      await env.DB.prepare("UPDATE app_usage_day_window SET sealed_until = '2026-06-01'").run();
      await expect(sealUsageDays(env.DB, NOW, new QueryBudget(100))).rejects.toThrow();
      const rows = await env.DB.prepare("SELECT requests FROM app_usage_day WHERE app_id = ?").bind(appId).all();
      expect(rows.results).toEqual([{ requests: 1 }]);
    });
  });

  describe("end user counts", () => {
    it("counts registered, blocked, virtual and rejection-only users once each, per app", async () => {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at)
         VALUES (?, 'Other', 'operator-test-owner', 'x', 'x')`,
      ).bind(OTHER_ORGANIZATION_ID).run();
      const appId = "usage-day-users";
      const sibling = "usage-day-users-sibling";
      const foreign = "usage-day-users-foreign";
      await seedApp(appId);
      await seedApp(sibling);
      await seedApp(foreign, { organizationId: OTHER_ORGANIZATION_ID });

      await registered(appId, "active-user");
      await registered(appId, "blocked-user", "blocked");
      // A registered user is that row, however many events also name it.
      await usage(appId, "2026-06-15T01:00:00.000Z", { user: "active-user" });
      await rejection(appId, "blocked-user", "2026-06-15T01:00:00.000Z");
      // Virtual: named by usage, by rejections only, and by both.
      for (let i = 0; i < 3; i++) await usage(appId, `2026-06-1${i}T01:00:00.000Z`, { user: "virtual-usage" });
      await rejection(appId, "virtual-rejected", "2026-06-12T01:00:00.000Z");
      await usage(appId, "2026-06-13T01:00:00.000Z", { user: "virtual-both" });
      await rejection(appId, "virtual-both", "2026-06-14T01:00:00.000Z");
      // Userless traffic is nobody.
      await usage(appId, "2026-06-15T02:00:00.000Z", { user: null });
      await rejection(appId, null, "2026-06-15T02:00:00.000Z");
      // The same ids elsewhere count there, not here.
      await usage(sibling, "2026-06-15T02:00:00.000Z", { user: "virtual-usage" });
      await registered(foreign, "active-user", "blocked");
      await usage(foreign, "2026-06-15T02:00:00.000Z", { user: "foreign-virtual", organizationId: OTHER_ORGANIZATION_ID });

      const { body } = await get("/v1/admin/apps");
      const byId = new Map(body.apps.map((row: any) => [row.id, row.users]));
      expect(byId.get(appId)).toEqual({ total: 5, blocked: 1 });
      expect(byId.get(sibling)).toEqual({ total: 1, blocked: 0 });
      expect(byId.has(foreign)).toBe(false);
      const foreignCounts = await prepared(env.DB, endUserCounts(OTHER_ORGANIZATION_ID)).all();
      expect(foreignCounts.results).toEqual([{ app_id: foreign, total: 2, blocked: 1 }]);

      // The list agrees with the count, user for user.
      const list = await get(`/v1/admin/apps/${appId}/users?month=2026-06`);
      expect(list.body.total).toBe(5);
      expect(list.body.users.map((user: any) => [user.id, user.status, user.is_virtual]).sort()).toEqual([
        ["active-user", "active", false],
        ["blocked-user", "blocked", false],
        ["virtual-both", "active", true],
        ["virtual-rejected", "active", true],
        ["virtual-usage", "active", true],
      ]);
      expect(list.body.users.find((user: any) => user.id === "virtual-both")).toMatchObject({
        created_at: "2026-06-13T01:00:00.000Z",
        last_seen_at: "2026-06-14T01:00:00.000Z",
        usage: { requests: 1 },
      });
      expect(list.body.users.find((user: any) => user.id === "virtual-usage")).toMatchObject({
        created_at: "2026-06-10T01:00:00.000Z",
        last_seen_at: "2026-06-12T01:00:00.000Z",
        usage: { requests: 3 },
      });
      const single = await get(`/v1/admin/apps/${appId}/users/virtual-rejected?month=2026-06`);
      expect(single.body.user).toMatchObject({
        id: "virtual-rejected",
        is_virtual: true,
        created_at: "2026-06-12T01:00:00.000Z",
        last_seen_at: "2026-06-12T01:00:00.000Z",
      });
      expect((await get(`/v1/admin/apps/${appId}/users/active-user`)).body.user.is_virtual).toBe(false);
      expect((await get(`/v1/admin/apps/${appId}/users/nobody`)).status).toBe(404);
      expect((await get(`/v1/admin/apps/${appId}/users/foreign-virtual`)).status).toBe(404);
    });

    it("finds a virtual user's first and last times across both timestamp formats on one day", async () => {
      const appId = "usage-day-mixed-formats";
      await seedApp(appId);
      // Text order puts ' ' below 'T', so on one day the smallest stored value
      // is the later event and the largest the earlier one.
      await usage(appId, "2026-06-14 23:00:00", { user: "mixed" });
      await usage(appId, "2026-06-14T01:00:00.000Z", { user: "mixed" });
      await usage(appId, "2026-06-13T12:00:00.000Z", { user: "spans-days" });
      await usage(appId, "2026-06-14 06:00:00", { user: "spans-days" });

      const { body } = await get(`/v1/admin/apps/${appId}/users?month=2026-06`);
      expect(body.users.map((user: any) => [user.id, user.created_at, user.last_seen_at])).toEqual([
        ["mixed", "2026-06-14T01:00:00.000Z", "2026-06-14T23:00:00.000Z"],
        ["spans-days", "2026-06-13T12:00:00.000Z", "2026-06-14T06:00:00.000Z"],
      ]);
      const single = await get(`/v1/admin/apps/${appId}/users/mixed`);
      expect(single.body.user).toMatchObject({
        created_at: "2026-06-14T01:00:00.000Z",
        last_seen_at: "2026-06-14T23:00:00.000Z",
      });
    });

    it("lets a virtual user go when retention removes the last event naming it", async () => {
      const appId = "usage-day-retained-users";
      await seedApp(appId);
      await usage(appId, "2026-01-10T01:00:00.000Z", { user: "aged-out" });
      await rejection(appId, "aged-out", "2026-01-11T01:00:00.000Z");
      await usage(appId, "2026-06-10T01:00:00.000Z", { user: "kept" });
      const before = await get("/v1/admin/apps");
      expect(before.body.apps.find((row: any) => row.id === appId).users).toEqual({ total: 2, blocked: 0 });

      await compactUsageEvents(env.DB, NOW);
      await pruneRejectionEvents(env.DB, NOW);

      const after = await get("/v1/admin/apps");
      expect(after.body.apps.find((row: any) => row.id === appId).users).toEqual({ total: 1, blocked: 0 });
      expect((await get(`/v1/admin/apps/${appId}/users/aged-out`)).status).toBe(404);
    });

    it("reads per user, not per event", async () => {
      const appId = "usage-day-user-reads";
      await seedApp(appId);
      await env.DB.prepare(`
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2999)
        INSERT INTO app_usage_event(event_id, organization_id, app_id, user_id, provider_type, model, route, cost_usd, status, created_at)
        SELECT 'usage-day-user-bulk-' || i, ?1, ?2, 'bulk-user-' || (i % 3), 'openai', 'gpt-test', 'openai/v1/responses', 0, 'ok',
               strftime('%Y-%m-%dT%H:%M:%fZ', '2026-06-01', '+' || i || ' minutes')
        FROM n`).bind(TEST_ORGANIZATION_ID, appId).run();

      const { results, meta } = await prepared(env.DB, endUserCounts(TEST_ORGANIZATION_ID)).all<{ app_id: string; total: number }>();
      expect(results.find((row) => row.app_id === appId)?.total).toBe(3);
      // Every app of the test account is in scope, each with a handful of users;
      // grouping the events instead would read at least the three thousand above.
      expect(meta.rows_read).toBeLessThan(1000);
    });
  });
});
