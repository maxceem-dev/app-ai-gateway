import { and, eq, sql, type SQL } from "drizzle-orm";
import { getBillingAccess, requireActiveBilling } from "../billing/gateway";
import type { AppUpdate, AppWrite } from "../contracts/schemas";
import type {
  AppDeleteResponse,
  AppListResponse,
  AppResponse,
  AppDraftValidateResponse,
  AppValidateResponse,
  CreatedAppResponse,
} from "../contracts/responses";
import { generateApiKey } from "../client-auth/api-keys";
import { appWarnings } from "./app-warnings";
import {
  appRecordFromRow,
  invalidateAppConfig,
  storedAppFromRow,
  type StoredApp,
} from "../core/app-records";
import { referencedProviderSlugs, validateConfigurationReferences } from "./config-references";
import { GatewayError } from "../core/errors";
import {
  authoritativeOrganizationProviders,
  type OrganizationProviders,
} from "../providers/provider-store";
import { database } from "../db";
import { guardedInsert, prepared, type WriteStatement } from "../db/sql";
import {
  app,
  appApiKey,
  appAttestKey,
  appAuthChallenge,
  appAuthEvent,
  appRejectionEvent,
  appUser,
} from "../db/schema";
import {
  ConfigError,
  selectedProviderPolicies,
  type AppConfig,
} from "../shared/app-config";
import type { Actor } from "./actor";
import { appInsertStatement, updateApp as writeAppRow } from "./app-writes";
import { planCap } from "./plan-caps";
import type { ManagementScope } from "./scope";
import { databaseErrorMatches } from "./validation";
import { assertMonth, EMPTY_USAGE_TOTALS, organizationMonthUsage } from "./usage-queries";
import { endUserCounts } from "./users";
import { commitResourceWrite, type ResourceWriteBoundary } from "./write-boundary";

type AppRow = typeof app.$inferSelect;

const APP_ID_MAX_LENGTH = 63;
/**
 * Crockford's base32: the digits and letters that survive being read aloud or
 * copied by hand, without `i`, `l`, `o` or `u`. Thirty-two divides 256, so
 * {@link randomAppIdSuffix} can fold a random byte into a character without the
 * modulo bias a 36-character alphabet would give its first four letters.
 */
const APP_ID_SUFFIX_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/**
 * Every id carries one, so the readable stem is never the whole identifier.
 *
 * Twelve characters is 32^12, about 10^18. The size is deliberate rather than
 * merely sufficient: an app id outlives the app. Usage and authentication
 * history are keyed by it and survive deletion on purpose, so an id that came
 * round a second time would show one organization the history of another's
 * deleted app. At this width that cannot happen — reproducing a specific
 * retired id is a one-in-10^18 event, and ids are assigned here and never
 * chosen by a caller, so there is nothing to aim at either.
 *
 * It also keeps every assigned id clear of the segments the console and the
 * gateway use themselves (`admin`, `new`, `v1`, …): none of them ends in
 * `-<twelve characters>`. And it leaves the unauthenticated
 * `/v1/apps/{app}/auth/challenge` route unreachable by guessing an app's name.
 */
const APP_ID_SUFFIX_LENGTH = 12;

/** How many times a colliding generated id is retried before the request is refused. */
const APP_ID_ATTEMPTS = 16;

const APP_REVISION_REQUIRED =
  "Send the revision the application was read at as revision";

function slugifyAppName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, APP_ID_MAX_LENGTH)
    .replace(/-+$/u, "");
  return slug || "app";
}

function randomAppIdSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(APP_ID_SUFFIX_LENGTH));
  return Array.from(bytes, (byte) => APP_ID_SUFFIX_ALPHABET[byte % APP_ID_SUFFIX_ALPHABET.length]).join("");
}

/**
 * The id of a new app, derived here and nowhere else: a client sends a name and
 * is answered with the id, which it can neither choose nor change afterwards.
 *
 * Suffixed unconditionally, for the first app of the first organization as much
 * as for the thousandth: an id is claimed against the whole deployment, and a
 * bare stem would mean whoever arrived first owns `chat` and everyone after is
 * quietly given something else. One rule for everybody is the fair form of
 * that, and it leaves nothing for a caller to negotiate over.
 */
