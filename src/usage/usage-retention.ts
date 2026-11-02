/**
 * Retention for `app_usage_event`: sum it, then drop it.
 *
 * Usage events are the largest thing a busy deployment stores. Measured against
 * this schema, one event costs about 547 bytes once its three indexes are
 * counted, so a million requests a month grows half a gigabyte a month. D1's
 * per-database ceiling is a hard ten gigabytes, which a deployment at that rate
 * reaches in roughly eighteen months — and reaching it is an outage, not a
 * larger invoice.
 *
 * So events past {@link USAGE_EVENT_RETENTION_DAYS} are summed into
 * `app_usage_rollup` and then deleted, inside one transaction per chunk. The
 * rollup's grain carries no per-event or per-user dimension, which is what makes
 * its row count track an application's configuration rather than its traffic:
 * three million events compact to 3,225 rows. Day buckets are folded again into
 * month buckets past {@link USAGE_ROLLUP_DAY_RETENTION_DAYS}, so even the rollup
 * stops growing.
 */
import { log } from "../core/log";
import { pruneSettledUsageSpend } from "./app-usage-accounting";
import {
  DEFAULT_MAINTENANCE_QUERY_BUDGET,
  MAINTENANCE_SLACK_QUERIES,
  QueryBudget,
} from "../core/query-budget";
import { errorFacts } from "../core/error-facts";

/** How long a raw, per-event row survives. */
export const USAGE_EVENT_RETENTION_DAYS = 90;

/**
 * How long a day bucket survives before it is folded into its month.
 *
 * Thirteen months, so a day-resolution chart can always reach back far enough
 * to put the current month beside the same month a year ago.
 */
export const USAGE_ROLLUP_DAY_RETENTION_DAYS = 400;

/**
 * Rows per transaction.
 *
 * The delete runs at roughly 5,000 rows a second whatever the chunk size, so
 * this does not set throughput — it sets how long one transaction holds D1's
 * single write lock, and how many of the scarce queries below a night's work
 * costs. Five thousand rows measured at about 1.0s, against 4.8s for a whole day
 * at once and 42s for a month, which D1 abandons at its 30s statement limit.
 *
 * Holding that lock for a second is affordable because nothing user-facing is
 * behind it: the only writer it blocks is the usage insert, which the proxy
 * hands to `waitUntil` after the response has already gone to the client.
 */
export const CHUNK_ROWS = 5_000;

/**
 * Queries retention may issue when it is called on its own.
 *
 * A whole nightly allowance, less its slack: a standalone call — a test, or a
 * manual invocation — has no sweeps in front of it to have spent any of it.
 * Inside the nightly run nothing uses this number: {@link runUsageRetention} is
 * handed the run's own budget, already charged for whatever ran before it.
 *
 * Each compaction chunk commits independently, so a backlog that does not fit
 * is simply continued the following night. A deployment on the Workers Paid
 * plan can raise the whole run's allowance with `MAINTENANCE_QUERY_BUDGET`.
 */
export const USAGE_RETENTION_QUERY_BUDGET =
  DEFAULT_MAINTENANCE_QUERY_BUDGET - MAINTENANCE_SLACK_QUERIES;

/** Held back so a large compaction backlog can never starve the fold entirely. */
const FOLD_RESERVE = 9;

const SUMMED_COLUMNS = [
  "requests",
  "input_tokens",
  "cached_input_tokens",
  "cache_write_tokens",
  "output_tokens",
  "cost_usd",
] as const;

/** `requests = requests + excluded.requests, ...` for every summed column. */
const ACCUMULATE = SUMMED_COLUMNS.map((column) => `${column} = ${column} + excluded.${column}`).join(",\n    ");

const CONFLICT_KEY = "(organization_id, grain, bucket, app_id, model, provider_type, status)";

const ROLLUP_COLUMNS =
  "(organization_id, grain, bucket, app_id, model, provider_type, status, requests, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd)";

