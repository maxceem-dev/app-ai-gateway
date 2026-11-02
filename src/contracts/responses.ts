/**
 * Every documented response body, as one schema per shape.
 *
 * These are the definition of the wire format. `openapi.ts` imports them and
 * publishes them,
 * the Worker handlers `satisfies` the inferred types so a drifting handler
 * fails `pnpm run check`, the console imports the types alone, and the CLI
 * parses real responses with the schemas themselves.
 *
 * Plain `zod`, never `@hono/zod-openapi`: the CLI bundles this module and must
 * not pull Hono in behind it. `.meta({ id })` registers a named component
 * exactly as `.openapi("Name")` does, and `.meta({ description })` a field
 * description — the generated document is byte-identical either way.
 */
import { z } from "zod";
import { REJECTION_REASONS, REJECTION_SCOPES } from "../shared/rejection-reasons.ts";
import { PROVIDER_TYPES } from "../shared/providers.ts";
import { APP_STATUSES } from "../shared/app-status.ts";
import { API_STYLES, ENDPOINT_API_STYLES } from "../shared/capabilities.ts";
import { MODEL_KINDS } from "../shared/model-kinds.ts";
import {
  GATEWAY_DESCRIPTORS,
  GATEWAY_TYPES,
  type GatewayConnectionShape,
  type GatewayType,
} from "../shared/gateways.ts";
import {
  APP_ATTEST_VERIFY_ON,
  AppConfigSchema,
  CredentialGrantSchema,
  GatewayRouteConfigSchema,
  OrganizationRoleSchema,
  ProviderPricingSchema,
  SlugSchema,
} from "./schemas.ts";

/** Outcomes of requests dispatched to a provider. */
export const USAGE_STATUSES = ["ok", "provider_error"] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

/** The dimensions a usage breakdown can group by. */
export const USAGE_BREAKDOWN_DIMENSIONS = [
  "model",
  "provider",
  "provider_slug",
  "provider_gateway",
  "credential_source",
  "model_author",
  "user",
  "install",
  "status",
  "cost_source",
  "route",
  "endpoint",
  "app_version",
] as const;
export type UsageBreakdownDimension = (typeof USAGE_BREAKDOWN_DIMENSIONS)[number];

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().meta({
      description: "Machine-readable facts about this rejection, present only where the code alone is not actionable. A billing_request_quota_exceeded rejection carries periodId, periodStart, periodEnd, limit, used, and resetAt; a billing_plan_limit_reached rejection carries limit and used; an app_rate_limited or app_budget_exhausted rejection carries scope, one of user, install or app; a rate_limited rejection carries scope naming the endpoint policy that refused, plus limit, windowSeconds, retryAfterSeconds and resetAt.",
    }),
  }),
}).meta({ id: "ErrorResponse" });

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("app-ai-gateway"),
  vault: z.enum(["ok", "misconfigured"]),
  /**
   * Whether this deployment verifies email addresses: `off` with no way to
   * send email configured, `ok` with Cloudflare Email Service or SMTP ready to
   * send, `misconfigured` with one that cannot send yet (a setting missing or
   * contradictory), where verification is required and no link can be sent.
   */
  email: z.enum(["off", "ok", "misconfigured"]),
});

export const ConsoleCapabilitiesResponseSchema = z.object({
  billing: z.boolean(),
  registrationOpen: z.boolean(),
  googleAuth: z.boolean(),
  termsOfServiceUrl: z.string().url().optional(),
  privacyPolicyUrl: z.string().url().optional(),
  apiBaseUrl: z.string().url().optional(),
  /**
   * Whether this deployment verifies email addresses. Where it does, an
   * account's apps serve requests only once its owner has verified theirs, and
   * the console offers the link to do it.
   */
  emailVerification: z.boolean(),
});

/** The provider URL returned when a Google OAuth sign-in is initiated. */
export const GoogleSignInResponseSchema = z.object({
  url: z.url().meta({ description: "Provider authorization URL for the browser to navigate to." }),
  redirect: z.boolean().meta({
    description: "Whether Better Auth also sets a Location header. The console navigates to url itself.",
  }),
});

export const AppAttestChallengeResponseSchema = z.object({
  challenge: z.string(),
  expires_in: z.number(),
});

export const AppAttestRegisterResponseSchema = z.object({ user_id: z.string() });

export const GatewayTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  verify_on: z.enum(APP_ATTEST_VERIFY_ON).optional().meta({
    description: "On App Attest applications, when the gateway verifies the install's assertion: every_request means every request sent with this token must carry X-AppAttest-Proof; token_exchange means requests carry only the token. Absent on other applications.",
  }),
});

/**
 * Where one end user stands against the limits their application sets.
 *
 * The account's request allowance is deliberately absent: that is the
 * organization's arrangement with the gateway rather than its users' business,
 * and it is reported on the rejection that spends it.
 */
export const CurrentUserResponseSchema = z.object({
  user_id: z.string(),
  install_id: z.string().nullable().meta({
    description: "The App Attest key id of the install making the request, on App Attest applications, whose request limits are counted per install. Null on server applications.",
  }),
  limits: z.object({
    requests_today: z.number().int().nullable().meta({ description: "Requests made so far in the current UTC day: by this install on an App Attest application, by this user on a server application. Null when the application sets no per-user limit, in which case requests are not counted at all." }),
    requests_remaining: z.number().int().nullable().meta({ description: "What is left of requests_per_day. Null when no daily limit is set." }),
    requests_per_minute: z.number().nullable().meta({ description: "The per-minute limit this app sets on each install (App Attest) or user (server). Null means unlimited." }),
    requests_per_day: z.number().nullable().meta({ description: "The per-day limit this app sets on each install (App Attest) or user (server). Null means unlimited." }),
    monthly_cost_usd: z.number().meta({ description: "What has been spent so far in the current UTC calendar month against the budget below: by this install, or by this user when the budget's scope is user." }),
    monthly_budget_usd: z.number().nullable().meta({ description: "The monthly spending budget this app sets on each install or user, per limits.per_user.spending.scope. Null means unlimited." }),
    blocked: z.boolean().meta({ description: "Whether this user has been blocked in the console." }),
  }).meta({
    description: "The limits the app sets on this user, and where the user stands against them. The account's request allowance is not reported here: it is shared by all apps, and is reported on the rejection that spends it.",
  }),
});