function generatedAppId(name: string): string {
  const suffix = randomAppIdSuffix();
  const stem = slugifyAppName(name)
    .slice(0, APP_ID_MAX_LENGTH - suffix.length - 1)
    .replace(/-+$/u, "");
  return `${stem}-${suffix}`;
}

/**
 * Writes are validated against the global price catalog merged with this
 * organization's own overrides, so a model the operator has priced under
 * Providers is configurable here too. `grandfathered` carries the slugs the
 * app's stored configuration already names, which an update may keep even if
 * the instance behind one has since been deleted; creates pass nothing.
 */
const NO_GRANDFATHERED_SLUGS: ReadonlySet<string> = new Set();

function validatedConfig(
  next: AppConfig,
  providers: OrganizationProviders,
  grandfathered: ReadonlySet<string> = NO_GRANDFATHERED_SLUGS,
): AppConfig {
  try {
    validateConfigurationReferences(next, { instances: providers, grandfathered });
    return next;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new GatewayError(400, "invalid_request", error.message);
    }
    throw error;
  }
}

function summary(config: AppConfig, providerIndex: OrganizationProviders) {
  // Disabled instances are excluded from the all-mode expansion: the summary
  // says what the app can reach, and a paused slug is not reachable.
  const selected = selectedProviderPolicies(config.routing);
  const providerSlugs = config.routing.providers.mode === "all"
    ? Object.keys(providerIndex).filter((slug) => providerIndex[slug]?.status === "active")
    : Object.keys(selected);
  const models = new Set<string>();
  for (const provider of Object.values(selected)) {
    for (const model of provider.allowed_models) models.add(model);
  }
  // The slugs this configuration names outright — selected policies and
  // endpoint targets — as opposed to `providers`, which an all-mode app expands
  // to everything. This is what "which apps use this provider?" means when a
  // delete or disable is about to be confirmed.
  const referenced = new Set<string>(Object.keys(selected));
  for (const endpoint of Object.values(config.endpoints)) {
    referenced.add(endpoint.provider);
    for (const fallback of endpoint.fallback ?? []) referenced.add(fallback.provider);
  }
  return {
    apple_bundle_id: config.authentication.type === "apple_app_attest"
      ? config.authentication.app_attest.bundle_id
      : null,
    providers: providerSlugs,
    referenced_providers: [...referenced],
    allowed_model_count: models.size,
    // What the whole app may spend this month, so the list can show the
    // month's cost against it. `null` is unlimited, as everywhere in limits.
    monthly_budget_usd: config.limits.per_app.spending.monthly_usd,
  };
}

function serializeApp(stored: StoredApp) {
  return {
    id: stored.id,
    name: stored.name,
    config: stored.config,
    status: stored.status,
    created_at: stored.createdAt,
    updated_at: stored.updatedAt,
    revision: stored.revision,
    // Computed on every read, never stored or written.
    warnings: appWarnings(stored),
  };
}

/**
 * Refuses the write unless the organization may currently use the product.
 *
 * Entitlement only — whether the plan grants access at all. A ceiling on how
 * much configuration the plan allows is a separate question, asked by the
 * statement that would store the row; see `./plan-caps.ts`.
 */
async function requireEntitlement(
  scope: ManagementScope,
  organizationId: string,
): Promise<void> {
  requireActiveBilling(
    await getBillingAccess(scope.deployment, organizationId, scope.billingCache),
  );
}

