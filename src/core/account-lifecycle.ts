import { GatewayError } from "./errors";
import { ttlCache } from "./ttl-cache";
import { QueryBudget } from "./query-budget";
import {
  accountAccessDenial,
  type AccountAccessMode,
  type AccountLifecycle,
} from "../policy/accounts";
import { sql, type SQL } from "drizzle-orm";
import type { CfAuthOAuth, OperationSweepStatements } from "@maxceem/cf-auth";

/** The OAuth sweep's statements, as `CfAuthOAuth.sweepStatements` answers them. */
export type OAuthSweepStatements = ReturnType<CfAuthOAuth["sweepStatements"]>;
import { database } from "../db";
import { prepared } from "../db/sql";
import type { Deployment } from "../policy/deployment";
import {
  expiredUnclaimedAccountsCondition,
  accountActivatedCondition,
  humanOwnerCondition,
} from "../policy/sql";

/**
 * Lifecycle rows are read on the dispatch path of every hosted request, so they
 * are cached per isolate for a short interval instead of being re-read each
 * time.
 *
 * What makes that safe is the direction the gated fields can move, not how
 * rarely they move. Neither instant in a row is ever rewritten to a later one:
 * `created_at` is fixed, and `expires_at` only goes from a deadline to `NULL`;
 * `activated` only goes from false to true, since an owner's verified email is
 * never unverified and an `account_activation` row is never removed from a
 * live account. So every transition that widens access is a claim — the CLI
 * handoff, or the recovery script promoting an owner, which clears the
 * deadline for the same reason — or an activation, and every other write that
 * touches this row, such as the scheduled
 * cleanup deleting an account already past its deadline, either narrows access
 * or leaves the gated fields alone. A stale entry can therefore refuse for a
 * moment longer than necessary, and can never admit for a moment longer than it
 * should.
 *
 * The isolate that serves a claim or a verification drops its own entry
 * ({@link invalidateAccountLifecycle}); every other isolate converges within
 * the TTL. Nothing here decides the claim itself: that is settled by the
 * guarded D1 writes in the handoff.
 *
 * Keys are organization ids that came out of D1, so the cache is not
 * attacker-growable; the bound is only so that a long-lived isolate in a large
 * deployment cannot keep one entry per account it ever served, and it sits far
 * above what any isolate reads inside a ten-second window.
 *
 * Exported for the tests that clear it on its own; nothing in the Worker reads
 * it but this file.
 */
const LIFECYCLE_CACHE_TTL_MS = 10_000;
export const accountLifecycleCache = ttlCache<string, AccountLifecycle>({
  name: "account-lifecycle",
  ttlMs: LIFECYCLE_CACHE_TTL_MS,
  maxEntries: 5_000,
});

export function invalidateAccountLifecycle(id: string): void {
  accountLifecycleCache.delete(id);
}

export async function accountLifecycle(
  env: Env,
  id: string,
): Promise<AccountLifecycle> {
  const cached = accountLifecycleCache.get(id);
  if (cached) return cached;
  // Fill from the authoritative primary. The ten-second TTL is the entire
  // intentional lifecycle staleness window.
  const row = await prepared(env.DB, sql`SELECT o.id, o.name, o.created_at AS createdAt,
    ${humanOwnerCondition(sql.raw("o.id"))} AS claimed,
    o.expires_at AS expiresAt,
    ${accountActivatedCondition(sql.raw("o.id"))} AS activated
    FROM mgmt_organization o WHERE o.id = ${id}`).first<AccountLifecycle>();
  if (!row) throw new GatewayError(404, "not_found", "Account was not found");
  const value = { ...row, claimed: Boolean(row.claimed), activated: Boolean(row.activated) };
  accountLifecycleCache.set(id, value);
  return value;
}

/**
 * The one gate on an account's own deadlines, and on its owner's email.
 *
 * The row is read through {@link accountLifecycle}'s short-lived cache, but no
 * decision is: both deadlines are compared against the current instant on every
 * call, so a warm isolate stops an account on the same second a cold one would.
 * What a cached row can cost is the other direction — up to one TTL of refusals
 * after a claim or a verification has lifted them.
 */
