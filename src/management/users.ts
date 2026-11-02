import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { ParsedOperationQuery } from "../contracts/catalog";
import type {
  UserBlockResponse,
  UserListResponse,
  UserResponse,
  UsageTotals,
} from "../contracts/responses";
import { GatewayError } from "../core/errors";
import { database } from "../db";
import { prepared } from "../db/sql";
import { appUsageEvent, appUser, type app } from "../db/schema";
import { invalidateBlockedCache } from "../client-auth/user-status";
import type { Actor } from "./actor";
import type { ManagementScope } from "./scope";
import { currentMonth, EMPTY_USAGE_TOTALS, monthBounds, usageTotals } from "./usage-queries";

type AppRow = typeof app.$inferSelect;

/** One row of {@link endUserIdentities}. */
export interface EndUserIdentityRow {
  app_id: string;
  id: string;
  status: "active" | "blocked";
  /** The user's most recently seen App Attest key, if they hold any. */
  attest_key_id: string | null;
  /** How many App Attest keys — installs — the user holds. */
  installs: number;
  /** 1 when the row's id is itself a registered App Attest key: an install under `app_install`. */
  is_install: number;
  created_at: string;
  last_seen_at: string | null;
  is_virtual: number;
}

/**
 * The end users of an organization's applications, as an `identities` common
 * table expression for a query to begin with.
 *
 * An end user is an `app_user` row, which the token exchange writes, with the
 * App Attest keys — one per install — it holds; or, for
 * an application whose clients name their users without ever exchanging a
 * token, a user id its usage events carry and no row does. The second kind is
 * *virtual*: always active, first and last seen when its events were, and
 * never both — a user id with a row is that row. Userless traffic belongs to
 * no user, so it synthesizes none: an application that identifies nobody has
 * an empty user list, which is the true answer rather than one row standing
 * for all of it.
 *
 * Always scoped to the organization; narrowed to one application, and to one
 * user of it, when those are given. Reads about a handful of rows per end user
 * and none per event — see {@link namedEndUsers}.
 */
export function endUserIdentities(where: {
  organizationId: string;
  appId?: string;
  userId?: string;
}): SQL {
  const users = where.userId === undefined ? sql`` : sql`WHERE users.id = ${where.userId}`;
  return sql`
  WITH RECURSIVE ${namedEndUsers(where)},
  extremes AS (
    SELECT named.app_id, named.user_id,
           (SELECT MIN(events.created_at) FROM app_usage_event AS events
             WHERE events.app_id = named.app_id AND events.user_id = named.user_id) AS used_first,
           (SELECT MAX(events.created_at) FROM app_usage_event AS events
             WHERE events.app_id = named.app_id AND events.user_id = named.user_id) AS used_last,
           (SELECT MIN(events.created_at) FROM app_rejection_event AS events
             WHERE events.app_id = named.app_id AND events.user_id = named.user_id) AS refused_first,
           (SELECT MAX(events.created_at) FROM app_rejection_event AS events
             WHERE events.app_id = named.app_id AND events.user_id = named.user_id) AS refused_last
      FROM named
     WHERE NOT EXISTS (
       SELECT 1 FROM app_user
        WHERE app_user.app_id = named.app_id AND app_user.id = named.user_id
     )
  ),
  seen AS (
    SELECT app_id, user_id,
           ${firstSeen("app_usage_event", "used_first")} AS used_first,
           ${lastSeen("app_usage_event", "used_last")} AS used_last,
           ${firstSeen("app_rejection_event", "refused_first")} AS refused_first,
           ${lastSeen("app_rejection_event", "refused_last")} AS refused_last
      FROM extremes
  ),
  identities AS (
    SELECT users.app_id, users.id, users.status,
           (SELECT keys.key_id FROM app_attest_key AS keys
             WHERE keys.app_id = users.app_id AND keys.user_id = users.id
             ORDER BY keys.last_seen_at DESC, keys.key_id LIMIT 1) AS attest_key_id,
           (SELECT COUNT(*) FROM app_attest_key AS keys
             WHERE keys.app_id = users.app_id AND keys.user_id = users.id) AS installs,
           EXISTS (SELECT 1 FROM app_attest_key AS keys
             WHERE keys.app_id = users.app_id AND keys.key_id = users.id) AS is_install,
           users.created_at, users.last_seen_at, 0 AS is_virtual
      FROM scoped
      JOIN app_user AS users ON users.app_id = scoped.id
     ${users}
    UNION ALL
    -- Two-argument min() and max() are NULL if either side is, so each side
    -- falls back to the other: a user only one table names has only its times.
    SELECT app_id, user_id AS id, 'active' AS status, NULL AS attest_key_id,
           0 AS installs, 0 AS is_install,
           min(COALESCE(used_first, refused_first), COALESCE(refused_first, used_first)) AS created_at,
           max(COALESCE(used_last, refused_last), COALESCE(refused_last, used_last)) AS last_seen_at,
           1 AS is_virtual
      FROM seen
  )`;
}

