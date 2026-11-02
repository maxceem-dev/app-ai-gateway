import { sql } from "drizzle-orm";
import type { UsageStatus } from "../contracts/responses";
import type { RejectionReason, RejectionScope } from "../shared/rejection-reasons";
import { createCfAuthTables } from "@maxceem/cf-auth/schema";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { AuthMethod, ModalityTokens } from "../core/types";
import type { CredentialSource } from "../shared/capabilities";
import type { GatewayConnectionConfig, GatewayType } from "../shared/gateways";
import type { AppConfig } from "../shared/app-config";
import type { AppStatus } from "../shared/app-status";
import type { ProviderType } from "../shared/providers";
import type { TokenPrice, TokenVariants } from "../shared/token-rates";

export type UserStatus = "active" | "blocked";
export type AttestEnvironment = "production" | "development";
export type ApiKeyStatus = "active" | "revoked";
/**
 * `disabled` is a reversible pause, not a credential event: the row keeps its
 * secret, its pricing and its slug, and requests to it fail with
 * provider_disabled. Holding the slug is what makes the pause symmetric — no
 * other instance can take it meanwhile, so re-enabling can never conflict.
 * Only deleting the row frees the slug.
 */
export type ProviderStatus = "active" | "disabled";
export type ProviderGatewayStatus = "active" | "revoked";
/**
 * The `type` columns below carry {@link ProviderType} and {@link GatewayType},
 * the runtime registries' own unions, and no CHECK narrows them: a CHECK on a
 * value set that grows is a table rebuild per addition, and it was never the
 * thing that decided anything. A stored name with no adapter or no descriptor is
 * refused by the contracts on the way in and treated as unroutable on the way
 * out — `isGatewayType` and `isProviderType` are that check, in code.
 */
/**
 * What `provider_gateway.config_json` holds: one gateway type's non-secret
 * connection, discriminated at runtime by the row's `type`. Each shape is its
 * descriptor's `connection` schema in `src/shared/gateways.ts`, and a stored
 * value is read as its type's own shape only through `readStoredGateway` in
 * `src/providers/gateway-adapters.ts`, which validates it on the way.
 */
export type ProviderGatewayConfig = GatewayConnectionConfig;
/**
 * What `provider.gateway_route_json` holds: how one provider row is routed
 * inside its gateway. The referenced `provider_gateway.type` selects the schema,
 * and the owning adapter validates it — Cloudflare's accepts nothing at all.
 */
export interface GatewayRouteConfig {
  /** Namespace the gateway expects in front of the canonical model ID. */
  modelPrefix?: string;
  /** Serving providers the gateway may pick from, where it supports pinning. */
  providerOnly?: string[];
}
/**
 * Per-1M-token overrides for models the shipped catalog does not cover, or
 * covers at a price this provider does not charge. An entry replaces the
 * catalog's rates for its model outright; see `modelPrice` in
 * `src/usage/pricing.ts`.
 */
export type ProviderPricing = Record<string, TokenPrice>;
/**
 * Where a proxied request's `cost_usd` came from. `reported` is the upstream's
 * own figure for that request, which outranks a local estimate because it is
 * definitionally what the operator was charged; `computed` is this deployment's
 * price catalog; `unresolved` marks a successful provider response whose cost
 * neither source could establish, so its zero cost is an unknown rather than a
 * measurement.
 */
export type CostSource = "computed" | "reported" | "unresolved";

// Table naming rule: `mgmt_` is who administers the gateway, their credentials
// and their unfinished administrative acts; a bare noun (`app`, `provider`,
// `provider_gateway`) is a resource the account configures and the proxy reads;
// `app_` is a row owned by an app.

/** Management-plane auth tables, namespaced away from end-user gateway data. */
export const mgmtAuthTables = createCfAuthTables({ tablePrefix: "mgmt_" });
export const {
  user: mgmtUser,
  session: mgmtUserSession,
  account: mgmtUserAccount,
  verification: mgmtVerification,
  organization: mgmtOrganization,
  organizationUser: mgmtOrganizationUser,
  apiKey: mgmtApiKey,
  /**
   * Every CLI operation — a bootstrap, an account claim, a login, or a
   * resource write — is one row of cf-auth's operation table. The library owns
   * its shape and its state machine; see `src/routes/cli/README.md` for what
   * this gateway keeps in a row's record beside it.
   */
  operation: mgmtOperation,
  /**
   * The token generations of an OAuth connection, which is an `api_key` row of
   * its own (`client_id`, `resource`). cf-auth owns both; nothing in the
   * gateway reads them yet.
   */
  oauthToken: mgmtOauthToken,
  /**
   * cf-auth's invitations by email address. The gateway issues none yet, but
   * cf-auth reads the table when it provisions a new person, so it has to exist.
   */
  organizationInvitation: mgmtOrganizationInvitation,
} = mgmtAuthTables;