export const UsageEventSchema = z.object({
  id: z.number().int(),
  /** Null for an application that identifies no end users. */
  user_id: z.string().nullable(),
  install_id: z.string().nullable().meta({
    description: "The App Attest key id of the install that made the request, on App Attest applications; null for server applications.",
  }),
  api_key_id: z.string().nullable().meta({
    description: "Non-secret ID of the application API key that authenticated the request, including the client-proof key carried by an exchanged gateway token.",
  }),
  provider: z.string(),
  provider_slug: z.string().nullable(),
  provider_gateway_id: z.string().nullable().meta({
    description: "The gateway connection that carried the request, or null for a direct call. Recorded for every routed request; the id is kept even after the gateway row is deleted.",
  }),
  provider_gateway_type: z.string().nullable().meta({
    description: "That gateway's type at request time, for example cf_aig.",
  }),
  credential_source: z.enum(["direct", "byok", "gateway_system", "unknown"]).nullable().meta({
    description: "Whose credential paid, where something settles it: `direct` for an instance holding its own key, `byok` when a gateway serves it from your own key store or when a reporting upstream says your own key paid for the inference. Never inferred from a successful response; null when nothing settles it.",
  }),
  model_author: z.string().nullable().meta({
    description: "Who made the model, resolved when the event was recorded. An analytics dimension only — it never affects budgets or allowlists.",
  }),
  served_provider: z.string().nullable().meta({
    description: "The serving provider the upstream named, when it names one — the host OpenRouter routed to, for instance. Null means unknown, never a guarantee.",
  }),
  served_model: z.string().nullable().meta({
    description: "The serving model the upstream named, canonicalized back to the provider's own model ID.",
  }),
  model: z.string(),
  route: z.string(),
  endpoint_slug: z.string().nullable(),
  input_tokens: z.number().int(),
  cached_input_tokens: z.number().int(),
  cache_write_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cost_usd: z.number(),
  reported_cost_usd: z.number().nullable().meta({
    description: "What the upstream said the request cost, on routes that report one. Null everywhere else; cost_usd stays the billed figure either way.",
  }),
  cost_source: z.enum(["computed", "reported", "unresolved"]).nullable().meta({
    description: "How cost_usd was determined. `reported` is the upstream's own figure for this request, which is what was billed; `computed` is this deployment's price catalog; `unresolved` means the provider answered successfully but neither source could establish a cost, so the zero is unknown rather than measured. Null on events recorded before this field existed.",
  }),
  app_version: z.string().nullable(),
  auth_method: z.enum(["attest", "api_key"]).nullable(),
  status: z.enum(USAGE_STATUSES),
  client_aborted: z.number().int().nullable().meta({
    description: "1 when the client disconnected before the upstream finished streaming, which cancelled the provider call; null otherwise. Not a failure — the request was served as far as the caller wanted it — but an aborted stream often takes the provider's end-of-response usage with it, which is why such an event may carry cost_source unresolved.",
  }),
  latency_ms: z.number().int().nullable(),
  created_at: z.string(),
}).meta({ id: "UsageEvent" });

export const UsageEventListSchema = z.object({
  app_id: z.string(),
  limit: z.number().int(),
  next_before_id: z.number().int().nullable(),
  events: z.array(UsageEventSchema),
});

export const AuthEventSchema = z.object({
  id: z.number().int(),
  user_id: z.string().nullable().meta({
    description: "The verified issuer identity, where the attempt got far enough to establish one. Null for attempts refused before any identity was trusted.",
  }),
  event: z.enum(["token_exchange", "register"]),
  auth_method: z.enum(["attest", "api_key"]).nullable(),
  outcome: z.string().meta({
    description: "`ok`, or the error code the client was handed — for example issuer_claims_missing, issuer_token_rejected, attest_failed.",
  }),
  reason: z.string().nullable().meta({
    description: "The granular cause behind the outcome, for example claims_missing, bad_signature, jwks_unreachable. Diagnostic only: clients never see it.",
  }),
  app_version: z.string().nullable(),
  latency_ms: z.number().int().nullable(),
  claim_delay_ms: z.number().int().nullable().meta({
    description: "Set only on the exchange that ended a claim-propagation window: how long the user waited from their first issuer_claims_missing rejection.",
  }),
  created_at: z.string(),
}).meta({ id: "AuthEvent" });

export const AuthEventListSchema = z.object({
  app_id: z.string(),
  limit: z.number().int(),
  next_before_id: z.number().int().nullable(),
  events: z.array(AuthEventSchema),
});

export const RejectionEventSchema = z.object({
  id: z.number().int(),
  user_id: z.string().nullable(),
  install_id: z.string().nullable().meta({
    description: "The App Attest key id of the refused install, on App Attest applications; null for server applications and for samples recorded before installs were.",
  }),
  api_key_id: z.string().nullable(),
  reason: z.enum(REJECTION_REASONS),
  scope: z.enum(REJECTION_SCOPES).nullable().meta({ description: "Null on historical samples whose limit scope cannot be recovered." }),
  provider_slug: z.string().nullable().meta({ description: "Attempted provider; this request did not contact an upstream." }),
  model: z.string().nullable(),
  route: z.string().nullable(),
  endpoint_slug: z.string().nullable(),
  app_version: z.string().nullable(),
  auth_method: z.enum(["attest", "api_key"]).nullable(),
  latency_ms: z.number().int().nullable(),
  created_at: z.string(),
}).meta({ id: "RejectionEvent" });