/**
 * Per application of an organization, how many end users it has and how many
 * of them are blocked: the same people {@link endUserIdentities} lists, counted
 * without the first- and last-seen times the list needs and a count does not.
 * Virtual users are never blocked.
 */
export function endUserCounts(organizationId: string): SQL {
  return sql`
  WITH RECURSIVE ${namedEndUsers({ organizationId })}
  SELECT app_id, COUNT(*) AS total, SUM(blocked) AS blocked
    FROM (
      SELECT users.app_id, users.status = 'blocked' AS blocked
        FROM scoped
        JOIN app_user AS users ON users.app_id = scoped.id
      UNION ALL
      SELECT named.app_id, 0 AS blocked
        FROM named
       WHERE NOT EXISTS (
         SELECT 1 FROM app_user
          WHERE app_user.app_id = named.app_id AND app_user.id = named.user_id
       )
    )
   GROUP BY app_id`;
}

/**
 * The common table expressions both of the above begin with: `scoped`, the
 * applications in scope, and `named`, each distinct (application, user id)
 * that a usage or rejection event still carries.
 *
 * Distinct ids are found by a loose index scan rather than by grouping the
 * events: each step asks the (app_id, user_id, created_at) index for the
 * smallest user id after the previous one, which is one seek, so the cost
 * follows how many users an application has and not how many requests they
 * made. NULL — userless traffic — never compares greater than anything, so it
 * is skipped by construction. Asked about one user, there is nothing to scan:
 * one existence check per table is the whole answer.
 *
 * Reading the event tables themselves, rather than a list kept beside them, is
 * what keeps a virtual user exactly as long-lived as its events: when
 * retention deletes the last of them, the user is gone from both the list and
 * the counts, with nothing to clean up.
 *
 * Times are taken per table as the smallest and largest stored `created_at`
 * through the same index — see {@link firstSeen} for the one place where that
 * differs from normalizing every event first, and how it is corrected.
 */
const ISO_TIMESTAMP = "'%Y-%m-%dT%H:%M:%fZ'";

/*
 * `created_at` holds two formats, `YYYY-MM-DD HH:MM:SS` (the usage column's
 * default) and ISO `YYYY-MM-DDTHH:MM:SS.sssZ`, and ' ' sorts below 'T'. So the
 * smallest stored value of a day can be a space-format one while an ISO value
 * of that same day is earlier, and the largest an ISO one while a space-format
 * value is later. Across days the text order is the time order. Each extreme
 * therefore takes one more seek, for the other format on the same day, and
 * the earlier or later of the two once normalized: exactly what grouping
 * every normalized event used to answer, at two index reads instead of all.
 */

