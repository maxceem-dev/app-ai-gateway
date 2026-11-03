import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { generateIssuerKey } from "../src/issuer.ts";
import { createMockServer } from "../src/mock/server.ts";

// The mock is what the live checks lean on to judge the gateway, so its own
// judgement — auth per format, leak detection, what it files — is pinned here,
// offline.

const secret = "smoke_test_secret";
const id = "smoke-00000000-0000-4000-8000-000000000000";
let origin = "";
let close: () => Promise<void>;

before(async () => {
  const server = createMockServer({ secret, issuerKey: await generateIssuerKey() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

after(() => close());

const post = (path: string, headers: Record<string, string>, body: unknown) =>
  fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const seen = async (smokeId: string) =>
  (await fetch(`${origin}/_seen/${smokeId}`, { headers: { authorization: `Bearer ${secret}` } })).json();

test("answers an OpenAI chat completion carrying the right key, and echoes the smoke id", async () => {
  const response = await post("/openai/v1/chat/completions", { authorization: `Bearer ${secret}` }, {
    model: "smoke-model",
    messages: [{ role: "user", content: id }],
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { choices: { message: { content: string } }[]; usage: unknown };
  assert.equal(body.choices[0]?.message.content, `pong ${id}`);
  assert.ok(body.usage);
  assert.deepEqual(await seen(id), {
    format: "openai",
    method: "POST",
    path: "v1/chat/completions",
    authorized: true,
    clientCredentialLeaked: false,
  });
});

test("refuses a wrong key and notes a client credential that leaked through", async () => {
  const leakId = "smoke-00000000-0000-4000-8000-000000000001";
  const response = await post("/anthropic/v1/messages", { "x-api-key": secret, authorization: "Bearer agw_client" }, {
    model: "smoke-model",
    messages: [{ role: "user", content: leakId }],
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await seen(leakId), {
    format: "anthropic",
    method: "POST",
    path: "v1/messages",
    authorized: false,
    clientCredentialLeaked: true,
  });
});

test("streams Gemini as server-sent events and fails on purpose for the failing models", async () => {
  const stream = await post("/gemini/v1beta/models/smoke-model:streamGenerateContent?alt=sse", { "x-goog-api-key": secret }, {
    contents: [{ parts: [{ text: id }] }],
  });
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.match(await stream.text(), new RegExp(`pong ${id}`));

  const failing = await post("/gemini/v1beta/models/smoke-429:generateContent", { "x-goog-api-key": secret }, {});
  assert.equal(failing.status, 429);
});

test("publishes only the public half of the issuer key, and guards what it saw", async () => {
  const jwks = (await (await fetch(`${origin}/.well-known/jwks.json`)).json()) as { keys: Record<string, unknown>[] };
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0]?.d, undefined);
  assert.equal((await fetch(`${origin}/_seen/${id}`)).status, 401);
});
