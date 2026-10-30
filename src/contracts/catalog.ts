/**
 * Every documented operation this gateway serves, as one entry each.
 *
 * This is the single place an endpoint is declared: its method, its path, the
 * parameters and body it takes, the body it answers with, and the prose the
 * published document carries. Everything else is derived from it —
 * `./openapi.ts` turns each entry into an OpenAPI operation, the console and
 * the CLI send and parse through it, and `src/routes/catalog-router.ts` mounts
 * the Hono handler on the path written here. Adding an endpoint means adding an
 * entry and mounting a handler; there is nothing else to keep in step.
 *
 * Plain `zod`, never `@hono/zod-openapi`: the console and the CLI both import
 * this module, and neither may pull Hono in behind it. `.meta({ description })`
 * produces the same document `.openapi({ description })` does.
 */
import { z } from "zod";
import { REJECTION_REASONS, REJECTION_SCOPES } from "../shared/rejection-reasons.ts";
import {
  BillingCancelResponseSchema,
  BillingChangeResponseSchema,
  BillingCheckoutRequestSchema,
  BillingCheckoutResponseSchema,
  BillingAccessSchema,
  BillingPlanSelectionSchema,
  BillingPlansResponseSchema,
  BillingStatusResponseSchema,
  BillingTrialRequestSchema,
} from "./billing.ts";
import {
  CliBootstrapRequestSchema,
  CliBrowserDetailsResponseSchema,
  CliBrowserProofSchema,
  CliBrowserRegisterRequestSchema,
  CliBrowserSubmitRequestSchema,
  CliBrowserGoogleResponseSchema,
  CliBrowserRegisterResponseSchema,
  CliBrowserSubmitResponseSchema,
  CliBrowserDenyResponseSchema,
  CliBrowserLookupRequestSchema,
  CliBrowserLookupResponseSchema,
  CliCapabilitiesResponseSchema,
  CliCredentialRevokeResponseSchema,
  CliLoginRedeemRequestSchema,
  CliLoginRedeemResponseSchema,
  CliLoginRequestSchema,
  CliLoginSchema,
  CliOperationRequestSchema,
  CliOperationSchema,
  CliUsageResponseSchema,
  CliAccountResponseSchema,
} from "./cli.ts";
import {
  ApiKeyCreateRequestSchema,
  ApiKeyTokenRequestSchema,
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
  AppSnippetQuerySchema,
  AppUpdateSchema,
  AppWriteSchema,
  GoogleSignInRequestSchema,
  ManagementKeyCreateRequestSchema,
  MonthSchema,
  OAuthConsentAllowRequestSchema,
  OAuthConsentProofSchema,
  SendVerificationEmailRequestSchema,
  SupportMessageRequestSchema,
  ConfirmEmailVerificationRequestSchema,
  OrganizationSelectRequestSchema,
  PROVIDER_SLUG_PATTERN,
  ProviderCreateRequestSchema,
  ProviderGatewayCreateRequestSchema,
  ProviderGatewayRotateRequestSchema,
  ProviderGatewayTestRequestSchema,
  ProviderGatewayUpdateRequestSchema,
  ProviderTestRequestSchema,
  ProviderUpdateRequestSchema,
  UsageRepriceRequestSchema,
} from "./schemas.ts";
import {
  ApiKeyListResponseSchema,
  ApiKeyRevokeResponseSchema,
  AppAttestChallengeResponseSchema,
  AppAttestRegisterResponseSchema,
  AppCheckResponseSchema,
  AppDeleteResponseSchema,
  AppListResponseSchema,
  AppResponseSchema,
  AppDraftValidateResponseSchema,
  AppSnippetResponseSchema,
  AppValidateResponseSchema,
  AuthEventListSchema,
  AuthEventSummarySchema,
  RejectionEventListSchema,
  BreakdownResponseSchema,
  ConsoleCapabilitiesResponseSchema,
  CreatedApiKeySchema,
  CreatedAppResponseSchema,
  CreatedManagementKeyResponseSchema,
  CurrentUserResponseSchema,
  GatewayTokenResponseSchema,
  GoogleSignInResponseSchema,
  HealthResponseSchema,
  IdentitySessionSchema,
  ManagementKeyListResponseSchema,
  ManagementKeyResponseSchema,
  MonthlyUsageResponseSchema,
  OAuthConsentDetailsResponseSchema,
  OAuthConsentRedirectResponseSchema,
  SendVerificationEmailResponseSchema,
  SupportMessageResponseSchema,
  ConfirmEmailVerificationResponseSchema,
  OrganizationListResponseSchema,
  PricesResponseSchema,
  ProviderDeleteResponseSchema,
  ProviderGatewayDeleteResponseSchema,
  ProviderGatewayListResponseSchema,
  ProviderGatewayResponseSchema,
  ProviderGatewayTestResponseSchema,
  ProviderListResponseSchema,
  ProviderResponseSchema,
  ProviderTestResponseSchema,
  OperationStatusResponseSchema,
  RevealedOperationResponseSchema,
  TimeseriesResponseSchema,
  UsageEventListSchema,
  UsageRepriceResponseSchema,
  UserBlockResponseSchema,
  UserListResponseSchema,
  UserResponseSchema,
  USAGE_BREAKDOWN_DIMENSIONS,
  USAGE_STATUSES,
} from "./responses.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Which credential reaches an operation, named rather than spelled out: the
 * arrays these map to are the document's, and live in `./openapi.ts`.
 */
export type SecurityKind = "public" | "session" | "management" | "gateway" | "cliPoll";

/** Documentation for one `{name}` segment of an operation's path. */
export interface PathParameterSpec {
  description?: string;
  example?: string;
  pattern?: RegExp;
}

export interface OperationSpec {
  readonly method: HttpMethod;
  /** OpenAPI template, e.g. `/v1/admin/apps/{app}/keys/{key}/revoke`. The only place a path is written. */
  readonly path: string;
  /** Per-parameter docs, keyed by the names in `path`. */
  readonly params?: Readonly<Record<string, PathParameterSpec>>;
  readonly query?: z.ZodObject;
  readonly headers?: z.ZodObject;
  /**
   * The request body. A bare schema is a required `application/json` body; the
   * object form exists for the two endpoints that also accept multipart.
   */
  readonly request?:
    | z.ZodType
    | { readonly required?: boolean; readonly content: Readonly<Record<string, z.ZodType>> };
  /** The success body, or {@link NO_RESPONSE_BODY} where the answer has none. */
  readonly response: z.ZodType;
  /** What the success response means, as the document publishes it. */
  readonly responseDescription: string;
  readonly status?: 200 | 201 | 302;
  /**
   * Extra documented error responses, status → description. The shared
   * 400/401/403/404 set is added to every entry; `"none"` leaves an operation
   * with its success response alone, for the two that cannot refuse.
   */
  readonly errors?: Readonly<Record<number, string>> | "none";
  readonly tags: readonly string[];
  readonly summary: string;
  readonly description?: string;
  readonly security: SecurityKind;
  /**
   * Management-surface authorization, for `security: "management" | "session"`
   * entries, applied by `runOperation` in `src/management/executor.ts` before
   * the handler runs.
   *
   * Defaults are the shape of the surface rather than a list: `GET` reads, so
   * `{ role: "member", access: "read" }`; anything else writes, so
   * `{ role: "admin", access: "setup" }`. Only an operation that departs from
   * that says so here, and it says so beside its own path instead of in a
   * regex in another file. `session: true` requires an interactive browser
   * session, which only a human has; a `session` security entry additionally
   * refuses a management key. `grant` is the least credential grant the
   * caller needs, `manage` for anything but a `GET`; only an operation that
   * changes nothing despite its method — a dry-run validation, a key ending
   * itself — says `read`.
   */
  readonly policy?: {
    readonly role?: "member" | "admin";
    readonly access?: "read" | "setup";
    readonly session?: true;
    readonly grant?: "read" | "manage";
  };
  /** Registered in the full document but not the published one. */
  readonly hidden?: true;
}

// ---------------------------------------------------------------------------
// Shared prose. Written once because several operations answer with the same
// sentence, and a second copy is a second thing to keep true.
// ---------------------------------------------------------------------------

const NO_PLAN = "No billing plan resolves for the account.";
const APP_AUTH_RATE_LIMITED =
  "Too many application authentication requests from this network address for this application. Carries Retry-After.";
const NO_END_USERS =
  "This application identifies no end users, so there is no per-user standing to report. Answered with auth_method_not_supported: the request was well-formed, and nothing the caller can rephrase would make it work.";
const DATA_PLANE_RATE_LIMITED =
  "Either the app's own limits or the account's request allowance refused the request. The app's limits are checked first and answer app_rate_limited or app_budget_exhausted, carrying scope; the plan allowance answers billing_request_quota_exceeded with limit, used, and the UTC resetAt. Every one of them carries a Retry-After header.";

/**
 * What an issuer-token exchange can refuse with, split by what the client
 * should do about it. Three codes and no more: a finer split would publish
 * causes no client can act on differently.
 */
