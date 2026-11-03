import { fail, isMain } from "./cli.ts";
import { need, readStateIfAny, smokeEnv, writeState, type SmokeEnv, type SmokeState } from "./env.ts";
import { APP_NAMES, appConfigs, PRICING, PROVIDERS, TEMPORARY_PREFIX } from "./fixtures.ts";
import { admin } from "./gateway.ts";

/**
 * Brings the test account in line with `fixtures.ts` and records what the
 * tests need in the state file:
 *
 *   SMOKE_GATEWAY_URL=… SMOKE_MANAGEMENT_KEY=… SMOKE_MOCK_URL=… SMOKE_MOCK_SECRET=… \
 *     SMOKE_ISSUER_KEY=… node src/setup.ts
 *
 * Idempotent: it creates what is missing, repairs what drifted, mints an
 * application key only when this runner has no working one, and sweeps the
 * leftovers of interrupted write checks.
 */

interface ProviderRow {
  id: string;
  slug: string;
  baseUrl: string | null;
  secretHint: string | null;
  pricing: Record<string, { input: number; output: number }> | null;
  status: string;
  revision: number;
  createdAt: string;
}

interface AppRow {
  id: string;
  name: string;
  revision: number;
  created_at: string;
}

interface KeyRow {
  id: string;
  name: string;
  key_prefix: string;
  status: "active" | "revoked";
}

const STALE_MS = 60 * 60_000;

function stale(createdAt: string): boolean {
  return Date.now() - Date.parse(createdAt) > STALE_MS;
}

/** Whether a stored key's hint is the tail of `secret`, ignoring any ellipsis it is shown with. */
function hintMatches(hint: string | null, secret: string): boolean {
  const tail = hint?.replace(/^[^A-Za-z0-9_-]+/u, "");
  return Boolean(tail) && secret.endsWith(tail!);
}

async function sweep(env: SmokeEnv): Promise<number> {
  let removed = 0;
  const { apps } = await admin<{ apps: AppRow[] }>(env, "GET", "/v1/admin/apps");
  for (const app of apps) {
    if (app.name.startsWith(TEMPORARY_PREFIX) && stale(app.created_at)) {
      const id = encodeURIComponent(app.id);
      await admin(env, "DELETE", `/v1/admin/apps/${id}?confirm=${id}`);
      removed++;
    }
  }
  const { providers } = await admin<{ providers: ProviderRow[] }>(env, "GET", "/v1/admin/providers");
  for (const provider of providers) {
    if (provider.slug.startsWith(TEMPORARY_PREFIX) && stale(provider.createdAt)) {
      await admin(env, "DELETE", `/v1/admin/providers/${encodeURIComponent(provider.id)}`);
      removed++;
    }
  }
  return removed;
}

async function ensureProviders(env: SmokeEnv, mockUrl: string, secret: string): Promise<string[]> {
  const changes: string[] = [];
  const { providers } = await admin<{ providers: ProviderRow[] }>(env, "GET", "/v1/admin/providers");
  for (const wanted of PROVIDERS) {
    const baseUrl = `${mockUrl}/${wanted.format}/`;
    const row = providers.find((provider) => provider.slug === wanted.slug);
    if (!row) {
      await admin(env, "POST", "/v1/admin/providers", {
        type: wanted.type,
        name: wanted.slug,
        slug: wanted.slug,
        baseUrl,
        pricing: PRICING,
        secret,
      });
      changes.push(`created provider ${wanted.slug}`);
    } else if (
      row.baseUrl !== baseUrl ||
      row.status !== "active" ||
      !hintMatches(row.secretHint, secret) ||
      JSON.stringify(row.pricing) !== JSON.stringify(PRICING)
    ) {
      // The secret is sealed together with the base URL, so it is always sent
      // again with it.
      await admin(env, "PUT", `/v1/admin/providers/${encodeURIComponent(row.id)}`, {
        revision: row.revision,
        baseUrl,
        pricing: PRICING,
        secret,
        status: "active",
      });
      changes.push(`repaired provider ${wanted.slug}`);
    }
  }
  return changes;
}

async function ensureApps(env: SmokeEnv, mockUrl: string): Promise<Record<keyof typeof APP_NAMES, string>> {
  const configs = appConfigs(mockUrl);
  const { apps } = await admin<{ apps: AppRow[] }>(env, "GET", "/v1/admin/apps");
  const ids = {} as Record<keyof typeof APP_NAMES, string>;
  for (const [role, name] of Object.entries(APP_NAMES) as [keyof typeof APP_NAMES, string][]) {
    const row = apps.find((app) => app.name === name);
    if (!row) {
      const { app } = await admin<{ app: AppRow }>(env, "POST", "/v1/admin/apps", { name, config: configs[role] });
      ids[role] = app.id;
    } else {
      // Written every time rather than compared: the stored configuration has
      // every default filled in, and a rewrite of an unchanged one is harmless.
      // The list carries no revision, so the update is based on a fresh read.
      const path = `/v1/admin/apps/${encodeURIComponent(row.id)}`;
      const { app } = await admin<{ app: AppRow }>(env, "GET", path);
      await admin(env, "PUT", path, { name, config: configs[role], status: "active", revision: app.revision });
      ids[role] = row.id;
    }
  }
  return ids;
}

/** This runner's key for an app: the recorded one while it still works, otherwise a new one. */
async function ensureKey(env: SmokeEnv, appId: string, recorded: string | undefined): Promise<string> {
  const name = `smoke ${env.runner}`;
  const path = `/v1/admin/apps/${encodeURIComponent(appId)}/keys`;
  const { keys } = await admin<{ keys: KeyRow[] }>(env, "GET", path);
  const mine = keys.filter((key) => key.name === name && key.status === "active");
  const current = recorded === undefined ? undefined : mine.find((key) => recorded.startsWith(key.key_prefix));
  if (current && recorded) return recorded;

  const created = await admin<{ id: string; key: string }>(env, "POST", path, { name });
  for (const key of mine) {
    await admin(env, "POST", `${path}/${encodeURIComponent(key.id)}/revoke`);
  }
  return created.key;
}

export async function setup(env: SmokeEnv): Promise<string[]> {
  const mockUrl = need(env, "mockUrl", "SMOKE_MOCK_URL");
  const secret = need(env, "mockSecret", "SMOKE_MOCK_SECRET");
  need(env, "issuerKey", "SMOKE_ISSUER_KEY");

  const health = await fetch(`${mockUrl}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  if (!health?.ok) throw new Error(`The mock provider does not answer at ${mockUrl}/healthz; start it first`);

  const report: string[] = [];
  const swept = await sweep(env);
  if (swept > 0) report.push(`swept ${swept} stale temporary resources`);
  report.push(...(await ensureProviders(env, mockUrl, secret)));
  const ids = await ensureApps(env, mockUrl);

  const previous = readStateIfAny(env);
  const state: SmokeState = {
    gatewayUrl: env.gatewayUrl,
    runner: env.runner,
    apps: {
      server: { id: ids.server, key: await ensureKey(env, ids.server, previous?.apps.server.key) },
      signedIn: { id: ids.signedIn, key: await ensureKey(env, ids.signedIn, previous?.apps.signedIn.key) },
      ios: { id: ids.ios },
    },
  };
  writeState(env, state);
  report.push(`fixtures ready for ${env.gatewayUrl}`);
  return report;
}

if (isMain(import.meta.url)) {
  setup(smokeEnv()).then((lines) => lines.forEach((line) => console.log(line)), fail);
}