/** The earliest event time in `table` for a row of `extremes`, normalized. */
function firstSeen(table: string, column: string): SQL {
  return sql.raw(`min(strftime(${ISO_TIMESTAMP}, ${column}), COALESCE(strftime(${ISO_TIMESTAMP}, (
             SELECT MIN(events.created_at) FROM ${table} AS events
              WHERE events.app_id = extremes.app_id AND events.user_id = extremes.user_id
                AND events.created_at >= substr(${column}, 1, 10) || 'T'
                AND events.created_at < substr(${column}, 1, 10) || 'U')), strftime(${ISO_TIMESTAMP}, ${column})))`);
}

/** The latest event time in `table` for a row of `extremes`, normalized. */
function lastSeen(table: string, column: string): SQL {
  return sql.raw(`max(strftime(${ISO_TIMESTAMP}, ${column}), COALESCE(strftime(${ISO_TIMESTAMP}, (
             SELECT MAX(events.created_at) FROM ${table} AS events
              WHERE events.app_id = extremes.app_id AND events.user_id = extremes.user_id
                AND events.created_at >= substr(${column}, 1, 10) || ' '
                AND events.created_at < substr(${column}, 1, 10) || '!')), strftime(${ISO_TIMESTAMP}, ${column})))`);
}

function namedEndUsers(where: { organizationId: string; appId?: string; userId?: string }): SQL {
  const apps = where.appId === undefined
    ? sql`organization_id = ${where.organizationId}`
    : sql`organization_id = ${where.organizationId} AND id = ${where.appId}`;
  const scoped = sql`scoped(id) AS (SELECT id FROM app WHERE ${apps})`;
  if (where.userId !== undefined) {
    return sql`${scoped},
  named(app_id, user_id) AS (
    SELECT scoped.id, ${where.userId} FROM scoped
     WHERE EXISTS (SELECT 1 FROM app_usage_event AS events
             WHERE events.app_id = scoped.id AND events.user_id = ${where.userId})
        OR EXISTS (SELECT 1 FROM app_rejection_event AS events
             WHERE events.app_id = scoped.id AND events.user_id = ${where.userId})
  )`;
  }
  return sql`${scoped},
  used(app_id, user_id) AS (
    SELECT scoped.id, (SELECT MIN(events.user_id) FROM app_usage_event AS events
                        WHERE events.app_id = scoped.id)
      FROM scoped
    UNION ALL
    SELECT used.app_id, (SELECT MIN(events.user_id) FROM app_usage_event AS events
                          WHERE events.app_id = used.app_id AND events.user_id > used.user_id)
      FROM used
     WHERE used.user_id IS NOT NULL
  ),
  refused(app_id, user_id) AS (
    SELECT scoped.id, (SELECT MIN(events.user_id) FROM app_rejection_event AS events
                        WHERE events.app_id = scoped.id)
      FROM scoped
    UNION ALL
    SELECT refused.app_id, (SELECT MIN(events.user_id) FROM app_rejection_event AS events
                             WHERE events.app_id = refused.app_id AND events.user_id > refused.user_id)
      FROM refused
     WHERE refused.user_id IS NOT NULL
  ),
  named(app_id, user_id) AS (
    SELECT app_id, user_id FROM used WHERE user_id IS NOT NULL
    UNION
    SELECT app_id, user_id FROM refused WHERE user_id IS NOT NULL
  )`;
}

function serializeUser(row: EndUserIdentityRow) {
  return {
    id: row.id,
    status: row.status,
    attest_key_id: row.attest_key_id,
    attest_registered: row.installs > 0,
    installs: row.installs,
    is_install: row.is_install === 1,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    is_virtual: row.is_virtual === 1,
  };
}