const ISSUER_ERRORS = {
  403: "`issuer_token_rejected` — the token did not verify; get a fresh one, retry once, then fail. `issuer_claims_missing` — the token is valid but a required entitlement claim has not propagated yet; do not re-authenticate, wait and retry. `auth_required` — the key was refused or the user is blocked. `attest_failed` — the App Attest proof did not hold.",
  503: "`issuer_verification_unavailable` — the gateway could not reach or read the issuer's keys, so the token was never judged. Retry with backoff.",
} as const;

/**
 * Every client call that is not a served request can meet this: the platform
 * failing underneath the gateway, or the call running past its deadline.
 */
const SERVICE_UNAVAILABLE =
  "`service_unavailable` — the gateway's database or one of its Durable Objects failed or was overloaded, or the call ran past its ten-second deadline. Nothing about the request is known to be wrong. Carries Retry-After; retry after it with backoff.";

/** The three refusals every CLI handoff endpoint shares. */
const CLI_ERRORS = {
  409: "A conflicting transition or setup cap prevents this operation.",
  410: "The protected credential exchange has expired; no replacement is minted.",
  429: "The durable initiation or submission rate limit was reached.",
} as const;

/** The refusals every OAuth consent call shares, beside the shared set. */
const CONSENT_ERRORS = {
  409: "The authorization was denied, already completed by another choice, or the account the choice needed is gone; nothing was written.",
  410: "The authorization lapsed: it is open for ten minutes. Start the connection again from the client.",
} as const;

const CONSENT_DESCRIPTION =
  "The API of the console's OAuth consent page, which an MCP client's authorization request sends a person to. First-party browser only: both the request URL origin and the exact Origin header must match the console origin, and `submissionToken` is the proof from the consent page URL's fragment, so it never travels in a URL. Allowing, continuing without an account and denying each answer the `redirect` to send the browser to, and answer it again, byte for byte, when repeated with the same proof.";

const BROWSER_HANDOFF_DESCRIPTION =
  "First-party browser only: both the request URL origin and exact Origin header must match consoleOrigin; a separate submissionToken is required — the proof from the approval URL's fragment, or, for a login, the user code the terminal shows. Identity approval (a claim or a login) also requires an interactive human session; registration is limited to a valid pending claim or login. Provider secret values are write-only.";

// ---------------------------------------------------------------------------
// Bodies this gateway documents but does not own: Better Auth's console
// sign-in surface, and the provider-native bodies the proxy forwards verbatim.
// ---------------------------------------------------------------------------

const SignUpRequestSchema = z.object({
  name: z.string(),
  email: z.email(),
  password: z.string().min(8),
});
const SignInRequestSchema = z.object({ email: z.email(), password: z.string() });

const ProviderNativeBodySchema = z.record(z.string(), z.unknown()).meta({
  description:
    "Provider-native JSON request. Consult the selected provider's API reference for the exact shape.",
});
const EndpointJsonBodySchema = z.record(z.string(), z.unknown()).meta({
  description:
    "The JSON body the endpoint's api_style takes: an OpenAI Responses, Chat Completions, image generation or embeddings body, an Anthropic Messages body, or a Gemini generateContent or embedContent body. The gateway sets the configured model (in the body, or in the URL for the Gemini styles) and deep-merges the configured params.",
});
const TranscriptionStyleBodySchema = z.object({
  file: z.string().meta({ format: "binary" }),
  model: z.string().optional().meta({ description: "Ignored; the gateway sets the configured model." }),
  prompt: z.string().optional(),
  language: z.string().optional(),
  response_format: z.string().optional(),
}).meta({ description: "Body for endpoints whose api_style is audio_transcription." });

/** What an application client sends beside its credential. */
const GatewayClientHeadersSchema = z.object({
  "x-app-version": z.string().optional().meta({
    description: "Required for gateway-token clients; optional for issuer-less API-key clients.",
  }),
  "x-appattest-proof": z.string().regex(/^v1\.[0-9]{1,12}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/).optional().meta({
    description:
      "Required on every request sent with the gateway token of an App Attest application whose authentication.app_attest.verify_on is every_request; ignored, and never forwarded, where verify_on is token_exchange and for API-key clients. Format `v1.<timestamp>.<nonce>.<assertion>`: decimal unix seconds from the device clock (signed, but not compared with the gateway's clock), 16 random bytes as base64url without padding, and the CBOR assertion from DCAppAttestService.generateAssertion as base64url without padding. The assertion's client data is the SHA-256 of these lines joined by \\n with no trailing newline: `appaigateway-request-v1`, the app id, the upper-case HTTP method, the URL path and query exactly as sent, base64url(sha256(body bytes)) (an absent body hashes as empty), base64url(sha256(the bearer token)), the timestamp, and the nonce. Missing answers 401 assertion_required; refused answers 403 attest_failed. The AppAIGateway Swift package 1.4 or later computes it.",
  }),
  "x-end-user-id": z.string().optional().meta({
    description: "Optional configured end-user identity for issuer-less API-key applications.",
  }),
});

// Query strings are parsed with these by the router before a handler runs, so
// a handler reads typed values and never re-checks one. Numbers are coerced,
// because a query string has no other kind of value.
const MonthQuerySchema = z.object({
  month: MonthSchema.optional().meta({ description: "YYYY-MM; defaults to the current UTC month." }),
});
const DaySchema = (name: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: `${name} must use YYYY-MM-DD format` });
const RangeQuerySchema = z.object({
  from: DaySchema("from").optional().meta({ description: "Inclusive YYYY-MM-DD start; defaults to 29 days before `to`." }),
  to: DaySchema("to").optional().meta({ description: "Inclusive YYYY-MM-DD end; defaults to today." }),
});
/** A page size: 50 unless asked, and never more than 200. */
const PageLimitSchema = z.coerce.number()
  .int({ error: "limit must be an integer between 1 and 200" })
  .min(1, { error: "limit must be an integer between 1 and 200" })
  .max(200, { error: "limit must be an integer between 1 and 200" })
  .default(50);
/** Keyset paging: only rows older than this id. */
const BeforeIdSchema = z.coerce.number()
  .int({ error: "before_id must be a positive integer" })
  .positive({ error: "before_id must be a positive integer" })
  .optional()
  .meta({ description: "Page backwards: only events older than this id." });

const APP_PARAM = { app: { example: "my-app" } } as const;

/**
 * The success response of the one operation that answers with no body at all.
 *
 * Written as a schema rather than as a missing field so that every entry has a
 * `response`: a lookup that has to ask whether one is there stays unresolved
 * while the operation name is still generic, and an unresolved type is no
 * contextual type — a handler written against it would have its `true` widened
 * to `boolean` and then be rejected for it.
 */
export const NO_RESPONSE_BODY = z.never();

