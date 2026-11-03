import { expect, test } from "vitest";
import { ENDPOINT_SLUG } from "../../../src/fixtures.ts";
import { call, smokeId } from "../../../src/gateway.ts";
import { env, expectForwardedCleanly, expectStatus, json, state } from "../../support.ts";

test("a custom endpoint answers with its configured provider and model", async () => {
  const id = smokeId();
  const response = await call(env, `/v1/apps/${state.apps.server.id}/endpoints/${ENDPOINT_SLUG}`, {
    key: state.apps.server.key,
    body: { input: id },
  });
  await expectStatus(response, 200, "Custom endpoint");
  const body = await json<{ output: { content: { text: string }[] }[] }>(response, "Custom endpoint");
  expect(body.output[0]?.content[0]?.text).toBe(`pong ${id}`);
  await expectForwardedCleanly(id, "v1/responses");
});