/**
 * An account that may serve application traffic whatever its owner's email.
 *
 * Where the deployment sends email, a claimed account serves traffic once an
 * owner has verified their address; a row here is the other way in. Written
 * for every account that existed before verification did, and for every one
 * created or claimed while the deployment sends no email, so adding a sender
 * later never stops traffic that already flowed. Rows are only ever inserted,
 * and deleted only with their account, which cascades to them: access this
 * grants is never withdrawn.
 *
 * Its own table rather than a column, because `mgmt_organization` is cf-auth's.
 */
export const accountActivation = sqliteTable("account_activation", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => mgmtOrganization.id, { onDelete: "cascade" }),
  activatedAt: text("activated_at").notNull().default(sql`(datetime('now'))`),
});

export const app = sqliteTable(
  "app",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => mgmtOrganization.id),
    name: text("name").notNull(),
    config: text("config_json", { mode: "json" })
      .$type<AppConfig>()
      .notNull(),
    /**
     * `config.authentication.type`, lifted out so the queries that only need to
     * know what kind of application this is never parse the configuration —
     * and never reach into the JSON with `json_extract`, which is an index
     * nothing can use and a path that silently answers null if the shape moves.
     *
     * Written by `src/management/app-writes.ts` alone, from the parsed configuration.
     * No CHECK: the database is permissive and the runtime is authoritative,
     * which is this schema's standing position.
     */
    authType: text("auth_type").notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status").$type<AppStatus>().notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_apps_organization_id").on(table.organizationId),
    check("apps_status_check", sql`${table.status} IN ('active', 'disabled')`),
  ],
);

/** A reusable connection to one of an organization's AI gateways. */
export const providerGateway = sqliteTable(
  "provider_gateway",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => mgmtOrganization.id),
    type: text("type").$type<GatewayType>().notNull(),
    name: text("name").notNull(),
    config: text("config_json", { mode: "json" }).$type<ProviderGatewayConfig>().notNull(),
    /** Vault blob for the gateway token; never leaves the server. */
    secretBlob: text("secret_blob").notNull(),
    secretHint: text("secret_hint").notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status").$type<ProviderGatewayStatus>().notNull().default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_provider_gateways_organization").on(table.organizationId),
    check(
      "provider_gateways_status_check",
      sql`${table.status} IN ('active', 'revoked')`,
    ),
  ],
);

/** One row = one named provider instance configured by an organization. */
export const provider = sqliteTable(
  "provider",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => mgmtOrganization.id),
    type: text("type").$type<ProviderType>().notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** Vault blob (`cfkms-env1.…` or `local1.…`); never leaves the server. */
    secretBlob: text("secret_blob"),
    /** Last four characters of the plaintext — the only fragment ever shown again. */
    secretHint: text("secret_hint"),
    providerGatewayId: text("provider_gateway_id")
      .references(() => providerGateway.id),
    /**
     * An operator-supplied origin replacing the provider type's own base URL,
     * so one instance can point at Azure OpenAI, a self-hosted vLLM, or any
     * other endpoint speaking that provider's API. Null is the normal case.
     *
     * Validated and canonicalized by `src/core/origin-guard.ts` on every write
     * — never by a CHECK, which would be a rebuild of this table for a rule
     * SQLite could not express anyway. A gateway-routed row must not carry one
     * (the gateway owns the transport); that pairing is refused in the admin
     * routes and ignored at resolution time, for the same reason.
     */
    baseUrl: text("base_url"),
    /**
     * How this row is routed inside its gateway. Null on a direct row and on
     * every gateway whose adapter needs no routing configuration; the adapter
     * named by `provider_gateway.type` validates the shape — see
     * `RouteAdapter.validateRouteConfig`.
     */
    gatewayRoute: text("gateway_route_json", { mode: "json" }).$type<GatewayRouteConfig>(),
    pricing: text("pricing_json", { mode: "json" }).$type<ProviderPricing>(),
    revision: integer("revision").notNull().default(1),
    status: text("status").$type<ProviderStatus>().notNull().default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_providers_organization").on(table.organizationId),
    // Unconditional, disabled rows included: a slug is a URL segment an
    // organization owns until the row holding it is deleted, so pausing one
    // never lets another instance take its place.
    uniqueIndex("providers_slug_unique").on(table.organizationId, table.slug),
    check("providers_status_check", sql`${table.status} IN ('active', 'disabled')`),
    check(
      "providers_secret_source_check",
      sql`(${table.providerGatewayId} IS NULL) = (${table.secretBlob} IS NOT NULL)`,
    ),
  ],
);

