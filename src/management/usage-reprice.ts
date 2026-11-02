import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { UsageRepriceResponse } from "../contracts/responses";
import type { UsageRepriceRequest } from "../contracts/schemas";
import { GatewayError } from "../core/errors";
import { database } from "../db";
import { appUsageEvent, provider as providerTable, type app } from "../db/schema";
import { computeCost, hasTokenModelPrice, pricesModalities } from "../usage/pricing";
import type { Actor } from "./actor";
import type { ManagementScope } from "./scope";
import { monthBounds } from "./usage-queries";

const REPRICE_UPDATE_CHUNK = 500;

/**
 * Whether an event carries usage a price could act on.
 *
 * All-zero counts are the shape of a metering failure, not of a free request:
 * an unreadable response body, or a stream a client abandoned before the chunk
 * carrying its usage. Repricing such a row computes zero from zero, which is
 * arithmetic rather than an answer — so this is what separates a row whose cost
 * is now known from one whose cost is still unknown.
 *
 * Time-priced events never reach the caller: their models have no token price,
 * so {@link hasTokenModelPrice} excludes them before this is asked.
 */
function hasReadableCounts(row: {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}): boolean {
  return row.inputTokens + row.cachedInputTokens + row.cacheWriteTokens + row.outputTokens > 0;
}

/**
 * Recomputes one model's cost, for one provider and one month of one app, from
 * the prices configured now: a dry run reports what would change, and `apply`
 * writes it.
 */