export const RejectionEventListSchema = z.object({
  app_id: z.string(),
  limit: z.number().int(),
  next_before_id: z.number().int().nullable(),
  events: z.array(RejectionEventSchema),
});

export const AuthEventSummarySchema = z.object({
  app_id: z.string(),
  days: z.number().int(),
  from: z.string(),
  to: z.string(),
  daily: z.array(z.object({
    date: z.string(),
    event: z.enum(["token_exchange", "register"]),
    outcome: z.string(),
    reason: z.string().nullable(),
    count: z.number().int(),
  })).meta({ description: "Authentication attempts per day, grouped by outcome and granular reason." }),
  usage_failures: z.array(z.object({
    date: z.string(),
    status: z.string(),
    count: z.number().int(),
  })).meta({ description: "Provider errors per day from requests that reached an upstream." }),
  rejection_samples: z.array(z.object({
    date: z.string(),
    reason: z.enum(REJECTION_REASONS),
    scope: z.enum(REJECTION_SCOPES).nullable(),
    count: z.number().int(),
  })).meta({ description: "Sampled pre-provider refusals per day. These are diagnostic samples, not exact request totals." }),
  token_exchange: z.object({
    total: z.number().int(),
    ok: z.number().int(),
    success_rate: z.number().nullable().meta({
      description: "Null when the window contains no exchanges at all, which is not the same as a perfect score.",
    }),
  }),
  claim_delay: z.object({
    count: z.number().int(),
    avg_ms: z.number().nullable(),
    p50_ms: z.number().nullable(),
    p95_ms: z.number().nullable(),
  }).meta({ description: "How long users waited for a required entitlement claim to propagate, over the window." }),
  pending_users: z.number().int().meta({
    description: "Users currently inside an unclosed claim-propagation window — stuck mid-activation right now.",
  }),
}).meta({ id: "AuthEventSummary" });

/**
 * Something about an application that will stop working on a stated date,
 * computed by the gateway when the application is read. Read-only: no write
 * accepts it.
 */
export const AppWarningSchema = z.object({
  code: z.string().meta({ description: "Stable identifier of what the warning is about." }),
  message: z.string().meta({ description: "What will stop, when, and what to do about it, in one sentence or two." }),
  until: z.string().optional().meta({ description: "ISO 8601 UTC instant the behaviour stops." }),
  docs_url: z.string().optional().meta({ description: "Where the change is described." }),
}).meta({ id: "AppWarning" });

/**
 * The one shape every single-application route answers with. Reading an app,
 * creating one and updating one all return the same object, so a client parses
 * one type and never has to ask which route produced it.
 */
export const AppResponseSchema = z.object({
  app: z.object({
    revision: z.number().int().positive(),
    id: z.string().meta({ description: "The gateway-assigned id, and the `{app}` segment of every URL for this application." }),
    name: z.string(),
    /**
     * An `AppConfig` — the parsed one, which is also the stored one: what the
     * gateway accepts is what it keeps, so there is no second "resolved" view
     * of it to publish.
     */
    config: AppConfigSchema,
    status: z.enum(APP_STATUSES),
    created_at: z.string(),
    updated_at: z.string(),
    warnings: z.array(AppWarningSchema).meta({
      description: "Behaviour of this application that will stop on a stated date, computed when the application is read; empty when there is none. Read-only: tell the person who owns the app, and act before each date.",
    }),
  }),
}).meta({ id: "AppResponse" });

export const AppDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  app_id: z.string(),
  removed_users: z.number().int(),
  usage_events_retained: z.literal(true),
});

export const ManagementKeySummarySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  name: z.string(),
  tokenHint: z.string().meta({
    description: "Last four characters of the token for display.",
    example: "x9Qb",
  }),
  enabled: z.boolean().meta({
    description:
      "Whether the key may authenticate. False for a revoked key, and for one issued by a trusted exchange that has not committed yet.",
  }),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  source: z.string().meta({
    description:
      "Where the key was issued: `console`, `cli` for a key a CLI login received, `bootstrap` for the key a CLI account starts with, or `oauth` for an OAuth connection an MCP client holds. Display only.",
    example: "cli",
  }),
  credentialType: z.enum(["apiKey", "oauth"]).meta({
    description:
      "What the row authenticates as: `apiKey` for a management key, `oauth` for an MCP client's connection. `source` says where it was issued and is display only.",
    example: "apiKey",
  }),
  label: z.string().nullable().meta({
    description: "Who holds it, as the issuing client described itself, e.g. `CLI on mac-studio`. Display only.",
  }),
  grant: CredentialGrantSchema.meta({
    description:
      "How much of its holder's role the key may use: `read` may list, inspect and validate but cannot change anything other than revoking itself; `manage` does everything the role allows. Keys issued before grants existed are `manage`.",
    example: "manage",
  }),
  clientId: z.string().nullable().meta({
    description:
      "For an OAuth connection (`credentialType: \"oauth\"`), the client it was issued to: a registered client's id, or the https URL a client identifies itself with. Null for a key. A connection's `name` is the client's own name for itself, display only; its `expiresAt` is when it ends unless the client refreshes it first.",
  }),
});

export const ManagementKeyListResponseSchema = z.object({
  keys: z.array(ManagementKeySummarySchema),
});

export const CreatedManagementKeyResponseSchema = z.object({
  key: ManagementKeySummarySchema.extend({ plaintext: z.string() }),
});