/**
 * Sums one id range into day buckets.
 *
 * An id range rather than a date range because `created_at` carries no index of
 * its own — adding one would cost a fourth row write on every proxied request,
 * which is exactly the tax this table was recently relieved of. The rowid range
 * scan is free, and `created_at` then filters the rows it lands on.
 *
 * The upsert is required, not defensive: chunks are id ranges and buckets are
 * calendar days, so a chunk that straddles midnight is the normal case and a
 * plain insert would fail on the unique key the second time it saw that day.
 */
const ROLLUP_CHUNK = `
INSERT INTO app_usage_rollup ${ROLLUP_COLUMNS}
SELECT
  organization_id,
  'day',
  substr(created_at, 1, 10),
  app_id,
  model,
  provider_type,
  status,
  COUNT(*),
  COALESCE(SUM(input_tokens), 0),
  COALESCE(SUM(cached_input_tokens), 0),
  COALESCE(SUM(cache_write_tokens), 0),
  COALESCE(SUM(output_tokens), 0),
  COALESCE(SUM(cost_usd), 0)
FROM app_usage_event
WHERE id >= ? AND id < ? AND created_at < ?
GROUP BY organization_id, substr(created_at, 1, 10), app_id, model, provider_type, status
ON CONFLICT ${CONFLICT_KEY} DO UPDATE SET
    ${ACCUMULATE}`;

const DELETE_CHUNK = "DELETE FROM app_usage_event WHERE id >= ? AND id < ? AND created_at < ?";

/**
 * Folds every day bucket of one month into that month's bucket.
 *
 * Reads and writes the same table, which is safe by construction rather than by
 * luck: the scan is filtered to `grain = 'day'` and every row it writes is
 * `grain = 'month'`, so no row this statement inserts can be read back by its
 * own scan and counted twice.
 */
const FOLD_MONTH = `
INSERT INTO app_usage_rollup ${ROLLUP_COLUMNS}
SELECT
  organization_id,
  'month',
  ?,
  app_id,
  model,
  provider_type,
  status,
  SUM(requests),
  SUM(input_tokens),
  SUM(cached_input_tokens),
  SUM(cache_write_tokens),
  SUM(output_tokens),
  SUM(cost_usd)
FROM app_usage_rollup
WHERE grain = 'day' AND substr(bucket, 1, 7) = ?
GROUP BY organization_id, app_id, model, provider_type, status
ON CONFLICT ${CONFLICT_KEY} DO UPDATE SET
    ${ACCUMULATE}`;

const DROP_FOLDED_DAYS = "DELETE FROM app_usage_rollup WHERE grain = 'day' AND substr(bucket, 1, 7) = ?";

