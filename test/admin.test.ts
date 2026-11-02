import { env, exports } from "cloudflare:workers";
import { grantInsufficient, type AuthState, type CredentialGrant } from "@maxceem/cf-auth";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { asGatewayAuthError, isCfAuthError } from "../src/auth/identity";
import { accountLifecycleCache } from "../src/core/account-lifecycle";
import { GatewayError } from "../src/core/errors";
import type { AdminVariables } from "../src/middleware/admin";
import { resolveDeployment } from "../src/policy/deployment";
import { adminRouter } from "../src/routes/catalog-router";
import { monthlySpendMicrousd } from "../src/usage/app-usage-accounting";
import worker from "../src/index";
import { TEST_MANAGEMENT_KEY, TEST_ORGANIZATION_ID, TEST_SERVICE_USER_ID } from "./apply-migrations";
import { appleConfig, seedApp, seedHuman, seedProvider, seedServerApp, serverConfig } from "./helpers";
import { microusd, shippedRates } from "./shipped-rates";

/** What the seeded 50/40/10/20-token gpt-5.6-luna event costs at the shipped rates. */
function lunaEventCost(): number {
  const luna = shippedRates("openai", "gpt-5.6-luna");
  return (50 * luna.input + 40 * luna.cached_input + 10 * luna.cache_write + 20 * luna.output) / 1e6;
}

