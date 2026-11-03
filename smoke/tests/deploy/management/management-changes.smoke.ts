import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { need } from "../../../src/env.ts";
import { PRICING, TEMPORARY_PREFIX } from "../../../src/fixtures.ts";
import { admin, GatewayFailure } from "../../../src/gateway.ts";
import { env } from "../../support.ts";

// Changing what the account holds. Reading it is `monitor/management.smoke.ts`.
const temporaryName = () => `${TEMPORARY_PREFIX}${randomBytes(4).toString("hex")}`;

test("an app can be created, renamed and deleted", async () => {
  const name = temporaryName();
  const config = { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: { mode: "all" }, model_rewrites: {} } };
  const { app } = await admin<{ app: { id: string } }>(env, "POST", "/v1/admin/apps", { name, config });
  const path = `/v1/admin/apps/${encodeURIComponent(app.id)}`;
  try {
    const { app: read } = await admin<{ app: { revision: number } }>(env, "GET", path);
    const { app: renamed } = await admin<{ app: { name: string } }>(env, "PUT", path, {
      name: `${name}-renamed`,
      config,
      revision: read.revision,
    });
    expect(renamed.name).toBe(`${name}-renamed`);
  } finally {
    await admin(env, "DELETE", `${path}?confirm=${encodeURIComponent(app.id)}`);
  }
  await expect(admin(env, "GET", path)).rejects.toSatisfy((error) => error instanceof GatewayFailure && error.status === 404);
});

test("a provider can be added and removed, and its key is never echoed back", async () => {
  const secret = need(env, "mockSecret", "SMOKE_MOCK_SECRET");
  const slug = temporaryName();
  // Adding a provider tests its key against the provider, so this also proves
  // the gateway can still seal a secret and reach the mock with it.
  const created = await admin<{ provider: { id: string; secretHint: string | null } }>(env, "POST", "/v1/admin/providers", {
    type: "openai",
    name: slug,
    slug,
    baseUrl: `${need(env, "mockUrl", "SMOKE_MOCK_URL")}/openai/`,
    pricing: PRICING,
    secret,
  });
  try {
    expect(JSON.stringify(created)).not.toContain(secret);
    expect(created.provider.secretHint).toBeTruthy();
  } finally {
    await admin(env, "DELETE", `/v1/admin/providers/${encodeURIComponent(created.provider.id)}`);
  }
});