export const ManagementKeyResponseSchema = z.object({ key: ManagementKeySummarySchema });

export const ProviderSummarySchema = z.object({
  id: z.string(),
  type: z.enum(PROVIDER_TYPES),
  slug: SlugSchema.meta({ description: "The URL segment used under /proxy/{slug}/, unique across your providers." }),
  name: z.string(),
  secretHint: z.string().nullable().meta({
    description: "Last characters of a direct provider key; null when a shared provider gateway owns the token.",
  }),
  providerGatewayId: z.string().nullable(),
  gatewayRoute: GatewayRouteConfigSchema.nullable().meta({
    description: "How this instance is routed inside its gateway. Always null for a direct instance and for gateways that take no routing configuration, such as Cloudflare AI Gateway.",
  }),
  baseUrl: z.string().nullable().meta({
    description: "Your own origin replacing the provider type's own base URL, stored canonicalized (https, public host, default port, trailing slash). Null means the provider type's own base URL is used. Always null on a gateway-routed instance, which cannot carry one.",
    example: "https://my-resource.openai.azure.com/openai/v1/",
  }),
  pricing: ProviderPricingSchema.nullable(),
  route: z.enum(["direct", ...GATEWAY_TYPES]).nullable().meta({
    description: "Where this instance's traffic goes: direct to the provider's own API, or the type of the provider gateway it is routed through. Null when that gateway's type has no adapter in this deployment, so the instance can serve nothing until it is fixed or deleted.",
  }),
  capability: z.object({
    apiStyles: z.array(z.enum(API_STYLES)).meta({
      description: "The client APIs this instance can be called with on its route. A direct instance lists every style its provider type does not narrow; the provider itself answers for paths it lacks.",
    }),
    endpointStyles: z.array(z.enum(ENDPOINT_API_STYLES)).meta({
      description: "The custom-endpoint styles this instance can back on its route.",
    }),
    modelPrefix: z.string().nullable().meta({
      description: "The namespace the route adds to model IDs on the way out. Clients always send the provider's own ID; null means the route sends it unchanged.",
    }),
    paths: z.enum(["provider", "gateway"]).meta({
      description: "Whose URL layout clients call under /proxy/{slug}/: the provider's own paths, or the one path per API style a gateway publishes for every provider it serves.",
    }),
  }).meta({ description: "What this instance can do on its route, decided by the gateway rather than re-derived by clients." }),
  revision: z.number().int().positive(),
  status: z.enum(["active", "disabled"]).meta({
    description: "disabled is a reversible pause: the row keeps its secret, its pricing and its slug, and requests to it fail with provider_disabled until it is enabled again.",
  }),
  createdAt: z.string(),
  createdBy: z.string(),
}).meta({ id: "Provider" });

export const ProviderValidatedSchema = z.boolean().meta({
  description: "Whether the live probe confirmed the credential. false means the probe was inconclusive (provider outage, or no probe exists for this provider), not that the credential is bad — a credential the provider refuses fails this request with provider_key_invalid.",
});

export const ProbeReasonSchema = z.enum(["no_probe", "unreachable", "unexpected_status"]).meta({
  description: "Why an unvalidated probe proved nothing. Absent when validated is true.",
});

export const ProbeStatusSchema = z.number().int().meta({
  description: "The upstream status behind an unexpected_status or rejected reason.",
});

export const ProviderListResponseSchema = z.object({
  providers: z.array(ProviderSummarySchema),
});

export const ProviderResponseSchema = z.object({ provider: ProviderSummarySchema });

export const ProviderTestResponseSchema = z.object({
  validated: ProviderValidatedSchema,
  reason: ProbeReasonSchema.optional(),
  status: ProbeStatusSchema.optional(),
});

export const ProviderDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  provider_id: z.string(),
});

/** Everything about a gateway that does not depend on which gateway it is. */
const providerGatewayFields = {
  id: z.string(),
  name: z.string(),
  secretHint: z.string().meta({
    description: "The last characters of the gateway token. The token itself is never returned.",
  }),
  providerCount: z.number().int().nonnegative().meta({
    description: "Active provider instances routed through this gateway.",
  }),
  referencedCount: z.number().int().nonnegative().meta({
    description:
      "All provider instances referencing this gateway, including disabled rows retained for re-enabling. Deletion is refused while this is above zero.",
  }),
  revision: z.number().int().positive(),
  status: z.enum(["active", "revoked"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
};

type GatewaySummaryMember<T extends GatewayType, Fields extends z.ZodRawShape> = z.ZodObject<
  Fields & { type: z.ZodLiteral<T>; config: z.ZodObject<GatewayConnectionShape<T>> }
>;
type GatewaySummaryMembers<Fields extends z.ZodRawShape> = {
  [T in GatewayType]: GatewaySummaryMember<T, Fields>;
}[GatewayType];

/**
 * The response-side sibling of `gatewayUnion` in `./schemas.ts`: the common
 * `fields` beside the type and its connection nested under `config`, published
 * as the stored strings without the request's own limits.
 */
function gatewaySummaryUnion<Fields extends z.ZodRawShape>(fields: Fields) {
  const members = GATEWAY_TYPES.map((type) => {
    const { connection } = GATEWAY_DESCRIPTORS[type];
    const config = z.object(
      Object.fromEntries(Object.keys(connection.shape).map((key) => [key, z.string()])),
    );
    return z.object({
      ...fields,
      type: z.literal(type),
      config: connection.description === undefined
        ? config
        : config.meta({ description: connection.description }),
    });
  });
  // As in `gatewayUnion`: each member is its own type's, which the mapped
  // array cannot say, and zod wants a non-empty tuple.
  return z.discriminatedUnion(
    "type",
    members as [GatewaySummaryMembers<Fields>, ...GatewaySummaryMembers<Fields>[]],
  );
}

/**
 * Discriminated by `type`, because each gateway's `config` is its own
 * connection: Cloudflare's account and gateway pair, and nothing at all for
 * Vercel, whose origin is fixed in adapter code and whose team is named by the
 * token.
 */
export const ProviderGatewaySummarySchema = gatewaySummaryUnion(providerGatewayFields)
  .meta({ id: "ProviderGateway" });

export const GatewayValidatedSchema = z.boolean().meta({
  description: "Whether the live probe confirmed the connection. Unlike the providers API, a refused token is not an error here: a Cloudflare AI Gateway answers 401 both for a wrong token and for a gateway that is not finished being set up, so the verdict is reported as reason: rejected and the caller decides what it means.",
});

export const GatewayProbeReasonSchema = z
  .enum(["no_probe", "unreachable", "unexpected_status", "rejected"])
  .meta({
    description: "Why the probe did not confirm the connection. Absent when validated is true. rejected means the gateway refused the token.",
  });

export const ProviderGatewayListResponseSchema = z.object({
  gateways: z.array(ProviderGatewaySummarySchema),
});

export const ProviderGatewayResponseSchema = z.object({
  gateway: ProviderGatewaySummarySchema,
});

export const ProviderGatewayTestResponseSchema = z.object({
  validated: GatewayValidatedSchema,
  reason: GatewayProbeReasonSchema.optional(),
  status: ProbeStatusSchema.optional(),
});

export const ProviderGatewayDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  provider_gateway_id: z.string(),
});

