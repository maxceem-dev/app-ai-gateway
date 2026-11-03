import { AUDIENCE, ISSUER, REQUIRED_CLAIM } from "./issuer.ts";
import { FAILING_MODELS, MODEL, type Format } from "./mock/formats.ts";

/**
 * What the test account holds. `setup` creates whatever is missing and puts
 * back whatever drifted, so it is safe to run before every test run.
 *
 * Everything is named with the `smoke-` prefix; anything named `smoke-tmp-` is
 * created by a test's own write cycle and swept by `setup` once it is stale.
 */

/** One mock provider per wire format, each pointing at its prefix on the mock. */
export const PROVIDERS: { slug: string; type: string; format: Format }[] = [
  { slug: "smoke-openai", type: "openai", format: "openai" },
  { slug: "smoke-anthropic", type: "anthropic", format: "anthropic" },
  { slug: "smoke-gemini", type: "gemini", format: "gemini" },
];

/**
 * A price for every mock model, in USD per million tokens: the gateway refuses
 * a model it cannot cost, and the failing models must reach the mock to fail.
 */
export const PRICING = Object.fromEntries(
  [MODEL, ...Object.keys(FAILING_MODELS)].map((model) => [model, { input: 1, output: 2 }]),
);

export const APP_NAMES = {
  server: "smoke-server",
  signedIn: "smoke-signed-in",
  ios: "smoke-ios",
} as const;

export const ENDPOINT_SLUG = "smoke-chat";
export const TEMPORARY_PREFIX = "smoke-tmp-";

const ROUTING = { providers: { mode: "all" }, model_rewrites: {} };

/** The configuration each fixture application should have, given where the mock answers. */
export function appConfigs(mockUrl: string): Record<keyof typeof APP_NAMES, Record<string, unknown>> {
  return {
    // A backend calling with its key alone, and a custom endpoint on it.
    server: {
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: ROUTING,
      endpoints: {
        [ENDPOINT_SLUG]: { provider: "smoke-openai", model: MODEL, api_style: "responses" },
      },
    },
    // Signed-in users from the test issuer, with a required claim standing in
    // for a paid entitlement: the iOS sign-in path minus App Attest.
    signedIn: {
      authentication: {
        type: "api_key",
        end_user: {
          source: "issuer",
          issuer: {
            jwks_url: `${mockUrl}/.well-known/jwks.json`,
            issuer: ISSUER,
            audience: AUDIENCE,
            user_id_claim: "sub",
            required_claims: [REQUIRED_CLAIM],
            max_token_lifetime_seconds: 3600,
            provider: "custom",
            entitlement: "custom",
          },
        },
      },
      routing: ROUTING,
    },
    // App Attest cannot be produced off a device, so this application is only
    // ever asked to refuse; the checks make sure it refuses cleanly.
    ios: {
      authentication: {
        type: "apple_app_attest",
        end_user: { source: "app_install" },
        app_attest: { team_id: "SMOKETEST0", bundle_id: "com.example.smoke" },
      },
      routing: ROUTING,
    },
  };
}