export const appApiKey = sqliteTable(
  "app_api_key",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    status: text("status").$type<ApiKeyStatus>().notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [
    index("idx_api_keys_app").on(table.appId),
    uniqueIndex("api_keys_key_hash_unique").on(table.keyHash),
    check("api_keys_status_check", sql`${table.status} IN ('active', 'revoked')`),
  ],
);

export const appUser = sqliteTable(
  "app_user",
  {
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    id: text("id").notNull(),
    status: text("status").$type<UserStatus>().notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    lastSeenAt: text("last_seen_at"),
    /**
     * When this user was *first* refused for a required claim that had not
     * propagated yet, and still is. Set once per window and never overwritten,
     * so the measured delay is the whole wait rather than the last retry's;
     * cleared by the exchange that finally succeeds, which is also what makes
     * `IS NOT NULL` the list of users stuck mid-activation right now.
     */
    claimPendingSince: text("claim_pending_since"),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.id] }),
    check("users_status_check", sql`${table.status} IN ('active', 'blocked')`),
  ],
);

/**
 * One registered App Attest key: one install of an iOS application.
 *
 * A user may hold several — one per device they signed in on, and a new one
 * each time the app is reinstalled — so registering a key never replaces
 * another. Under `app_install` the key is the identity, and `user_id` is the
 * key id itself.
 *
 * The assertion counter is not here. It is per-request state, kept by the
 * install's limiter Durable Object (`src/do/UserLimiter.ts`), which is the one
 * place every request of the install already passes through.
 */