export const OrganizationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  claimed: z.boolean(),
  expiresAt: z.string().nullable(),
});

export const OrganizationMembershipSchema = z.object({
  organization: OrganizationSummarySchema,
  role: OrganizationRoleSchema,
  status: z.literal("active"),
  joinedAt: z.string(),
});

export const IdentitySessionSchema = z.object({
  session: z.object({
    user: z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      kind: z.enum(["human", "service"]),
      emailVerified: z.boolean(),
      image: z.string().nullable(),
      createdAt: z.string(),
    }).nullable(),
    organization: OrganizationSummarySchema.nullable(),
    role: OrganizationRoleSchema,
    memberships: z.array(OrganizationMembershipSchema),
    credentialType: z.enum(["session", "apiKey", "oauth"]),
    /**
     * How the caller proved who they are: `interactive` for a human who just
     * signed in, `credential` for a key. The CLI's browser handoff refuses to
     * complete a claim on anything but the former, and this is where a client
     * can see which it holds.
     */
    assurance: z.enum(["interactive", "credential"]).nullable(),
    /** The identity acting, which for a management key is the key's owner. */
    actor: z.object({
      type: z.literal("user"),
      id: z.string(),
      kind: z.enum(["human", "service"]),
      credentialId: z.string().nullable(),
      actionSource: z.string(),
    }).nullable(),
    /**
     * Whether this account's apps refuse requests with `email_unverified`
     * right now: the deployment verifies addresses, the account is not
     * activated, and no owner of it has verified theirs. False wherever
     * traffic is served, an unverified owner of an activated account included.
     */
    verificationPending: z.boolean(),
  }),
});

/**
 * What an OAuth consent page reads before it shows anything: who is asking,
 * for what, where the browser goes afterwards, and what this browser may do
 * about it. No secret is ever part of it.
 */
export const OAuthConsentDetailsResponseSchema = z.object({
  id: z.string(),
  /** `pending` until a person allows or denies it, or it lapses ten minutes after it opened. */
  state: z.enum(["pending", "completed", "denied", "expired", "retired"]),
  client: z.object({
    /** The `client_id`: a registered client's id, or the https URL of its metadata document. */
    id: z.string(),
    /**
     * The client's own name for itself. Untrusted text: show it as text, as
     * declared by `domain`, never as markup.
     */
    name: z.string(),
    /** The host that served the client's metadata document; null for a registered client. */
    domain: z.string().nullable(),
    source: z.enum(["cimd", "registered"]),
  }),
  /** Where the browser is sent once this is decided: the host of the client's redirect URI. */
  redirectHost: z.string(),
  /** What the client asked for. The person chooses the grant; it is only the default. */
  requestedGrant: CredentialGrantSchema,
  expiresAt: z.string(),
  /** The person signed in to this browser, who would allow it; null when nobody is. */
  viewer: z.object({ name: z.string().nullable(), email: z.string().nullable() }).nullable(),
  /** The accounts that person may connect the client to: every live membership. */
  accounts: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: OrganizationRoleSchema,
  })),
  /**
   * What stands between this browser and Allow: nobody is signed in, or the
   * person signed in belongs to no account the client could use. Null when
   * nothing does.
   */
  blockedBy: z.enum(["registration_required", "no_eligible_organization"]).nullable(),
  /**
   * Whether "continue without an account" would be admitted now: always on
   * the hosted service, and on a self-hosted deployment only while it is
   * empty. A guest connection always has the `manage` grant.
   */
  guestAvailable: z.boolean(),
  /** When an account created now without a person would be deleted unless claimed; null where accounts have no deadline. */
  guestExpiresAt: z.string().nullable(),
  googleEnabled: z.boolean(),
  /** Whether the console's own registration would admit a new person now. */
  registrationOpen: z.boolean(),
});

/** Where the consent page sends the browser next: the client's redirect URI, with the code or the refusal. */
export const OAuthConsentRedirectResponseSchema = z.object({
  redirect: z.string().meta({
    description: "The client's redirect URI with `code`, `state` and `iss`, or with `error=access_denied` after a denial. Navigate the browser there.",
  }),
});

export const SendVerificationEmailResponseSchema = z.object({
  status: z.enum(["sent", "already_verified"]).meta({
    description: "`sent` when a link went out now; `already_verified` when the address needs none.",
  }),
  email: z.string().meta({ description: "The address the link was sent to, or that is already verified." }),
});

