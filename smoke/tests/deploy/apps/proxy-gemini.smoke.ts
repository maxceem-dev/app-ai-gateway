import { expect, test } from "vitest";
import { call, smokeId } from "../../../src/gateway.ts";
import { MODEL } from "../../../src/mock/formats.ts";
import { env, expectForwardedCleanly, expectStatus, json, state } from "../../support.ts";

const base = `/v1/apps/${state.apps.server.id}/proxy/smoke-gemini/v1beta/models/${MODEL}`;
const key = state.apps.server.key;
const body = (id: string) => ({ contents: [{ role: "user", parts: [{ text: id }] }] });

test("a server app gets a Gemini generateContent answer", async () => {
  const id = smokeId();
  const response = await call(env, `${base}:generateContent`, { key, body: body(id) });
  await expectStatus(response, 200, "Gemini generateContent");
  const reply = await json<{ candidates: { content: { parts: { text: string }[] } }[] }>(response, "Gemini generateContent");
  expect(reply.candidates[0]?.content.parts[0]?.text).toBe(`pong ${id}`);
  await expectForwardedCleanly(id, `v1beta/models/${MODEL}:generateContent`);
});

test("a server app gets a streamed Gemini answer", async () => {
  const id = smokeId();
  const response = await call(env, `${base}:streamGenerateContent?alt=sse`, { key, body: body(id) });
  await expectStatus(response, 200, "Gemini streamGenerateContent");
  expect(await response.text()).toContain(`pong ${id}`);
  await expectForwardedCleanly(id, `v1beta/models/${MODEL}:streamGenerateContent`);
});