export async function assertAccountAccess(
  deployment: Deployment,
  env: Env,
  id: string,
  mode: AccountAccessMode,
): Promise<AccountLifecycle> {
  const account = await accountLifecycle(env, id);
  const denial = accountAccessDenial(
    deployment,
    account,
    mode,
    Date.now(),
  );
  if (denial === "account_expired") {
    throw new GatewayError(
      403,
      "account_expired",
      "The account recovery deadline has passed",
    );
  }
  if (denial === "unclaimed_access_expired") {
    throw new GatewayError(
      403,
      "unclaimed_access_expired",
      "This unclaimed account's free access has ended; claim your account to continue",
    );
  }
  if (denial === "email_unverified") {
    throw new GatewayError(
      403,
      "email_unverified",
      "This account's owner has not verified their email address yet. Open the link in the "
        + "verification email, or send a new one from the console, and requests will be served.",
    );
  }
  return account;
}

/**
 * Accounts one cleanup pass deletes.
 *
 * The batch is not what bounds a night's work — the loop below is — but a pass
 * costs the same twenty-one statements whether it collects one account or two
 * hundred, so collecting one at a time would make the query allowance, not the
 * database, the thing that decides how fast an expired backlog drains. The
 * ceiling on the batch is transaction size: every statement in a pass is one
 * D1 transaction holding the single write lock, and a much larger batch could
 * reach the 30s statement limit on an account with a long usage history.
 */
export const ACCOUNT_CLEANUP_BATCH = 200;

/** Tables whose rows belong to an application of an expired account. */
const APP_SCOPED_TABLES = [
  "app_api_key",
  "app_attest_key",
  "app_user",
  // Before the events: their delete trigger would otherwise move the sealed
  // day totals row by row, only for this list to delete them afterwards.
  "app_usage_day",
  "app_usage_event",
  "app_usage_rollup",
  "app_usage_spend",
  "app_auth_event",
  "app_rejection_event",
  "app_auth_challenge",
] as const;

/** Of those, the ones that also carry the account directly. */
const ORGANIZATION_STAMPED_TABLES = new Set([
  "app_usage_day",
  "app_usage_event",
  "app_usage_rollup",
  "app_usage_spend",
]);

/** Tables whose rows belong to the expired account itself. */
const ORGANIZATION_SCOPED_TABLES = [
  "app",
  "provider",
  "provider_gateway",
  "mgmt_api_key",
  "mgmt_organization_user",
  "account_activation",
] as const;

/**
 * The statements one cleanup pass issues.
 *
 * Built apart from the database so the pass's size is knowable before any of it
 * is issued — {@link ACCOUNT_CLEANUP_STATEMENTS} is this list's length, not a
 * number written down beside it — and so adding a table here moves the loop's
 * own bound with it.
 *
 * Every statement repeats the unclaimed deadline predicate with one captured
 * cutoff and the same ordering, so the whole D1 transaction addresses one set
 * of accounts. A claim committed before this write transaction begins excludes
 * its account from every statement; no claim can commit midway through it.
 */
function accountCleanupStatements(cutoffMs: number): {
  statements: SQL[];
  /** Index of the statement whose `changes` counts the accounts collected. */
  accounts: number;
} {
  const expired = sql`SELECT id FROM mgmt_organization o
    WHERE ${expiredUnclaimedAccountsCondition(cutoffMs)}
    ORDER BY o.id LIMIT ${sql.raw(String(ACCOUNT_CLEANUP_BATCH))}`;
  const apps = sql`SELECT id FROM app WHERE organization_id IN (${expired})`;
  const statements: SQL[] = [];
  for (const table of APP_SCOPED_TABLES) {
    const stamped = ORGANIZATION_STAMPED_TABLES.has(table)
      ? sql` OR organization_id IN (${expired})`
      : sql.empty();
    statements.push(sql`DELETE FROM ${sql.identifier(table)} WHERE app_id IN (${apps})${stamped}`);
  }
  // An OAuth connection's token generations, before the connection itself:
  // the foreign key would cascade them, but what a pass removes is written in
  // the pass, and an unclaimed account's connections end with it.
  statements.push(sql`DELETE FROM mgmt_oauth_token WHERE api_key_id IN (
    SELECT id FROM mgmt_api_key WHERE organization_id IN (${expired}))`);
  for (const table of ORGANIZATION_SCOPED_TABLES) {
    statements.push(sql`DELETE FROM ${sql.identifier(table)} WHERE organization_id IN (${expired})`);
  }
  // Keep only the token-bound bootstrap tombstone: deleting it would let an
  // old bootstrap recreate the same expired account. No account identity or
  // secret survives. A bootstrap is opened by nobody, so its row names the
  // account only in its record, and never in the organization column whose
  // foreign key would delete it along with the account; that column is
  // cleared all the same, before the account is deleted below.
  statements.push(sql`UPDATE mgmt_operation SET state='expired', organization_id=NULL,
      opener_user_id=NULL, opener_credential_id=NULL, outcome=NULL,
      sealed_outcome=NULL, sealed_until=NULL, redeem_code_hash=NULL, updated_at=${cutoffMs}
      WHERE kind='bootstrap' AND json_extract(outcome,'$.accountId') IN (${expired})`);
  // Every other operation of the account, deleted here rather than left to
  // the foreign key's cascade, so what a pass removes is written in the pass.
  statements.push(
    sql`DELETE FROM mgmt_operation WHERE kind!='bootstrap' AND organization_id IN (${expired})`,
  );
  const accounts = statements.length;
  statements.push(sql`DELETE FROM mgmt_organization WHERE id IN (${expired})`);
  statements.push(sql`DELETE FROM mgmt_user WHERE id IN (SELECT id FROM mgmt_user WHERE kind='service' AND NOT EXISTS (SELECT 1 FROM mgmt_organization WHERE created_by_user_id=mgmt_user.id) AND NOT EXISTS (SELECT 1 FROM mgmt_organization_user WHERE user_id=mgmt_user.id) LIMIT 100)`);
  return { statements, accounts };
}