export const ConfirmEmailVerificationResponseSchema = z.object({
  email: z.string().meta({ description: "The address now verified." }),
  returnTo: z.string().nullable().meta({
    description: "The console path the link was asked for from, to continue there; null for none.",
  }),
});

export const OrganizationListResponseSchema = z.object({
  organizations: z.array(OrganizationMembershipSchema),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type GatewayTokenResponse = z.infer<typeof GatewayTokenResponseSchema>;
export type CurrentUserResponse = z.infer<typeof CurrentUserResponseSchema>;
export type ConsoleCapabilitiesResponse = z.infer<typeof ConsoleCapabilitiesResponseSchema>;
export type UsageEvent = z.infer<typeof UsageEventSchema>;
export type UsageEventList = z.infer<typeof UsageEventListSchema>;
export type AuthEvent = z.infer<typeof AuthEventSchema>;
export type AuthEventList = z.infer<typeof AuthEventListSchema>;
export type RejectionEvent = z.infer<typeof RejectionEventSchema>;
export type RejectionEventList = z.infer<typeof RejectionEventListSchema>;
export type AuthEventSummary = z.infer<typeof AuthEventSummarySchema>;
export type AppResponse = z.infer<typeof AppResponseSchema>;
export type AppWarning = z.infer<typeof AppWarningSchema>;
export type AppDeleteResponse = z.infer<typeof AppDeleteResponseSchema>;
export type ManagementKeySummary = z.infer<typeof ManagementKeySummarySchema>;
export type OAuthConsentDetailsResponse = z.infer<typeof OAuthConsentDetailsResponseSchema>;
export type OAuthConsentRedirectResponse = z.infer<typeof OAuthConsentRedirectResponseSchema>;
export type ManagementKeyListResponse = z.infer<typeof ManagementKeyListResponseSchema>;
export type CreatedManagementKeyResponse = z.infer<typeof CreatedManagementKeyResponseSchema>;
export type ManagementKeyResponse = z.infer<typeof ManagementKeyResponseSchema>;
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;
export type ProbeReason = z.infer<typeof ProbeReasonSchema>;
export type ProviderGatewayProbeReason = z.infer<typeof GatewayProbeReasonSchema>;
export type ProviderListResponse = z.infer<typeof ProviderListResponseSchema>;
export type ProviderResponse = z.infer<typeof ProviderResponseSchema>;
export type ProviderTestResponse = z.infer<typeof ProviderTestResponseSchema>;
export type ProviderDeleteResponse = z.infer<typeof ProviderDeleteResponseSchema>;
export type ProviderGatewaySummary = z.infer<typeof ProviderGatewaySummarySchema>;
export type ProviderGatewayListResponse = z.infer<typeof ProviderGatewayListResponseSchema>;
export type ProviderGatewayResponse = z.infer<typeof ProviderGatewayResponseSchema>;
export type ProviderGatewayTestResponse = z.infer<typeof ProviderGatewayTestResponseSchema>;
export type ProviderGatewayDeleteResponse = z.infer<typeof ProviderGatewayDeleteResponseSchema>;
export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>;
export type OrganizationMembership = z.infer<typeof OrganizationMembershipSchema>;
export type IdentitySession = z.infer<typeof IdentitySessionSchema>;
export type OrganizationListResponse = z.infer<typeof OrganizationListResponseSchema>;

/**
 * The rest of the admin surface. `./catalog.ts` documents each operation with
 * these, so the handler, the document, the console and the CLI all move
 * together.
 */
export const UsageTotalsSchema = z.object({
  requests: z.number(),
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  cache_write_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
  errors: z.number(),
});

export const AppSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(APP_STATUSES),
  authentication_type: z.enum(["apple_app_attest", "api_key"]),
  apple_bundle_id: z.string().nullable(),
  created_at: z.string(),
  providers: z.array(z.string()),
  /**
   * The slugs this app names outright: selected-mode policy keys, endpoint
   * targets and endpoint fallbacks. Unlike `providers`, an all-mode app is not
   * expanded here — it reaches every instance without referencing any.
   */
  referenced_providers: z.array(z.string()),
  allowed_model_count: z.number(),
  /** What the whole app may spend this month; `null` is unlimited. */
  monthly_budget_usd: z.number().nullable(),
  users: z.object({ total: z.number(), blocked: z.number() }),
  usage: UsageTotalsSchema,
});

export const AppListResponseSchema = z.object({
  month: z.string(),
  has_proxied_requests: z.boolean().meta({
    description:
      "Whether this account has ever recorded a provider attempt, at any time. Refusals before a provider call do not set this flag. Unlike the per-application `usage` totals beside it, which cover `month` only, this does not reset when a new month begins, and it never goes from true back to false. Intended for first-run interfaces that stop offering setup guidance once traffic has started.",
  }),
  apps: z.array(AppSummarySchema),
});

export const AppValidateResponseSchema = z.object({
  valid: z.literal(true),
  app_id: z.string(),
});

/** A configuration for an application that does not exist yet would be accepted. */
export const AppDraftValidateResponseSchema = z.object({
  valid: z.literal(true),
});

/**
 * What a configuration check of a stored application established, without
 * sending it any traffic.
 */
