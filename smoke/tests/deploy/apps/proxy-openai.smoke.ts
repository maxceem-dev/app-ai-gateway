import { expect, test } from "vitest";
import { call, smokeId } from "../../../src/gateway.ts";
import { MODEL } from "../../../src/mock/formats.ts";
import { env, expectForwardedCleanly, expectStatus, json, state } from "../../support.ts";

// The OpenAI wire format, which every OpenAI-compatible provider type shares.
const proxy = (path: string) => `/v1/apps/${state.apps.server.id}/proxy/smoke-openai/${path}`;
const key = state.apps.server.key;

test("a server app gets a Chat Completions answer", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/chat/completions"), {
    key,
    body: { model: MODEL, messages: [{ role: "user", content: id }] },
  });
  await expectStatus(response, 200, "Chat Completions");
  const body = await json<{ choices: { message: { content: string } }[] }>(response, "Chat Completions");
  expect(body.choices[0]?.message.content).toBe(`pong ${id}`);
  await expectForwardedCleanly(id, "v1/chat/completions");
});

test("a server app gets a streamed Chat Completions answer", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/chat/completions"), {
    key,
    body: { model: MODEL, stream: true, messages: [{ role: "user", content: id }] },
  });
  await expectStatus(response, 200, "Streamed Chat Completions");
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  expect(text).toContain(`pong ${id}`);
  expect(text).toContain("data: [DONE]");
  await expectForwardedCleanly(id, "v1/chat/completions");
});

test("a server app gets a Responses answer", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/responses"), { key, body: { model: MODEL, input: id } });
  await expectStatus(response, 200, "Responses");
  const body = await json<{ output: { content: { text: string }[] }[] }>(response, "Responses");
  expect(body.output[0]?.content[0]?.text).toBe(`pong ${id}`);
  await expectForwardedCleanly(id, "v1/responses");
});

test("a server app gets a streamed Responses answer", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/responses"), { key, body: { model: MODEL, input: id, stream: true } });
  await expectStatus(response, 200, "Streamed Responses");
  const text = await response.text();
  expect(text).toContain(`pong ${id}`);
  expect(text).toContain("response.completed");
  await expectForwardedCleanly(id, "v1/responses");
});
