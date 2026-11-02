import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** Idempotent, so each test that needs an owning organization can ask for it. */
async function seedProviderOrganization(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_user(id, name, email, email_verified, created_at, updated_at)
       VALUES ('provider-owner', 'Owner', 'owner@providers.test', 1, 0, 0)`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at)
       VALUES ('org-providers', 'Providers', 'provider-owner', datetime('now'), datetime('now'))`,
    ),
  ]);
}

describe("initial database migration", () => {
  it("creates the complete current schema", async () => {
    const userColumns = await env.DB.prepare("PRAGMA table_info(app_user)").all<{ name: string }>();
    const usageColumns = await env.DB.prepare("PRAGMA table_info(app_usage_event)").all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    const rejectionColumns = await env.DB.prepare("PRAGMA table_info(app_rejection_event)")
      .all<{ name: string; notnull: number; dflt_value: string | null }>();
    const appColumns = await env.DB.prepare("PRAGMA table_info(app)").all<{
      name: string;
      notnull: number;
    }>();
    const spendColumns = await env.DB.prepare("PRAGMA table_info(app_usage_spend)")
      .all<{ name: string; notnull: number }>();
    const apiKeyColumns = await env.DB.prepare("PRAGMA table_info(app_api_key)").all<{ name: string }>();
    const apiKeyIndexes = await env.DB.prepare("PRAGMA index_list(app_api_key)").all<{
      name: string;
      unique: number;
    }>();
    const managementKeyColumns = await env.DB.prepare("PRAGMA table_info(mgmt_api_key)")
      .all<{ name: string; notnull: number; dflt_value: string | null }>();

    expect(usageColumns.results.map((column) => column.name)).toContain("auth_method");
    expect(usageColumns.results.map((column) => column.name)).toContain("api_key_id");
    expect(usageColumns.results.map((column) => column.name)).toContain("provider_type");
    expect(usageColumns.results.map((column) => column.name)).toContain("provider_id");
    expect(usageColumns.results.map((column) => column.name)).toContain("provider_slug");
    expect(usageColumns.results.map((column) => column.name)).toContain("event_id");
    expect(rejectionColumns.results.map((column) => column.name)).toEqual([
      "id", "event_id", "app_id", "user_id", "api_key_id", "reason", "scope",
      "provider_slug", "model", "route", "endpoint_slug", "app_version",
      "auth_method", "latency_ms", "created_at", "install_id",
    ]);
    expect(rejectionColumns.results.find((column) => column.name === "created_at"))
      .toMatchObject({ notnull: 1, dflt_value: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" });
    // Provider attempts can lack optional attribution or pricing details.
    expect(usageColumns.results.find((column) => column.name === "cost_source")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    for (const name of [
      "provider_gateway_id",
      "provider_gateway_type",
      "reported_cost_usd",
      "served_provider",
      "served_model",
      "credential_source",
      "model_author",
    ]) {
      expect({ name, column: usageColumns.results.find((column) => column.name === name) })
        .toEqual({ name, column: expect.objectContaining({ notnull: 0, dflt_value: null }) });
    }
    // `provider_type` and `provider_slug` carry this; a bare `provider` would be
    // ambiguous between the two.
    expect(usageColumns.results.map((column) => column.name)).not.toContain("provider");
    expect(usageColumns.results.find((column) => column.name === "cost_usd")).toMatchObject({
      notnull: 1,
      dflt_value: "0",
    });
    expect(appColumns.results.map((column) => column.name)).toEqual([
      "id",
      "organization_id",
      "name",
      "config_json",
      // What kind of application this is, lifted out of the JSON so the queries
      // that only need that never parse a configuration.
      "auth_type",
      "revision",
      "status",
      "created_at",
      "updated_at",
    ]);
    expect(appColumns.results.find((column) => column.name === "auth_type"))
      .toMatchObject({ notnull: 1, dflt_value: null });
    expect(appColumns.results.find((column) => column.name === "organization_id")?.notnull).toBe(1);
    expect(spendColumns.results.map((column) => column.name)).toEqual([
      "id",
      "organization_id",
      "app_id",
      "scope",
      "user_key",
      "month",
      "microusd",
    ]);
    // Every event names its account, so every total it feeds does too.
    expect(spendColumns.results.find((column) => column.name === "organization_id")?.notnull).toBe(1);
    for (const name of ["event_id", "organization_id"]) {
      expect(usageColumns.results.find((column) => column.name === name))
        .toMatchObject({ notnull: 1, dflt_value: null });
    }
    const spendTriggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'app_usage_event_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(spendTriggers.results.map((row) => row.name)).toEqual([
      "app_usage_event_owner_guard_before_insert",
      "app_usage_event_spend_after_cost_update",
      "app_usage_event_spend_after_insert",
    ]);
    const appTables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name = 'app' OR name LIKE 'app_%') ORDER BY name",
    ).all<{ name: string }>();
    expect(appTables.results.map((row) => row.name)).toEqual([
      "app",
      "app_api_key",
      "app_attest_key",
      "app_auth_challenge",
      "app_auth_event",
      "app_rejection_event",
      "app_usage_day",
      "app_usage_day_window",
      "app_usage_event",
      "app_usage_rollup",
      "app_usage_spend",
      "app_user",
    ]);
    const dayTriggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'app_usage_day_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(dayTriggers.results.map((row) => row.name)).toEqual([
      "app_usage_day_after_delete",
      "app_usage_day_after_insert",
      "app_usage_day_after_update",
    ]);
    // A database this small is sealed by the migration itself, up to today,
    // rather than left for the nightly run to catch up.
    const sealed = await env.DB.prepare(
      `SELECT sealed_from = date('now', '-90 days') AS from_cutoff, sealed_until = date('now') AS until_today
       FROM app_usage_day_window`,
    ).first();
    expect(sealed).toEqual({ from_cutoff: 1, until_today: 1 });
    // The auth event log mirrors usage's conventions, with the two differences
    // that made it a sibling table rather than more columns on that one: a
    // nullable user (most refusals establish no identity) and its own retention.
    const authEventColumns = await env.DB.prepare("PRAGMA table_info(app_auth_event)").all<{
      name: string;
      notnull: number;
    }>();
    expect(authEventColumns.results.map((column) => column.name)).toEqual([
      "id",
      "event_id",
      "app_id",
      "user_id",
      "event",
      "auth_method",
      "outcome",
      "reason",
      "app_version",
      "latency_ms",
      "claim_delay_ms",
      "created_at",
    ]);
    expect(authEventColumns.results.find((column) => column.name === "user_id")?.notnull).toBe(0);
    expect(authEventColumns.results.find((column) => column.name === "outcome")?.notnull).toBe(1);
    // Keys moved to app_attest_key, and the counter out of D1 altogether.
    expect(userColumns.results.map((column) => column.name)).toEqual([
      "app_id", "id", "status", "created_at", "last_seen_at", "claim_pending_since",
    ]);
    const attestKeyColumns = await env.DB.prepare("PRAGMA table_info(app_attest_key)")
      .all<{ name: string; notnull: number; pk: number }>();
    expect(attestKeyColumns.results.map((column) => column.name)).toEqual([
      "app_id", "key_id", "public_key", "environment", "user_id", "created_at", "last_seen_at",
    ]);
    expect(attestKeyColumns.results.filter((column) => column.pk > 0).map((column) => column.name))
      .toEqual(["app_id", "key_id"]);
    expect(attestKeyColumns.results.find((column) => column.name === "user_id")?.notnull).toBe(0);
    const attestKeyIndexes = await env.DB.prepare("PRAGMA index_list(app_attest_key)")
      .all<{ name: string }>();
    expect(attestKeyIndexes.results.map((index) => index.name)).toContain("idx_attest_keys_app_user");
    expect(usageColumns.results.find((column) => column.name === "install_id"))
      .toMatchObject({ notnull: 0, dflt_value: null });
    const usageIndexes = await env.DB.prepare("PRAGMA index_list(app_usage_event)").all<{ name: string }>();
    expect(usageIndexes.results.map((index) => index.name)).toContain("idx_usage_install_month");
    // Nullable: most identities never enter the pending-claim state at all.
    expect(userColumns.results.find((column) => column.name === "claim_pending_since")).toMatchObject({
      notnull: 0,
    });
    const providerColumns = await env.DB.prepare("PRAGMA table_info(provider)").all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    // Provider rows include the revision used for optimistic updates.
    expect(providerColumns.results.map((column) => column.name)).toEqual([
      "id",
      "organization_id",
      "type",
      "slug",
      "name",
      "secret_blob",
      "secret_hint",
      "provider_gateway_id",
      "base_url",
      "gateway_route_json",
      "pricing_json",
      "revision",
      "status",
      "created_by",
      "created_at",
      "updated_at",
    ]);
    expect(providerColumns.results.find((column) => column.name === "gateway_route_json"))
      .toMatchObject({ notnull: 0 });
    expect(providerColumns.results.find((column) => column.name === "base_url"))
      .toMatchObject({ notnull: 0, dflt_value: null });
    expect(providerColumns.results.find((column) => column.name === "revision"))
      .toMatchObject({ notnull: 1, dflt_value: "1" });
    const gatewayColumns = await env.DB.prepare("PRAGMA table_info(provider_gateway)")
      .all<{ name: string; notnull: number; dflt_value: string | null }>();
    expect(gatewayColumns.results.map((column) => column.name)).toEqual([
      "id",
      "organization_id",
      "type",
      "name",
      "config_json",
      "secret_blob",
      "secret_hint",
      "revision",
      "status",
      "created_by",
      "created_at",
      "updated_at",
    ]);
    expect(gatewayColumns.results.find((column) => column.name === "revision"))
      .toMatchObject({ notnull: 1, dflt_value: "1" });
    const mgmtTables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mgmt_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(mgmtTables.results.map((row) => row.name)).toEqual([
      "mgmt_api_key",
      "mgmt_oauth_token",
      "mgmt_operation",
      "mgmt_organization",
      "mgmt_organization_invitation",
      "mgmt_organization_user",
      "mgmt_user",
      "mgmt_user_account",
      "mgmt_user_session",
      "mgmt_verification",
    ]);
    const membershipColumns = await env.DB.prepare(
      "PRAGMA table_info(mgmt_organization_user)",
    ).all<{ name: string; notnull: number }>();
    // When the member last used the account; written by cf-auth's middleware.
    expect(membershipColumns.results.find((column) => column.name === "last_active_at"))
      .toMatchObject({ notnull: 0 });
    const organizationColumns = await env.DB.prepare(
      "PRAGMA table_info(mgmt_organization)",
    ).all<{ name: string }>();
    expect(organizationColumns.results.map((column) => column.name)).toEqual([
      "id",
      "name",
      "expires_at",
      "created_by_user_id",
      "created_at",
      "updated_at",
    ]);
    const verificationColumns = await env.DB.prepare(
      "PRAGMA table_info(mgmt_verification)",
    ).all<{ name: string }>();
    expect(verificationColumns.results.map((column) => column.name)).toEqual([
      "id",
      "identifier",
      "value",
      "expires_at",
      "created_at",
      "updated_at",
    ]);
    expect(managementKeyColumns.results.map((column) => column.name)).toEqual([
      "id",
      "user_id",
      "organization_id",
      "name",
      "token_hash",
      "token_hint",
      "enabled",
      "expires_at",
      "created_at",
      "revoked_at",
      "source",
      "label",
      "grant",
      "client_id",
      "resource",
      "credential_type",
    ]);
    // A key from before grants existed keeps doing what it did.
    expect(managementKeyColumns.results.find((column) => column.name === "grant"))
      .toMatchObject({ notnull: 1, dflt_value: "'manage'" });
    // What a row authenticates as, whatever its display-only `source` says: a
    // key from before connections existed stays a management key.
    expect(managementKeyColumns.results.find((column) => column.name === "credential_type"))
      .toMatchObject({ notnull: 1, dflt_value: "'apiKey'" });
    // An OAuth connection is a key row of its own; every other key has neither.
    for (const column of ["client_id", "resource"])
      expect(managementKeyColumns.results.find(({ name }) => name === column)).toMatchObject({ notnull: 0 });
    // A connection's token generations, cf-auth's, removed with the connection.
    const oauthTokenColumns = await env.DB.prepare("PRAGMA table_info(mgmt_oauth_token)")
      .all<{ name: string; notnull: number }>();
    expect(oauthTokenColumns.results.map((column) => column.name)).toEqual([
      "id",
      "api_key_id",
      "generation",
      "access_token_hash",
      "access_expires_at",
      "refresh_token_hash",
      "rotated_at",
      "sealed_response",
      "created_at",
    ]);
    const oauthTokenIndexes = await env.DB.prepare("PRAGMA index_list(mgmt_oauth_token)")
      .all<{ name: string; unique: number }>();
    expect(oauthTokenIndexes.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "mgmt_oauth_token_access_token_hash_unique", unique: 1 }),
      expect.objectContaining({ name: "mgmt_oauth_token_refresh_token_hash_unique", unique: 1 }),
      expect.objectContaining({ name: "mgmt_oauth_token_api_key_id_generation_unique", unique: 1 }),
    ]));
    const oauthTokenKeys = await env.DB.prepare("PRAGMA foreign_key_list(mgmt_oauth_token)")
      .all<{ table: string; from: string; on_delete: string }>();
    expect(oauthTokenKeys.results).toEqual([
      expect.objectContaining({ table: "mgmt_api_key", from: "api_key_id", on_delete: "CASCADE" }),
    ]);
    // Every CLI operation is one row of cf-auth's operation table: the digest
    // of the CLI's token is how it is found, and the engine's own fields are
    // columns, never fields mixed into the payload the CLI sent.
    const operationColumns = await env.DB.prepare("PRAGMA table_info(mgmt_operation)")
      .all<{ name: string; notnull: number }>();
    expect(operationColumns.results.map((column) => column.name)).toEqual(expect.arrayContaining([
      "kind",
      "state",
      "payload",
      "request_hash",
      "poll_token_hash",
      "browser_proof_hash",
      "user_code_hash",
      "outcome",
      "sealed_outcome",
      "sealed_until",
      "retain_until",
      "execution_claim",
    ]));
    for (const column of ["request_hash", "poll_token_hash", "retain_until"])
      expect(operationColumns.results.find(({ name }) => name === column)).toMatchObject({ notnull: 1 });
    // What holds a reservation while one call executes it: nothing until then,
    // so every operation from before reservations existed holds none.
    expect(operationColumns.results.find(({ name }) => name === "execution_claim")).toMatchObject({ notnull: 0 });
    expect(apiKeyColumns.results.map((column) => column.name)).toEqual([
      "id",
      "app_id",
      "name",
      "key_hash",
      "key_prefix",
      "status",
      "created_at",
      "last_used_at",
    ]);
    expect(apiKeyIndexes.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_api_keys_app" }),
      expect.objectContaining({ name: "api_keys_key_hash_unique", unique: 1 }),
    ]));
  });

  it("rejects usage events without a cost", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO app_usage_event(event_id, organization_id, app_id, user_id, provider_type, model, route, cost_usd, status)
         VALUES (lower(hex(randomblob(16))), 'operator-test-organization', 'migration-cost', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', NULL, 'ok')`,
      ).run(),
    ).rejects.toThrow(/NOT NULL constraint failed: app_usage_event.cost_usd/u);
  });

  it("requires every usage event to carry its own id", async () => {
    const insert = (eventId: string | null) =>
      env.DB.prepare(
        `INSERT INTO app_usage_event(organization_id, event_id, app_id, user_id, provider_type, model, route, cost_usd, status)
         VALUES ('operator-test-organization', ?, 'migration-event-id', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', 0, 'ok')`,
      ).bind(eventId).run();

    await expect(insert(null)).rejects.toThrow(/NOT NULL constraint failed: app_usage_event.event_id/u);
    await insert("migration-event-1");
    await expect(insert("migration-event-1")).rejects.toThrow(/UNIQUE constraint failed/u);
  });

  it("keeps refusal diagnostics separate from provider accounting", async () => {
    await expect(env.DB.prepare(
      `INSERT INTO app_usage_event(event_id, organization_id, app_id, provider_type, model, route, status)
       VALUES (?, 'operator-test-organization', 'migration-invalid-status', 'openai', 'test', 'test', 'blocked_user')`,
    ).bind(crypto.randomUUID()).run()).rejects.toThrow(/CHECK constraint failed/u);

    const insert = (eventId: string, reason: string, scope: string | null) =>
      env.DB.prepare(
        `INSERT INTO app_rejection_event(event_id, app_id, reason, scope)
         VALUES (?, 'migration-rejection', ?, ?)`,
      ).bind(eventId, reason, scope).run();
    await insert("migration-rejection-1", "blocked_user", "user");
    await expect(insert("migration-rejection-1", "blocked_user", "user"))
      .rejects.toThrow(/UNIQUE constraint failed/u);
    await expect(insert("migration-rejection-2", "provider_error", null))
      .rejects.toThrow(/CHECK constraint failed/u);
    await expect(insert("migration-rejection-3", "blocked_user", "other"))
      .rejects.toThrow(/CHECK constraint failed/u);
    // A replayed App Attest counter is refused per install.
    await insert("migration-rejection-4", "blocked_replay", "install");
  });

  /**
   * Every App Attest application that exists when migration 0006 lands has
   * builds on the 1.x Swift package in its users' hands, which sign no
   * request, so it is set to verify App Attest on the token exchange. The
   * statement is run here again, exactly as the migration holds it, over rows
   * that predate it.
   */
  it("sets existing App Attest apps to verify on the token exchange, and leaves server apps alone", async () => {
    await seedProviderOrganization();
    const flip = env.TEST_MIGRATIONS
      .find((migration) => migration.name.startsWith("0006_"))!
      .queries.find((query) => query.includes("'$.authentication.app_attest.verify_on', 'token_exchange'"));
    expect(flip).toBeDefined();
    const ios = (verifyOn?: string) => JSON.stringify({
      authentication: {
        type: "apple_app_attest",
        app_attest: {
          team_id: "AAAAAAAAAA",
          bundle_id: "com.example.flip",
          environments: ["production"],
          ...(verifyOn === undefined ? {} : { verify_on: verifyOn }),
        },
        end_user: { source: "app_install" },
      },
    });
    const server = JSON.stringify({ authentication: { type: "api_key", end_user: { source: "none" } } });
    const insert = (id: string, type: string, config: string) => env.DB.prepare(
      `INSERT INTO app(id, organization_id, name, config_json, auth_type)
       VALUES (?, 'org-providers', ?, ?, ?)`,
    ).bind(id, id, config, type);
    await env.DB.batch([
      insert("flip-ios", "apple_app_attest", ios()),
      insert("flip-ios-set", "apple_app_attest", ios("every_request")),
      insert("flip-server", "api_key", server),
    ]);
    await env.DB.prepare(flip!).run();

    const configOf = async (id: string) => JSON.parse((await env.DB.prepare("SELECT config_json FROM app WHERE id = ?")
      .bind(id).first<{ config_json: string }>())!.config_json) as {
      authentication: { app_attest?: Record<string, unknown> };
    };
    // Only the field is added: the rest of the stored document is untouched.
    expect((await configOf("flip-ios")).authentication.app_attest).toEqual({
      team_id: "AAAAAAAAAA",
      bundle_id: "com.example.flip",
      environments: ["production"],
      verify_on: "token_exchange",
    });
    // A value already written is kept, and a server app has nothing to verify.
    expect((await configOf("flip-ios-set")).authentication.app_attest?.verify_on).toBe("every_request");
    expect(await configOf("flip-server")).toEqual(JSON.parse(server));
    // Minimal rows no reader could parse: gone before anything else meets them.
    await env.DB.prepare("DELETE FROM app WHERE id IN ('flip-ios', 'flip-ios-set', 'flip-server')").run();
  });

  it("keeps an install's spend beside its user's, and changes both on a reprice", async () => {
    await seedProviderOrganization();
    const appId = "migration-install-spend";
    await env.DB.prepare(
      `INSERT INTO app_usage_event(event_id, organization_id, app_id, user_id, install_id, provider_type, model, route, cost_usd, status, created_at)
       VALUES ('migration-install-spend-1', 'org-providers', ?, 'user-1', 'key-1', 'openai', 'm', 'r', 0.25, 'ok', '2026-03-04 05:06:07')`,
    ).bind(appId).run();
    await env.DB.prepare("UPDATE app_usage_event SET cost_usd = 1 WHERE event_id = 'migration-install-spend-1'").run();
    const rows = await env.DB.prepare(
      "SELECT scope, user_key, month, microusd FROM app_usage_spend WHERE app_id = ? ORDER BY scope",
    ).bind(appId).all();
    expect(rows.results).toEqual([
      { scope: "app", user_key: "", month: "2026-03", microusd: 1_000_000 },
      { scope: "install", user_key: "key-1", month: "2026-03", microusd: 1_000_000 },
      { scope: "user", user_key: "user-1", month: "2026-03", microusd: 1_000_000 },
    ]);
    await expect(env.DB.prepare(
      `INSERT INTO app_usage_spend(organization_id, app_id, scope, user_key, month, microusd)
       VALUES ('org-providers', ?, 'device', 'x', '2026-03', 1)`,
    ).bind(appId).run()).rejects.toThrow(/CHECK constraint failed/u);
  });

  it("allows one provider row per organization and slug, whatever its status", async () => {
    await seedProviderOrganization();
    const insert = (id: string, slug: string, status: string) =>
      env.DB.prepare(
        `INSERT INTO provider(id, organization_id, type, slug, name, secret_blob, secret_hint, status, created_by)
         VALUES (?, 'org-providers', 'openai', ?, 'Prod OpenAI', 'local1.1.iv.ct', 'abcd', ?, 'provider-owner')`,
      ).bind(id, slug, status).run();

    await insert("provider-1", "openai", "active");
    await expect(insert("provider-2", "openai", "active")).rejects.toThrow(/UNIQUE constraint failed/u);
    await expect(insert("provider-2", "openai-dev", "active")).resolves.toBeDefined();
    // A disabled row occupies the slot too — the index is unconditional — which
    // is what keeps a paused instance's slug from being taken out from under it.
    await insert("provider-3", "openai-paused", "disabled");
    await expect(insert("provider-4", "openai-paused", "active"))
      .rejects.toThrow(/UNIQUE constraint failed/u);
    // `revoked` belongs to gateways, not providers: a provider row is paused
    // with `disabled` or deleted outright.
    await expect(insert("provider-4", "openai-old", "revoked"))
      .rejects.toThrow(/CHECK constraint failed/u);
    await expect(insert("provider-4", "sideways", "sideways")).rejects.toThrow(/CHECK constraint failed/u);
  });

  /**
   * The `type` columns carry whatever is stored. Constraining them was a table
   * rebuild per name added, and it was never the thing that decided anything:
   * the contracts refuse a type no descriptor backs on the way in, and
   * `isGatewayType` treats a gateway with no adapter as unroutable on the way
   * out. What the database still owes is the rest of the row — the slug index,
   * the status CHECK, and the credential-source pairing.
   */
  it("admits any provider type, leaving the decision to the registry", async () => {
    await seedProviderOrganization();
    const insert = (id: string, type: string) =>
      env.DB.prepare(
        `INSERT INTO provider(id, organization_id, type, slug, name, secret_blob, secret_hint, status, created_by)
         VALUES (?, 'org-providers', ?, ?, 'Planned', 'local1.1.iv.ct', 'abcd', 'active', 'provider-owner')`,
      ).bind(id, type, `slug-${type}`).run();

    for (const type of [
      "deepseek", "groq", "mistral", "together", "fireworks", "openrouter",
      "cerebras", "moonshot", "huggingface", "baseten", "bytedance",
      // Types with no descriptor at all: storable, and refused by the contracts
      // long before anything tries to serve one.
      "cohere", "litellm",
    ]) {
      await expect(insert(`planned-${type}`, type)).resolves.toBeDefined();
    }
    // The other constraints still bind.
    await expect(insert("planned-dup", "cohere")).rejects.toThrow(/UNIQUE constraint failed/u);
    await expect(
      env.DB.prepare(
        `INSERT INTO provider(id, organization_id, type, slug, name, secret_blob, secret_hint, status, created_by)
         VALUES ('planned-bad-status', 'org-providers', 'openai', 'slug-bad-status', 'Planned', 'local1.1.iv.ct', 'abcd', 'revoked', 'provider-owner')`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });

  it("admits any gateway type, and still refuses a row with no organization", async () => {
    await seedProviderOrganization();
    const insert = (id: string, type: string, organizationId = "org-providers") =>
      env.DB.prepare(
        `INSERT INTO provider_gateway(id, organization_id, type, name, config_json, secret_blob, secret_hint, created_by)
         VALUES (?, ?, ?, 'Planned gateway', '{}', 'local1.1.iv.ct', 'abcd', 'provider-owner')`,
      ).bind(id, organizationId, type).run();

    await expect(insert("planned-cf", "cf_aig")).resolves.toBeDefined();
    await expect(insert("planned-vercel", "vercel")).resolves.toBeDefined();
    // No adapter for this one; `requireGatewayAdapter` is what refuses it, and
    // a row carrying it reads as unroutable rather than as another gateway.
    await expect(insert("planned-litellm", "litellm")).resolves.toBeDefined();
    // The foreign key still binds.
    await expect(insert("planned-orphan", "cf_aig", "org-missing"))
      .rejects.toThrow(/FOREIGN KEY constraint failed/u);
  });
});