export async function listApps(
  scope: ManagementScope,
  actor: Actor,
  month: string,
): Promise<AppListResponse> {
  const { env } = scope;
  assertMonth(month);
  const db = database(env.DB);
  const organizationId = actor.organizationId;
  const providerIndex = await authoritativeOrganizationProviders(env, organizationId);
  const rows = await db
    .select()
    .from(app)
    .where(eq(app.organizationId, organizationId))
    .orderBy(app.id);
  const { results: usage } = await organizationMonthUsage(env.DB, organizationId, month);
  const usageByApp = new Map(usage.map(({ app_id, ...totals }) => [app_id, totals]));
  const counts = await prepared(env.DB, endUserCounts(organizationId)).all<{
    app_id: string;
    total: number;
    blocked: number;
  }>();
  const countsByApp = new Map(counts.results.map((row) => [row.app_id, row]));

  /*
   * Whether this account has ever recorded a provider attempt, at any time.
   *
   * Deliberately not derived from the usage totals above: those are scoped to
   * the selected month, so an organization that proxied in March and nothing in
   * April would read as having never sent one. Callers use this to decide
   * whether an organization is still being set up, and that answer must not
   * come back on the first of the month.
   *
   * Retention moves old events into rollups. Check both in one statement so
   * compaction cannot make an established organization look new again.
   */
  const proxied = rows.length === 0 ? null : await env.DB.prepare(`
    SELECT 1 AS found FROM app_usage_event
    INNER JOIN app ON app.id = app_usage_event.app_id
    WHERE app.organization_id = ?
    UNION ALL
    SELECT 1 AS found FROM app_usage_rollup
    INNER JOIN app ON app.id = app_usage_rollup.app_id
    WHERE app.organization_id = ?
    LIMIT 1
  `).bind(organizationId, organizationId).first();

  return {
    month,
    has_proxied_requests: proxied !== null,
    apps: rows.map((row) => {
      const userCounts = countsByApp.get(row.id);
      const config = appRecordFromRow(row).config;
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        created_at: row.createdAt,
        authentication_type: config.authentication.type,
        ...summary(config, providerIndex),
        users: { total: userCounts?.total ?? 0, blocked: userCounts?.blocked ?? 0 },
        usage: usageByApp.get(row.id) ?? EMPTY_USAGE_TOTALS,
      };
    }),
  };
}

/**
 * Creates one application and its default key in one batch, completing the
 * operation it runs under, if any, in the same one.
 *
 * The id is generated rather than chosen, so the only retry this loop makes is
 * for an id that was already taken; every other refusal is the caller's answer.
 */
export async function createApp(
  scope: ManagementScope,
  actor: Actor,
  body: AppWrite,
  boundary?: ResourceWriteBoundary,
): Promise<CreatedAppResponse> {
  const { env } = scope;
  await requireEntitlement(scope, actor.organizationId);
  const { name } = body;
  const organizationId = actor.organizationId;
  const config = validatedConfig(
    body.config,
    await authoritativeOrganizationProviders(env, organizationId),
  );
  const cap = await planCap(scope, "app", organizationId);
  for (let attempt = 0; attempt < APP_ID_ATTEMPTS; attempt += 1) {
    const appId = generatedAppId(name);
    const now = new Date().toISOString();
    const status = body.status ?? "active";
    const generated = config.authentication.type === "api_key" ? await generateApiKey() : null;
    const createdKey = generated ? {
      id: generated.id, name: "Default key", key: generated.key,
      key_prefix: generated.keyPrefix, created_at: now,
    } : null;
    const outcome = {
      app: { id: appId, name, config, status, revision: 1, created_at: now, updated_at: now, warnings: [] },
      api_key: createdKey,
    };
    // The app cap guards the app row alone. The default key rides along with the
    // app it belongs to, and by the time its statement runs the app is already
    // counted, so sharing the guard would refuse the key of the very app that
    // just filled the plan's last slot. Keys added later are capped in `./keys.ts`.
    const keyGuard = boundary?.condition ?? sql`1`;
    const db = database(env.DB);
    const build = (guard: SQL): WriteStatement[] => [
      appInsertStatement(db, { id: appId, organizationId, name, config, status, createdAt: now, updatedAt: now }, guard),
      ...(generated
        ? [guardedInsert(
            db,
            appApiKey,
            {
              id: generated.id,
              appId,
              name: "Default key",
              keyHash: generated.keyHash,
              keyPrefix: generated.keyPrefix,
              status: "active",
              createdAt: now,
            },
            and(keyGuard, sql`EXISTS (SELECT 1 FROM app WHERE id = ${appId} AND organization_id = ${organizationId})`)!,
          )]
        : []),
    ];
    // The application, default key and operation outcome are committed together.
    // A response lost after this batch can redeliver the original ID and key.
    try {
      await commitResourceWrite(scope, build, outcome, {
        boundary,
        cap,
        conflict: "The application could not be created; retry the same request",
      });
    } catch (error) {
      // The one retryable failure: the generated id was already taken, so the
      // next attempt generates another. Everything else is the caller's answer,
      // and the operation this write may be running under answers with what it
      // recorded.
      if (databaseErrorMatches(error, /UNIQUE constraint failed: app\.id/u)) continue;
      throw error;
    }
    invalidateAppConfig(appId);
    return outcome;
  }
  throw new GatewayError(409, "conflict", "Could not allocate a unique app ID; retry the same request");
}

