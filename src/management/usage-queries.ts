/**
 * Every query and calendar calculation the usage surfaces read through.
 *
 * It lives in the management layer because the services beside it — the
 * application list and the end-user list — read the same totals the usage
 * endpoints report, the auth-event summary reads the same day and range
 * helpers, and the CLI's account usage sums the same counters, so each is
 * written once.
 */
import { and, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { GatewayError } from "../core/errors";
import type { UsageTotals } from "../contracts/responses";
import { MONTH_FORMAT_MESSAGE, MONTH_PATTERN } from "../contracts/schemas";
import { appUsageEvent } from "../db/schema";

/** The totals of a scope with nothing recorded, which every usage answer falls back to. */
export const EMPTY_USAGE_TOTALS: Readonly<UsageTotals> = Object.freeze({
  requests: 0,
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  errors: 0,
});

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Rejects a caller-supplied month before it reaches a query. */
export function assertMonth(month: string): void {
  if (!MONTH_PATTERN.test(month)) {
    throw new GatewayError(400, "invalid_request", MONTH_FORMAT_MESSAGE);
  }
}

/** A half-open text range that includes both day and month rollup buckets. */
export function monthBounds(month: string): { from: string; toExclusive: string } {
  assertMonth(month);
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  if (year === 9999 && index === 12) return { from: month, toExclusive: `${month}~` };
  const nextYear = year + (index === 12 ? 1 : 0);
  const nextMonth = index === 12 ? 1 : index + 1;
  return {
    from: month,
    toExclusive: `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`,
  };
}

export interface DateRange {
  from: string;
  to: string;
}

/**
 * Inclusive day range, defaulting to the trailing `days` window ending today.
 * Each bound's format is the operation's query schema's to check; what is
 * left here is the defaults and that the two bounds are in order.
 */
export function parseRange(from: string | undefined, to: string | undefined, days = 30): DateRange {
  const end = to ?? new Date().toISOString().slice(0, 10);
  const start =
    from ?? new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  if (start > end) {
    throw new GatewayError(400, "invalid_request", "from must not be after to");
  }
  return { from: start, to: end };
}

/**
 * Exclusive end of an inclusive UTC day, usable against either SQLite or ISO
 * text timestamps. The query schema checks shape, not calendar validity; for
 * an impossible date, a high suffix preserves the old prefix comparison rather
 * than normalizing the requested day or throwing. It also covers year 9999.
 */
export function exclusiveDayEnd(day: string): string {
  const midnight = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== day) {
    return `${day}~`;
  }
  const next = new Date(midnight.getTime() + 86_400_000).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(next) ? next : `${day}~`;
}

/** Day label for projection and grouping only; never filter an indexed column through it. */
export const eventDay = sql<string>`substr(${appUsageEvent.createdAt}, 1, 10)`;

export function inRange(appId: string, range: DateRange): SQL | undefined {
  return and(
    eq(appUsageEvent.appId, appId),
    gte(appUsageEvent.createdAt, range.from),
    lt(appUsageEvent.createdAt, exclusiveDayEnd(range.to)),
  );
}

export const usageTotals = {
  requests: sql<number>`COUNT(*)`,
  input_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.inputTokens}), 0)`,
  cached_input_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.cachedInputTokens}), 0)`,
  cache_write_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.cacheWriteTokens}), 0)`,
  output_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.outputTokens}), 0)`,
  cost_usd: sql<number>`COALESCE(SUM(${appUsageEvent.costUsd}), 0)`,
  errors: sql<number>`COALESCE(SUM(CASE WHEN ${appUsageEvent.status} = 'provider_error' THEN 1 ELSE 0 END), 0)`,
};

