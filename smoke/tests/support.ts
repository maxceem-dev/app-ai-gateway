import { need, readState, smokeEnv } from "../src/env.ts";
import { gatewayError } from "../src/gateway.ts";
import type { Observation } from "../src/mock/server.ts";

export const env = smokeEnv();
export const state = readState(env);

/**
 * Fails with the gateway's status and error code when `response` is not
 * `status`. The body is read only for that code, so a test can still read it
 * on success.
 */
export async function expectStatus(response: Response, status: number, what: string): Promise<void> {
  if (response.status === status) return;
  const { code, message } = await gatewayError(response.clone());
  throw new Error(`${what}: expected ${status}, got ${response.status}${code ? ` ${code}` : ""}${message ? ` (${message})` : ""}`);
}

/**
 * The body as JSON, or a failure that says what came back instead. A proxy in
 * front of a stopped gateway can answer an empty 200, which would otherwise
 * surface as a bare JSON parse error.
 */
export async function json<T>(response: Response, what: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const type = response.headers.get("content-type") ?? "no content type";
    throw new Error(`${what}: expected JSON, got ${text.length === 0 ? "an empty body" : `${text.length} bytes of ${type}`}`);
  }
}

/** The gateway error code of a refusal, which the refusal checks pin. */
export async function errorCode(response: Response): Promise<string | undefined> {
  return (await gatewayError(response)).code;
}

/** What the mock provider saw for the request carrying `id`. */
export async function observed(id: string): Promise<Observation> {
  const response = await fetch(`${need(env, "mockUrl", "SMOKE_MOCK_URL")}/_seen/${id}`, {
    headers: { authorization: `Bearer ${need(env, "mockSecret", "SMOKE_MOCK_SECRET")}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) throw new Error("The mock provider never received this request");
  if (!response.ok) throw new Error(`The mock provider answered ${response.status} when asked what it saw`);
  return (await response.json()) as Observation;
}

/**
 * The gateway reached the provider with the stored key in the format's own
 * header, and passed none of the client's credentials on.
 */
export async function expectForwardedCleanly(id: string, path: string): Promise<void> {
  const seen = await observed(id);
  if (seen.path !== path) throw new Error(`The provider was called at ${seen.path}, not ${path}`);
  if (!seen.authorized) throw new Error("The provider did not receive the stored provider key in its auth header");
  if (seen.clientCredentialLeaked) throw new Error("A client credential (agw_…) reached the provider");
}
