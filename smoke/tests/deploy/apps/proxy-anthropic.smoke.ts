import { expect, test } from "vitest";
import { call, smokeId } from "../../../src/gateway.ts";
import { MODEL } from "../../../src/mock/formats.ts";
import { env, expectForwardedCleanly, expectStatus, json, state } from "../../support.ts";

const path = `/v1/apps/${state.apps.server.id}/proxy/smoke-anthropic/v1/messages`;
const key = state.apps.server.key;
const body = (id: string, stream: boolean) => ({
  model: MODEL,
  max_tokens: 16,
  stream,
  messages: [{ role: "user", content: id }],
});

test("a server app gets an Anthropic Messages answer", async () => {
  const id = smokeId();
  const response = await call(env, path, { key, body: body(id, false) });
  await expectStatus(response, 200, "Anthropic Messages");
  const reply = await json<{ content: { text: string }[] }>(response, "Anthropic Messages");
  expect(reply.content[0]?.text).toBe(`pong ${id}`);
  await expectForwardedCleanly(id, "v1/messages");
});

test("a server app gets a streamed Anthropic Messages answer", async () => {
  const id = smokeId();
  const response = await call(env, path, { key, body: body(id, true) });
  await expectStatus(response, 200, "Streamed Anthropic Messages");
  const text = await response.text();
  expect(text).toContain(`pong ${id}`);
  expect(text).toContain("message_stop");
  await expectForwardedCleanly(id, "v1/messages");
});