/*
 * Usage history lives in two tables, and every aggregate has to read both.
 *
 * Events inside the retention window are rows in `app_usage_event`; everything
 * older has been summed into `app_usage_rollup` and deleted. Compaction sums and
 * deletes in one transaction, so an event is in exactly one of the two places
 * and never in both — which is what lets these queries `UNION ALL` the halves
 * and add them up without double counting.
 *
 * A range that straddles the boundary draws its oldest days from the rollup and
 * the rest from raw events, including the boundary day itself, which is normally
 * split across both. Grouping the union by the same key re-joins that day.
 *
 * These are hand-written SQL rather than Drizzle because a `UNION ALL` of two
 * differently-shaped aggregates is exactly the query the builder expresses worst.
 * Every table is aliased and every column qualified: two of these join `app`,
 * which has a `status` column of its own, and an unqualified `status` there would
 * silently count the wrong thing.
 */

/** The counters, over per-event rows, where one row is one request. */
export function rawTotals(t: string): string {
  return `
      COUNT(*) AS requests,
      COALESCE(SUM(${t}.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(${t}.cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(${t}.cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(${t}.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(${t}.cost_usd), 0) AS cost_usd,
      COALESCE(SUM(CASE WHEN ${t}.status = 'provider_error' THEN 1 ELSE 0 END), 0) AS errors`;
}

/**
 * The same counters over pre-summed rows, where each row already stands for
 * `requests` events and the two status counters therefore weigh by it rather
 * than counting rows.
 */
export function rollupTotals(t: string): string {
  return `
      COALESCE(SUM(${t}.requests), 0) AS requests,
      COALESCE(SUM(${t}.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(${t}.cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(${t}.cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(${t}.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(${t}.cost_usd), 0) AS cost_usd,
      COALESCE(SUM(CASE WHEN ${t}.status = 'provider_error' THEN ${t}.requests ELSE 0 END), 0) AS errors`;
}

/**
 * The same counters over `app_usage_day` rows, which carry `errors` already
 * counted rather than a status to count it from.
 */
export function dayTotals(t: string): string {
  return `
      COALESCE(SUM(${t}.requests), 0) AS requests,
      COALESCE(SUM(${t}.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(${t}.cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(${t}.cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(${t}.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(${t}.cost_usd), 0) AS cost_usd,
      COALESCE(SUM(${t}.errors), 0) AS errors`;
}

/*
 * A month's totals read a third place besides the two above.
 *
 * `app_usage_day` holds one row per app per sealed day, and inside the sealed
 * window `[sealed_from, sealed_until)` that row always equals the day's raw
 * events — see the table. So a month is read as its sealed days from there,
 * and its raw events only from the two ranges the window does not cover: the
 * days below the floor, which are about to be compacted, and the days from
 * `sealed_until` on, which is today and anything the nightly run has not yet
 * reached. Those two ranges and the window partition the month, and day rows
 * exist only inside the window, so no event is read twice; the rollup holds
 * only compacted events, which are in none of them.
 *
 * The window bounds are scalar subqueries in the range itself, so the index on
 * (app_id, created_at) seeks straight to today's events and never touches the
 * sealed days. A missing window row reads as an empty window, which answers
 * from raw events alone: slower, never wrong.
 */
const SEALED_FROM = "COALESCE((SELECT sealed_from FROM app_usage_day_window WHERE id = 1), '')";
const SEALED_UNTIL = "COALESCE((SELECT sealed_until FROM app_usage_day_window WHERE id = 1), '')";

/** Re-sums the union's two already-grouped halves into one row per key. */
export const UNION_TOTALS = `
    SUM(requests) AS requests,
    SUM(input_tokens) AS input_tokens,
    SUM(cached_input_tokens) AS cached_input_tokens,
    SUM(cache_write_tokens) AS cache_write_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cost_usd) AS cost_usd,
    COALESCE(SUM(errors), 0) AS errors`;

/** The six figures the month summary endpoint has always reported. */
export type MonthTotals = Omit<UsageTotals, "errors">;

/**
 * Which `by` values survive compaction.
 *
 * The rollup keeps no per-event or per-user dimension, so a breakdown by user,
 * route, endpoint, app version, credential source, cost source, provider slug or
 * provider gateway can only answer from raw events, and therefore only reaches
 * back as far as the retention window. Those keep the unmodified per-event query;
 * these three read the union as well, and so reach back as far as day buckets
 * exist — see {@link usageBreakdown} for where that stops.
 */