export const appAttestKey = sqliteTable(
  "app_attest_key",
  {
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    /** Apple's key id: the base64 SHA-256 of the public key. */
    keyId: text("key_id").notNull(),
    /** SPKI PEM. */
    publicKey: text("public_key").notNull(),
    /**
     * Which App Attest environment attested the key, so that removing an
     * application's development opt-in also stops the keys it admitted.
     */
    environment: text("environment").$type<AttestEnvironment>().notNull(),
    /** The `(app_id, id)` user this key authenticates for. */
    userId: text("user_id"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    /** Updated by the token exchange, not by every request. */
    lastSeenAt: text("last_seen_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.keyId] }),
    index("idx_attest_keys_app_user").on(table.appId, table.userId),
  ],
);

export const appUsageEvent = sqliteTable(
  "app_usage_event",
  {
    /**
     * The rowid, which is also the keyset cursor the events list pages on.
     *
     * Deliberately not `AUTOINCREMENT`: that keeps a `sqlite_sequence` row in
     * step with every insert, and D1 bills that extra write on every single
     * proxied request.
     *
     * What is given up is that ids are reused once the row holding the highest
     * one is gone — emptying the table restarts at 1. What is kept is the only
     * property the cursor needs: a new id is always greater than every id still
     * live, so paging backwards through `id` never revisits or skips a row that
     * exists. A purge that removes the maximum (deleting an app's history, or
     * retention catching up with an idle deployment) can hand an old id out
     * again, which is harmless — rows are identified by `event_id`, and a
     * cursor held across such a purge belongs to a page that no longer exists
     * either way.
     */
    id: integer("id").primaryKey(),
    /**
     * Recording identity, generated once per event and reused by every retry so
     * the insert can be replayed without duplicating the row.
     */
    eventId: text("event_id").notNull(),
    appId: text("app_id").notNull(),
    /** Durable ownership: the account the request was served for, which outlives the app. */
    organizationId: text("organization_id").notNull(),
    /**
     * Null for an application that identifies no end users, where the request
     * was made by the API key itself and there is nobody else to name. The
     * `api_key_id` beside it still says which credential served the traffic, so
     * a userless row keeps its attribution rather than losing it.
     */
    userId: text("user_id"),
    apiKeyId: text("api_key_id"),
    providerType: text("provider_type").notNull(),
    /**
     * The provider row that served the traffic. Deliberately not a foreign key:
     * deleting a provider is a hard delete, and usage history must survive it
     * with its attribution intact. Null if the provider row was removed before this event.
     */
    providerId: text("provider_id"),
    /** Provider instance slug at request time; survives row deletion or reuse. */
    providerSlug: text("provider_slug"),
    /**
     * The gateway row the request was routed through, or null for a direct
     * call. Not a foreign key, for the same reason `provider_id` is not: a
     * gateway can be deleted, and the history must keep its attribution.
     */
    providerGatewayId: text("provider_gateway_id"),
    /** That gateway's type at request time, so history survives a rename. */
    providerGatewayType: text("provider_gateway_type").$type<GatewayType>(),
    model: text("model").notNull(),
    route: text("route").notNull(),
    endpointSlug: text("endpoint_slug"),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /**
     * What the response said the prompt and the answer were made of, as JSON
     * `{ input?: { image?, audio?, video?, unknown? }, output?: { … } }`, kept
     * so a model that prices a modality apart reprices exactly. `{}` where the
     * response broke neither side down; null only on rows recorded before the
     * column existed.
     */
    modalityTokens: text("modality_tokens", { mode: "json" }).$type<ModalityTokens>(),
    /**
     * The parts of a token bucket the response split out to bill at a rate of
     * their own, as JSON `{ cache_write?: { "1h"?: n } }` — see `TOKEN_VARIANTS`
     * in `src/shared/token-rates.ts`. Every such split shares this one column,
     * so a new one never adds another. `{}` where the response split nothing;
     * null only on rows recorded before the column existed.
     */
    tokenVariants: text("token_variants", { mode: "json" }).$type<TokenVariants>(),
    costUsd: real("cost_usd").notNull().default(0),
    /**
     * How `cost_usd` was arrived at, for events that reached a provider. Deliberately unconstrained text: the value set grows as new cost sources land, and a
     * CHECK on this table would make each addition a full rebuild.
     */
    costSource: text("cost_source").$type<CostSource>(),
    /**
     * What the upstream said the request cost, where the route reports one. It
     * is recorded next to `cost_usd` rather than instead of it, so a reported
     * figure and the locally computed one can always be compared.
     */
    reportedCostUsd: real("reported_cost_usd"),
    /** Serving provider the upstream named, when it names one. Never inferred. */
    servedProvider: text("served_provider"),
    /** Serving model the upstream named, canonicalized by the owning adapter. */
    servedModel: text("served_model"),
    /**
     * Whose key paid, where the configuration settles it. Unconstrained text
     * for the same reason `cost_source` is: new values must not rebuild a
     * populated table.
     */
    credentialSource: text("credential_source").$type<CredentialSource>(),
    /**
     * Who made the model, resolved when the event is recorded. An analytics
     * dimension only — never a budget or an allowlist — and re-derivable, the
     * way the reprice endpoint rewrites `cost_usd`.
     */
    modelAuthor: text("model_author"),
    appVersion: text("app_version"),
    authMethod: text("auth_method").$type<AuthMethod>(),
    status: text("status").$type<UsageStatus>().notNull(),
    /**
     * `1` when the client disconnected before the upstream finished streaming,
     * which cancels the provider call; null otherwise. Not a status: the
     * request was served as far as the caller wanted it. It is recorded because
     * an aborted stream often takes the provider's end-of-response usage with
     * it, so a run of `unresolved` costs is explained by this column.
     */
    clientAborted: integer("client_aborted"),
    latencyMs: integer("latency_ms"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    /**
     * The App Attest key id of the install that made the request, on every
     * request an App Attest application served; null for server applications,
     * which have no install.
     */
    installId: text("install_id"),
  },
  (table) => [
    index("idx_usage_event_account_created").on(table.organizationId, table.createdAt),
    index("idx_usage_user_month").on(table.appId, table.userId, table.createdAt),
    index("idx_usage_install_month").on(table.appId, table.installId, table.createdAt),
    index("idx_usage_app_month").on(table.appId, table.createdAt),
    uniqueIndex("usage_events_event_id_unique").on(table.eventId),
    check(
      "usage_events_status_check",
      sql`${table.status} IN ('ok', 'provider_error')`,
    ),
  ],
);

export type AppUsageSpendScope = "app" | "user" | "install";

/**
 * Canonical monthly spend derived atomically from `app_usage_event` by the D1
 * triggers installed with this table: an insert adds the event's cost, a
 * reprice applies its delta, both in the same write as the event. The request
 * gate reads one row by its unique key and caches it briefly — see
 * `src/usage/app-usage-accounting.ts`.
 *
 * `user_key` is deliberately non-null. App rows use the empty string, while a
 * user row may also name a real empty user id; `scope` keeps those identities
 * distinct in the unique key. An `install` row's key is the App Attest key id;
 * every event of an App Attest application writes both its `user` and its
 * `install` row, so either can become the budget's scope with its history.
 */
export const appUsageSpend = sqliteTable(
  "app_usage_spend",
  {
    id: integer("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    appId: text("app_id").notNull(),
    scope: text("scope").$type<AppUsageSpendScope>().notNull(),
    userKey: text("user_key").notNull(),
    /** UTC calendar month as `YYYY-MM`, fixed from the event timestamp. */
    month: text("month").notNull(),
    microusd: integer("microusd").notNull(),
  },
  (table) => [
    uniqueIndex("app_usage_spend_scope_month_unique").on(
      table.scope,
      table.appId,
      table.userKey,
      table.month,
    ),
    index("idx_app_usage_spend_organization").on(table.organizationId),
    check("app_usage_spend_scope_check", sql`${table.scope} IN ('app', 'user', 'install')`),
    check(
      "app_usage_spend_month_check",
      sql`${table.month} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(${table.month}, 6, 2) BETWEEN '01' AND '12'`,
    ),
    check("app_usage_spend_microusd_check", sql`${table.microusd} >= 0`),
  ],
);

/** How wide a bucket one rollup row covers. */
export type UsageRollupGrain = "day" | "month";

/**
 * Usage history older than {@link USAGE_EVENT_RETENTION_DAYS}, summed to a
 * grain whose row count is bounded by an application's configuration rather
 * than by its traffic.
 *
 * Raw events cost about 547 bytes each once their three indexes are counted, so
 * a deployment serving a million requests a month grows half a gigabyte a month
 * and reaches D1's hard ten gigabyte per-database ceiling in roughly eighteen
 * months. That ceiling is an outage, not a bill. Summing instead of deleting
 * keeps the answer to "what did this app spend, on which model, through which
 * provider" available forever, for about a thousandth of the bytes: measured on
 * three million events, this grain holds them in 3,225 rows.
 *
 * What is deliberately given up is every per-event and per-user dimension.
 * `user_id`, `route`, `endpoint_slug`, `app_version`, `credential_source`,
 * `cost_source`, `latency_ms` and the event list itself exist only for the
 * retention window; past it there is no row that could answer for one user, and
 * that is the trade that makes the row count stop tracking traffic. Every
 * dimension kept here is NOT NULL so that the upsert key below can never see a
 * NULL, which SQLite treats as distinct from every other NULL and which would
 * quietly accumulate a duplicate row per compaction run instead of summing.
 */
export const appUsageRollup = sqliteTable(
  "app_usage_rollup",
  {
    id: integer("id").primaryKey(),
    grain: text("grain").$type<UsageRollupGrain>().notNull(),
    /** `YYYY-MM-DD` at day grain, `YYYY-MM` at month grain. Compares lexically. */
    bucket: text("bucket").notNull(),
    appId: text("app_id").notNull(),
    /** Durable ownership, carried over from the events the bucket folds. */
    organizationId: text("organization_id").notNull(),
    model: text("model").notNull(),
    providerType: text("provider_type").notNull(),
    status: text("status").$type<UsageStatus>().notNull(),
    requests: integer("requests").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costUsd: real("cost_usd").notNull(),
  },
  (table) => [
    /**
     * The conflict target compaction upserts against, so a chunk that straddles
     * a bucket boundary adds to the bucket instead of duplicating it. Chunks are
     * id ranges and buckets are calendar days, so straddling is the normal case
     * rather than the exception.
     */
    uniqueIndex("usage_rollup_key").on(
      table.organizationId,
      table.grain,
      table.bucket,
      table.appId,
      table.model,
      table.providerType,
      table.status,
    ),
    /** Serves the admin reads, which are always scoped to one app and a range. */
    index("idx_usage_rollup_account_bucket").on(table.organizationId, table.grain, table.bucket),
    index("idx_usage_rollup_app_bucket").on(table.appId, table.grain, table.bucket),
  ],
);

/** One sampled refusal before any provider attempt; diagnostics expire without rollups. */
export const appRejectionEvent = sqliteTable(
  "app_rejection_event",
  {
    id: integer("id").primaryKey(),
    eventId: text("event_id").notNull(),
    appId: text("app_id").notNull(),
    userId: text("user_id"),
    apiKeyId: text("api_key_id"),
    reason: text("reason").$type<RejectionReason>().notNull(),
    scope: text("scope").$type<RejectionScope>(),
    providerSlug: text("provider_slug"),
    model: text("model"),
    route: text("route"),
    endpointSlug: text("endpoint_slug"),
    appVersion: text("app_version"),
    authMethod: text("auth_method").$type<AuthMethod>(),
    latencyMs: integer("latency_ms"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    /** The install that was refused, on App Attest applications; null for server applications. */
    installId: text("install_id"),
  },
  (table) => [
    uniqueIndex("rejection_events_event_id_unique").on(table.eventId),
    index("idx_rejection_events_app_created").on(table.appId, table.createdAt),
    index("idx_rejection_events_app_user_created").on(table.appId, table.userId, table.createdAt),
    index("idx_rejection_events_created").on(table.createdAt),
    check("rejection_events_reason_check", sql`${table.reason} IN ('blocked_app_rate', 'blocked_app_budget', 'blocked_billing', 'blocked_user', 'blocked_replay')`),
    check("rejection_events_scope_check", sql`${table.scope} IS NULL OR ${table.scope} IN ('user', 'install', 'app', 'account')`),
  ],
);

/** What a `/auth/token` or `/auth/register` attempt was, and how it ended. */
export type AuthEventName = "token_exchange" | "register";

/**
 * One row per authentication attempt, successful or not.
 *
 * A sibling of `app_usage_event` rather than part of it: that table is a
 * financial fact table whose `model`, `route`, `provider_type` and `user_id` are
 * NOT NULL and none of which an auth attempt has, and whose rows are billing
 * history summed into `app_usage_rollup` rather than simply dropped. These rows
 * are diagnostics, and are pruned at 90 days with nothing kept. The conventions are copied deliberately, though — the idempotent
 * nullable-unique `event_id`, the two `(app_id, …, created_at)` indexes, and
 * unconstrained text wherever the value set is expected to grow.
 */
export const appAuthEvent = sqliteTable(
  "app_auth_event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Recording identity, so a retried insert converges instead of duplicating. */
    eventId: text("event_id").notNull(),
    /**
     * No foreign key, but for a different reason than usage's. Usage outlives
     * the app it belongs to because it is billing history; this table is
     * diagnostic and is deleted along with the app. What it cannot tolerate is
     * a constraint: rows are written from `waitUntil` after the response has
     * gone, so an app deleted in that window would turn a diagnostic write into
     * a foreign-key failure. It is emptied explicitly instead.
     */
    appId: text("app_id").notNull(),
    /**
     * Nullable, unlike usage's: most failures happen before any identity is
     * established, and inventing one would attribute an attack to a user.
     */
    userId: text("user_id"),
    event: text("event").$type<AuthEventName>().notNull(),
    authMethod: text("auth_method").$type<AuthMethod>(),
    /**
     * `ok`, or the error code the client was handed. Unconstrained text: every
     * new error code would otherwise rebuild this table.
     */
    outcome: text("outcome").notNull(),
    /** The granular cause behind the outcome — see `IssuerRejectionReason`. */
    reason: text("reason"),
    appVersion: text("app_version"),
    latencyMs: integer("latency_ms"),
    /**
     * Set only on the exchange that ends a claim-propagation window: how long
     * the user waited from their first `issuer_claims_missing` rejection.
     */
    claimDelayMs: integer("claim_delay_ms"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_auth_events_app_created").on(table.appId, table.createdAt),
    index("idx_auth_events_app_user_created").on(table.appId, table.userId, table.createdAt),
    uniqueIndex("auth_events_event_id_unique").on(table.eventId),
  ],
);

export const appAuthChallenge = sqliteTable(
  "app_auth_challenge",
  {
    challenge: text("challenge").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [index("idx_auth_challenges_expiry").on(table.expiresAt)],
);