/**
 * Statements one cleanup pass issues, counted from the pass rather than declared.
 *
 * Local on purpose: the run's allowance is charged for what the batch actually
 * issues, so this number is only what the loop below needs in order to decide
 * whether another whole pass still fits.
 */
const ACCOUNT_CLEANUP_STATEMENTS = accountCleanupStatements(0).statements.length;

/** Deletes one batch of expired accounts, and answers how many it found. */
async function deleteExpiredAccountBatch(db: D1Database): Promise<number> {
  const { statements, accounts } = accountCleanupStatements(Date.now());
  const results = await db.batch(statements.map((statement) => prepared(db, statement)));
  return results[accounts]?.meta.changes ?? 0;
}

/**
 * Deletes every expired unclaimed account the night's allowance can reach.
 *
 * One pass is bounded so it cannot hold the write lock indefinitely, which
 * means a backlog larger than one batch — the shape abuse takes, since a
 * bootstrap is rate limited per address and an account becomes eligible only
 * ninety days after it was created — needs more than one. So passes repeat
 * while the last one filled its batch and the run can still afford another.
 * A backlog that outlives the allowance is continued the following night.
 */
export async function pruneExpiredAccounts(
  db: D1Database,
  budget: QueryBudget = new QueryBudget(ACCOUNT_CLEANUP_STATEMENTS),
): Promise<number> {
  let deleted = 0;
  // A pass is one transaction, so it is asked for in full or not started: the
  // charge lands as the batch is issued, not before it.
  while (budget.affords(ACCOUNT_CLEANUP_STATEMENTS)) {
    const batch = await deleteExpiredAccountBatch(db);
    deleted += batch;
    if (batch < ACCOUNT_CLEANUP_BATCH) break;
  }
  return deleted;
}

/**
 * Expires what CLI operations hold for a short while, wherever this gateway
 * runs: cf-auth's own sweep, as one batch — pending operations past their
 * deadline are marked expired, sealed outcomes past their window dropped, and
 * records past their retention deleted. A bootstrap's record is retained as
 * long as any other, which is as long as the CLI will resend the token that
 * opened it.
 *
 * `sweep` is the engine's statements, built over `db` so the run's allowance
 * counts them.
 */
export async function pruneExpiredAuthorizations(
  db: D1Database,
  sweep: OperationSweepStatements,
): Promise<void> {
  if (sweep.length === 0) return;
  await database(db).batch(sweep as [OperationSweepStatements[number], ...OperationSweepStatements]);
}

/**
 * cf-auth's OAuth sweep, as one batch: the token generations of connections
 * that were revoked or passed their lifetime. A revocation already deletes
 * them, so what this collects is a connection that simply lapsed. Built over
 * `db`, like the operation sweep, so the run's allowance counts it.
 */
export async function pruneOAuthTokens(db: D1Database, sweep: OAuthSweepStatements): Promise<void> {
  if (sweep.length === 0) return;
  await database(db).batch(sweep as [OAuthSweepStatements[number], ...OAuthSweepStatements]);
}
