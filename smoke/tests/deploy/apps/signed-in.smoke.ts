import { generateKeyPair, exportJWK } from "jose";
import { expect, test } from "vitest";
import { need } from "../../../src/env.ts";
import { call, smokeId } from "../../../src/gateway.ts";
import { endUserToken } from "../../../src/issuer.ts";
import { MODEL } from "../../../src/mock/formats.ts";
import { env, errorCode, expectForwardedCleanly, expectStatus, json, state } from "../../support.ts";

// The signed-in path an iOS app takes, minus App Attest: an end-user token from
// the test issuer is exchanged for a gateway token, which then authorizes
// calls; and what such an app refuses. Checked after each deploy rather than
// on a schedule: sign-in is optional for an app, and without App Attest this
// covers only half of what a real iOS app goes through.
const app = state.apps.signedIn;
const issuerKey = need(env, "issuerKey", "SMOKE_ISSUER_KEY");
const appVersion = { "x-app-version": "smoke" };

function exchange(issuerToken: string): Promise<Response> {
  return call(env, `/v1/apps/${app.id}/auth/token`, { body: { issuer_token: issuerToken, api_key: app.key } });
}

test("a signed-in user exchanges a token and calls a provider", async () => {
  const exchanged = await exchange(await endUserToken(issuerKey, "smoke-user"));
  await expectStatus(exchanged, 200, "Token exchange");
  const { access_token: token } = await json<{ access_token: string }>(exchanged, "Token exchange");

  const id = smokeId();
  const response = await call(env, `/v1/apps/${app.id}/proxy/smoke-openai/v1/chat/completions`, {
    key: token,
    headers: appVersion,
    body: { model: MODEL, messages: [{ role: "user", content: id }] },
  });
  await expectStatus(response, 200, "Proxied call with a gateway token");
  await expectForwardedCleanly(id, "v1/chat/completions");

  const me = await call(env, `/v1/apps/${app.id}/me`, { key: token, headers: appVersion });
  await expectStatus(me, 200, "GET /me");
});

test("the app key alone is refused once users must sign in", async () => {
  const response = await call(env, `/v1/apps/${app.id}/proxy/smoke-openai/v1/chat/completions`, {
    key: app.key,
    body: { model: MODEL, messages: [{ role: "user", content: smokeId() }] },
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
});

test("a user without the required claim is refused with issuer_claims_missing", async () => {
  const response = await exchange(await endUserToken(issuerKey, "smoke-free-user", { plan: "free" }));
  expect(response.status).toBe(403);
  expect(await errorCode(response)).toBe("issuer_claims_missing");
});

test("a token signed by an unknown key is refused with issuer_token_rejected", async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const forged = JSON.stringify({ ...(await exportJWK(privateKey)), alg: "RS256", kid: "smoke-forged" });
  const response = await exchange(await endUserToken(forged, "smoke-forged-user"));
  expect(response.status).toBe(403);
  expect(await errorCode(response)).toBe("issuer_token_rejected");
});