export const CATALOG = {
  getHealth: {
    method: "GET",
    path: "/v1/healthz",
    tags: ["Operations"],
    summary: "Check gateway health",
    security: "public",
    response: HealthResponseSchema,
    responseDescription: "The Worker is accepting requests.",
    errors: "none",
  },

  getConsoleCapabilities: {
    method: "GET",
    path: "/v1/console/capabilities",
    tags: ["Operations"],
    summary: "Discover optional deployment capabilities",
    security: "public",
    response: ConsoleCapabilitiesResponseSchema,
    responseDescription: "Capabilities the console adapts to.",
    errors: "none",
  },

  signUp: {
    method: "POST",
    path: "/v1/auth/sign-up/email",
    tags: ["Console authentication"],
    summary: "Create an account",
    security: "public",
    request: SignUpRequestSchema,
    response: z.unknown(),
    responseDescription: "Authenticated session.",
  },

  // Only the password route is throttled by the gateway, so the two console
  // authentication routes do not document the same responses.
  signIn: {
    method: "POST",
    path: "/v1/auth/sign-in/email",
    tags: ["Console authentication"],
    summary: "Sign in with email and password",
    security: "public",
    request: SignInRequestSchema,
    response: z.unknown(),
    responseDescription: "Authenticated session.",
    errors: {
      429: "Too many sign-in attempts. Counted twice over: per client address, and per email address so that a spread of addresses cannot grind through one account's passwords. Carries Retry-After.",
    },
  },

  getSession: {
    method: "GET",
    path: "/v1/auth/get-session",
    tags: ["Console authentication"],
    summary: "Get the current session",
    security: "session",
    response: z.unknown(),
    responseDescription: "Current session or null.",
  },

  signOut: {
    method: "POST",
    path: "/v1/auth/sign-out",
    tags: ["Console authentication"],
    summary: "End the current session",
    security: "session",
    response: z.unknown(),
    responseDescription: "Session ended.",
  },

  signInWithGoogle: {
    method: "POST",
    path: "/v1/auth/sign-in/social",
    tags: ["Console authentication"],
    summary: "Start optional Google sign-in",
    description: "Available only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are configured. Send provider=google in the JSON body, with optional success and error callback URLs. The console uses callbackURL to restore its destination and errorCallbackURL to return to sign-in with the error. Navigate the browser to the URL in the JSON response to continue the Google flow.",
    security: "public",
    request: GoogleSignInRequestSchema,
    status: 200,
    response: GoogleSignInResponseSchema,
    responseDescription: "Google authorization URL and redirect indicator.",
  },

  createAppAttestChallenge: {
    method: "POST",
    path: "/v1/apps/{app}/auth/challenge",
    tags: ["Application authentication"],
    summary: "Create an App Attest challenge",
    security: "public",
    params: APP_PARAM,
    response: AppAttestChallengeResponseSchema,
    responseDescription: "A five-minute, single-use challenge.",
    errors: { 402: NO_PLAN, 429: APP_AUTH_RATE_LIMITED, 404: NO_END_USERS, 503: SERVICE_UNAVAILABLE },
  },

  registerAppAttestKey: {
    method: "POST",
    path: "/v1/apps/{app}/auth/register",
    tags: ["Application authentication"],
    summary: "Register an App Attest key",
    security: "public",
    params: APP_PARAM,
    request: AppAttestRegisterRequestSchema,
    response: AppAttestRegisterResponseSchema,
    responseDescription: "The key was registered for the verified issuer identity.",
    errors: {
      ...ISSUER_ERRORS,
      402: NO_PLAN,
      429: APP_AUTH_RATE_LIMITED,
      503: `${ISSUER_ERRORS[503]} ${SERVICE_UNAVAILABLE}`,
    },
  },

  exchangeGatewayToken: {
    method: "POST",
    path: "/v1/apps/{app}/auth/token",
    tags: ["Application authentication"],
    summary: "Exchange a client proof for a gateway token",
    description: "App Attest clients send key_id, assertion, and challenge; the assertion is verified here whatever the application's verify_on, and the answer's verify_on says whether requests sent with the token must also carry X-AppAttest-Proof. Issuer-backed API-key clients send api_key and issuer_token. The verified issuer claim is always the resulting user identity.",
    security: "public",
    params: APP_PARAM,
    request: z.union([AppAttestTokenRequestSchema, ApiKeyTokenRequestSchema]),
    response: GatewayTokenResponseSchema,
    responseDescription: "A short-lived gateway access token.",
    errors: {
      ...ISSUER_ERRORS,
      402: NO_PLAN,
      429: APP_AUTH_RATE_LIMITED,
      503: `${ISSUER_ERRORS[503]} ${SERVICE_UNAVAILABLE}`,
    },
  },

  getCurrentUser: {
    method: "GET",
    path: "/v1/apps/{app}/me",
    tags: ["Application"],
    summary: "Get the current user's limits, spend and block state",
    description: "On an App Attest application the request limits and, by default, the budget are the install's; install_id names it. Signed with X-AppAttest-Proof like every other request where the application verifies App Attest on every request.",
    security: "gateway",
    params: APP_PARAM,
    headers: GatewayClientHeadersSchema,
    response: CurrentUserResponseSchema,
    responseDescription: "Current user state.",
    errors: { 402: NO_PLAN, 404: NO_END_USERS, 503: SERVICE_UNAVAILABLE },
  },

  proxyProviderRequest: {
    method: "POST",
    path: "/v1/apps/{app}/proxy/{provider}/{path}",
    tags: ["Provider proxy"],
    summary: "Proxy a provider-native model request",
    description: "The path, body, and successful response retain the selected provider's native contract. For example, OpenAI clients send v1/responses or v1/chat/completions; gateway-specific provider slug quirks are never part of the client path. The gateway validates the configured path and model, spends one request from the account's monthly allowance, and streams the upstream response without buffering.",
    security: "gateway",
    params: {
      app: { example: "my-app" },
      provider: { example: "openai-dev", pattern: PROVIDER_SLUG_PATTERN },
      path: {
        description: "The provider's native API path verbatim, without a leading slash.",
        example: "v1/responses",
      },
    },
    headers: GatewayClientHeadersSchema,
    request: ProviderNativeBodySchema,
    response: z.unknown(),
    responseDescription: "Provider-native response. Streaming responses remain streamed.",
    errors: {
      402: NO_PLAN,
      429: DATA_PLANE_RATE_LIMITED,
      502: "The upstream provider request failed.",
      504: "The upstream provider sent no response headers within the gateway's time-to-first-byte budget.",
    },
  },

  callNamedEndpoint: {
    method: "POST",
    path: "/v1/apps/{app}/endpoints/{slug}",
    tags: ["Custom endpoints"],
    summary: "Call a server-configured custom endpoint",
    description: "The endpoint's provider, model, fixed parameters, output cap, and fallback chain come from the application configuration, so you can change models without shipping a client release. The body is the one the endpoint's api_style takes, without a model: JSON for every style but audio_transcription, which takes an OpenAI audio transcription multipart body. A gemini_native endpoint streams when the request URL carries alt=sse, as Gemini's own API does; every other style streams as its body asks. The successful response keeps the serving provider's native format and streaming behaviour.",
    security: "gateway",
    params: {
      app: { example: "my-app" },
      slug: { example: "chat", pattern: /^[a-z0-9-]{1,64}$/ },
    },
    query: z.object({
      alt: z.literal("sse").optional().meta({
        description: "gemini_native endpoints only: `sse` streams the response as server-sent events, as Gemini's own API does. Never forwarded upstream.",
      }),
    }),
    headers: GatewayClientHeadersSchema,
    request: {
      content: {
        "application/json": EndpointJsonBodySchema,
        "multipart/form-data": TranscriptionStyleBodySchema,
      },
    },
    response: z.unknown(),
    responseDescription: "Provider-native response. Streaming responses remain streamed.",
    errors: {
      402: NO_PLAN,
      429: DATA_PLANE_RATE_LIMITED,
      502: "Every configured target failed.",
      504: "Every configured target failed, and the last one sent no response headers within the gateway's time-to-first-byte budget.",
    },
  },

  listApps: {
    method: "GET",
    path: "/v1/admin/apps",
    tags: ["Admin applications"],
    summary: "List applications",
    security: "management",
    query: MonthQuerySchema,
    response: AppListResponseSchema,
    responseDescription: "Applications and current usage summaries.",
  },

  createApp: {
    method: "POST",
    path: "/v1/admin/apps",
    tags: ["Admin applications"],
    summary: "Create an application",
    description: "Send only `name`, `config` and an optional `status`. The gateway assigns the id — the name slugified plus a six-character random suffix — and returns it as `app.id`; it cannot be chosen, and it cannot change once the application exists. A body that still carries `id` is refused with `400`. API-key applications receive a one-time plaintext initial key in the response.",
    security: "management",
    request: AppWriteSchema,
    status: 201,
    response: CreatedAppResponseSchema,
    responseDescription: "Application created. `app.id` is the assigned id and the segment every gateway URL for this app uses. `api_key` is the one-time plaintext initial key for an API-key application, and null for any other.",
    errors: {
      409: "`invalid_request` — no unique generated id could be allocated after repeated attempts. Retrying is safe.",
    },
  },

  listBillingPlans: {
    method: "GET",
    path: "/v1/admin/billing/plans",
    hidden: true,
    tags: ["Admin billing"],
    summary: "List billing plans",
    security: "management",
    // The whole billing subtree is a person's to act on: a service credential
    // may run an account but may not buy, change or cancel what pays for it.
    policy: { session: true },
    response: BillingPlansResponseSchema,
    responseDescription: "Billing service response.",
  },

  getBillingStatus: {
    method: "GET",
    path: "/v1/admin/billing/status",
    hidden: true,
    tags: ["Admin billing"],
    summary: "Get billing access and the current allowance period",
    security: "management",
    policy: { session: true },
    response: BillingStatusResponseSchema,
    responseDescription:
      "Billing access, and the current period against the plan's request allowance when an entitlement resolves.",
  },

  startCheckout: {
    method: "POST",
    path: "/v1/admin/billing/checkout",
    hidden: true,
    tags: ["Admin billing"],
    summary: "Create a hosted checkout",
    security: "management",
    policy: { session: true },
    request: BillingCheckoutRequestSchema,
    response: BillingCheckoutResponseSchema,
    responseDescription: "Hosted checkout URL.",
  },

  changePlan: {
    method: "POST",
    path: "/v1/admin/billing/change",
    hidden: true,
    tags: ["Admin billing"],
    summary: "Change the subscription plan",
    security: "management",
    policy: { session: true },
    request: BillingPlanSelectionSchema,
    response: BillingChangeResponseSchema,
    responseDescription: "Billing service response.",
  },

  resumeSubscription: {
    method: "POST",
    path: "/v1/admin/billing/resume",
    hidden: true,
    tags: ["Admin billing"],
    summary: "Resume a canceled subscription",
    security: "management",
    policy: { session: true },
    request: BillingPlanSelectionSchema,
    response: BillingChangeResponseSchema,
    responseDescription: "Billing service response.",
  },

  cancelSubscription: {
    method: "POST",
    path: "/v1/admin/billing/cancel",
    hidden: true,
    tags: ["Admin billing"],
    summary: "Cancel the subscription at period end",
    security: "management",
    policy: { session: true },
    response: BillingCancelResponseSchema,
    responseDescription: "Cancellation accepted.",
  },

  startTrial: {
    method: "POST",
    path: "/v1/admin/billing/trial",
    hidden: true,
    tags: ["Admin billing"],
    summary: "Start a no-card trial",
    security: "management",
    policy: { session: true },
    request: BillingTrialRequestSchema,
    response: BillingAccessSchema,
    responseDescription: "Trial access state.",
  },

  /*
   * Support is part of a paid plan, so it sits with billing: the Support menu
   * is offered only to an organization on one, and this refuses everyone else
   * the same way. Any member may write, read-only ones included — reporting a
   * bug changes nothing in the account.
   */
  sendSupportMessage: {
    method: "POST",
    path: "/v1/admin/support",
    hidden: true,
    tags: ["Admin billing"],
    summary: "Send a message to support",
    security: "management",
    policy: { role: "member", access: "read", session: true },
    request: SupportMessageRequestSchema,
    response: SupportMessageResponseSchema,
    responseDescription: "The message went to the support inbox; replies go to the sender.",
    errors: {
      403: "The organization is not on a paid plan (`forbidden`).",
      409: "The sign-in has no email address to reply to (`conflict`).",
      429: "Too many messages were sent from this sign-in. Carries Retry-After.",
      503: "The deployment could not send the email (`email_unavailable`).",
    },
  },

  getApp: {
    method: "GET",
    path: "/v1/admin/apps/{app}",
    tags: ["Admin applications"],
    summary: "Get an application",
    security: "management",
    params: APP_PARAM,
    response: AppResponseSchema,
    responseDescription: "Application state.",
  },

  updateApp: {
    method: "PUT",
    path: "/v1/admin/apps/{app}",
    tags: ["Admin applications"],
    summary: "Update an application",
    description: "Requires `revision` in the body, the one the application was read at; a stale revision answers `409 app_revision_conflict` and an absent one `400 app_revision_required`. Updates an existing application in place. It never creates one: an id none of your applications holds answers `404 app_not_found`, and nothing is written. Applications are created only by `POST /v1/admin/apps`, which assigns the id.",
    security: "management",
    params: APP_PARAM,
    request: AppUpdateSchema,
    response: AppResponseSchema,
    responseDescription: "Application state.",
    errors: { 409: "The application changed since it was read." },
  },

  validateApp: {
    method: "POST",
    path: "/v1/admin/apps/{app}/validate",
    tags: ["Admin applications"],
    summary: "Validate an edit of an application without saving it",
    description: "Judged as an update of this application would be: provider slugs its stored configuration already names stay acceptable even if their provider has since been deleted. Use the draft validation for an application that does not exist yet.",
    security: "management",
    // A POST that stores nothing: it answers whether a body would be accepted,
    // which is a read of the configuration rules and not a write.
    policy: { role: "member", access: "read", grant: "read" },
    params: APP_PARAM,
    request: AppWriteSchema,
    response: AppValidateResponseSchema,
    responseDescription: "Resolved valid configuration.",
  },

  validateAppDraft: {
    method: "POST",
    path: "/v1/admin/app-drafts/validate",
    tags: ["Admin applications"],
    summary: "Validate a new application configuration without saving it",
    description: "Judged as a creation would be, against the account's current providers and prices.",
    security: "management",
    policy: { role: "member", access: "read", grant: "read" },
    request: AppWriteSchema,
    response: AppDraftValidateResponseSchema,
    responseDescription: "The configuration would be accepted.",
  },

  checkApp: {
    method: "GET",
    path: "/v1/admin/apps/{app}/check",
    tags: ["Admin applications"],
    summary: "Check whether an application is ready to serve requests",
    description: "Validates the stored configuration as an update of it would be judged, lists every provider its routing names with that provider's status — a disabled one included — and reports `ready` when the application is active and at least one of those providers is active. It sends no inference: App Attest on a physical device, issuer sign-in, subscription entitlements and the upstream credentials themselves are not exercised, and `limitations` says so in every answer. A stored configuration that would no longer be accepted answers `400 invalid_request` with the reason.",
    security: "management",
    params: APP_PARAM,
    response: AppCheckResponseSchema,
    responseDescription: "What the check established, and what it did not exercise.",
  },

  getAppSnippet: {
    method: "GET",
    path: "/v1/admin/apps/{app}/snippet",
    tags: ["Admin applications"],
    summary: "Get the first request an application can send",
    description: "Written against what the application has today: a provider it can reach and a priced model where those exist, and named placeholders, explained in `notes`, where they do not. An App Attest application gets Swift for the App AI Gateway Swift package and a server application gets curl; asking for the other answers `400 unsupported_snippet`. The URL is the one application clients call, which is this deployment's separate API host where it publishes one. A snippet never contains a credential: a server application's example reads its key from the `APP_AI_GATEWAY_KEY` environment variable.",
    security: "management",
    params: APP_PARAM,
    query: AppSnippetQuerySchema,
    response: AppSnippetResponseSchema,
    responseDescription: "The example, its language and the notes written into it.",
  },

  deleteApp: {
    method: "DELETE",
    path: "/v1/admin/apps/{app}",
    tags: ["Admin applications"],
    summary: "Delete an application and its associated operational data",
    security: "management",
    params: APP_PARAM,
    query: z.object({
      confirm: z.string({ error: "Pass ?confirm=<app-id> to delete an app" }),
    }),
    response: AppDeleteResponseSchema,
    responseDescription:
      "Application deleted. Its usage events are kept, which is what `usage_events_retained` reports.",
  },

  listManagementKeys: {
    method: "GET",
    path: "/v1/admin/keys",
    tags: ["Admin management keys"],
    summary: "List management keys",
    description: "Console session only. Management keys cannot administer management keys.",
    security: "session",
    response: ManagementKeyListResponseSchema,
    responseDescription: "Management key metadata without plaintext tokens.",
  },

  createManagementKey: {
    method: "POST",
    path: "/v1/admin/keys",
    tags: ["Admin management keys"],
    summary: "Create a management key",
    description: "Console session only, and requires the owner or admin role. A management key cannot create another one, so revoking a key you handed out ends that access for good. The plaintext agw_mgmt_ token is returned once, and never expires; the account's own deadline is the only one. A key created with the `read` grant cannot change your apps, providers or settings: a change its owner's role would otherwise allow is refused with `403 grant_insufficient`, and the key may still revoke itself.",
    security: "session",
    request: ManagementKeyCreateRequestSchema,
    status: 201,
    response: CreatedManagementKeyResponseSchema,
    responseDescription: "One-time plaintext management key.",
  },

  revokeManagementKey: {
    method: "POST",
    path: "/v1/admin/keys/{id}/revoke",
    tags: ["Admin management keys"],
    summary: "Revoke a management key",
    description: "Console session only, and requires the owner or admin role.",
    security: "session",
    params: { id: { example: "key_123" } },
    response: ManagementKeyResponseSchema,
    responseDescription: "Revoked management key metadata.",
  },

  listProviders: {
    method: "GET",
    path: "/v1/admin/providers",
    tags: ["Admin providers"],
    summary: "List provider credentials",
    security: "management",
    response: ProviderListResponseSchema,
    responseDescription: "Provider metadata without credentials.",
  },

  createProvider: {
    method: "POST",
    path: "/v1/admin/providers",
    tags: ["Admin providers"],
    summary: "Store a provider credential",
    description:
      "Creates one named provider instance. Supply exactly one direct provider secret or reusable providerGatewayId. The credential is stored as given and never probed: check one first with POST /v1/admin/providers/test. The slug defaults to the provider type and is unique among your provider instances, disabled ones included; only deleting an instance frees its slug.",
    security: "management",
    request: ProviderCreateRequestSchema,
    status: 201,
    response: ProviderResponseSchema,
    responseDescription: "Stored provider.",
    errors: { 409: "The requested active provider slug is already in use." },
  },

  testProviderCredential: {
    method: "POST",
    path: "/v1/admin/providers/test",
    tags: ["Admin providers"],
    summary: "Probe a provider credential without storing it",
    description:
      "Calls the provider with a credential, and reports what it answered. Nothing is stored, and no other endpoint runs this check: a write stores what it is given. Supply exactly one direct provider secret or an existing providerGatewayId.",
    security: "management",
    request: ProviderTestRequestSchema,
    response: ProviderTestResponseSchema,
    responseDescription: "Probe outcome.",
  },

  updateProvider: {
    method: "PUT",
    path: "/v1/admin/providers/{id}",
    tags: ["Admin providers"],
    summary: "Update, rotate or disable a provider credential",
    description:
      "Requires the revision returned by the provider read this edit is based on; a stale revision returns 409 conflict. Sending status disables or re-enables the instance. Disabling keeps the secret, the pricing and the slug, so requests to it fail with provider_disabled and no other instance can take its slug meanwhile. Re-enabling does not require reclaiming the slug. Sending a non-null baseUrl also requires secret in the same request: the stored key is write-only and is never decrypted to be sent to an origin it has not been sent to before, so a move carries the key it is to be used with. Sending baseUrl: null returns the instance to its provider type's own origin and needs nothing else.",
    security: "management",
    params: { id: { example: "b0a1…" } },
    request: ProviderUpdateRequestSchema,
    response: ProviderResponseSchema,
    responseDescription: "Updated provider.",
  },

  deleteProvider: {
    method: "DELETE",
    path: "/v1/admin/providers/{id}",
    tags: ["Admin providers"],
    summary: "Delete a provider credential and its custom pricing",
    description:
      "A hard delete, secret and pricing included. Applications using this provider start failing with provider_not_configured within a minute. To pause an instance reversibly instead, send status: \"disabled\" to PUT /v1/admin/providers/{id}.",
    security: "management",
    params: { id: { example: "b0a1…" } },
    response: ProviderDeleteResponseSchema,
    responseDescription: "Provider deleted.",
  },

  listProviderGateways: {
    method: "GET",
    path: "/v1/admin/provider-gateways",
    tags: ["Admin provider gateways"],
    summary: "List reusable provider gateways",
    security: "management",
    response: ProviderGatewayListResponseSchema,
    responseDescription: "Provider gateway metadata without tokens.",
  },

  createProviderGateway: {
    method: "POST",
    path: "/v1/admin/provider-gateways",
    tags: ["Admin provider gateways"],
    summary: "Create a reusable provider gateway connection",
    description: "Cloudflare AI Gateway takes an account and gateway id; Vercel AI Gateway takes only a name and a token. The token is encrypted and stored as given, never probed: check a connection first with POST /v1/admin/provider-gateways/test. Provider instances are attached separately through the providers API.",
    security: "management",
    request: ProviderGatewayCreateRequestSchema,
    status: 201,
    response: ProviderGatewayResponseSchema,
    responseDescription: "Created provider gateway.",
  },

  testProviderGateway: {
    method: "POST",
    path: "/v1/admin/provider-gateways/test",
    tags: ["Admin provider gateways"],
    summary: "Probe a gateway connection without storing it",
    description:
      "Calls the gateway with a token, and reports what it answered. Nothing is stored, and no other endpoint runs this check: a write stores what it is given. Unlike the providers API, a refused token is reported as reason: rejected rather than raised as provider_key_invalid, because the same 401 means both a wrong token and a gateway that is not finished being set up.",
    security: "management",
    request: ProviderGatewayTestRequestSchema,
    response: ProviderGatewayTestResponseSchema,
    responseDescription: "Probe outcome.",
  },

  updateProviderGateway: {
    method: "PATCH",
    path: "/v1/admin/provider-gateways/{id}",
    tags: ["Admin provider gateways"],
    summary: "Rename a provider gateway",
    description: "Requires the revision returned by the gateway read this rename is based on; a stale revision returns 409 conflict.",
    security: "management",
    params: { id: { example: "b0a1…" } },
    request: ProviderGatewayUpdateRequestSchema,
    response: ProviderGatewayResponseSchema,
    responseDescription: "Updated provider gateway.",
  },

  rotateProviderGateway: {
    method: "POST",
    path: "/v1/admin/provider-gateways/{id}/rotate",
    tags: ["Admin provider gateways"],
    summary: "Rotate a shared provider gateway token",
    description: "Requires the revision returned by the gateway read this rotation is based on; a stale revision returns 409 conflict. Re-encrypts the token once for every provider instance referencing this gateway. The new token is stored as given, never probed.",
    security: "management",
    params: { id: { example: "b0a1…" } },
    request: ProviderGatewayRotateRequestSchema,
    response: ProviderGatewayResponseSchema,
    responseDescription: "Rotated provider gateway.",
  },

  deleteProviderGateway: {
    method: "DELETE",
    path: "/v1/admin/provider-gateways/{id}",
    tags: ["Admin provider gateways"],
    summary: "Delete an unused provider gateway",
    security: "management",
    params: { id: { example: "b0a1…" } },
    response: ProviderGatewayDeleteResponseSchema,
    responseDescription: "Provider gateway deleted.",
    errors: {
      409: "Provider instances still reference this gateway. Disabled rows are retained for re-enabling and block deletion too; see referencedCount.",
    },
  },

  getAdminSession: {
    method: "GET",
    path: "/v1/admin/session",
    tags: ["Admin organizations"],
    summary: "Get the caller's identity, current organization and role",
    description:
      "The console needs the caller's role and active organization to gate its UI; the sign-in session endpoint reports neither.",
    security: "management",
    response: IdentitySessionSchema,
    responseDescription: "Resolved session.",
  },

  listOrganizations: {
    method: "GET",
    path: "/v1/admin/organizations",
    tags: ["Admin organizations"],
    summary: "List the organizations the caller belongs to",
    security: "management",
    // cf-auth lists them only for an interactive session: a key is scoped to
    // its one organization and may not read the others its owner belongs to.
    policy: { session: true },
    response: OrganizationListResponseSchema,
    responseDescription: "Memberships ordered by organization creation time.",
  },

  selectOrganization: {
    method: "POST",
    path: "/v1/admin/organizations/select",
    tags: ["Admin organizations"],
    summary: "Switch the caller's active organization",
    description: "Available to every member, including read-only members, of the target organization.",
    security: "management",
    // Switching the active organization re-signs the cookie naming which
    // tenant the caller reads; gating it behind owner/admin would strand a
    // read-only member in one organization, and gating it behind setup access
    // would strand them in an account whose trial has ended. Only an
    // interactive session has a cookie to re-sign, and cf-auth refuses any
    // other caller, so the entry says so rather than leaving a key to learn it
    // from the handler — after the grant check, with a remedy that cannot work.
    policy: { role: "member", access: "read", session: true },
    request: OrganizationSelectRequestSchema,
    response: IdentitySessionSchema,
    responseDescription: "Session rescoped to the selected organization.",
  },

  listAppEvents: {
    method: "GET",
    path: "/v1/admin/apps/{app}/events",
    tags: ["Admin operations"],
    summary: "List application usage events",
    security: "management",
    params: APP_PARAM,
    query: z.object({
      limit: PageLimitSchema,
      status: z.enum(USAGE_STATUSES).optional(),
      provider: z.string().optional(),
      user: z.string().optional(),
      install: z.string().optional().meta({ description: "Only events of this install: an App Attest key id." }),
      model: z.string().optional(),
      before_id: BeforeIdSchema,
    }),
    response: UsageEventListSchema,
    responseDescription: "Paginated application usage events.",
  },

  getAppAuthEventSummary: {
    method: "GET",
    path: "/v1/admin/apps/{app}/auth-events/summary",
    tags: ["Admin operations"],
    summary: "Summarize application authentication outcomes",
    description: "Daily authentication outcomes and reasons, non-ok proxied requests, token-exchange success rate, entitlement-claim propagation delays, and how many users are waiting on a claim right now.",
    security: "management",
    params: APP_PARAM,
    query: z.object({
      days: z.coerce.number()
        .int({ error: "days must be an integer between 1 and 365" })
        .min(1, { error: "days must be an integer between 1 and 365" })
        .max(365, { error: "days must be an integer between 1 and 365" })
        .default(30)
        .meta({ description: "Trailing window in days, ending today. Defaults to 30." }),
    }),
    response: AuthEventSummarySchema,
    responseDescription: "Authentication activity for the window.",
  },

  listAppAuthEvents: {
    method: "GET",
    path: "/v1/admin/apps/{app}/auth-events",
    tags: ["Admin operations"],
    summary: "List application authentication events",
    security: "management",
    params: APP_PARAM,
    query: z.object({
      limit: PageLimitSchema,
      outcome: z.string().optional(),
      event: z.enum(["token_exchange", "register"]).optional(),
      user: z.string().optional(),
      before_id: BeforeIdSchema,
    }),
    response: AuthEventListSchema,
    responseDescription: "Paginated authentication attempts, newest first.",
  },

  listAppRejectionEvents: {
    method: "GET",
    path: "/v1/admin/apps/{app}/rejection-events",
    tags: ["Admin operations"],
    summary: "List sampled application refusals",
    description: "Sampled requests refused before contacting a provider. One sample per authenticated identity per minute; counts are not exact request totals.",
    security: "management",
    params: APP_PARAM,
    query: z.object({
      limit: PageLimitSchema,
      reason: z.enum(REJECTION_REASONS).optional(),
      scope: z.enum(REJECTION_SCOPES).optional(),
      user: z.string().optional(),
      from: DaySchema("from").optional(),
      to: DaySchema("to").optional(),
      before_id: BeforeIdSchema,
    }),
    response: RejectionEventListSchema,
    responseDescription: "Paginated refusal samples, newest first.",
  },

  listAppKeys: {
    method: "GET",
    path: "/v1/admin/apps/{app}/keys",
    tags: ["Admin operations"],
    summary: "List application API keys",
    security: "management",
    params: APP_PARAM,
    response: ApiKeyListResponseSchema,
    responseDescription: "Application API keys without plaintext tokens.",
  },

  createAppKey: {
    method: "POST",
    path: "/v1/admin/apps/{app}/keys",
    tags: ["Admin operations"],
    summary: "Create an application API key",
    security: "management",
    params: APP_PARAM,
    request: ApiKeyCreateRequestSchema,
    status: 201,
    response: CreatedApiKeySchema,
    responseDescription: "One-time plaintext application API key.",
  },

  revokeAppKey: {
    method: "POST",
    path: "/v1/admin/apps/{app}/keys/{key}/revoke",
    tags: ["Admin operations"],
    summary: "Revoke an application API key",
    security: "management",
    params: { app: { example: "my-app" }, key: { example: "key_123" } },
    response: ApiKeyRevokeResponseSchema,
    responseDescription: "Revoked application API key.",
  },

  listAppUsers: {
    method: "GET",
    path: "/v1/admin/apps/{app}/users",
    tags: ["Admin operations"],
    summary: "List application users",
    security: "management",
    params: APP_PARAM,
    query: z.object({
      month: MonthSchema.optional().meta({ description: "YYYY-MM; defaults to the current UTC month." }),
      query: z.string().optional().meta({ description: "Substring match on the user id." }),
      status: z.enum(["active", "blocked"]).optional(),
      limit: PageLimitSchema,
      offset: z.coerce.number()
        .int({ error: "offset must be a non-negative integer" })
        .min(0, { error: "offset must be a non-negative integer" })
        .default(0),
    }),
    response: UserListResponseSchema,
    responseDescription: "Application users and their usage for the month.",
  },

  getAppUser: {
    method: "GET",
    path: "/v1/admin/apps/{app}/users/{user}",
    tags: ["Admin operations"],
    summary: "Get an application user",
    security: "management",
    params: { app: { example: "my-app" }, user: { example: "user-123" } },
    query: MonthQuerySchema,
    response: UserResponseSchema,
    responseDescription: "One application user and their usage for the month.",
  },

  blockAppUser: {
    method: "POST",
    path: "/v1/admin/apps/{app}/users/{user}/block",
    tags: ["Admin operations"],
    summary: "Block an application user",
    security: "management",
    params: { app: { example: "my-app" }, user: { example: "user-123" } },
    response: UserBlockResponseSchema,
    responseDescription: "The user's new block state.",
  },

  unblockAppUser: {
    method: "POST",
    path: "/v1/admin/apps/{app}/users/{user}/unblock",
    tags: ["Admin operations"],
    summary: "Unblock an application user",
    security: "management",
    params: { app: { example: "my-app" }, user: { example: "user-123" } },
    response: UserBlockResponseSchema,
    responseDescription: "The user's new block state.",
  },

  getAppUsage: {
    method: "GET",
    path: "/v1/admin/apps/{app}/usage",
    tags: ["Admin operations"],
    summary: "Get application usage totals",
    security: "management",
    params: APP_PARAM,
    query: MonthQuerySchema,
    response: MonthlyUsageResponseSchema,
    responseDescription: "One month's totals for one application.",
  },

  repriceAppUsage: {
    method: "POST",
    path: "/v1/admin/apps/{app}/usage/reprice",
    tags: ["Admin operations"],
    summary: "Preview or apply current catalog prices to stored usage",
    security: "management",
    params: APP_PARAM,
    request: UsageRepriceRequestSchema,
    response: UsageRepriceResponseSchema,
    responseDescription: "What repricing would change, or did.",
  },

  getAppUsageTimeseries: {
    method: "GET",
    path: "/v1/admin/apps/{app}/usage/timeseries",
    tags: ["Admin operations"],
    summary: "Get application usage over time",
    security: "management",
    params: APP_PARAM,
    query: RangeQuerySchema,
    response: TimeseriesResponseSchema,
    responseDescription: "Daily buckets split by provider.",
  },

  getAppUsageBreakdown: {
    method: "GET",
    path: "/v1/admin/apps/{app}/usage/breakdown",
    tags: ["Admin operations"],
    summary: "Get grouped application usage",
    security: "management",
    params: APP_PARAM,
    query: RangeQuerySchema.extend({
      by: z.enum(USAGE_BREAKDOWN_DIMENSIONS).default("model")
        .meta({ description: "Which dimension to group by. Defaults to model. install groups an App Attest application's traffic by the install — the App Attest key — that made it; server applications have none." }),
      limit: PageLimitSchema,
    }),
    response: BreakdownResponseSchema,
    responseDescription: "One dimension's totals, largest first.",
  },

  listModelPrices: {
    method: "GET",
    path: "/v1/admin/prices",
    tags: ["Admin models"],
    summary: "List known model prices",
    security: "management",
    response: PricesResponseSchema,
    responseDescription: "The priced model catalog this deployment enforces.",
  },

  getOperation: {
    method: "GET",
    path: "/v1/admin/operations/{id}",
    tags: ["Admin change operations"],
    summary: "Get where an operation stands",
    description: "Any credential of the account that opened the operation may read it, whatever its role and grant; any other is answered `404 operation_not_found`, so the answer never says whether the id exists elsewhere. A pending operation reports when it lapses, a completed one what it changed, and one declined in a browser `expired` with `denied: true`. It never returns a secret and never collects one: a key the operation created is revealed only on the page `reveal_url` names, to a person signed in to the console as an owner or admin. The approval link of a pending browser step is in the answer that opened it and nowhere else.",
    security: "management",
    params: { id: { example: "4b1e…" } },
    response: OperationStatusResponseSchema,
    responseDescription: "Where the operation stands, and what it changed once completed.",
  },

  revealOperation: {
    method: "POST",
    path: "/v1/admin/operations/{id}/reveal",
    tags: ["Admin change operations"],
    summary: "Reveal the key an operation created, once",
    description: "Console session only, and requires the owner or admin role in the operation's account; a management key is refused with `403 session_required`. First-party console only: the request URL's origin and the exact `Origin` header must both be the console origin. Answers the key an app or key creation made once, within 15 minutes of its creation: a second reveal is `409 already_revealed`, and one after the window, or for a key revoked since, is `410 operation_expired`. Reveal it only on a page a person asked to see it on, never on load.",
    security: "session",
    // Read access: the key already exists, and collecting it is not a change.
    policy: { role: "admin", access: "read", session: true },
    params: { id: { example: "4b1e…" } },
    response: RevealedOperationResponseSchema,
    responseDescription: "The key the operation created, with its plaintext.",
    errors: {
      409: "The key was already revealed.",
      410: "The reveal window passed, or the key was revoked since it was created.",
    },
  },

  getCliCapabilities: {
    method: "GET",
    path: "/v1/cli/capabilities",
    tags: ["CLI"],
    summary: "Discover deployment identity and provider capabilities",
    security: "public",
    response: CliCapabilitiesResponseSchema,
    responseDescription: "Public deployment capabilities. No credentials or inference calls.",
    errors: "none",
  },

  bootstrapCliAccount: {
    method: "POST",
    path: "/v1/cli/bootstrap",
    tags: ["CLI"],
    summary: "Initialize a recoverable CLI account",
    description: "Persist the random token before sending: its digest is the operation's id, and an identical retry returns the same account and protected credential during its exchange window. Cloud initialization is public and rate limited. Self-hosted initialization creates the deployment's single unclaimed account, and only for the token whose SHA-256 the deploying CLI stored as the Worker secret `CLI_BOOTSTRAP_TOKEN_DIGEST`; any other token, or a deployment without that secret, is refused with 403. It is not rate limited, because only the deploying CLI can pass it, and a limit would refuse that CLI retrying a deployment whose storage has not come up yet. All responses are no-store.",
    security: "public",
    request: CliBootstrapRequestSchema,
    response: CliOperationSchema,
    responseDescription: "The completed bootstrap: its account, and the credential in `result`. Never print or log the credential.",
    errors: CLI_ERRORS,
  },

  createCliOperation: {
    method: "POST",
    path: "/v1/cli/operations",
    tags: ["CLI"],
    summary: "Send or recover a CLI operation",
    description: "Persist the random token before sending: its digest is the operation's id, and repeating the same token and payload recovers the same operation instead of repeating it. A current account key is required. An operation without a browser step runs at once and answers completed, with any one-time key in `result` for 15 minutes. One with a browser step answers pending with the approval `url`: claims require interactive human sign-in and explicit consent, and provider and gateway operations collect their secret on that page after showing the exact configuration. A browser step expires after 15 minutes.",
    security: "management",
    // Admin, like every write; read access because the claim is the one kind
    // an account past its free window may still open. Every resource kind then
    // asks for setup access of its own, in the handler, from its kind entry.
    policy: { role: "admin", access: "read" },
    request: CliOperationRequestSchema,
    response: CliOperationSchema,
    responseDescription: "Where the operation stands: completed with its result, or pending with the approval URL.",
    errors: CLI_ERRORS,
  },

  openCliLogin: {
    method: "POST",
    path: "/v1/cli/login",
    tags: ["CLI"],
    summary: "Ask a person to log this CLI in",
    description: "Persist the random token before sending: its digest is the operation's id, and sending it again answers with where the login stands — `completed` once approved, when polling or redeeming collects the key — and never hands the key over itself. Needs no credential. Open `url` in a browser, or show `userCode` for the person to type on the console's code-entry page; once a signed-in person approves, the CLI receives a management key of its own in the account they chose. Without `loopbackRedirect`, poll `pollCliOperation` until it completes: the first completed answer carries the key in `result.credential`, and no later one does. With `loopbackRedirect`, the approval page sends the browser there with a one-time `code`, which `redeemCliLogin` exchanges for the key; polling then never returns it. A login expires after 15 minutes, and its record is kept for a day. Each network address may ask for 20 logins an hour — sending the same token again is not counted — and may have 10 waiting at once.",
    security: "public",
    request: CliLoginRequestSchema,
    response: CliLoginSchema,
    responseDescription: "The pending login, its approval URL and its user code.",
    errors: CLI_ERRORS,
  },

  redeemCliLogin: {
    method: "POST",
    path: "/v1/cli/login/{id}/redeem",
    tags: ["CLI"],
    summary: "Exchange a login's redeem code for its credential",
    description: "For a login opened with `loopbackRedirect`: send the operation token as the bearer credential and the `code` the approval page delivered to the local listener. Answers once; a second redemption is refused with `already_completed`. Never print or log the credential.",
    security: "cliPoll",
    params: { id: {} },
    request: CliLoginRedeemRequestSchema,
    response: CliLoginRedeemResponseSchema,
    responseDescription: "The management key the login issued, and the account it belongs to.",
    errors: CLI_ERRORS,
  },

  revokeCliCredential: {
    method: "DELETE",
    path: "/v1/cli/credential",
    tags: ["CLI"],
    summary: "Revoke the management key this request is sent with",
    description: "Logging a CLI out. Any management key may end itself, whatever its role and whatever the account's standing; a browser session cannot use this and signs out instead.",
    security: "management",
    // Holding a key is authority enough to end it: a member may, an account
    // past its free window may, and a key with the `read` grant may.
    policy: { role: "member", access: "read", grant: "read" },
    response: CliCredentialRevokeResponseSchema,
    responseDescription: "The key is revoked; the next request made with it is refused.",
    errors: CLI_ERRORS,
  },

  pollCliOperation: {
    method: "GET",
    path: "/v1/cli/operations/{id}",
    tags: ["CLI"],
    summary: "Poll a CLI operation",
    description: "Only the operation's token can read it. Completed claims report the account they landed on; the CLI keeps the access it already had. Provider secrets are never returned; a one-time key an operation created is, for 15 minutes. A login's key is returned once, by the first completed answer, and never when the login registered a loopback redirect. A step a person declined answers `expired` with `denied: true`.",
    security: "cliPoll",
    params: { id: {} },
    response: CliOperationSchema,
    responseDescription: "Where the operation stands, and its result once completed.",
    errors: CLI_ERRORS,
  },

  getCliAccount: {
    method: "GET",
    path: "/v1/cli/account",
    tags: ["CLI"],
    summary: "Read account lifecycle and current access",
    security: "management",
    response: CliAccountResponseSchema,
    responseDescription: "Account deadlines, effective access and current request count.",
    errors: CLI_ERRORS,
  },

  getCliUsage: {
    method: "GET",
    path: "/v1/cli/usage",
    tags: ["CLI"],
    summary: "Read retained account usage for a UTC month",
    description: "Includes retained usage for deleted apps, with durable account attribution.",
    security: "management",
    query: z.object({
      month: MonthSchema.optional()
        .meta({ description: "YYYY-MM; defaults to the current UTC month." }),
    }),
    response: CliUsageResponseSchema,
    responseDescription: "Account totals, per-app totals and attribution coverage.",
    errors: CLI_ERRORS,
  },

  /*
   * The human half of a handoff. There is no page to fetch here: the console
   * renders the approval screen at `/cli/approve/{id}` from its own bundle, and
   * these four are the API it calls with the proof it read from the URL
   * fragment. Every one of them carries that proof in its body, so they are
   * POSTs with no readable URL of their own.
   */
  cliBrowserDetails: {
    method: "POST",
    path: "/v1/cli/browser/{id}/details",
    tags: ["CLI"],
    summary: "Browser handoff: details",
    description: BROWSER_HANDOFF_DESCRIPTION,
    security: "public",
    params: { id: {} },
    request: CliBrowserProofSchema,
    response: CliBrowserDetailsResponseSchema,
    responseDescription: "The pending action, its configuration, the account it lands on, the signed-in human who would approve it, if any, and what stands between this browser and approving it.",
    errors: CLI_ERRORS,
  },

  cliBrowserSubmit: {
    method: "POST",
    path: "/v1/cli/browser/{id}/submit",
    tags: ["CLI"],
    summary: "Browser handoff: submit",
    description: BROWSER_HANDOFF_DESCRIPTION,
    security: "public",
    params: { id: {} },
    request: CliBrowserSubmitRequestSchema,
    response: CliBrowserSubmitResponseSchema,
    responseDescription: "The handoff is approved and consumed. No submitted secret is ever echoed. For a login with a loopback redirect, `redirectUrl` is where to send the browser next.",
    errors: CLI_ERRORS,
  },

  cliBrowserDeny: {
    method: "POST",
    path: "/v1/cli/browser/{id}/deny",
    tags: ["CLI"],
    summary: "Browser handoff: deny",
    description: `${BROWSER_HANDOFF_DESCRIPTION} Anyone holding the link or the code may decline, signed in or not.`,
    security: "public",
    params: { id: {} },
    request: CliBrowserProofSchema,
    response: CliBrowserDenyResponseSchema,
    responseDescription: "The handoff is declined; the CLI's next poll reports it. Repeating a denial answers the same.",
    errors: CLI_ERRORS,
  },

  cliBrowserLookup: {
    method: "POST",
    path: "/v1/cli/browser/lookup",
    tags: ["CLI"],
    summary: "Browser handoff: find a step by its user code",
    description: "First-party browser only, like the other handoff steps. Case and dashes are ignored. Continue with the code as `submissionToken` on the step it names. Rate limited per network address, because a code is short enough to guess in bulk.",
    security: "public",
    request: CliBrowserLookupRequestSchema,
    response: CliBrowserLookupResponseSchema,
    responseDescription: "Whether a pending step answers to the code, and which one.",
    errors: CLI_ERRORS,
  },

  cliBrowserRegister: {
    method: "POST",
    path: "/v1/cli/browser/{id}/register",
    tags: ["CLI"],
    summary: "Browser handoff: register",
    description: BROWSER_HANDOFF_DESCRIPTION,
    security: "public",
    params: { id: {} },
    request: CliBrowserRegisterRequestSchema,
    response: CliBrowserRegisterResponseSchema,
    responseDescription: "A new human identity for a pending claim or login, with its session set as a cookie.",
    errors: CLI_ERRORS,
  },

  /*
   * The OAuth consent page's API. Like the CLI handoff, there is no page to
   * fetch here: the console renders `/oauth/consent` from its own bundle, and
   * these four carry the proof from its fragment in their bodies. The OAuth
   * endpoints themselves — discovery, `/oauth/authorize`, `/oauth/token` and
   * `/oauth/revoke` — are HTTP-only and not management operations, so they
   * have no entries; the MCP guide documents them.
   */
  getOauthConsentDetails: {
    method: "POST",
    path: "/v1/console/oauth/{id}/details",
    tags: ["Console OAuth consent"],
    summary: "OAuth consent: details",
    description: `${CONSENT_DESCRIPTION} Reading the details changes nothing. The client's name is its own claim, shown as declared by the host that served its metadata document.`,
    security: "public",
    params: { id: { description: "The authorization's id, from the consent page URL's `id` query parameter." } },
    request: OAuthConsentProofSchema,
    response: OAuthConsentDetailsResponseSchema,
    responseDescription: "Who is asking and for what, who this browser would allow it as, the accounts that person may choose, and whether continuing without an account is available.",
    errors: CONSENT_ERRORS,
  },

  allowOauthConsent: {
    method: "POST",
    path: "/v1/console/oauth/{id}/allow",
    tags: ["Console OAuth consent"],
    summary: "OAuth consent: allow",
    description: `${CONSENT_DESCRIPTION} Console session only: the person signed in to this browser connects the client to one of their accounts, with the grant they choose. A management key or an OAuth access token is refused with \`403 session_required\`.`,
    security: "session",
    // Any member may connect a client with their own role, as any member may
    // log a CLI in; the grant is theirs to narrow. Read access, because
    // connecting changes nothing in the account.
    policy: { role: "member", access: "read", session: true },
    params: { id: { description: "The authorization's id." } },
    request: OAuthConsentAllowRequestSchema,
    response: OAuthConsentRedirectResponseSchema,
    responseDescription: "The client's redirect URI with the authorization code.",
    errors: CONSENT_ERRORS,
  },

  continueOauthWithoutAccount: {
    method: "POST",
    path: "/v1/console/oauth/{id}/guest",
    tags: ["Console OAuth consent"],
    summary: "OAuth consent: continue without an account",
    description: `${CONSENT_DESCRIPTION} Creates an account nobody has claimed yet, owned by the connection's own service identity, and connects the client to it with the \`manage\` grant whatever it asked for. Admitted where the deployment allows a new unclaimed account — always on the hosted service, where it is deleted unless a person claims it, and on a self-hosted deployment only while it is empty — and counted per network address with the CLI's account creation. Repeating it for the same authorization answers the same account.`,
    security: "public",
    params: { id: { description: "The authorization's id." } },
    request: OAuthConsentProofSchema,
    response: OAuthConsentRedirectResponseSchema,
    responseDescription: "The client's redirect URI with the authorization code.",
    errors: {
      ...CONSENT_ERRORS,
      409: "This deployment no longer admits an account without a person (a self-hosted one that has been initialized), or another choice completed the authorization first.",
      429: "Too many accounts were created from this network address. Carries Retry-After.",
    },
  },

  denyOauthConsent: {
    method: "POST",
    path: "/v1/console/oauth/{id}/deny",
    tags: ["Console OAuth consent"],
    summary: "OAuth consent: deny",
    description: `${CONSENT_DESCRIPTION} Anyone holding the link may decline, signed in or not.`,
    security: "public",
    params: { id: { description: "The authorization's id." } },
    request: OAuthConsentProofSchema,
    response: OAuthConsentRedirectResponseSchema,
    responseDescription: "The client's redirect URI with `error=access_denied`.",
    errors: CONSENT_ERRORS,
  },

  /*
   * Email verification, on a deployment that sends email. Both are the
   * console's own and run on its origin alone. Neither needs an account: the
   * person approving a claim has none yet, and has to verify before the claim
   * can complete.
   */
  sendVerificationEmail: {
    method: "POST",
    path: "/v1/console/email-verification/send",
    tags: ["Console email verification"],
    summary: "Email verification: send a link",
    description: "Sends a verification link to the address of the person signed in to this browser, for their console session only. Where the deployment verifies email addresses, an account's apps serve requests only once its owner has verified theirs, and a claim completes only for a person who has; nothing else waits for it. A link lasts 24 hours, and a sign-up with a password sends the first one itself. Counted per person.",
    security: "public",
    request: SendVerificationEmailRequestSchema,
    response: SendVerificationEmailResponseSchema,
    responseDescription: "Whether a link went out, and to which address.",
    errors: {
      401: "No person is signed in to this browser (`session_required`).",
      409: "This deployment does not verify email addresses, or the sign-in has no address of its own (`conflict`).",
      429: "Too many links were sent for this sign-in. Carries Retry-After.",
      503: "The deployment could not send the email (`email_unavailable`).",
    },
  },

  confirmEmailVerification: {
    method: "POST",
    path: "/v1/console/email-verification/confirm",
    tags: ["Console email verification"],
    summary: "Email verification: confirm a link",
    description: "Verifies the address a verification link was sent to. The link alone is the proof, so no sign-in is needed; it is bound to the sign-in and the address it was sent for, and stops working once it expires or the address changes. Confirming a link again answers the same.",
    security: "public",
    request: ConfirmEmailVerificationRequestSchema,
    response: ConfirmEmailVerificationResponseSchema,
    responseDescription: "The address verified, and where to continue.",
    errors: {
      400: "The link is malformed, has expired, or no longer matches the sign-in's address (`invalid_request`).",
    },
  },

  cliBrowserGoogle: {
    method: "POST",
    path: "/v1/cli/browser/{id}/google",
    tags: ["CLI"],
    summary: "Browser handoff: google",
    description: BROWSER_HANDOFF_DESCRIPTION,
    security: "public",
    params: { id: {} },
    request: CliBrowserProofSchema,
    response: CliBrowserGoogleResponseSchema,
    responseDescription: "Where to send the browser to start Google consent for a pending claim or login.",
    errors: CLI_ERRORS,
  },
} as const satisfies Record<string, OperationSpec>;

