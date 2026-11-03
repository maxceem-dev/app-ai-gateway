import { expect, test } from "vitest";
import { call, smokeId } from "../../src/gateway.ts";
import { MODEL } from "../../src/mock/formats.ts";
import { env, expectForwardedCleanly, expectStatus, json, state } from "../support.ts";

// Whether apps can reach their providers right now: the gateway is up, its
// vault opens, and one ordinary call goes through the whole path — app key,
// stored provider key, outbound network, answer. Every format and failure mode
// is checked after each deploy instead (`deploy/apps/`).

test("the gateway reports itself healthy, with a working vault", async () => {
  const response = await call(env, "/v1/healthz");
  await expectStatus(response, 200, "GET /v1/healthz");
  expect(await json(response, "GET /v1/healthz")).toMatchObject({ ok: true, vault: "ok" });
});

test("a server app gets an answer from its provider", async () => {
  const id = smokeId();
  const response = await call(env, `/v1/apps/${state.apps.server.id}/proxy/smoke-openai/v1/chat/completions`, {
    key: state.apps.server.key,
    body: { model: MODEL, messages: [{ role: "user", content: id }] },
  });
  await expectStatus(response, 200, "Chat Completions");
  const body = await json<{ choices: { message: { content: string } }[] }>(response, "Chat Completions");
  expect(body.choices[0]?.message.content).toBe(`pong ${id}`);
  await expectForwardedCleanly(id, "v1/chat/completions");
});