export const ROLLUP_DIMENSIONS = {
  model: "model",
  provider: "provider_type",
  status: "status",
} as const;

export type RollupDimension = keyof typeof ROLLUP_DIMENSIONS;

export function isRollupDimension(by: string): by is RollupDimension {
  return Object.hasOwn(ROLLUP_DIMENSIONS, by);
}

/**
 * Daily buckets split by provider, across both tables.
 *
 * Only `grain = 'day'` rollup rows can appear: a month bucket has no day to plot,
 * and spreading one back over thirty identical days would invent detail that was
 * deliberately discarded. A range reaching past the day-grain window is answered
 * as far back as day resolution exists, and no further.
 */
export function usageTimeseries(
  db: D1Database,
  appId: string,
  range: DateRange,
): Promise<{ results: (UsageTotals & { date: string; provider: string })[] }> {
  const toExclusive = exclusiveDayEnd(range.to);
  return db
    .prepare(`
SELECT date, provider,${UNION_TOTALS}
FROM (
  SELECT
      substr(events.created_at, 1, 10) AS date,
      events.provider_type AS provider,${rawTotals("events")}
  FROM app_usage_event AS events
  WHERE events.app_id = ?1
    AND events.created_at >= ?2
    AND events.created_at < ?3
  GROUP BY date, provider
  UNION ALL
  SELECT
      rollup.bucket AS date,
      rollup.provider_type AS provider,${rollupTotals("rollup")}
  FROM app_usage_rollup AS rollup
  WHERE rollup.app_id = ?1
    AND rollup.grain = 'day'
    AND rollup.bucket >= ?2
    AND rollup.bucket < ?3
  GROUP BY date, provider
)
GROUP BY date, provider
ORDER BY date`)
    .bind(appId, range.from, toExclusive)
    .all();
}

/**
 * One dimension's totals across both tables, largest first.
 *
 * Reaches back as far as day buckets go, and no further. An arbitrary day range
 * cannot be answered from a month bucket — the range may start mid-month, and
 * splitting a month across it would be invention — so a range extending past the
 * day-grain window silently omits the folded part rather than guessing at it. The
 * console never asks for one: its widest range is 90 days. A direct API caller
 * can, and gets a short answer.
 */
export function usageBreakdown(
  db: D1Database,
  appId: string,
  range: DateRange,
  by: RollupDimension,
  limit: number,
): Promise<{ results: (UsageTotals & { key: string })[] }> {
  // Interpolated because a column name cannot be a bound parameter. The value is
  // a lookup on ROLLUP_DIMENSIONS, never caller text.
  const column = ROLLUP_DIMENSIONS[by];
  const toExclusive = exclusiveDayEnd(range.to);
  return db
    .prepare(`
SELECT key,${UNION_TOTALS}
FROM (
  SELECT events.${column} AS key,${rawTotals("events")}
  FROM app_usage_event AS events
  WHERE events.app_id = ?1
    AND events.created_at >= ?2
    AND events.created_at < ?3
  GROUP BY key
  UNION ALL
  SELECT rollup.${column} AS key,${rollupTotals("rollup")}
  FROM app_usage_rollup AS rollup
  WHERE rollup.app_id = ?1
    AND rollup.grain = 'day'
    AND rollup.bucket >= ?2
    AND rollup.bucket < ?3
  GROUP BY key
)
GROUP BY key
ORDER BY requests DESC
LIMIT ?4`)
    .bind(appId, range.from, toExclusive, limit)
    .all();
}

/**
 * One calendar month's totals for one app, across raw events, sealed days, and
 * both rollup grains.
 *
 * Matched on the month range of `bucket` across both grains: a month is held as
 * day buckets until it is folded and as one month bucket afterwards, never as
 * both. The grain constraint lets the existing (app_id, grain, bucket) index
 * seek the range. `errors` is summed by the parts and then dropped: this
 * endpoint has never reported them, and widening its response is not this
 * change's business.
 *
 * Reads about one row per sealed day of the month plus one per request since
 * the last nightly run, rather than one per request of the month.
 *
 * An aggregate with no GROUP BY always answers with one row, though `.first()`
 * is typed nullable; the empty month is filled in rather than spread away, so
 * the documented shape holds even if that ever stops being true.
 */