export async function repriceAppUsage(
  scope: ManagementScope,
  actor: Actor,
  appRow: typeof app.$inferSelect,
  body: UsageRepriceRequest,
): Promise<UsageRepriceResponse> {
  const { env } = scope;
  const appId = appRow.id;
  const { provider, model, month, apply } = body;
  const bounds = monthBounds(month);
  const rows = await database(env.DB)
    .select({
      id: appUsageEvent.id,
      inputTokens: appUsageEvent.inputTokens,
      cachedInputTokens: appUsageEvent.cachedInputTokens,
      cacheWriteTokens: appUsageEvent.cacheWriteTokens,
      outputTokens: appUsageEvent.outputTokens,
      modalityTokens: appUsageEvent.modalityTokens,
      tokenVariants: appUsageEvent.tokenVariants,
      costUsd: appUsageEvent.costUsd,
      pricing: providerTable.pricing,
    })
    .from(appUsageEvent)
    .leftJoin(providerTable, and(
      eq(appUsageEvent.providerId, providerTable.id),
      eq(providerTable.organizationId, actor.organizationId),
    ))
    .where(and(
      eq(appUsageEvent.appId, appId),
      eq(appUsageEvent.providerType, provider),
      eq(appUsageEvent.model, model),
      gte(appUsageEvent.createdAt, bounds.from),
      lt(appUsageEvent.createdAt, bounds.toExclusive),
      // An event billed on what the upstream charged is already the authoritative
      // figure; recomputing it from a local price would replace a fact with an
      // estimate. Written out rather than `!=` because SQL's inequality is false
      // for the NULLs on older rows, which would exclude every one of them.
      sql`(${appUsageEvent.costSource} IS NULL OR ${appUsageEvent.costSource} != 'reported')`,
    ))
    .limit(10_001);
  if (rows.length > 10_000) {
    throw new GatewayError(400, "invalid_request", "Repricing is limited to 10,000 events per operation");
  }

  // Pricing is per event, through the row that served it, so one event whose
  // provider instance was deleted can be unpriceable while its siblings are
  // fine. A dry run reports that instead of refusing to answer; only `apply`
  // insists on repricing every matched event.
  const repriced: {
    id: number;
    previousCostUsd: number;
    costUsd: number;
    metered: boolean;
  }[] = [];
  const skipped: { id: number; previousCostUsd: number }[] = [];
  // Every row was selected by the requested provider type, so that is the type
  // each one is priced as.
  for (const row of rows) {
    // A row recorded before modality records were kept says nothing about what
    // its tokens were. Where the price depends on that, any figure would be a
    // guess, and the highest-rate one could multiply a text request's cost.
    const unrecorded = row.modalityTokens === null && pricesModalities(provider, model, row.pricing);
    // A row recorded before token variants were kept is priced unsplit, every
    // cache write at the default rate. Unlike a missing modality record that is
    // no new guess: it is the assumption the row was recorded under, so its
    // repriced cost moves only with the rates themselves.
    const costUsd = hasTokenModelPrice(provider, model, row.pricing) && !unrecorded
      ? computeCost(provider, model, {
        ...row,
        modalityTokens: row.modalityTokens ?? undefined,
        tokenVariants: row.tokenVariants ?? undefined,
      }, row.pricing)
      : null;
    if (costUsd === null) {
      if (apply) {
        throw new GatewayError(
          400,
          "invalid_request",
          unrecorded
            ? `Some ${provider}/${model} events predate the modality record its price needs, so they cannot be repriced`
            : `No token price is configured for ${provider}/${model}`,
        );
      }
      skipped.push({ id: row.id, previousCostUsd: row.costUsd });
      continue;
    }
    repriced.push({
      id: row.id,
      previousCostUsd: row.costUsd,
      costUsd,
      metered: hasReadableCounts(row),
    });
  }
  const previousCostUsd = repriced.reduce((total, row) => total + row.previousCostUsd, 0);
  const recalculatedCostUsd = repriced.reduce((total, row) => total + row.costUsd, 0);

  if (apply && repriced.length > 0) {
    const updates: D1PreparedStatement[] = [];
    for (let offset = 0; offset < repriced.length; offset += REPRICE_UPDATE_CHUNK) {
      const chunk = repriced.slice(offset, offset + REPRICE_UPDATE_CHUNK);
      // `cost_source` moves with the figure, but only where there was a figure
      // to move. A row with readable counts now has a cost the local catalog
      // stands behind, so leaving an `unresolved` marker on it would keep the
      // console hiding a cost it has and keep the alert firing for spend that
      // has since been accounted for.
      //
      // A row with *no* readable counts is the opposite case and must not be
      // touched the same way. Multiplying zero tokens by any price yields zero,
      // which looks like a computed answer and is not one: nothing was ever
      // metered, so the cost is still unknown. Claiming `computed` there would
      // convert "spend escaping the budget" into "this request was free",
      // silence the By cost source signal operators are told to watch, and hide
      // the row in the console — while the unbudgeted spend continued. Its
      // `cost_usd` is still rewritten, so a stale figure is corrected, but the
      // marker survives.
      //
      // `reported` rows never get here — they are excluded by the query above.
      const changes = JSON.stringify(chunk.map((row) => ({
        id: row.id,
        cost: row.costUsd,
        metered: row.metered ? 1 : 0,
      })));
      // Each chunk is one D1 subrequest. The row triggers still apply every
      // delta separately, so a concurrent live event composes with repricing.
      updates.push(env.DB.prepare(
        `WITH changes AS (
           SELECT
             CAST(json_extract(value, '$.id') AS INTEGER) AS id,
             CAST(json_extract(value, '$.cost') AS REAL) AS cost,
             CAST(json_extract(value, '$.metered') AS INTEGER) AS metered
           FROM json_each(?)
         )
         UPDATE app_usage_event SET
           cost_usd = (SELECT cost FROM changes WHERE changes.id = app_usage_event.id),
           cost_source = CASE
             WHEN (SELECT metered FROM changes WHERE changes.id = app_usage_event.id) = 1
             THEN 'computed' ELSE cost_source END
         WHERE app_id = ? AND id IN (SELECT id FROM changes)`,
      ).bind(changes, appId));
    }
    // One transaction preserves the endpoint's all-or-nothing apply contract.
    // The row triggers move each month's spend totals with it, and the
    // limiters read them within their refresh window: nothing to push.
    await env.DB.batch(updates);
  }

  return {
    app_id: appId,
    provider,
    model,
    month,
    applied: apply,
    matched_events: repriced.length,
    /**
     * Matched events that carried no readable usage, and so were repriced to
     * the zero their zero counts imply while keeping whatever `cost_source`
     * they had. Counted here rather than dropped from `matched_events` because
     * their `cost_usd` really is rewritten; surfaced separately because a
     * non-zero number means the month contains spend nothing could meter, which
     * repricing cannot fix and must not appear to have fixed.
     */
    unmetered_events: repriced.filter((row) => !row.metered).length,
    /** Dry-run only: matched events that cannot be priced now, by their serving instance or for want of a modality breakdown. */
    unpriced_events: skipped.length,
    unpriced_cost_usd: skipped.reduce((total, row) => total + row.previousCostUsd, 0),
    previous_cost_usd: previousCostUsd,
    recalculated_cost_usd: recalculatedCostUsd,
    delta_usd: recalculatedCostUsd - previousCostUsd,
  };
}