describe("admin API", () => {
  it("requires operator authentication and returns exact monthly usage rollups", async () => {
    await seedApp("admin-rollup");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_usage_event(
           event_id, organization_id, app_id, user_id, provider_type, model, route, input_tokens,
           cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status
         ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind("admin-rollup", "user-1", "openai", "known", "openai/v1/responses", 10, 2, 0, 3, 0.01, "ok"),
      env.DB.prepare(
        `INSERT INTO app_usage_event(
           event_id, organization_id, app_id, user_id, provider_type, model, route, input_tokens,
           cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status
         ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind("admin-rollup", "user-1", "openai", "known-2", "openai/v1/responses", 4, 0, 1, 2, 0.02, "ok"),
    ]);
    const month = new Date().toISOString().slice(0, 7);
    const url = `https://example.test/v1/admin/apps/admin-rollup/usage?month=${month}`;
    const denied = await exports.default.fetch(url);
    expect(denied.status).toBe(401);

    const response = await exports.default.fetch(url, {
      headers: { authorization: "Bearer agw_mgmt_test-admin-secret" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      app_id: "admin-rollup",
      month,
      requests: 2,
      input_tokens: 14,
      cached_input_tokens: 2,
      cache_write_tokens: 1,
      output_tokens: 5,
      cost_usd: 0.03,
    });

    // A month that does not exist is refused, not read as an empty one.
    for (const bad of ["2026-13", "2026-00", "2026-1"]) {
      const refused = await exports.default.fetch(
        `https://example.test/v1/admin/apps/admin-rollup/usage?month=${bad}`,
        { headers: { authorization: "Bearer agw_mgmt_test-admin-secret" } },
      );
      expect(refused.status).toBe(400);
      await expect(refused.json()).resolves.toMatchObject({
        error: { code: "invalid_request", message: "month must use YYYY-MM format" },
      });
    }
  });

  it("counts app spend recorded before app-wide limits are enabled", async () => {
    const appId = "admin-budget-flip";
    await seedApp(appId);
    await env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, cost_usd, status
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, ?, 'openai', 'gpt-5.6-sol', 'openai/v1/responses', ?, 'ok')`,
    ).bind(appId, "spender", 0.08).run();
    const month = new Date().toISOString().slice(0, 7);

    // Accounting is independent of configuration, so enabling a budget below
    // needs no historical SUM/backfill race.
    expect(await monthlySpendMicrousd(env.DB, { appId, scope: "app", key: null }, month)).toBe(80_000);

    const written = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          revision: 1,
          name: `Test ${appId}`,
          config: {
            ...appleConfig({ jwks_url: "https://issuer.test/.well-known/jwks.json" }),
            limits: {
              per_user: {
                requests: { per_minute: null, per_day: null },
                spending: { monthly_usd: null },
              },
              per_app: {
                requests: { per_minute: null, per_day: null },
                spending: { monthly_usd: 50 },
              },
            },
          },
        }),
      },
    );
    expect(written.status).toBe(200);

    // The month's spend is there to be measured against: $0.08 of a $50 budget
    // leaves room, while a budget of exactly what was spent is already closed.
    expect(await env.USER_LIMITER.getByName(appId).checkAndIncrement({
      now: Date.now(),
      rpm: null,
      rpd: null,
      monthlyBudgetMicrousd: 50_000_000,
      spend: { appId, scope: "app", key: null },
    })).toEqual({ allowed: true });
    expect(await env.USER_LIMITER.getByName(`${appId}-tight`).checkAndIncrement({
      now: Date.now(),
      rpm: null,
      rpd: null,
      monthlyBudgetMicrousd: 80_000,
      spend: { appId, scope: "app", key: null },
    })).toMatchObject({ allowed: false, reason: "budget" });
  });

  it("previews and applies usage repricing, which moves both spend totals", async () => {
    const appId = "admin-reprice";
    const userId = "user-1";
    await seedApp(appId, { appBudgetUsd: 100 });
    await env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      appId,
      userId,
      "openai",
      "gpt-5.6-luna",
      "openai/v1/responses",
      50,
      40,
      10,
      20,
      0.000184,
      "ok",
    ).run();
    // The app-wide total backs the app-wide budget, and is a second sum over
    // the same rows. Repricing has to correct it too, or that budget would run
    // on a total nothing can fix.
    const month = new Date().toISOString().slice(0, 7);
    const userTotal = () => monthlySpendMicrousd(env.DB, { appId, scope: "user", key: userId }, month);
    const appTotal = () => monthlySpendMicrousd(env.DB, { appId, scope: "app", key: null }, month);
    const url = `https://example.test/v1/admin/apps/${appId}/usage/reprice`;
    const request = (apply: boolean) => exports.default.fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer agw_mgmt_test-admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", month, apply }),
    });

    const preview = await request(false);
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      applied: false,
      matched_events: 1,
      previous_cost_usd: 0.000184,
      recalculated_cost_usd: expect.closeTo(lunaEventCost(), 12),
    });
    expect(await userTotal()).toBe(184);

    const applied = await request(true);
    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({
      applied: true,
      matched_events: 1,
      recalculated_cost_usd: expect.closeTo(lunaEventCost(), 12),
    });
    const row = await env.DB.prepare("SELECT cost_usd FROM app_usage_event WHERE app_id = ?")
      .bind(appId)
      .first<{ cost_usd: number }>();
    expect(row?.cost_usd).toBeCloseTo(lunaEventCost(), 12);
    expect(await userTotal()).toBe(microusd(lunaEventCost()));
    expect(await appTotal()).toBe(microusd(lunaEventCost()));
  });

  it("selects both timestamp formats through the last day of a leap-month reprice", async () => {
    const appId = "admin-reprice-leap-month";
    await seedApp(appId);
    const insert = env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status, created_at
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, 'user-1',
                 'openai', 'gpt-5.6-luna', 'openai/v1/responses', 50, 40, 10, 20,
                 0.000184, 'ok', ?)`,
    );
    for (const createdAt of [
      "2024-01-31T23:59:59.999Z",
      "2024-02-01 00:00:00",
      "2024-02-29 23:59:59",
      "2024-02-29T23:59:59.999Z",
      "2024-03-01 00:00:00",
    ]) {
      await insert.bind(appId, createdAt).run();
    }

    const response = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "openai", model: "gpt-5.6-luna", month: "2024-02", apply: false,
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ matched_events: number; previous_cost_usd: number }>();
    expect(body.matched_events).toBe(3);
    expect(body.previous_cost_usd).toBeCloseTo(3 * 0.000184, 10);
  });

  it("names the field at fault in a reprice request", async () => {
    const appId = "admin-reprice-bad-month";
    await seedApp(appId);
    const response = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", month: "not-a-month" }),
      },
    );
    expect(response.status).toBe(400);
    const body = await response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("invalid_request");
    // The month schema's own message names its field, so it is not prefixed again.
    expect(body.error.message).toBe("month must use YYYY-MM format");
  });

  it("rolls back every reprice chunk when a later chunk fails", async () => {
    const appId = "admin-reprice-atomic-chunks";
    const userId = "bulk-user";
    await seedApp(appId);
    for (let offset = 0; offset < 501; offset += 100) {
      const statements: D1PreparedStatement[] = [];
      for (let index = offset; index < Math.min(offset + 100, 501); index += 1) {
        statements.push(env.DB.prepare(
          `INSERT INTO app_usage_event(
             organization_id, event_id, app_id, user_id, provider_type, model, route,
             input_tokens, output_tokens, cost_usd, status
           ) VALUES ('operator-test-organization', ?, ?, ?, 'openai', 'gpt-5.6-luna', 'openai/v1/responses',
             50, 20, 0.000184, 'ok')`,
        ).bind(`bulk-${index}`, appId, userId));
      }
      await env.DB.batch(statements);
    }
    const before = await env.DB.prepare(
      "SELECT microusd FROM app_usage_spend WHERE app_id = ? AND scope = 'app'",
    ).bind(appId).first<{ microusd: number }>();

    let sabotaged = false;
    const failingDb = {
      prepare: (query: string) => env.DB.prepare(query),
      exec: (query: string) => env.DB.exec(query),
      batch(statements: D1PreparedStatement[]) {
        if (!sabotaged && statements.length === 2) {
          sabotaged = true;
          return env.DB.batch([
            statements[0]!,
            env.DB.prepare("UPDATE missing_reprice_table SET value = 1"),
          ]);
        }
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const response = await worker.request(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "openai",
          model: "gpt-5.6-luna",
          month: new Date().toISOString().slice(0, 7),
          apply: true,
        }),
      },
      { ...env, DB: failingDb } as Env,
    );
    expect(response.status).toBe(500);
    expect(sabotaged).toBe(true);

    const costs = await env.DB.prepare(
      "SELECT COUNT(*) AS rows, COUNT(DISTINCT cost_usd) AS costs, MIN(cost_usd) AS cost FROM app_usage_event WHERE app_id = ?",
    ).bind(appId).first<{ rows: number; costs: number; cost: number }>();
    expect(costs).toEqual({ rows: 501, costs: 1, cost: 0.000184 });
    expect(await env.DB.prepare(
      "SELECT microusd FROM app_usage_spend WHERE app_id = ? AND scope = 'app'",
    ).bind(appId).first()).toEqual(before);
  });

  /**
   * Repricing recomputes a local estimate. An event billed on what the upstream
   * actually charged has no estimate to go back to, so leaving it out is what
   * keeps the reported figure meaningful.
   */
  it("leaves an event billed on a reported cost out of repricing", async () => {
    const appId = "admin-reprice-reported";
    await seedApp(appId);
    const insert = (costSource: string | null, costUsd: number) => env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, cost_usd,
         cost_source, reported_cost_usd, status
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, 'user-1', 'openai', 'gpt-5.6-luna', 'openai/v1/responses',
                 50, 40, 10, 20, ?, ?, ?, 'ok')`,
    ).bind(appId, costUsd, costSource, costSource === "reported" ? costUsd : null).run();
    await insert(null, 0.000184);
    await insert("reported", 0.5);
    const month = new Date().toISOString().slice(0, 7);
    const preview = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", month, apply: true }),
      },
    );
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      // Only the locally priced event; the reported one was never a candidate.
      matched_events: 1,
      previous_cost_usd: 0.000184,
    });
    const reported = await env.DB.prepare(
      "SELECT cost_usd FROM app_usage_event WHERE app_id = ? AND cost_source = 'reported'",
    ).bind(appId).first<{ cost_usd: number }>();
    expect(reported?.cost_usd).toBe(0.5);
  });

  /**
   * A repriced row's cost came from the local catalog, so that is what its
   * `cost_source` has to say. Leaving `unresolved` behind kept the console
   * hiding a cost it now has, and kept the unresolved-count alert firing for
   * spend that had since been accounted for — so the marker could never clear.
   */
  it("moves a repriced event's cost source to computed with its new cost", async () => {
    const appId = "admin-reprice-source";
    await seedApp(appId);
    const insert = (costSource: string | null) => env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, cost_usd,
         cost_source, status
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, 'user-1', 'openai', 'gpt-5.6-luna', 'openai/v1/responses',
                 50, 40, 10, 20, 0, ?, 'ok')`,
    ).bind(appId, costSource).run();
    // The row the fix is for: metered tokens, no cost anyone could stand behind.
    await insert("unresolved");
    // And a row that names no cost source at all.
    await insert(null);
    const month = new Date().toISOString().slice(0, 7);
    const applied = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", month, apply: true }),
      },
    );
    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({
      applied: true,
      matched_events: 2,
      unmetered_events: 0,
    });
    const rows = await env.DB.prepare(
      "SELECT cost_usd, cost_source FROM app_usage_event WHERE app_id = ?",
    ).bind(appId).all<{ cost_usd: number; cost_source: string | null }>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) {
      expect(row.cost_source).toBe("computed");
      expect(row.cost_usd).toBeCloseTo(lunaEventCost(), 12);
    }
    // Nothing unresolved is left to alert on or to hide in the console.
    const stale = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM app_usage_event WHERE app_id = ? AND cost_source = 'unresolved'",
    ).bind(appId).first<{ n: number }>();
    expect(stale?.n).toBe(0);
  });

  it("reprices generated image tokens at the image rate", async () => {
    const appId = "admin-reprice-image";
    await seedApp(appId);
    const insert = (modalityTokens: string | null) => env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, modality_tokens, cost_usd, status
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, 'user-1', 'gemini', 'gemini-nano-banana-2.1',
                 'gemini/v1beta/models/gemini-nano-banana-2.1:generateContent', 12, 0, 0, 1130, ?, 0, 'ok')`,
    ).bind(appId, modalityTokens).run();
    await insert(JSON.stringify({ output: { image: 1120 } }));
    // No breakdown was reported, so every output token bills as an image.
    await insert("{}");
    const month = new Date().toISOString().slice(0, 7);
    const reprice = (apply: boolean) => exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "gemini", model: "gemini-nano-banana-2.1", month, apply }),
      },
    );
    const applied = await reprice(true);
    expect(applied.status).toBe(200);
    const rows = await env.DB.prepare(
      "SELECT cost_usd FROM app_usage_event WHERE app_id = ? ORDER BY id",
    ).bind(appId).all<{ cost_usd: number }>();
    const banana = shippedRates("gemini", "gemini-nano-banana-2.1");
    expect(rows.results[0]?.cost_usd)
      .toBeCloseTo((12 * banana.input + 10 * banana.output + 1120 * banana.image_output) / 1e6, 12);
    expect(rows.results[1]?.cost_usd)
      .toBeCloseTo((12 * banana.input + 1130 * banana.image_output) / 1e6, 12);

    // A row from before modality records were kept says nothing about its
    // tokens, so it is neither guessed at nor charged the highest rate.
    await insert(null);
    const dryRun = await reprice(false);
    expect(dryRun.status).toBe(200);
    await expect(dryRun.json()).resolves.toMatchObject({ matched_events: 2, unpriced_events: 1 });
    const refused = await reprice(true);
    expect(refused.status).toBe(400);
    await expect(refused.text()).resolves.toContain("predate the modality record");
  });

  it("reprices a one-hour cache write at its own rate, and an unsplit one at the default", async () => {
    const appId = "admin-reprice-cache-1h";
    await seedApp(appId);
    const insert = (tokenVariants: string | null) => env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, token_variants, cost_usd, status
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, 'user-1', 'anthropic', 'claude-sonnet-5',
                 'anthropic/v1/messages', 0, 0, 100, 0, ?, 0, 'ok')`,
    ).bind(appId, tokenVariants).run();
    await insert(JSON.stringify({ cache_write: { "1h": 40 } }));
    await insert("{}");
    // Recorded before the split was kept: priced as it was recorded, unsplit.
    await insert(null);
    const month = new Date().toISOString().slice(0, 7);
    const applied = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5", month, apply: true }),
      },
    );
    expect(applied.status).toBe(200);
    const rows = await env.DB.prepare(
      "SELECT cost_usd FROM app_usage_event WHERE app_id = ? ORDER BY id",
    ).bind(appId).all<{ cost_usd: number }>();
    const sonnet = shippedRates("anthropic", "claude-sonnet-5");
    expect(rows.results[0]?.cost_usd).toBeCloseTo((60 * sonnet.cache_write + 40 * sonnet.cache_write_1h) / 1e6, 12);
    expect(rows.results[1]?.cost_usd).toBeCloseTo(100 * sonnet.cache_write / 1e6, 12);
    expect(rows.results[2]?.cost_usd).toBeCloseTo(100 * sonnet.cache_write / 1e6, 12);
  });

  /**
   * The other half, and the one that matters more. An unresolved event with
   * *no* readable counts is spend nothing could measure — an unreadable
   * response, or a stream a client abandoned before its usage chunk. Repricing
   * multiplies zero tokens by a price and gets zero, which is arithmetic and
   * not an answer: calling that `computed` would turn "spend is escaping the
   * budget" into "this request was free", hide the row in the console, and
   * silence the By cost source signal operators are told to watch — while the
   * unbudgeted spend carried on.
   */
  it("leaves an unresolved event with no readable usage marked unresolved", async () => {
    const appId = "admin-reprice-unmetered";
    await seedApp(appId);
    const insert = (
      costSource: string | null,
      tokens: { input: number; output: number },
      costUsd = 0,
    ) => env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, cost_usd,
         cost_source, status
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, 'user-1', 'openai', 'gpt-5.6-luna', 'openai/v1/responses',
                 ?, 0, 0, ?, ?, ?, 'ok')`,
    ).bind(appId, tokens.input, tokens.output, costUsd, costSource).run();

    // Nothing was metered: the marker is the only record that spend happened.
    await insert("unresolved", { input: 0, output: 0 });
    // Metered tokens on the same model: this one genuinely reprices.
    await insert("unresolved", { input: 50, output: 20 });

    const month = new Date().toISOString().slice(0, 7);
    const applied = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", month, apply: true }),
      },
    );
    expect(applied.status).toBe(200);
    // Both rows had their cost rewritten; one of them could not be metered, and
    // the response says so rather than letting it disappear into the total.
    await expect(applied.json()).resolves.toMatchObject({
      applied: true,
      matched_events: 2,
      unmetered_events: 1,
    });

    const unmetered = await env.DB.prepare(
      "SELECT cost_usd, cost_source FROM app_usage_event WHERE app_id = ? AND input_tokens = 0",
    ).bind(appId).first<{ cost_usd: number; cost_source: string | null }>();
    // Marker intact, so the console still shows it as unresolved and the
    // By cost source breakdown still counts it.
    expect(unmetered).toMatchObject({ cost_source: "unresolved", cost_usd: 0 });

    const metered = await env.DB.prepare(
      "SELECT cost_usd, cost_source FROM app_usage_event WHERE app_id = ? AND input_tokens = 50",
    ).bind(appId).first<{ cost_usd: number; cost_source: string | null }>();
    expect(metered?.cost_source).toBe("computed");
    expect(metered?.cost_usd).toBeGreaterThan(0);

    // The alerting signal survives repricing entirely.
    const stillUnresolved = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM app_usage_event WHERE app_id = ? AND cost_source = 'unresolved'",
    ).bind(appId).first<{ n: number }>();
    expect(stillUnresolved?.n).toBe(1);
  });

  /** A stale figure on an unmeterable row is still corrected; only the marker is kept. */
  it("corrects a zero-usage row's cost without claiming it was computed", async () => {
    const appId = "admin-reprice-unmetered-stale";
    await seedApp(appId);
    await env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, input_tokens,
         cached_input_tokens, cache_write_tokens, output_tokens, cost_usd,
         cost_source, status
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, 'user-1', 'openai', 'gpt-5.6-luna', 'openai/v1/responses',
                 0, 0, 0, 0, 0.75, 'unresolved', 'ok')`,
    ).bind(appId).run();
    const month = new Date().toISOString().slice(0, 7);
    const applied = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "openai", model: "gpt-5.6-luna", month, apply: true }),
      },
    );
    expect(applied.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT cost_usd, cost_source FROM app_usage_event WHERE app_id = ?",
    ).bind(appId).first<{ cost_usd: number; cost_source: string | null }>();
    expect(row).toMatchObject({ cost_usd: 0, cost_source: "unresolved" });
  });

  it("reprices each event with its serving provider instance override", async () => {
    const appId = "admin-reprice-instances";
    await seedApp(appId);
    await seedProvider({
      type: "openai",
      id: "admin-reprice-openai-dev",
      slug: "openai-dev",
      pricing: { "gpt-5.6-luna": { input: 0, output: 0 } },
    });
    const insert = env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, provider_id, provider_slug, model, route,
         input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, 'user-1', 'openai', ?, ?, 'gpt-5.6-luna', ?, 50, 40, 10, 20, 1, 'ok')`,
    );
    await env.DB.batch([
      insert.bind(
        appId,
        "provider_operator-test-organization_openai",
        "openai",
        "openai/v1/responses",
      ),
      insert.bind(
        appId,
        "admin-reprice-openai-dev",
        "openai-dev",
        "openai-dev/v1/responses",
      ),
    ]);
    const month = new Date().toISOString().slice(0, 7);
    const response = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "openai",
          model: "gpt-5.6-luna",
          month,
          apply: false,
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matched_events: 2,
      recalculated_cost_usd: expect.closeTo(lunaEventCost(), 12),
    });
    await env.DB.prepare("DELETE FROM provider WHERE id = 'admin-reprice-openai-dev'").run();
  });

  // Pricing is resolved per event through the row that served it, so a deleted
  // instance can leave a single event unpriceable. A dry run reports that; only
  // apply refuses to touch a month it cannot reprice completely.
  it("reports unpriceable events on a dry run and refuses to apply them", async () => {
    const appId = "admin-reprice-partial";
    await seedApp(appId);
    await seedProvider({
      type: "openai",
      id: "admin-reprice-custom",
      slug: "openai-custom",
      pricing: { "custom-only-model": { input: 1, output: 2 } },
    });
    const insert = env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, provider_id, provider_slug, model, route,
         input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, status
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, 'user-1', 'openai', ?, ?, 'custom-only-model', 'openai/v1/responses',
         1000000, 0, 0, 0, 0.5, 'ok')`,
    );
    await env.DB.batch([
      insert.bind(appId, "admin-reprice-custom", "openai-custom"),
      // The row that served this one is gone, so nothing prices its model.
      insert.bind(appId, "admin-reprice-deleted", "openai-deleted"),
    ]);
    const month = new Date().toISOString().slice(0, 7);
    const reprice = (apply: boolean) => exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}/usage/reprice`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "openai", model: "custom-only-model", month, apply }),
      },
    );

    const preview = await reprice(false);
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      applied: false,
      matched_events: 1,
      unpriced_events: 1,
      unpriced_cost_usd: 0.5,
      recalculated_cost_usd: 1,
    });

    const applied = await reprice(true);
    expect(applied.status).toBe(400);
    await expect(applied.json()).resolves.toMatchObject({
      error: { code: "invalid_request", message: "No token price is configured for openai/custom-only-model" },
    });
    // Nothing was written: a refused apply leaves every stored cost alone.
    const untouched = await env.DB
      .prepare("SELECT cost_usd FROM app_usage_event WHERE app_id = ? ORDER BY id")
      .bind(appId)
      .all<{ cost_usd: number }>();
    expect(untouched.results.map((row) => row.cost_usd)).toEqual([0.5, 0.5]);
    await env.DB.prepare("DELETE FROM provider WHERE id = 'admin-reprice-custom'").run();
  });

  it("rejects an insecure issuer URL when updating an app", async () => {
    await seedApp("insecure-issuer");
    const response = await exports.default.fetch("https://example.test/v1/admin/apps/insecure-issuer", {
      method: "PUT",
      headers: {
        authorization: "Bearer agw_mgmt_test-admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: 1,
        name: "Insecure issuer",
        config: appleConfig({ jwks_url: "http://issuer.test/jwks" }),
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
  });

  it("requires the tenant-scoping issuer and audience, and flags a stored row without them", async () => {
    // Firebase, Sign in with Apple and Google Sign-In sign every customer's
    // tokens with one shared key set, so an issuer block with no `iss`/`aud` is
    // not a narrower policy — it accepts every tenant on the planet.
    const config = appleConfig({ jwks_url: "https://issuer.test/jwks" }) as any;
    delete config.authentication.end_user.issuer.issuer;
    delete config.authentication.end_user.issuer.audience;
    await seedApp("unscoped-issuer");
    const response = await exports.default.fetch("https://example.test/v1/admin/apps/unscoped-issuer", {
      method: "PUT",
      headers: {
        authorization: "Bearer agw_mgmt_test-admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ revision: 1, name: "Unscoped issuer", config }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });

    await seedApp("stored-unscoped-issuer");
    await env.DB.prepare(
      "UPDATE app SET config_json = json_remove(config_json, '$.authentication.end_user.issuer.issuer', '$.authentication.end_user.issuer.audience') WHERE id = ?",
    )
      .bind("stored-unscoped-issuer")
      .run();
    const stored = await exports.default.fetch(
      "https://example.test/v1/admin/apps/stored-unscoped-issuer",
      { headers: { authorization: "Bearer agw_mgmt_test-admin-secret" } },
    );
    expect(stored.status).toBe(500);
    await expect(stored.json()).resolves.toMatchObject({ error: { code: "internal_error" } });
  });

  it("validates the optional issuer on API-key applications", async () => {
    const config = serverConfig({
      authentication: {
        type: "api_key",
        issuer: {
          jwks_url: "http://issuer.test/jwks",
          user_id_claim: "sub",
          required_claims: [],
          max_token_lifetime_seconds: 3600,
        },
        end_user: { header: "x-end-user-id", required: false, fallback: "api_key" },
      },
    });
    await seedServerApp("invalid-api-key-issuer");
    const response = await exports.default.fetch(
      "https://example.test/v1/admin/apps/invalid-api-key-issuer",
      {
        method: "PUT",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ revision: 1, name: "Invalid API key issuer", config }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
  });

  it.each([
    ["development_access", () => {
      const config = serverConfig() as any;
      config.authentication.development_access = true;
      return config;
    }],
  ])("rejects the removed auth field %s instead of stripping it", async (field, config) => {
    const appId = `removed-${field.replace(/[^a-z]+/gu, "-")}`;
    await seedApp(appId);
    const response = await exports.default.fetch(
      `https://example.test/v1/admin/apps/${appId}`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ revision: 1, name: "Removed auth field", config: config() }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("stores an App Attest development environment opt-in", async () => {
    const config = appleConfig({ jwks_url: "https://issuer.test/jwks" }) as any;
    config.authentication.app_attest.environments = ["production", "development"];
    await seedApp("attest-environments");
    const created = await exports.default.fetch(
      "https://example.test/v1/admin/apps/attest-environments",
      {
        method: "PUT",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ revision: 1, name: "Attest environments", config }),
      },
    );
    expect(created.status).toBe(200);

    const read = await exports.default.fetch(
      "https://example.test/v1/admin/apps/attest-environments",
      { headers: { authorization: "Bearer agw_mgmt_test-admin-secret" } },
    );
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      app: {
        config: {
          authentication: {
            app_attest: { environments: ["production", "development"] },
          },
        },
      },
    });
  });

  it("rejects an unknown App Attest environment", async () => {
    const config = appleConfig({ jwks_url: "https://issuer.test/jwks" }) as any;
    config.authentication.app_attest.environments = ["staging"];
    await seedApp("attest-environments-invalid");
    const response = await exports.default.fetch(
      "https://example.test/v1/admin/apps/attest-environments-invalid",
      {
        method: "PUT",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ revision: 1, name: "Attest environments invalid", config }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("creates, lists, and revokes one-time server API keys", async () => {
    await seedServerApp("admin-server-keys");
    // The fixture ships a key of its own; the assertions below are about the
    // keys this test creates, so the app starts with none.
    await env.DB.prepare("DELETE FROM app_api_key WHERE app_id = 'admin-server-keys'").run();

    const created = await exports.default.fetch(
      "https://example.test/v1/admin/apps/admin-server-keys/keys",
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Production Worker" }),
      },
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<{
      id: string;
      key: string;
      key_prefix: string;
    }>();
    expect(createdBody.key).toMatch(/^agw_[0-9A-Za-z]{40,}$/u);
    expect(createdBody.key_prefix).toBe(createdBody.key.slice(0, 12));

    const listed = await exports.default.fetch(
      "https://example.test/v1/admin/apps/admin-server-keys/keys",
      { headers: { authorization: "Bearer agw_mgmt_test-admin-secret" } },
    );
    expect(listed.status).toBe(200);
    const listText = await listed.text();
    expect(listText).not.toContain(createdBody.key);
    expect(listText).not.toContain("key_hash");
    const listBody = JSON.parse(listText) as { keys: Array<{ id: string; status: string }> };
    expect(listBody.keys).toEqual([
      expect.objectContaining({ id: createdBody.id, status: "active" }),
    ]);

    const revoked = await exports.default.fetch(
      `https://example.test/v1/admin/apps/admin-server-keys/keys/${createdBody.id}/revoke`,
      {
        method: "POST",
        headers: { authorization: "Bearer agw_mgmt_test-admin-secret" },
      },
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      key: { id: createdBody.id, status: "revoked" },
    });

    await seedApp("issuer-no-keys");
    const issuerCreate = await exports.default.fetch(
      "https://example.test/v1/admin/apps/issuer-no-keys/keys",
      {
        method: "POST",
        headers: {
          authorization: "Bearer agw_mgmt_test-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Not allowed" }),
      },
    );
    expect(issuerCreate.status).toBe(400);
  });

  it("rejects unknown auth modes and malformed routing", async () => {
    const appId = "invalid-server-config";
    await seedServerApp(appId);
    for (const body of [
      {
        name: "Unknown mode",
        config: serverConfig({ authentication: { type: "unknown" } }),
      },
      {
        name: "Unknown provider slug",
        config: serverConfig({
          proxy: { "not-a-configured-slug": { allowed_paths: [], allowed_models: [] } },
        }),
      },
    ]) {
      const response = await exports.default.fetch(
        `https://example.test/v1/admin/apps/${appId}`,
        {
          method: "PUT",
          headers: {
            authorization: "Bearer agw_mgmt_test-admin-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...body, revision: 1 }),
        },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
    }
  });
});

describe("admin refusal order", () => {
  /*
   * Which refusal a request gets when it earns more than one is part of the
   * contract: the application an `/apps/{app}` operation names is resolved
   * first, inside the caller's account, then the operation's policy, and only
   * then is the body read. Each request below is short of at least two of
   * those and must be told about the first.
   */
  const MALFORMED = "{ not json";

  function write(path: string, method: string, headers: Record<string, string>) {
    return exports.default.fetch(`https://example.test${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: MALFORMED,
    });
  }

  const KEY = { authorization: `Bearer ${TEST_MANAGEMENT_KEY}` };

  /** A read-only member of an account of their own, signed in to the console. */
  async function member(email: string) {
    const human = await seedHuman(email);
    await env.DB.prepare("UPDATE mgmt_organization_user SET role = 'member' WHERE organization_id = ?")
      .bind(human.organizationId)
      .run();
    return {
      organizationId: human.organizationId,
      headers: { cookie: human.cookie, "x-console-request": "1" },
    };
  }

  it("resolves the application inside the caller's account before its policy", async () => {
    const { organizationId, headers } = await member("refusal-order-member@example.test");
    // In the test operator's account, not the member's.
    await seedServerApp("refusal-order-elsewhere");
    await seedServerApp("refusal-order-own", { organizationId });

    for (const app of ["refusal-order-missing", "refusal-order-elsewhere"]) {
      const response = await write(`/v1/admin/apps/${app}`, "PUT", headers);
      expect(response.status, app).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "app_not_found", message: "App is not registered" },
      });
    }

    // Found, so now the policy: a member may not write, whatever the body.
    const own = await write("/v1/admin/apps/refusal-order-own", "PUT", headers);
    expect(own.status).toBe(403);
    await expect(own.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
  });

  it("refuses an unparseable body only once the caller may write", async () => {
    await seedServerApp("refusal-order-present");
    const response = await write("/v1/admin/apps/refusal-order-present", "PUT", KEY);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request", message: "A JSON object is required" },
    });
  });

  it("refuses a management key on a session-only operation before reading the body", async () => {
    const response = await write("/v1/admin/keys", "POST", KEY);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "session_required" } });
  });

  /** An owner of an account of their own, and a `read` key they made in the console. */
  async function readKey(email: string) {
    const human = await seedHuman(email);
    const created = await exports.default.fetch("https://example.test/v1/admin/keys", {
      method: "POST",
      headers: { cookie: human.cookie, "x-console-request": "1", "content-type": "application/json" },
      body: JSON.stringify({ name: "Inspector", grant: "read" }),
    });
    expect(created.status).toBe(201);
    const { key } = await created.json<{ key: { id: string; plaintext: string; grant: string } }>();
    expect(key.grant).toBe("read");
    return {
      organizationId: human.organizationId,
      headers: { authorization: `Bearer ${key.plaintext}` },
    };
  }

  it("refuses a read key on a write last: after the application, the role and a session-only operation", async () => {
    const { organizationId, headers } = await readKey("refusal-order-read@example.test");
    await seedServerApp("refusal-order-read-own", { organizationId });
    // In the test operator's account, not the key holder's.
    await seedServerApp("refusal-order-read-elsewhere");

    for (const app of ["refusal-order-read-missing", "refusal-order-read-elsewhere"]) {
      const response = await write(`/v1/admin/apps/${app}`, "PUT", headers);
      expect(response.status, app).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "app_not_found" } });
    }

    // Found, the owner's role allows it, so the grant: refused before the
    // malformed body is read, with the remedy in the message.
    const own = await write("/v1/admin/apps/refusal-order-read-own", "PUT", headers);
    expect(own.status).toBe(403);
    await expect(own.json()).resolves.toMatchObject({
      error: {
        code: "grant_insufficient",
        message: "This key has the read grant; use a session or a key with the manage grant",
      },
    });

    // A session-only operation is refused as such, before the grant.
    const keys = await write("/v1/admin/keys", "POST", headers);
    expect(keys.status).toBe(403);
    await expect(keys.json()).resolves.toMatchObject({ error: { code: "session_required" } });

    // Reading is what the grant is for.
    const read = await exports.default.fetch("https://example.test/v1/admin/apps/refusal-order-read-own", {
      headers,
    });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ app: { id: "refusal-order-read-own" } });

  });

  it("lets a read key validate, which changes nothing", async () => {
    const { organizationId, headers } = await readKey("refusal-order-read-validate@example.test");
    await seedServerApp("refusal-order-read-validate", { organizationId });
    const validate = (path: string) =>
      exports.default.fetch(`https://example.test${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Validated by a read key", config: serverConfig() }),
      });

    for (const path of ["/v1/admin/apps/refusal-order-read-validate/validate", "/v1/admin/app-drafts/validate"]) {
      const response = await validate(path);
      expect(response.status, path).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ valid: true });
    }
    // And wrote nothing: the application is as it was seeded.
    const row = await env.DB.prepare("SELECT name FROM app WHERE id = ?")
      .bind("refusal-order-read-validate")
      .first<{ name: string }>();
    expect(row?.name).toBe("Test refusal-order-read-validate");
  });

  it("refuses a read key on a session policy as session_required, not for its grant", async () => {
    const { organizationId, headers } = await readKey("refusal-order-read-session@example.test");
    // `session: true` on a write: billing, and switching the active account.
    // Billing is refused as unconfigured only after the policy, so a key is
    // told what no key can fix rather than what a manage key would not fix.
    for (const [path, body] of [
      ["/v1/admin/billing/checkout", { planKey: "pro" }],
      ["/v1/admin/organizations/select", { organizationId }],
    ] as const) {
      const response = await exports.default.fetch(`https://example.test${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "session_required" } });
    }
  });

  it("refuses a read key on a write in an account past its free window for the account", async () => {
    const { organizationId, headers } = await readKey("refusal-order-read-unclaimed@example.test");
    await seedServerApp("refusal-order-read-unclaimed", { organizationId });
    // No human owner makes the account unclaimed; an admin still may write.
    await env.DB.batch([
      env.DB.prepare("UPDATE mgmt_organization_user SET role = 'admin' WHERE organization_id = ?")
        .bind(organizationId),
      env.DB.prepare("UPDATE mgmt_organization SET created_at = ?, expires_at = ? WHERE id = ?")
        .bind(
          new Date(Date.now() - 31 * 86_400_000).toISOString(),
          new Date(Date.now() + 60 * 86_400_000).toISOString(),
          organizationId,
        ),
    ]);
    accountLifecycleCache.clear();
    // Only a hosted deployment runs an unclaimed account's free window.
    const hosted = new Proxy(env, {
      get: (target, key, receiver) =>
        key === "BILLING" ? ({} as NonNullable<Env["BILLING"]>) : Reflect.get(target, key, receiver),
    });
    const response = await worker.request("https://example.test/v1/admin/apps/refusal-order-read-unclaimed", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: MALFORMED,
    }, hosted);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unclaimed_access_expired" } });
  });

  it("refuses a read key opening a CLI operation, and records nothing", async () => {
    const { organizationId, headers } = await readKey("refusal-order-read-cli@example.test");
    const cli = new Proxy(env, {
      get: (target, key, receiver) =>
        key === "DEPLOYMENT_ID" ? "refusal-order" : Reflect.get(target, key, receiver),
    });
    const name = "Opened by a read key";
    const response = await worker.request("https://example.test/v1/cli/operations", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "app.add",
        payload: { name, config: serverConfig() },
        token: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
      }),
    }, cli);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "grant_insufficient" } });
    const operations = await env.DB.prepare("SELECT COUNT(*) AS n FROM mgmt_operation WHERE organization_id = ?")
      .bind(organizationId)
      .first<{ n: number }>();
    expect(operations?.n).toBe(0);
    const apps = await env.DB.prepare("SELECT COUNT(*) AS n FROM app WHERE name = ?")
      .bind(name)
      .first<{ n: number }>();
    expect(apps?.n).toBe(0);
  });

  it("answers cf-auth's own grant refusal in the gateway's envelope", () => {
    // No request reaches one today — the executor refuses a read key before
    // any cf-auth write it could make — so the mapping is asserted directly.
    const refusal = grantInsufficient();
    expect(isCfAuthError(refusal)).toBe(true);
    const mapped = asGatewayAuthError(refusal);
    expect(mapped).toBeInstanceOf(GatewayError);
    expect(mapped).toMatchObject({ status: 403, code: "grant_insufficient" });
  });

  it("refuses a member's read key on a write for the role, not the grant", async () => {
    const { organizationId, headers } = await readKey("refusal-order-read-member@example.test");
    await seedServerApp("refusal-order-read-member-app", { organizationId });
    await env.DB.prepare("UPDATE mgmt_organization_user SET role = 'member' WHERE organization_id = ?")
      .bind(organizationId)
      .run();
    const response = await write("/v1/admin/apps/refusal-order-read-member-app", "PUT", headers);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
  });

  it("lets a read key end itself", async () => {
    const { headers } = await readKey("refusal-order-read-logout@example.test");
    const revoked = await exports.default.fetch("https://example.test/v1/cli/credential", {
      method: "DELETE",
      headers,
    });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    const after = await exports.default.fetch("https://example.test/v1/admin/apps", { headers });
    expect(after.status).toBe(401);
  });

  it("applies the grant to a relayed operation as to a handled one", async () => {
    // Both relays mounted today are public, so this mounts a writing
    // management operation through `relay` on a router of its own.
    let relayed = 0;
    const route = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
    route.onError((error, c) =>
      error instanceof GatewayError
        ? c.json({ error: { code: error.code } }, error.status as 403)
        : c.json({ error: { code: "unexpected", message: String(error) } }, 500));
    const grants: CredentialGrant[] = [];
    route.use("*", async (c, next) => {
      const grant = grants.shift()!;
      c.set("deployment", resolveDeployment(c.env, c.req.url));
      c.set("billingRequestCache", new Map());
      c.set("authState", {
        authenticated: true,
        user: { id: TEST_SERVICE_USER_ID, kind: "service" },
        organization: { id: TEST_ORGANIZATION_ID, name: "Test" },
        role: "owner",
        memberships: [],
        credentialType: "apiKey",
        assurance: "credential",
        grant,
        actor: { id: TEST_SERVICE_USER_ID, credentialId: "identity-test-key" },
      } as unknown as AuthState);
      c.set("actor", {
        userId: TEST_SERVICE_USER_ID,
        identityKind: "service",
        credentialId: "identity-test-key",
        organizationId: TEST_ORGANIZATION_ID,
        role: "owner",
        credentialType: "apiKey",
        grant,
      });
      await next();
    });
    adminRouter(route).relay("createProvider", async () => {
      relayed += 1;
      return new Response(null, { status: 204 });
    });

    grants.push("read");
    const refused = await route.request("/providers", { method: "POST" }, env);
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "grant_insufficient" } });
    expect(relayed).toBe(0);

    grants.push("manage");
    const allowed = await route.request("/providers", { method: "POST" }, env);
    expect(allowed.status).toBe(204);
    expect(relayed).toBe(1);
  });
});
