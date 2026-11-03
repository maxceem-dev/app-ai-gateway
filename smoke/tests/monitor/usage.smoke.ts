import { expect, test } from "vitest";
import { admin, call, smokeId } from "../../src/gateway.ts";
import { MODEL } from "../../src/mock/formats.ts";
import { env, expectStatus, state } from "../support.ts";

const RECORDING_DEADLINE_MS = 60_000;
const usagePath = `/v1/admin/apps/${state.apps.server.id}/usage`;

async function requests(): Promise<number> {
  return (await admin<{ requests: number }>(env, "GET", usagePath)).requests;
}

test("a proxied call is recorded in usage", { timeout: RECORDING_DEADLINE_MS + 15_000 }, async () => {
  const before = await requests();
  const response = await call(env, `/v1/apps/${state.apps.server.id}/proxy/smoke-openai/v1/chat/completions`, {
    key: state.apps.server.key,
    body: { model: MODEL, messages: [{ role: "user", content: smokeId() }] },
  });
  await expectStatus(response, 200, "Proxied call");
  await response.text();

  const deadline = Date.now() + RECORDING_DEADLINE_MS;
  let after = before;
  while (after <= before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    after = await requests();
  }
  expect(after, `usage stayed at ${before} requests for ${RECORDING_DEADLINE_MS / 1000}s`).toBeGreaterThan(before);
});