export type Catalog = typeof CATALOG;
export type OperationName = keyof Catalog;

/** The `{name}` segments of an OpenAPI path template, as a type. */
type PathParameterNames<P extends string> =
  P extends `${string}{${infer Name}}${infer Rest}` ? Name | PathParameterNames<Rest> : never;

export type PathParams<P extends string> = Record<PathParameterNames<P>, string>;

export type OperationParams<K extends OperationName> = PathParams<Catalog[K]["path"]>;

/** The optional schema fields, as a lookup that answers `never` where absent. */
type SchemaOf<Field extends string> = {
  [K in OperationName]: Catalog[K] extends { readonly [F in Field]: infer S extends z.ZodType }
    ? S
    : z.ZodNever;
};

type QuerySchema = SchemaOf<"query">;
type RequestSchema = SchemaOf<"request">;

/**
 * A query string as a client composes it, like {@link OperationRequest}: the
 * schema's input, where defaulted parameters are optional.
 */
export type OperationQuery<K extends OperationName> = z.input<QuerySchema[K]>;
/** The same query once the router has parsed it, which is what a handler reads. */
export type ParsedOperationQuery<K extends OperationName> = z.output<QuerySchema[K]>;
/**
 * The body once the router has parsed it, which is what a handler reads:
 * `undefined` for an operation that takes none, or takes the multipart form no
 * catalog-mounted handler serves.
 */