export async function listAppUsers(
  scope: ManagementScope,
  actor: Actor,
  appRow: AppRow,
  query: ParsedOperationQuery<"listAppUsers">,
): Promise<UserListResponse> {
  const { DB } = scope.env;
  const appId = appRow.id;
  const month = query.month ?? currentMonth();
  const bounds = monthBounds(month);
  const { limit, offset } = query;
  const identities = endUserIdentities({ organizationId: actor.organizationId, appId });
  const status = query.status ?? null;
  const match = query.query ? `%${query.query}%` : null;
  const filter = sql`WHERE (${status} IS NULL OR status = ${status})
    AND (${match} IS NULL OR id LIKE ${match})`;
  const total = await prepared(DB, sql`${identities} SELECT COUNT(*) AS value FROM identities ${filter}`)
    .first<{ value: number }>();
  const rows = await prepared(DB, sql`${identities}
     SELECT * FROM identities ${filter}
      ORDER BY COALESCE(last_seen_at, created_at) DESC
      LIMIT ${limit} OFFSET ${offset}`)
    .all<EndUserIdentityRow>();

  const usageByUser = new Map<string, UsageTotals>();
  if (rows.results.length > 0) {
    const totals = await database(DB)
      .select({ userId: appUsageEvent.userId, ...usageTotals })
      .from(appUsageEvent)
      .where(
        and(
          eq(appUsageEvent.appId, appId),
          inArray(appUsageEvent.userId, rows.results.map((row) => row.id)),
          gte(appUsageEvent.createdAt, bounds.from),
          lt(appUsageEvent.createdAt, bounds.toExclusive),
        ),
      )
      .groupBy(appUsageEvent.userId);
    for (const row of totals) {
      const { userId, ...rest } = row;
      // Userless traffic cannot match a listed user, and the `inArray` above
      // already excludes it. Skipped rather than keyed under a placeholder so
      // nothing can turn into a user that never existed.
      if (userId !== null) usageByUser.set(userId, rest);
    }
  }

  return {
    app_id: appId,
    month,
    total: total?.value ?? 0,
    limit,
    offset,
    users: rows.results.map((row) => ({
      ...serializeUser(row),
      usage: usageByUser.get(row.id) ?? EMPTY_USAGE_TOTALS,
    })),
  };
}

export async function getAppUser(
  scope: ManagementScope,
  actor: Actor,
  appRow: AppRow,
  userId: string,
  query: ParsedOperationQuery<"getAppUser">,
): Promise<UserResponse> {
  const { DB } = scope.env;
  const appId = appRow.id;
  const month = query.month ?? currentMonth();
  const bounds = monthBounds(month);
  const identities = endUserIdentities({ organizationId: actor.organizationId, appId, userId });
  const row = await prepared(DB, sql`${identities} SELECT * FROM identities`)
    .first<EndUserIdentityRow>();
  if (!row) throw new GatewayError(404, "not_found", "User was not found");

  const usage = await database(DB)
    .select(usageTotals)
    .from(appUsageEvent)
    .where(
      and(
        eq(appUsageEvent.appId, appId),
        eq(appUsageEvent.userId, userId),
        gte(appUsageEvent.createdAt, bounds.from),
        lt(appUsageEvent.createdAt, bounds.toExclusive),
      ),
    )
    .get();

  return { app_id: appId, month, user: { ...serializeUser(row), usage: usage ?? EMPTY_USAGE_TOTALS } };
}

/**
 * Blocks or unblocks one end user.
 *
 * D1 owns the status read by token exchange, /me, and admission. Admission
 * caches it for ten seconds per isolate; this isolate drops its entry after
 * the write, while other isolates converge when their entries expire.
 */
export async function setAppUserBlocked(
  scope: ManagementScope,
  _actor: Actor,
  appRow: AppRow,
  userId: string,
  blocked: boolean,
): Promise<UserBlockResponse> {
  const appId = appRow.id;
  const updated = await database(scope.env.DB)
    .update(appUser)
    .set({ status: blocked ? "blocked" : "active" })
    .where(and(eq(appUser.appId, appId), eq(appUser.id, userId)))
    .returning({ id: appUser.id });
  if (updated.length !== 1) throw new GatewayError(404, "not_found", "User was not found");
  invalidateBlockedCache(appId, userId);
  return { app_id: appId, user_id: userId, blocked };
}