export async function usageMonthTotals(
  db: D1Database,
  appId: string,
  month: string,
): Promise<MonthTotals> {
  const bounds = monthBounds(month);
  const row = await db
    .prepare(`
SELECT
    COALESCE(SUM(requests), 0) AS requests,
    COALESCE(SUM(input_tokens), 0) AS input_tokens,
    COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
    COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens,
    COALESCE(SUM(cost_usd), 0) AS cost_usd
FROM (
  SELECT${rawTotals("events")}
  FROM app_usage_event AS events
  WHERE events.app_id = ?1 AND events.created_at >= ?2
    AND events.created_at < min(?3, ${SEALED_FROM})
  UNION ALL
  SELECT${rawTotals("events")}
  FROM app_usage_event AS events
  WHERE events.app_id = ?1 AND events.created_at >= max(?2, ${SEALED_UNTIL})
    AND events.created_at < ?3
  UNION ALL
  SELECT${dayTotals("days")}
  FROM app_usage_day AS days
  WHERE days.app_id = ?1 AND days.day >= ?2 AND days.day < ?3
  UNION ALL
  SELECT${rollupTotals("rollup")}
  FROM app_usage_rollup AS rollup
  WHERE rollup.app_id = ?1 AND rollup.grain IN ('day', 'month')
    AND rollup.bucket >= ?2 AND rollup.bucket < ?3
)`)
    .bind(appId, bounds.from, bounds.toExclusive)
    .first<MonthTotals>();
  if (row) return row;
  const { errors: _errors, ...empty } = EMPTY_USAGE_TOTALS;
  return empty;
}

/**
 * One calendar month's totals for every app an organization owns.
 *
 * The lower bound is the month prefix itself, so the range reads day and month
 * grains alike: a `YYYY-MM` bucket would fall below a `YYYY-MM-01` lower bound.
 *
 * Read in the same parts as {@link usageMonthTotals}, one app at a time: each
 * part is a CROSS JOIN from the account's apps, which keeps the planner from
 * walking the events first and looking each one's app up afterwards.
 */
export function organizationMonthUsage(
  db: D1Database,
  organizationId: string,
  month: string,
): Promise<{ results: (UsageTotals & { app_id: string })[] }> {
  const bounds = monthBounds(month);
  return db
    .prepare(`
SELECT app_id,${UNION_TOTALS}
FROM (
  SELECT events.app_id AS app_id,${rawTotals("events")}
  FROM app AS owner
  CROSS JOIN app_usage_event AS events
  WHERE owner.organization_id = ?1 AND events.app_id = owner.id
    AND events.created_at >= ?2 AND events.created_at < min(?3, ${SEALED_FROM})
  GROUP BY events.app_id
  UNION ALL
  SELECT events.app_id AS app_id,${rawTotals("events")}
  FROM app AS owner
  CROSS JOIN app_usage_event AS events
  WHERE owner.organization_id = ?1 AND events.app_id = owner.id
    AND events.created_at >= max(?2, ${SEALED_UNTIL}) AND events.created_at < ?3
  GROUP BY events.app_id
  UNION ALL
  SELECT days.app_id AS app_id,${dayTotals("days")}
  FROM app AS owner
  CROSS JOIN app_usage_day AS days
  WHERE owner.organization_id = ?1 AND days.app_id = owner.id
    AND days.day >= ?2 AND days.day < ?3
  GROUP BY days.app_id
  UNION ALL
  SELECT rollup.app_id AS app_id,${rollupTotals("rollup")}
  FROM app AS owner
  CROSS JOIN app_usage_rollup AS rollup
  WHERE owner.organization_id = ?1 AND rollup.app_id = owner.id
    AND rollup.grain IN ('day', 'month') AND rollup.bucket >= ?2 AND rollup.bucket < ?3
  GROUP BY rollup.app_id
)
GROUP BY app_id`)
    .bind(organizationId, bounds.from, bounds.toExclusive)
    .all();
}