export function getApp(_scope: ManagementScope, _actor: Actor, row: AppRow): AppResponse {
  // Parsed rather than passed through: every write validates before it stores,
  // so a row that does not parse is an internal error here exactly as it is on
  // the request path.
  return { app: serializeApp(storedAppFromRow(row)) };
}

/** Whether an edit of an existing application would be accepted, judged as its update would be. */
export async function validateApp(
  scope: ManagementScope,
  actor: Actor,
  existing: AppRow,
  body: AppWrite,
): Promise<AppValidateResponse> {
  await requireEntitlement(scope, actor.organizationId);
  validatedConfig(
    body.config,
    await authoritativeOrganizationProviders(scope.env, actor.organizationId),
    referencedProviderSlugs(appRecordFromRow(existing).config),
  );
  return { valid: true, app_id: existing.id };
}

/** Whether a configuration for a new application would be accepted, judged as its creation would be. */
export async function validateAppDraft(
  scope: ManagementScope,
  actor: Actor,
  body: AppWrite,
): Promise<AppDraftValidateResponse> {
  await requireEntitlement(scope, actor.organizationId);
  validatedConfig(body.config, await authoritativeOrganizationProviders(scope.env, actor.organizationId));
  return { valid: true };
}

export async function updateApp(
  scope: ManagementScope,
  actor: Actor,
  existing: AppRow,
  body: AppUpdate,
): Promise<AppResponse> {
  const { env } = scope;
  await requireEntitlement(scope, actor.organizationId);
  const appId = existing.id;
  const organizationId = actor.organizationId;
  // Optional in the shape only so that its absence has a code of its own; see
  // `AppUpdateSchema`.
  if (body.revision === undefined) {
    throw new GatewayError(400, "app_revision_required", APP_REVISION_REQUIRED);
  }
  if (body.revision !== existing.revision) {
    throw new GatewayError(409, "app_revision_conflict", "The application changed; reload it before saving your changes");
  }
  // The slugs the stored row already names stay writable even if their provider
  // rows were deleted in the meantime.
  const config = validatedConfig(
    body.config,
    await authoritativeOrganizationProviders(env, organizationId),
    referencedProviderSlugs(appRecordFromRow(existing).config),
  );
  // Conditional on the row still being this organization's, so an app deleted
  // or handed over between the read above and this write is not resurrected
  // under the caller's name.
  const written = await writeAppRow(env.DB, {
    id: appId,
    organizationId,
    name: body.name,
    config,
    status: body.status ?? "active",
    updatedAt: new Date().toISOString(),
    expectedRevision: existing.revision,
  });
  if (!written) throw new GatewayError(409, "app_revision_conflict", "The application changed or was removed; reload it before saving your changes");
  invalidateAppConfig(appId);
  return { app: serializeApp(written) };
}

export async function deleteApp(
  scope: ManagementScope,
  actor: Actor,
  existing: AppRow,
  confirm: string | undefined,
): Promise<AppDeleteResponse> {
  const appId = existing.id;
  if (confirm !== appId) throw new GatewayError(400, "invalid_request", "Pass ?confirm=<app-id> to delete an app");
  const db = database(scope.env.DB);
  // One D1 batch, which is one transaction: a failure part-way rolls every
  // statement back instead of leaving an application with no keys, or keys and
  // users belonging to no application.
  const [removedUsers] = await db.batch([
    db.delete(appUser).where(eq(appUser.appId, appId)).returning({ id: appUser.id }),
    db.delete(appAttestKey).where(eq(appAttestKey.appId, appId)),
    db.delete(appAuthChallenge).where(eq(appAuthChallenge.appId, appId)),
    // Authentication history is diagnostic and reachable only under
    // `/apps/:app`, so it dies with the app it describes. Usage is the
    // exception: it is billing history, and it is deliberately kept.
    db.delete(appAuthEvent).where(eq(appAuthEvent.appId, appId)),
    db.delete(appRejectionEvent).where(eq(appRejectionEvent.appId, appId)),
    db.delete(appApiKey).where(eq(appApiKey.appId, appId)),
    db.delete(app).where(and(
      eq(app.id, appId),
      eq(app.organizationId, actor.organizationId),
    )),
  ]);
  invalidateAppConfig(appId);
  return {
    deleted: true,
    app_id: appId,
    removed_users: removedUsers.length,
    usage_events_retained: true,
  };
}