export type ParsedOperationRequest<K extends OperationName> = ParsedBody[K];
type ParsedBody = {
  [K in OperationName]: Catalog[K] extends { readonly request: infer S extends z.ZodType }
    ? z.output<S>
    : undefined;
};
/**
 * A request body as a *client composes* it, before the schema's defaults and
 * normalizations apply — `z.input` rather than `z.infer`. An application
 * configuration may name one issuer as a bare string where the stored form is
 * always a list, and refusing that here would refuse what the gateway accepts.
 */
export type OperationRequest<K extends OperationName> = z.input<RequestSchema[K]>;
/**
 * A chain of plain indexed accesses, unlike the two above, and deliberately so:
 * this is the type a catalog-mounted handler is checked against, and TypeScript
 * keeps a literal like `valid: true` only from a contextual type it has already
 * resolved. Both `z.infer` and a lookup that asks whether an entry has a
 * `response` at all are conditional types, which stay unresolved while the
 * operation name is generic — so every entry carries a `response`, and this
 * reads the inferred output off it the way `z.infer` would.
 */
export type OperationResponse<K extends OperationName> =
  Catalog[K]["response"]["_zod"]["output"];

/**
 * The operations whose success body has a shape of its own.
 *
 * A handful answer with someone else's body — Better Auth's session, a
 * provider's native response — and are declared `z.unknown()`. A union that
 * contains `unknown` is `unknown`, so with those in it the type above stops
 * being usable as a contextual type and every handler's `valid: true` widens
 * back to `boolean`. None of them is served from the catalog anyway, so this is
 * both the set that can be mounted and the set that types.
 */