export const AppCheckResponseSchema = z.object({
  appId: z.string(),
  validation: AppValidateResponseSchema.meta({
    description: "The stored configuration judged as an update of it would be. A configuration that would be refused answers the check itself with 400.",
  }),
  status: z.enum(APP_STATUSES),
  providers: z.array(z.object({
    id: z.string(),
    slug: z.string(),
    status: z.enum(["active", "disabled"]),
  })).meta({
    description: "Every provider instance the application's routing names, a disabled one included so that it shows as disabled rather than missing.",
  }),
  ready: z.boolean().meta({
    description: "Whether the application is active, at least one provider it names is active, and the account may serve requests (`accountRefusal` is null).",
  }),
  accountRefusal: z.enum(["email_unverified", "unclaimed_access_expired", "account_expired"]).nullable().meta({
    description: "Why the account would refuse this application's requests, as the error code its clients would get, or null when it would serve them. `email_unverified`: the account's owner has not verified their email address yet, on a deployment that verifies them; it clears once they open the link in the verification email.",
  }),
  limitations: z.array(z.string()).meta({
    description: "What this check did not exercise, one sentence each.",
  }),
  warnings: z.array(AppWarningSchema).meta({
    description: "The application's warnings, as reading it returns them: behaviour that will stop on a stated date. They never make an application not ready.",
  }),
});

/** The first request an application can send, in the language its callers authenticate with. */
export const AppSnippetResponseSchema = z.object({
  language: z.enum(["swift", "shell"]),
  snippet: z.string().meta({
    description: "Source to paste. It never contains a credential: a server application's example reads its key from APP_AI_GATEWAY_KEY.",
  }),
  notes: z.array(z.string()).meta({
    description: "What the example stands in for or leaves out, one sentence each. They are also written into the snippet as comments.",
  }),
});

export const CreatedApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The plaintext key, present exactly once, in the create response. */
  key: z.string(),
  key_prefix: z.string(),
  created_at: z.string(),
});

/**
 * An application key as a result names it once it has been created: every
 * field but its value. What a change operation records, and what an agent
 * reads, in place of the key itself.
 */
export const AppKeyMetadataSchema = CreatedApiKeySchema.omit({ key: true });

export const CreatedAppResponseSchema = AppResponseSchema.extend({
  api_key: CreatedApiKeySchema.nullable(),
});

export const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  status: z.enum(["active", "revoked"]),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

export const ApiKeyListResponseSchema = z.object({
  app_id: z.string(),
  keys: z.array(ApiKeySchema),
});

export const ApiKeyRevokeResponseSchema = z.object({
  app_id: z.string(),
  key: ApiKeySchema,
});

export const GatewayUserSchema = z.object({
  id: z.string(),
  status: z.enum(["active", "blocked"]),
  attest_key_id: z.string().nullable().meta({
    description: "The user's most recently seen App Attest key id, if they hold any. Under app_install it is the user's own id.",
  }),
  attest_registered: z.boolean().meta({ description: "Whether the user holds at least one App Attest key." }),
  installs: z.number().int().meta({
    description: "How many App Attest keys the user holds: one per install, that is one copy of the app on one device, and a new one each time the app is reinstalled. Always 0 on server applications.",
  }),
  is_install: z.boolean().meta({
    description: "Whether this row's id is itself a registered App Attest key, so the row is one install: every row of an app_install application, and none of a signed-in user's. Decided per row, so history kept from before an application changed its user identity reads as what it was. A per-install budget measures a row's spend only when this is true.",
  }),
  created_at: z.string(),
  last_seen_at: z.string().nullable(),
  is_virtual: z.boolean(),
  usage: UsageTotalsSchema,
});

