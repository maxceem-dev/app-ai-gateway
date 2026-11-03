import { expect, test } from "vitest";
import { call, smokeId } from "../../../src/gateway.ts";
import { env, state } from "../../support.ts";

// The mock fails on purpose for these models; the app must see the provider's
// own status, not a gateway failure of its own.
const path = `/v1/apps/${state.apps.server.id}/proxy/smoke-openai/v1/chat/completions`;

for (const status of [429, 500]) {
  test(`a provider's ${status} reaches the app as ${status}`, async () => {
    const response = await call(env, path, {
      key: state.apps.server.key,
      body: { model: `smoke-${status}`, messages: [{ role: "user", content: smokeId() }] },
    });
    expect(response.status).toBe(status);
    expect(await response.text()).toContain(`Smoke failure ${status}`);
  });
}
