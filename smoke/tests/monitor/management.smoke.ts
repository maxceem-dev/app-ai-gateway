import { expect, test } from "vitest";
import { APP_NAMES, PROVIDERS } from "../../src/fixtures.ts";
import { admin } from "../../src/gateway.ts";
import { env } from "../support.ts";

// Whether you can manage your apps right now: a management key is accepted and
// the account's data reads back. Changing things, the CLI and MCP are checked
// after each deploy (`deploy/management/`).
test("the management API lists the account's apps and providers", async () => {
  const { apps } = await admin<{ apps: { name: string }[] }>(env, "GET", "/v1/admin/apps");
  expect(apps.map((app) => app.name)).toEqual(expect.arrayContaining(Object.values(APP_NAMES)));
  const { providers } = await admin<{ providers: { slug: string }[] }>(env, "GET", "/v1/admin/providers");
  expect(providers.map((provider) => provider.slug)).toEqual(expect.arrayContaining(PROVIDERS.map((p) => p.slug)));
});