export const UserListResponseSchema = z.object({
  app_id: z.string(),
  month: z.string(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  users: z.array(GatewayUserSchema),
});

export const UserResponseSchema = z.object({
  app_id: z.string(),
  month: z.string(),
  user: GatewayUserSchema,
});

export const UserBlockResponseSchema = z.object({
  app_id: z.string(),
  user_id: z.string(),
  blocked: z.boolean(),
});

export const MonthlyUsageResponseSchema = z.object({
  app_id: z.string(),
  month: z.string(),
  ...UsageTotalsSchema.omit({ errors: true }).shape,
});

export const TimeseriesBucketSchema = UsageTotalsSchema.extend({
  date: z.string(),
  provider: z.string(),
});

export const TimeseriesResponseSchema = z.object({
  app_id: z.string(),
  from: z.string(),
  to: z.string(),
  buckets: z.array(TimeseriesBucketSchema),
});

export const BreakdownRowSchema = UsageTotalsSchema.extend({
  key: z.string().nullable(),
});

export const BreakdownResponseSchema = z.object({
  app_id: z.string(),
  by: z.enum(USAGE_BREAKDOWN_DIMENSIONS),
  from: z.string(),
  to: z.string(),
  rows: z.array(BreakdownRowSchema),
});

/**
 * What a repricing run would change, or did.
 *
 * `applied` is the difference between a dry run and a write: a dry run is the
 * only one that can report `unpriced_events`, because an apply refuses outright
 * rather than leaving some events at a stale figure.
 */
export const UsageRepriceResponseSchema = z.object({
  app_id: z.string(),
  provider: z.string(),
  model: z.string(),
  month: z.string(),
  applied: z.boolean(),
  matched_events: z.number().int(),
  unmetered_events: z.number().int().meta({
    description: "Matched events that carried no readable usage, and so were repriced to the zero their zero counts imply while keeping whatever cost_source they had. A non-zero number means the month contains spend nothing could meter, which repricing cannot fix and must not appear to have fixed.",
  }),
  unpriced_events: z.number().int().meta({
    description: "Dry-run only: matched events whose serving instance can no longer price them, or that predate the modality breakdown their model's price depends on.",
  }),
  unpriced_cost_usd: z.number(),
  previous_cost_usd: z.number(),
  recalculated_cost_usd: z.number(),
  delta_usd: z.number(),
});

export const ModelPriceSchema = z.object({
  kind: z.enum(MODEL_KINDS).meta({
    description:
      "What the model does: text, image (generation), speech (text to speech), transcription (speech to text), embedding, or realtime (served only over a realtime session). A custom endpoint serves models of its own kind only.",
  }),
  input: z.number().optional(),
  output: z.number().optional(),
  image_input: z.number().optional().meta({
    description: "USD per 1M image input tokens, where they are priced apart from text input.",
  }),
  audio_input: z.number().optional().meta({
    description: "USD per 1M audio input tokens, where they are priced apart from text input.",
  }),
  video_input: z.number().optional().meta({
    description: "USD per 1M video input tokens, where they are priced apart from text input.",
  }),
  image_output: z.number().optional().meta({
    description: "USD per 1M generated image tokens, where they cost more than text output.",
  }),
  cached_input: z.number().optional(),
  cache_write: z.number().optional(),
  cache_write_1h: z.number().optional().meta({
    description: "USD per 1M tokens written to a one-hour cache, where it costs more than the default cache write.",
  }),
  per_minute: z.number().optional(),
  per_hour: z.number().optional(),
  per_image: z.number().optional().meta({
    description: "USD per generated image, for a model billed per image rather than per token.",
  }),
  long_context_threshold: z.number().optional(),
  long_input: z.number().optional(),
  long_output: z.number().optional(),
  long_cached_input: z.number().optional(),
  long_cache_write: z.number().optional(),
  long_cache_write_1h: z.number().optional(),
  retirement_date: z.string().optional().meta({
    description:
      "The day (YYYY-MM-DD) the provider stops, or stopped, serving this model. The model stays priced after it.",
  }),
});

export const PricesResponseSchema = z.object({
  prices: z.record(z.string(), z.record(z.string(), ModelPriceSchema)),
});

/**
 * What a completed operation leaves in the clear: the ids and metadata of
 * what it changed, never a secret. An application key it created appears
 * without its value, which only the reveal page shows.
 */
export const OperationResultSchema = z.object({
  /** The account a claim settled, a login landed in, or a bootstrap created. */
  accountId: z.string().optional(),
  // An outcome recorded before warnings existed has none.
  app: AppResponseSchema.shape.app.extend({ warnings: AppResponseSchema.shape.app.shape.warnings.optional() }).optional(),
  api_key: AppKeyMetadataSchema.nullable().optional(),
  provider: ProviderSummarySchema.optional(),
  gateway: ProviderGatewaySummarySchema.optional(),
}).meta({ id: "OperationResult" });

/**
 * Where one operation of your account stands, read by any credential of it.
 * Never a secret: a key the operation created is revealed only on the page
 * `reveal_url` names, to a person signed in as an owner or admin.
 */
export const OperationStatusResponseSchema = z.object({
  id: z.string(),
  /**
   * The operation's kind as the gateway runs it: `app.add.reserved` for an app
   * created under a reservation, `provider.add.browser` for a provider whose
   * key a person enters in a browser, `claim`, and so on.
   */
  kind: z.string(),
  state: z.enum(["pending", "completed", "expired"]),
  /** Set beside `state: "expired"` when a person declined the browser step rather than letting it lapse. */
  denied: z.literal(true).optional(),
  createdAt: z.string(),
  /** While pending, when it lapses unless completed. */
  expiresAt: z.string(),
  result: OperationResultSchema.optional(),
  /** While a key the operation created can still be revealed, once, the page a person opens to see it. */
  reveal_url: z.url().optional(),
}).meta({ id: "OperationStatus" });

/** A key an operation created, revealed once to the person who asked for it. */
export const RevealedOperationResponseSchema = z.object({
  id: z.string(),
  kind: z.string(),
  result: z.object({
    app: AppResponseSchema.shape.app.extend({ warnings: AppResponseSchema.shape.app.shape.warnings.optional() }).optional(),
    /** `key` is the plaintext. It is shown this once; the gateway keeps only a hash. */
    api_key: CreatedApiKeySchema.nullable().optional(),
  }),
}).meta({ id: "RevealedOperation" });

export type OperationResult = z.infer<typeof OperationResultSchema>;
export type OperationStatusResponse = z.infer<typeof OperationStatusResponseSchema>;
export type RevealedOperationResponse = z.infer<typeof RevealedOperationResponseSchema>;
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;
export type AppSummary = z.infer<typeof AppSummarySchema>;
export type AppListResponse = z.infer<typeof AppListResponseSchema>;
export type AppValidateResponse = z.infer<typeof AppValidateResponseSchema>;
export type AppDraftValidateResponse = z.infer<typeof AppDraftValidateResponseSchema>;
export type AppCheckResponse = z.infer<typeof AppCheckResponseSchema>;
export type AppSnippetResponse = z.infer<typeof AppSnippetResponseSchema>;
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;
export type CreatedAppResponse = z.infer<typeof CreatedAppResponseSchema>;
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponseSchema>;
export type ApiKeyRevokeResponse = z.infer<typeof ApiKeyRevokeResponseSchema>;
export type GatewayUser = z.infer<typeof GatewayUserSchema>;
export type UserListResponse = z.infer<typeof UserListResponseSchema>;
export type UserResponse = z.infer<typeof UserResponseSchema>;
export type UserBlockResponse = z.infer<typeof UserBlockResponseSchema>;
export type MonthlyUsageResponse = z.infer<typeof MonthlyUsageResponseSchema>;
export type TimeseriesBucket = z.infer<typeof TimeseriesBucketSchema>;
export type TimeseriesResponse = z.infer<typeof TimeseriesResponseSchema>;
export type BreakdownRow = z.infer<typeof BreakdownRowSchema>;
export type BreakdownResponse = z.infer<typeof BreakdownResponseSchema>;
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export type PricesResponse = z.infer<typeof PricesResponseSchema>;
export type UsageRepriceResponse = z.infer<typeof UsageRepriceResponseSchema>;