/** The UTC day `days` before `now`, as `YYYY-MM-DD`. */
function dayBefore(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Days one sealing batch sums at most.
 *
 * A healthy night seals one day. This bounds the catch-up after nights that
 * failed, so a week's backlog is a statement of ordinary size rather than one
 * that could reach D1's 30s statement limit on a busy deployment.
 */
export const SEAL_DAYS_PER_BATCH = 7;

/** Statements sealing may issue in a night: the window read and two batches. */
export const SEAL_QUERY_BUDGET = 7;

/** Statements one sealing batch issues: move the window, drop below the floor, sum. */
const SEAL_STATEMENTS = 3;

/**
 * Moves the window from the bounds this run read to the new ones, and fails
 * the whole batch if the window is no longer what was read.
 *
 * Runs first in its batch, so a stale run — two overlapping, the second
 * reading the window before the first moved it — rolls back before it deletes
 * or sums anything. A stale window cannot just be skipped: its batch may have
 * an empty range to sum, so nothing else in it would conflict, and moving the
 * window back would strand the other run's day rows past `sealed_until`, read
 * there and again as raw events. The failure is the window's own order check:
 * a stale row is given bounds that cannot satisfy it.
 */
const MOVE_WINDOW = `
UPDATE app_usage_day_window SET
  sealed_from = CASE WHEN sealed_from = ?3 AND sealed_until = ?4 THEN ?1 ELSE '~' END,
  sealed_until = CASE WHEN sealed_from = ?3 AND sealed_until = ?4 THEN ?2 ELSE '' END
WHERE id = 1`;

/**
 * Sums a range of days into `app_usage_day`.
 *
 * Through `idx_usage_event_account_created`, one range per account: events
 * carry no index on `created_at` alone, and adding one would cost every
 * proxied request a write. The guard trigger refuses an event whose account
 * is gone, so every event has an account here to be found under.
 *
 * A plain insert, not an upsert: days at or past `sealed_until` never have a
 * row, so a conflict means a row exists where none may, and failing the batch
 * is right where adding to the row would double count.
 */
const SEAL_DAYS = `
INSERT INTO app_usage_day (app_id, day, organization_id, requests, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, errors)
SELECT
  app_id,
  substr(created_at, 1, 10),
  organization_id,
  COUNT(*),
  COALESCE(SUM(input_tokens), 0),
  COALESCE(SUM(cached_input_tokens), 0),
  COALESCE(SUM(cache_write_tokens), 0),
  COALESCE(SUM(output_tokens), 0),
  COALESCE(SUM(cost_usd), 0),
  COALESCE(SUM(status = 'provider_error'), 0)
FROM app_usage_event
WHERE organization_id IN (SELECT id FROM mgmt_organization)
  AND created_at >= ? AND created_at < ?
GROUP BY organization_id, app_id, substr(created_at, 1, 10)`;

/** `day` moved by `days`, both as `YYYY-MM-DD`. */
function dayAfter(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export interface SealResult {
  /** Days newly sealed. */
  days: number;
  /** Day rows written for them. */
  rows: number;
  /** Whether the window now ends at today, as opposed to the run hitting its budget. */
  caughtUp: boolean;
}

/**
 * Moves the sealed-day window: its floor up to the retention cutoff, and its
 * end up to today, summing each newly sealed day in the same transaction that
 * admits it.
 *
 * Both moves are what keep a day in exactly one place. A row below the floor
 * is deleted as the floor passes it, so once compaction moves that day's
 * events into the rollup, nothing else still holds them; compaction runs
 * after this for that reason, though the triggers would keep it correct in
 * either order, only with a write per compacted event. A day is admitted
 * together with its sum, so a reader never sees a sealed day without its row.
 */
export async function sealUsageDays(
  db: D1Database,
  now: number = Date.now(),
  budget: QueryBudget = new QueryBudget(SEAL_QUERY_BUDGET),
): Promise<SealResult> {
  const result: SealResult = { days: 0, rows: 0, caughtUp: false };
  if (!budget.affords(1 + SEAL_STATEMENTS)) return result;
  const window = await db
    .prepare("SELECT sealed_from AS sealedFrom, sealed_until AS sealedUntil FROM app_usage_day_window WHERE id = 1")
    .first<{ sealedFrom: string; sealedUntil: string }>();
  if (!window) throw new Error("app_usage_day_window has no row");
  const cutoff = dayBefore(now, USAGE_EVENT_RETENTION_DAYS);
  const today = dayBefore(now, 0);
  let { sealedFrom, sealedUntil } = window;

  while (true) {
    const from = sealedFrom > cutoff ? sealedFrom : cutoff;
    const start = sealedUntil > from ? sealedUntil : from;
    const limit = dayAfter(start, SEAL_DAYS_PER_BATCH);
    const end = today > start ? (limit < today ? limit : today) : start;
    if (from === sealedFrom && end === sealedUntil) {
      result.caughtUp = true;
      break;
    }
    if (!budget.affords(SEAL_STATEMENTS)) break;
    const [, , sealed] = await db.batch([
      db.prepare(MOVE_WINDOW).bind(from, end, sealedFrom, sealedUntil),
      db.prepare("DELETE FROM app_usage_day WHERE day < ?").bind(from),
      db.prepare(SEAL_DAYS).bind(start, end),
    ]);
    result.rows += sealed?.meta.changes ?? 0;
    result.days += Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
    sealedFrom = from;
    sealedUntil = end;
  }
  return result;
}

/**
 * The lowest surviving id, or null for an empty table.
 *
 * Doubles as the compaction cursor, which is why none is persisted anywhere: a
 * chunk deletes what it summed, so the oldest row left is always where the next
 * run resumes. SQLite answers `MIN(rowid)` from the left edge of the b-tree
 * rather than by scanning.
 */
async function oldestEventId(db: D1Database): Promise<number | null> {
  const row = await db.prepare("SELECT MIN(id) AS id FROM app_usage_event").first<{ id: number | null }>();
  return row?.id ?? null;
}

export interface CompactionResult {
  chunks: number;
  /** Rollup rows inserted or added to. */
  rolledUp: number;
  /** Raw events summed and dropped. */
  deleted: number;
  /** Whether the backlog was exhausted, as opposed to the run hitting its budget. */
  caughtUp: boolean;
}

/** Statements a chunk issues: the upsert, the delete, and the cursor read after them. */
const CHUNK_STATEMENTS = 3;

/** Statements a month issues: finding the oldest eligible one, then the fold pair. */
const MONTH_STATEMENTS = 3;

/**
 * Sums expired events into the rollup and deletes them, a chunk at a time.
 *
 * Each chunk is one transaction holding both statements, so the summing and the
 * deleting cannot come apart: a run that dies midway leaves whole chunks behind,
 * never a chunk that was counted but not removed, or removed but not counted.
 */
export async function compactUsageEvents(
  db: D1Database,
  now: number = Date.now(),
  budget: QueryBudget = new QueryBudget(USAGE_RETENTION_QUERY_BUDGET - FOLD_RESERVE),
): Promise<CompactionResult> {
  const cutoff = dayBefore(now, USAGE_EVENT_RETENTION_DAYS);
  if (!budget.affords(1)) return { chunks: 0, rolledUp: 0, deleted: 0, caughtUp: false };
  let cursor = await oldestEventId(db);
  const result: CompactionResult = { chunks: 0, rolledUp: 0, deleted: 0, caughtUp: cursor === null };

  while (cursor !== null && budget.affords(CHUNK_STATEMENTS)) {
    const end = cursor + CHUNK_ROWS;
    const [rolled, removed] = await db.batch([
      db.prepare(ROLLUP_CHUNK).bind(cursor, end, cutoff),
      db.prepare(DELETE_CHUNK).bind(cursor, end, cutoff),
    ]);
    result.chunks += 1;
    result.rolledUp += rolled?.meta.changes ?? 0;
    result.deleted += removed?.meta.changes ?? 0;

    const next = await oldestEventId(db);
    if (next === null) {
      result.caughtUp = true;
      break;
    }
    /*
     * A row inside the range just processed survived it, so it is newer than the
     * cutoff. The cursor is always the oldest surviving id, so this run cannot
     * advance past that row without persisting a separate scan cursor.
     *
     * Order inside a chunk does not matter, because a chunk is an id range and
     * both statements filter it by `created_at`: an expired row sitting behind a
     * live one in the same chunk is still collected.
     *
     * Event time is fixed before response observation, while id is assigned
     * after observation finishes. A long response can therefore insert an old
     * timestamp behind a newer row. Such a straggler is retained until the live
     * row blocking this cursor also ages out; no history is skipped or deleted
     * without first being rolled up.
     */
    if (next < end) {
      result.caughtUp = false;
      break;
    }
    // Jumps the gap left by earlier deletes rather than stepping through it.
    cursor = next;
  }
  return result;
}

export interface FoldResult {
  months: number;
  /** Month rows inserted or added to. */
  folded: number;
}

/** Folds day buckets older than the day-grain window into their month buckets. */
export async function foldUsageRollupMonths(
  db: D1Database,
  now: number = Date.now(),
  budget: QueryBudget = new QueryBudget(FOLD_RESERVE),
): Promise<FoldResult> {
  // A month is eligible only once all of it is past the window, so a month still
  // accumulating days is never half-folded.
  const cutoffMonth = dayBefore(now, USAGE_ROLLUP_DAY_RETENTION_DAYS).slice(0, 7);
  const result: FoldResult = { months: 0, folded: 0 };

  while (budget.affords(MONTH_STATEMENTS)) {
    const oldest = await db
      .prepare("SELECT MIN(substr(bucket, 1, 7)) AS month FROM app_usage_rollup WHERE grain = 'day' AND substr(bucket, 1, 7) < ?")
      .bind(cutoffMonth)
      .first<{ month: string | null }>();
    const month = oldest?.month ?? null;
    if (month === null) break;

    const [folded] = await db.batch([
      db.prepare(FOLD_MONTH).bind(month, month),
      db.prepare(DROP_FOLDED_DAYS).bind(month),
    ]);
    result.months += 1;
    result.folded += folded?.meta.changes ?? 0;
  }
  return result;
}

/**
 * Both passes, each reporting under its own code.
 *
 * The fold runs even when compaction failed: they touch different rows, and a
 * compaction that cannot keep up is no reason to let the rollup grow unbounded
 * as well. It is given its own reserved share of the run's allowance for the
 * same reason — a compaction backlog must not be able to spend the whole night's
 * allowance and starve it.
 *
 * `budget` is the nightly run's shared allowance, already charged for the sweeps
 * that ran before this one; whatever retention does not issue it never spends.
 */
export async function runUsageRetention(
  db: D1Database,
  now: number = Date.now(),
  budget: QueryBudget = new QueryBudget(USAGE_RETENTION_QUERY_BUDGET),
): Promise<void> {
  // First because it is one statement and it either fits or it does not; the
  // two passes below each want as much of what is left as they can get.
  if (budget.affords(1)) {
    try {
      const deleted = await pruneSettledUsageSpend(
        db,
        dayBefore(now, USAGE_EVENT_RETENTION_DAYS).slice(0, 7),
      );
      if (deleted > 0) log("info", "usage_spend_pruned", { deleted });
    } catch (error) {
      log("error", "usage_spend_prune_failed", {
        error: errorFacts(error),
      });
    }
  }
  // Before compaction, so the floor it raises is already past the days
  // compaction is about to delete. A small fixed share: a healthy night
  // spends four statements here.
  const sealing = budget.limited(SEAL_QUERY_BUDGET);
  try {
    const result = await sealUsageDays(sealing.database(db), now, sealing);
    log("info", "usage_days_sealed", { ...result });
  } catch (error) {
    log("error", "usage_days_seal_failed", {
      error: errorFacts(error),
    });
  }
  // Everything but the reserve. A view charges this budget as it spends, so
  // the nine it cannot reach are simply still here when the fold asks for them.
  const compaction = budget.limited(budget.remaining - FOLD_RESERVE);
  try {
    const result = await compactUsageEvents(compaction.database(db), now, compaction);
    log("info", "usage_events_compacted", { ...result, retentionDays: USAGE_EVENT_RETENTION_DAYS });
  } catch (error) {
    log("error", "usage_events_compact_failed", {
      error: errorFacts(error),
    });
  }
  try {
    const result = await foldUsageRollupMonths(db, now, budget);
    if (result.months > 0) {
      log("info", "usage_rollup_folded", { ...result, dayRetentionDays: USAGE_ROLLUP_DAY_RETENTION_DAYS });
    }
  } catch (error) {
    log("error", "usage_rollup_fold_failed", {
      error: errorFacts(error),
    });
  }
}