export type BodiedOperation = {
  [K in OperationName]: unknown extends OperationResponse<K> ? never : K;
}[OperationName];


/** Whether an operation takes any `{name}` segment at all. */
type HasParams<K extends OperationName> =
  PathParameterNames<Catalog[K]["path"]> extends never ? false : true;

/** A `?a=1&b=2` suffix, or the empty string when nothing is set. */
export function searchSuffix(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * The URL one operation is sent to, filled in from its own template.
 *
 * The one place a request path is produced, which is what keeps every client
 * from writing one: a path that changes here changes for the console, the CLI,
 * the server mount and the published document at once.
 */
export function operationPath<K extends OperationName>(
  name: K,
  ...rest: HasParams<K> extends true
    ? [params: OperationParams<K>, query?: OperationQuery<K>]
    : [params?: undefined, query?: OperationQuery<K>]
): string {
  const [params, query] = rest as [Record<string, string> | undefined, object | undefined];
  const filled = CATALOG[name].path.replace(/\{(\w+)\}/gu, (_match, key: string) => {
    const value = params?.[key];
    // A path segment nobody supplied would silently become an empty one, and
    // `/v1/admin/apps//keys` is a request to a different endpoint than the one
    // the caller meant. Refused here rather than sent.
    if (value === undefined) throw new Error(`${String(name)} needs a "${key}" path parameter`);
    return encodeURIComponent(value);
  });
  return query === undefined
    ? filled
    : filled + searchSuffix(query as Record<string, string | number | boolean | undefined | null>);
}
