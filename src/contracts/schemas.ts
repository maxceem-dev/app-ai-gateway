import { z } from "zod";
import { MAX_BASE_URL_LENGTH } from "../core/origin-guard.ts";
import {
  ENDPOINT_API_STYLES,
  OUTPUT_CLAMP_STYLES,
  type EndpointApiStyle,
} from "../shared/capabilities.ts";
import { ENDPOINT_KINDS, type EndpointKind } from "../shared/model-kinds.ts";
import { PROTOCOLS } from "../shared/protocols.ts";
import {
  GATEWAY_DESCRIPTORS,
  GATEWAY_TYPES,
  type GatewayConnectionShape,
  type GatewayType,
} from "../shared/gateways.ts";
import { PROVIDER_CREDENTIAL_HEADERS, PROVIDER_TYPES } from "../shared/providers.ts";
import { APP_STATUSES } from "../shared/app-status.ts";
import { LONG_RATE_FIELDS, TOKEN_RATE_FIELDS, type TokenRateField } from "../shared/token-rates.ts";

/**
 * The vocabulary an application configuration is written in.
 *
 * It lives beside the schema that enforces it rather than in `src/shared`,
 * because the schema *is* the grammar now: one parser, one set of patterns, and
 * nothing that can drift from it. `src/shared/app-config.ts` re-exports these
 * for the callers that have always read them from there.
 */
export const ISSUER_PROVIDERS = ["firebase", "supabase", "auth0", "clerk", "custom"] as const;
export const ENTITLEMENT_CHECKS = ["revenuecat", "custom"] as const;
export const APP_ATTEST_ENVIRONMENTS = ["production", "development"] as const;
/**
 * When an App Attest application's assertions are verified: on every gateway
 * request, each carrying its own `X-AppAttest-Proof`, or only at the token
 * exchange, after which requests carry the hourly gateway token alone.
 */
export const APP_ATTEST_VERIFY_ON = ["every_request", "token_exchange"] as const;
export const DEFAULT_END_USER_HEADER = "x-end-user-id";
export const ENDPOINT_SLUG = /^[a-z0-9-]{1,64}$/;
export const PROVIDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const HTTP_FIELD_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/**
 * A UTC calendar month as `YYYY-MM`, with a month that exists. Flag-free for
 * the same reason as the slug patterns: it is published as an OpenAPI
 * `pattern`.
 */
export const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
export const MONTH_FORMAT_MESSAGE = "month must use YYYY-MM format";
/** Every `month` a request names: a query parameter or a body field alike. */
export const MonthSchema = z.string().regex(MONTH_PATTERN, { error: MONTH_FORMAT_MESSAGE });

/** The documented Google OAuth redirect-initiation body. */
export const GoogleSignInRequestSchema = z.object({
  provider: z.literal("google"),
  callbackURL: z.string().optional().meta({
    description: "Where to send the browser after successful sign-in; may be a relative console path.",
  }),
  errorCallbackURL: z.string().optional().meta({
    description: "Where to send the browser if sign-in fails; may be a relative console path.",
  }),
  disableRedirect: z.boolean().optional().meta({
    description: "Set true to suppress Better Auth's Location header; the JSON response still contains the provider URL.",
  }),
});

/** Apple's ten-character team identifier, as the developer portal prints it. */
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;
/** A reverse-DNS bundle identifier: at least two dot-separated labels. */
const APPLE_BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/**
 * Keys a configuration may never name, wherever it supplies its own.
 *
 * Every one of them is a legal own property on a JSON object and a member of
 * `Object.prototype`, so a lookup that reached the prototype would resolve a
 * provider, a rewrite or an endpoint nobody configured. The reads themselves
 * are already own-property-only; refusing the keys means the question never
 * arises, and no stored configuration can be written to pose it.
 *
 * `__proto__` is refused in the same breath, but zod removes it from a record
 * before any check can see it — which is the same outcome by a shorter route:
 * it is never parsed, and so never stored.
 */
const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const RESERVED_KEY_ERROR = "key cannot be __proto__, constructor or prototype";

const safeKey = <T extends z.ZodString>(schema: T): T =>
  schema.refine((key) => !RESERVED_OBJECT_KEYS.has(key), { error: RESERVED_KEY_ERROR });

/**
 * Descriptor-driven, and the only gate there is: the `provider.type` column
 * carries whatever is stored, and a type is creatable exactly once
 * `PROVIDER_DESCRIPTORS` says how to reach, authenticate and price it. The
 * database is permissive; the runtime table is authoritative.
 */
export const ProviderTypeSchema = z.enum(PROVIDER_TYPES);

/**
 * A request-count limit: a whole number of requests, or null for unlimited.
 * Zero is not a limit, it is a closed door, and is rejected as a likely typo.
 */
const NullableRequestLimit = z.number().int().positive().nullable();

/**
 * A spending limit in USD, or null for unlimited. Zero is allowed and means no
 * spend. Bounded above by what survives the conversion to whole microdollars
 * the limiter counts in: past that a budget silently stops being the number
 * that was typed.
 */
const NullableSpendLimit = z.number()
  .nonnegative()
  .refine((usd) => Number.isSafeInteger(Math.round(usd * 1_000_000)), {
    error: "monthly_usd is too large",
  })
  .nullable();
/**
 * A provider instance slug: the `{slug}` segment of `/proxy/{slug}/…`, and the
 * key an application's routing policy names an instance by.
 *
 * Reserved keys are refused here rather than where the policy is keyed, so a
 * slug that no configuration could ever reference cannot be claimed in the
 * first place. `__proto__` never reaches the check — the pattern has no
 * underscore — leaving `constructor` and `prototype`, which the pattern does
 * admit and which every plain object already answers to.
 */
export const SlugSchema = safeKey(
  z.string().regex(PROVIDER_SLUG_PATTERN).meta({
    description:
      "Lowercase letters, digits and hyphens, starting with a letter or digit. `constructor` and `prototype` are reserved.",
  }),
);

/**
 * A claim path or value an operator typed, stored trimmed: a space pasted
 * around an entitlement id would otherwise never match the claim it names.
 * Blank is refused rather than stored: it is a half-filled form, not a
 * requirement, and it would match only a claim that is itself blank — a
 * paid-user check that never admits a paying user.
 */
// Flag-free, because the source is published verbatim as an OpenAPI `pattern`.
const ClaimTextSchema = z.string().trim().regex(/\S/, { error: "must not be blank" });

const ClaimRequirementSchema = z.object({
  path: ClaimTextSchema,
  contains: z.union([ClaimTextSchema, z.array(ClaimTextSchema).min(1)]).optional(),
  equals: z.union([ClaimTextSchema, z.number(), z.boolean()]).optional(),
}).strict().superRefine((value, context) => {
  // Exactly one: a requirement with both says two different things about the
  // same claim, and one with neither says nothing and would admit everybody.
  if ((value.contains === undefined) === (value.equals === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Claim requirements need exactly one of contains or equals",
    });
  }
});

/**
 * One value or a list of alternatives, for the two claims that scope an app to
 * a tenant. A list covers a migration between two issuers or bundle ids.
 *
 * Stored as a list either way: the gateway compares against a set, and a single
 * string is just the one-element case of it. Writing that normalization here
 * rather than at each read is what lets the stored form be the parsed form.
 */
const IssuerClaimValuesSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((value) => (typeof value === "string" ? [value] : value));

const IssuerAuthenticationSchema = z.object({
  /**
   * HTTPS only, and stored in the canonical form `URL` prints: the gateway
   * fetches this on the authentication path, so a plaintext origin would put
   * the keys that verify every token on the wire for anyone to replace.
   */
  jwks_url: z.url({ protocol: /^https$/, error: "Issuer JWKS URLs must be valid and use HTTPS" })
    // Guarded, because a check still runs on a value the format check has
    // already rejected, and `new URL` on one of those throws out of the parse.
    .overwrite((value) => {
      try {
        return new URL(value).toString();
      } catch {
        return value;
      }
    })
    .meta({ description: "An https URL. Stored in the canonical form `URL` prints." }),
  /**
   * Required: several issuers publish one JWKS for every customer — Firebase
   * signs all projects with the same keys — so without `iss` and `aud` a token
   * minted in an attacker's own project verifies against this app.
   */
  issuer: IssuerClaimValuesSchema,
  audience: IssuerClaimValuesSchema,
  user_id_claim: z.string().min(1),
  /** Lowercased, because header lookups ignore case. */
  token_header: z.string().min(1).toLowerCase().superRefine(refuseReservedHeader).optional(),
  required_claims: z.array(ClaimRequirementSchema),
  max_token_lifetime_seconds: z.number().int().positive(),
  /**
   * Which identity provider the three scoping fields were written for, and
   * which kind of paid-user check `required_claims` implements. Bookkeeping for
   * the console, so it can show "Firebase, project X" and reopen the same
   * form: the gateway verifies tokens from the fields above and reads neither.
   *
   * Refused rather than dropped when this build does not know the name: this
   * schema is checked on the way in, so a name it cannot interpret never
   * reaches storage in the first place.
   */
  provider: z.enum(ISSUER_PROVIDERS).optional(),
  entitlement: z.enum(ENTITLEMENT_CHECKS).optional(),
}).strict();

/**
 * Headers the gateway already owns, which an application may therefore name
 * neither as its end-user id header nor as its issuer token header. Naming a
 * credential carrier as the user id header would read the caller's own key as
 * a user id, then store, display and log it; naming `x-app-version` as the
 * token header would send a credential where the gateway logs the app version.
 */
const RESERVED_APP_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "x-appattest-proof",
  ...PROVIDER_CREDENTIAL_HEADERS,
  "x-app-version",
  "content-type",
  "content-length",
  "host",
]);

function refuseReservedHeader(header: string, context: z.RefinementCtx): void {
  if (RESERVED_APP_HEADERS.has(header)) {
    context.addIssue({
      code: "custom",
      message: `cannot be ${header}: the gateway already uses that header`,
    });
  }
}

/**
 * A header name, as HTTP defines one (RFC 9110 field names). Bounded because it
 * is echoed into error messages and compared on every request, and lowercased
 * here since header lookups ignore case.
 */
const EndUserHeaderSchema = z.string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(HTTP_FIELD_NAME, { error: "must be a valid HTTP header name" })
  .superRefine(refuseReservedHeader);

const HeaderEndUserSchema = z.object({
  source: z.literal("header"),
  header: EndUserHeaderSchema,
}).strict();

const IssuerEndUserSchema = z.object({
  source: z.literal("issuer"),
  issuer: IssuerAuthenticationSchema,
}).strict();

const AppInstallEndUserSchema = z.object({
  source: z.literal("app_install"),
}).strict();

const NoEndUserSchema = z.object({
  source: z.literal("none"),
}).strict();

/**
 * Each application type admits only the sources that can mean anything for it,
 * so an impossible pairing is a schema error rather than a rule someone has to
 * remember: an `api_key` app has no attested key and may have no end users at
 * all, and an App Attest client is the end user's own device and so cannot be
 * trusted to name itself, but always is somebody.
 */
const ApiKeyEndUserSchema = z.discriminatedUnion("source", [
  NoEndUserSchema,
  HeaderEndUserSchema,
  IssuerEndUserSchema,
], { error: "authentication.end_user.source must be one of none, header, issuer" });

const AppAttestEndUserSchema = z.discriminatedUnion("source", [
  IssuerEndUserSchema,
  AppInstallEndUserSchema,
], { error: "authentication.end_user.source must be one of issuer, app_install" });

/**
 * The two values that name one iOS application to Apple, stored trimmed so a
 * space pasted with either is not what every attestation is compared against.
 */
const AppleAppIdentitySchema = z.object({
  team_id: z.string().trim().regex(APPLE_TEAM_ID, {
    error: "team_id must contain ten uppercase letters or digits",
  }),
  bundle_id: z.string().trim().regex(APPLE_BUNDLE_ID, {
    error: "bundle_id must be a reverse DNS identifier",
  }),
});

const AppleAppAttestAuthenticationSchema = z.object({
  type: z.literal("apple_app_attest"),
  end_user: AppAttestEndUserSchema,
  app_attest: AppleAppIdentitySchema.extend({
    /**
     * Which of Apple's two App Attest environments this application accepts.
     * Defaulted to `["production"]` alone, because a development-signed build
     * stamps a different aaguid and is debuggable on any device carrying the
     * team's provisioning profile. Accepting one is therefore a deliberate
     * per-application opt-in, and belongs on a development bundle id rather
     * than the one shipped to the App Store.
     */
    environments: z.array(z.enum(APP_ATTEST_ENVIRONMENTS))
      .min(1, { error: "environments must name at least one environment" })
      .refine((values) => new Set(values).size === values.length, {
        error: "environments cannot repeat a value",
      })
      .prefault(["production"]),
    /**
     * Where the install's App Attest key proves itself. `every_request`, the
     * default, binds every gateway request to the device: each one carries
     * an assertion over that very request, so a copied token is worthless.
     * `token_exchange` checks the assertion only when the hourly gateway
     * token is minted, and requests then carry the token alone; limits and
     * budgets still count per install, because the token names it.
     */
    verify_on: z.enum(APP_ATTEST_VERIFY_ON, {
      error: "verify_on must be one of every_request, token_exchange",
    }).default("every_request").meta({
      description: "When the install's App Attest assertion is verified. every_request (the default): every gateway request carries X-AppAttest-Proof, a fresh assertion over that request; needs the AppAIGateway Swift package 1.4 or later. token_exchange: the assertion is verified once, when the hourly gateway token is exchanged, and requests carry only the token.",
    }),
  }).strict(),
}).strict();

const ApiKeyAuthenticationSchema = z.object({
  type: z.literal("api_key"),
  /**
   * Required, because having no end users is a position rather than a default:
   * `none` states it, and then nothing is metered or blocked per user and
   * `limits.per_user` is refused as meaningless. Naming any other source is how
   * an application opts into having users at all.
   */
  end_user: ApiKeyEndUserSchema,
}).strict();

const AllowedPathSchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    fixed_model: z.string().min(1).optional(),
    clamp: z.enum(OUTPUT_CLAMP_STYLES).optional(),
  }).strict(),
]);

/**
 * What one provider instance may be asked for. Both lists are required on the
 * wire — empty means "no restriction", which is a different statement from
 * "unspecified", and the console's draft layer materializes them.
 */
const ProviderPolicySchema = z.object({
  allowed_paths: z.array(AllowedPathSchema),
  allowed_models: z.array(z.string().min(1)),
  max_output_tokens: z.number().int().positive().optional(),
}).strict();

const EndpointTargetSchema = z.object({
  provider: SlugSchema,
  model: z.string().min(1),
});

/** The kinds of model an endpoint style carries, best first: the first is its default. */
export function endpointStyleKinds(style: EndpointApiStyle): EndpointKind[] {
  return ENDPOINT_KINDS.filter((kind) => PROTOCOLS[style].kinds.includes(kind));
}

/**
 * What an endpoint serves. Written on every parsed configuration; a draft that
 * names none serves its style's default, which is what a parse would write.
 */
export function endpointKind(endpoint: { kind?: EndpointKind; api_style: EndpointApiStyle }): EndpointKind {
  return endpoint.kind ?? endpointStyleKinds(endpoint.api_style)[0] ?? "text";
}

/**
 * A custom endpoint names what it does (`kind`) and the API its clients speak
 * (`api_style`), which are different questions only where one API carries
 * several kinds: Gemini's `generateContent` serves text, image and speech
 * models alike. Everywhere else the style settles the kind, so a configuration
 * written before kinds existed parses unchanged and has it filled in.
 */
const EndpointSchema = EndpointTargetSchema.extend({
  kind: z.enum(ENDPOINT_KINDS).optional().meta({
    description:
      "What the endpoint does, which decides the models it may serve: text, image, speech (text to speech), transcription (speech to text) or embedding. Must be a kind its api_style carries; defaults to the first of them (text for gemini_native). Filled in on every parsed configuration.",
  }),
  api_style: z.enum(ENDPOINT_API_STYLES),
  params: z.record(z.string(), z.unknown()).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  fallback: z.array(EndpointTargetSchema).optional(),
}).strict().superRefine((endpoint, context) => {
  const kinds = endpointStyleKinds(endpoint.api_style);
  if (endpoint.kind !== undefined && !kinds.includes(endpoint.kind)) {
    context.addIssue({
      code: "custom",
      path: ["kind"],
      message: `cannot be ${endpoint.kind}: a ${endpoint.api_style} endpoint serves ${
        new Intl.ListFormat("en", { type: "disjunction" }).format(kinds)
      }`,
    });
  }
}).overwrite((endpoint) => {
  endpoint.kind = endpointKind(endpoint);
  return endpoint;
});

const LimitScopeSchema = z.object({
  requests: z.object({
    per_minute: NullableRequestLimit,
    per_day: NullableRequestLimit,
  }).strict(),
  spending: z.object({ monthly_usd: NullableSpendLimit }).strict(),
}).strict();

/** Whose month a `limits.per_user` budget is measured over. */
export const BUDGET_SCOPES = ["install", "user"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/**
 * The limits on each of an application's callers. The key stays `per_user`,
 * but on an App Attest application its request limits count
 * per install — one copy of the app on one device — and so, by default, does
 * its budget; `spending.scope` moves the budget to the signed-in user, which
 * only an issuer-backed App Attest application can do. A server application
 * has no installs: everything here is per user.
 */
const PerUserLimitScopeSchema = LimitScopeSchema.extend({
  spending: LimitScopeSchema.shape.spending.extend({
    scope: z.enum(BUDGET_SCOPES).optional().meta({
      description:
        "Whose month monthly_usd is measured over: install (the default on App Attest applications) or user (the default, and the only value, on server applications). user on an App Attest application needs authentication.end_user.source issuer. Filled in on every parsed configuration.",
    }),
  }).strict(),
}).strict();

/** No limit of any kind, which is what an unwritten scope means. */
const UNLIMITED_SCOPE = {
  requests: { per_minute: null, per_day: null },
  spending: { monthly_usd: null },
} as const;

/**
 * Whether an application identifies its end users at all. An App Attest app
 * always does; an `api_key` app does unless its source is `none`. Typed on the
 * source alone, so a form's draft, whose issuer is still being filled in, asks
 * the same question as a parsed configuration.
 */
export function identifiesEndUsers(authentication: { end_user: { source: EndUserSource } }): boolean {
  return authentication.end_user.source !== "none";
}

/** Whether a scope sets any limit at all, as opposed to being written out in full as unlimited. */
export const scopeHasLimits = (scope: LimitScopeConfig): boolean =>
  scope.requests.per_minute !== null
  || scope.requests.per_day !== null
  || scope.spending.monthly_usd !== null;

/**
 * An application's configuration: the one grammar, and the one shape.
 *
 * What this schema accepts is what the gateway stores, and what it produces is
 * what every reader — the request path, the console, the CLI — works on. There
 * is no second parser and no resolved projection: the defaults below are
 * applied once, here, so `limits`, `endpoints` and the App Attest environments
 * are always present on a parsed configuration and nobody downstream has to ask
 * whether they were written.
 *
 * Every object is strict. A key this grammar does not define is a client that
 * has misread the contract or a field that has been removed, and both are
 * better answered by name than silently dropped.
 */
export const AppConfigSchema = z.object({
  authentication: z.discriminatedUnion("type", [
    AppleAppAttestAuthenticationSchema,
    ApiKeyAuthenticationSchema,
  ]),
  routing: z.object({
    /**
     * Discriminated, because the two modes carry different fields: `all` names
     * nothing and `selected` must name its policies. Declaring `selected` as an
     * optional member of one object would make "all mode with a selection" and
     * "selected mode with nothing selected" both expressible.
     */
    providers: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("all") }).strict(),
      z.object({
        mode: z.literal("selected"),
        selected: z.record(SlugSchema, ProviderPolicySchema, {
          error: "routing.providers.selected must be keyed by provider instance slug",
        }),
      }).strict(),
    ], { error: "routing.providers.mode must be all or selected" }),
    model_rewrites: z.record(safeKey(z.string().min(1)), z.string().min(1), {
      error: "routing.model_rewrites must be keyed by a model name",
    }),
  }).strict(),
  /**
   * The organization's own limits on its app's end users, always present on a
   * parsed configuration: an unwritten block is the unlimited one.
   */
  limits: z.object({
    per_user: PerUserLimitScopeSchema.prefault(UNLIMITED_SCOPE),
    per_app: LimitScopeSchema.prefault(UNLIMITED_SCOPE),
  }).strict().prefault({}),
  endpoints: z.record(
    safeKey(z.string().regex(ENDPOINT_SLUG)),
    EndpointSchema,
    { error: "is not a valid slug; use 1-64 characters from a-z, 0-9, and -" },
  ).prefault({}),
}).strict().superRefine((config, context) => {
  /*
   * Per-user limits need somebody to apply to. An application that identifies
   * no end users has nobody, so a configured `per_user` scope would be a limit
   * that never applies — and an operator who believes they have capped their
   * users. `per_app` is what such an application caps instead.
   */
  // Casts rather than guards: zod runs this check only once every member has
  // parsed, so both of these are the parsed values here.
  const authentication = config.authentication as AuthenticationConfig | undefined;
  const perUser = config.limits?.per_user as LimitScopeConfig | undefined;
  if (
    authentication !== undefined
    && perUser !== undefined
    && !identifiesEndUsers(authentication)
    && scopeHasLimits(perUser)
  ) {
    context.addIssue({
      code: "custom",
      path: ["limits", "per_user"],
      message:
        "needs an authentication.end_user source other than none: this application identifies no end users, so use limits.per_app",
    });
  }
  /*
   * A budget is measured per install or per user, and each application type
   * admits only the scopes it has. A server application has no installs. An
   * App Attest application under `app_install` has no user but the install
   * itself, so only an issuer gives `user` a meaning of its own.
   */
  const budgetScope = (perUser as PerUserLimitScopeConfig | undefined)?.spending.scope;
  if (authentication !== undefined && budgetScope !== undefined) {
    if (authentication.type === "api_key" && budgetScope === "install") {
      context.addIssue({
        code: "custom",
        path: ["limits", "per_user", "spending", "scope"],
        message: "cannot be install: server applications have no install; the budget is per user",
      });
    }
    if (
      authentication.type === "apple_app_attest"
      && budgetScope === "user"
      && authentication.end_user.source !== "issuer"
    ) {
      context.addIssue({
        code: "custom",
        path: ["limits", "per_user", "spending", "scope"],
        message:
          "can be user only when authentication.end_user.source is issuer: under app_install every install is its own user, so use install",
      });
    }
  }
}).overwrite((config) => {
  // The scope's default depends on the application type, so it is filled in
  // here, once both are parsed, and every reader finds it written.
  const spending = config.limits.per_user.spending;
  if (spending.scope === undefined) {
    spending.scope = config.authentication.type === "apple_app_attest" ? "install" : "user";
  }
  return config;
}).meta({ id: "AppConfig" });

/** What a client may send, and what a parse of it produces. They differ: see the defaults above. */
export type AppConfig = z.output<typeof AppConfigSchema>;
export type AppConfigInput = z.input<typeof AppConfigSchema>;

/** The answer to a body that still names an id, wherever one is rejected. */
export const APP_ID_IS_SERVER_ASSIGNED =
  "id is assigned by the server: omit it and read app.id from the response";

/**
 * The body of every application write. It carries no `id`: the gateway derives
 * one from `name` on create and answers with it as `app.id`, and no request may
 * choose or change it. Strict, so a client still sending `id` is told that in
 * so many words instead of having it silently ignored.
 */
export const AppWriteSchema = z.object({
  /** Trimmed, so a name of nothing but spaces is the empty name it looks like. */
  name: z.string().trim().min(1).max(100),
  config: AppConfigSchema,
  status: z.enum(APP_STATUSES).optional(),
}, {
  error: (issue) =>
    issue.code === "unrecognized_keys" && issue.keys.includes("id") ? APP_ID_IS_SERVER_ASSIGNED : undefined,
}).strict().meta({ id: "AppWrite" });

/**
 * An update, which is a write plus the revision it is made against.
 *
 * The revision travels in the body and nowhere else. It is a field of the
 * resource — every read already answers with it — and a body is the one channel
 * neither a CDN nor a browser's CORS rules interfere with: an `ETag` is
 * rewritten to its weak form by anything that compresses the response, and is
 * unreadable to a cross-origin client unless the server exposes it. It is
 * required all the same, so a client that has not read the application cannot
 * overwrite it blind; the shape leaves it optional only so that its absence is
 * answered with a code of its own, `app_revision_required`, once the
 * application has been found.
 */
export const AppUpdateSchema = AppWriteSchema.extend({
  revision: z.number().int().positive().optional().meta({
    description:
      "Required: the revision the application was read at. An absent one answers 400 app_revision_required, a stale one 409 app_revision_conflict.",
  }),
}).meta({ id: "AppUpdate" });
export type AppUpdate = z.infer<typeof AppUpdateSchema>;

/**
 * The two languages an application's example is written in: Swift for an App
 * Attest application, whose callers hold an attestation rather than a key, and
 * curl for a server application, which holds a key the Swift client cannot send.
 */
export const SNIPPET_LANGUAGES = ["swift", "curl"] as const;
export type SnippetLanguage = (typeof SNIPPET_LANGUAGES)[number];

/**
 * What an application's example may be narrowed to. Every field is optional
 * and defaulted from the application itself, so asking with none gets the
 * request it can send today.
 */
export const AppSnippetQuerySchema = z.object({
  language: z.enum(SNIPPET_LANGUAGES, { error: "language must be swift or curl" }).optional().meta({
    description:
      "swift or curl. Defaults to swift for an App Attest application and curl for a server application; the other one is refused with 400 unsupported_snippet.",
  }),
  provider: z.string().min(1).optional().meta({
    description:
      "The slug of the provider to write the example for. Defaults to the first one the application can reach. Unknown answers 404 provider_not_found; held but outside the application's routing or disabled answers 400 provider_unavailable.",
  }),
  endpoint: z.string().min(1).optional().meta({
    description:
      "The name of one of the application's custom endpoints, to call it instead of a provider path. Unknown answers 404 endpoint_not_found.",
  }),
});
export type AppSnippetQuery = z.infer<typeof AppSnippetQuerySchema>;

/**
 * Apple's key id is the base64 SHA-256 of the public key — 44 characters — and
 * a challenge is this gateway's own base64url of 32 bytes. Both are bounded
 * because these routes are unauthenticated and, under the `app_install` source,
 * the key id becomes an end-user id that is stored and displayed.
 */
const AppAttestKeyIdSchema = z.string().min(1).max(200);
const ChallengeSchema = z.string().min(1).max(200);

/**
 * `issuer_token` is optional here because one document serves every
 * application, and whether one is needed is a property of the application: an
 * `app_install` application identifies its user by the attested key alone and
 * has no issuer to present a token from. The App Attest exchange narrows it to
 * required or refused by the application's `end_user.source` before parsing.
 */
export const AppAttestRegisterRequestSchema = z.object({
  issuer_token: z.string().min(1).optional(),
  key_id: AppAttestKeyIdSchema,
  attestation: z.string().min(1),
  challenge: ChallengeSchema,
}).meta({ id: "AppAttestRegisterRequest" });

export const AppAttestTokenRequestSchema = z.object({
  issuer_token: z.string().min(1).optional(),
  key_id: AppAttestKeyIdSchema,
  assertion: z.string().min(1),
  challenge: ChallengeSchema,
}).meta({ id: "AppAttestTokenRequest" });

export const ApiKeyTokenRequestSchema = z.object({
  issuer_token: z.string().min(1),
  api_key: z.string().min(1),
}).strict().meta({ id: "ApiKeyTokenRequest" });

export const UsageRepriceRequestSchema = z.object({
  provider: ProviderTypeSchema,
  model: z.string().min(1),
  month: MonthSchema,
  apply: z.boolean().default(false),
}).strict().meta({ id: "UsageRepriceRequest" });

const TokenRateSchema = z.number().finite().nonnegative();

/**
 * Every rate but input and output, optional, named by the one list the cost
 * arithmetic reads — so a rate the gateway learns to bill is overridable the
 * moment it exists, and nothing else is ever stored.
 */
const OPTIONAL_TOKEN_RATES = Object.fromEntries(
  TOKEN_RATE_FIELDS
    .filter((field) => field !== "input" && field !== "output")
    .map((field) => [field, TokenRateSchema.optional()]),
) as Record<Exclude<TokenRateField, "input" | "output">, z.ZodOptional<typeof TokenRateSchema>>;

/**
 * Per-1M-token overrides for models the shipped catalog does not cover, or
 * covers with a stale price. `$0` is enterable for genuinely free models.
 * Input and output are required; every other rate is optional and, left out,
 * falls back as it does on a catalog entry without it — an override replaces
 * the catalog's rates for its model, it never inherits them.
 */
export const ProviderPricingSchema = z.record(
  z.string().trim().min(1).max(200),
  z.object({
    input: TokenRateSchema,
    output: TokenRateSchema,
    ...OPTIONAL_TOKEN_RATES,
    long_context_threshold: z.number().int().positive().optional(),
  }).strict().refine(
    (price) => price.long_context_threshold !== undefined
      || LONG_RATE_FIELDS.every((field) => price[field] === undefined),
    { message: "Long-context rates need long_context_threshold" },
  ),
).meta({ id: "ProviderPricing" });

const ProviderNameSchema = z.string().trim().min(1).max(100);
const ProviderSecretSchema = z.string().min(1).max(4096);

/**
 * An operator's own origin for a direct provider instance. Only the shape is
 * checked here; the rules that make it safe — https, a public registrable host,
 * no port, no credentials, no query — live in `src/core/origin-guard.ts`, which
 * also returns the canonical form that is stored. Keeping them there means one
 * implementation for the write paths, the probe, and any future reuse, rather
 * than a regex in a contract that would inevitably drift from it.
 */
const ProviderBaseUrlSchema = z.string().trim().min(1).max(MAX_BASE_URL_LENGTH);

/** Says why the two fields are exclusive, rather than that one is invalid. */
function assertBaseUrlIsDirect(
  value: { baseUrl?: string; providerGatewayId?: string },
  context: z.RefinementCtx,
): void {
  if (value.baseUrl !== undefined && value.providerGatewayId !== undefined) {
    context.addIssue({
      code: "custom",
      message:
        "A gateway-routed instance cannot carry a base URL: the gateway owns the upstream origin",
      path: ["baseUrl"],
    });
  }
}

/**
 * How one provider row is routed inside its gateway. The referenced gateway's
 * type selects what is meaningful here, and its adapter rejects the rest — a
 * Cloudflare AI Gateway, for instance, accepts no routing configuration at all.
 */
export const GatewayRouteConfigSchema = z.object({
  modelPrefix: z.string().trim().min(1).max(100).optional(),
  providerOnly: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(),
}).strict().meta({ id: "GatewayRouteConfig" });

/**
 * A provider instance's configuration as a create names it: everything but the
 * key, which is its own field so a browser handoff can collect it separately.
 */
const ProviderCreateFieldsSchema = z.object({
  type: ProviderTypeSchema,
  name: ProviderNameSchema,
  slug: SlugSchema.optional(),
  providerGatewayId: z.string().trim().min(1).optional(),
  gatewayRoute: GatewayRouteConfigSchema.optional(),
  baseUrl: ProviderBaseUrlSchema.optional(),
  pricing: ProviderPricingSchema.optional(),
});

export const ProviderCreateRequestSchema = ProviderCreateFieldsSchema.extend({
  secret: ProviderSecretSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.secret === undefined) === (value.providerGatewayId === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Provide exactly one of secret or providerGatewayId",
      path: ["secret"],
    });
  }
  assertBaseUrlIsDirect(value, context);
}).meta({ id: "ProviderCreateRequest" });

/**
 * A dry run of {@link ProviderCreateRequestSchema}: the same credential, minus
 * everything that only matters once a row is stored.
 */
export const ProviderTestRequestSchema = z.object({
  type: ProviderTypeSchema,
  secret: ProviderSecretSchema.optional(),
  providerGatewayId: z.string().trim().min(1).optional(),
  /** Probed at the origin the instance would really use, override included. */
  baseUrl: ProviderBaseUrlSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.secret === undefined) === (value.providerGatewayId === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Provide exactly one of secret or providerGatewayId",
      path: ["secret"],
    });
  }
  assertBaseUrlIsDirect(value, context);
}).meta({ id: "ProviderTestRequest" });

/** One gateway type's member of {@link gatewayUnion}: its type, `Fields`, and its own connection. */
type GatewayMember<T extends GatewayType, Fields extends z.ZodRawShape> = z.ZodObject<
  { type: z.ZodLiteral<T> } & Fields & GatewayConnectionShape<T>,
  z.core.$strict
>;
type GatewayMembers<Fields extends z.ZodRawShape> = {
  [T in GatewayType]: GatewayMember<T, Fields>;
}[GatewayType];

/**
 * A body discriminated by gateway `type`, one member per gateway descriptor:
 * the common `fields` beside the type's own connection fields, because each
 * gateway needs a different set of non-secret fields to be reachable at all.
 * Every gateway request union in the contracts is built here from
 * `GATEWAY_TYPES`, so adding a gateway is a descriptor and an adapter — never
 * a member written out by hand.
 */
export function gatewayUnion<Fields extends z.ZodRawShape>(
  fields: Fields,
  params?: { error: string },
) {
  const members = GATEWAY_TYPES.map((type) => z.object({
    type: z.literal(type),
    ...fields,
    ...GATEWAY_DESCRIPTORS[type].connection.shape,
  }).strict());
  // One member per type, built from that type's own descriptor; the mapped
  // array cannot say which member is whose, and zod wants a non-empty tuple.
  return z.discriminatedUnion(
    "type",
    members as [GatewayMembers<Fields>, ...GatewayMembers<Fields>[]],
    params,
  );
}

const GATEWAY_TYPE_ERROR = `Provider gateway type must be one of ${GATEWAY_TYPES.join(", ")}`;

/**
 * A gateway connection as a create request carries it: the type's own
 * connection fields beside a name and the token. Vercel asks for nothing but a
 * name and a token: its origin is fixed in adapter code, and the token alone
 * identifies the Vercel team.
 */
export const ProviderGatewayCreateRequestSchema = gatewayUnion(
  { name: ProviderNameSchema, token: ProviderSecretSchema },
  { error: GATEWAY_TYPE_ERROR },
).meta({ id: "ProviderGatewayCreateRequest" });

/**
 * A dry run of {@link ProviderGatewayCreateRequestSchema}: the same members
 * minus the name, so the connection is probed exactly as a create would probe
 * it, without a row having to exist.
 */
export const ProviderGatewayTestRequestSchema = gatewayUnion(
  { token: ProviderSecretSchema },
  { error: GATEWAY_TYPE_ERROR },
).meta({ id: "ProviderGatewayTestRequest" });

export const ProviderGatewayUpdateRequestSchema = z.object({
  name: ProviderNameSchema,
  revision: z.number().int().positive().meta({ description: "The gateway revision returned by the read this edit is based on." }),
}).strict().meta({ id: "ProviderGatewayUpdateRequest" });

export const ProviderGatewayRotateRequestSchema = z.object({
  token: ProviderSecretSchema,
  revision: z.number().int().positive().meta({ description: "The gateway revision returned by the read this rotation is based on." }),
}).strict().meta({ id: "ProviderGatewayRotateRequest" });

/**
 * Why a new origin comes with a new key. A provider secret is write-only: it is
 * encrypted on the way in and never read back out to a caller, and that has to
 * include reading it back out *through* an origin the operator just typed.
 * Decrypting the stored key to probe a fresh host would make the base URL field
 * a way for an admin, or a management-key holder, to have the gateway hand the
 * organization's key to a server they control.
 */
export const BASE_URL_REQUIRES_SECRET =
  "Changing the base URL requires re-supplying the provider key, because the stored key is never sent to a new origin";

/** The fields an update may change, other than the key and the revision it is based on. */
const ProviderUpdateFieldsSchema = z.object({
  name: ProviderNameSchema.optional(),
  /** A full replace; `null` clears the row's routing configuration. */
  gatewayRoute: GatewayRouteConfigSchema.nullable().optional(),
  /**
   * `null` returns the instance to its provider type's own base URL, and needs
   * nothing else. Any other value needs `secret` in the same request; see
   * {@link BASE_URL_REQUIRES_SECRET}.
   */
  baseUrl: ProviderBaseUrlSchema.nullable().optional(),
  /** A full replace; `null` clears every override. */
  pricing: ProviderPricingSchema.nullable().optional(),
  /**
   * A reversible pause. Disabling keeps the secret, the pricing and the slug, so
   * nothing can take the slug meanwhile and re-enabling always succeeds.
   */
  status: z.enum(["active", "disabled"]).optional(),
});

export const ProviderUpdateRequestSchema = ProviderUpdateFieldsSchema.extend({
  revision: z.number().int().positive().meta({ description: "The provider revision returned by the read this update is based on." }),
  secret: ProviderSecretSchema.optional(),
}).strict().superRefine((value, context) => {
  if (
    value.name === undefined
    && value.secret === undefined
    && value.gatewayRoute === undefined
    && value.baseUrl === undefined
    && value.pricing === undefined
    && value.status === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Provide at least one of name, secret, gatewayRoute, baseUrl, pricing, or status",
    });
  }
  if (value.baseUrl !== undefined && value.baseUrl !== null && value.secret === undefined) {
    context.addIssue({ code: "custom", message: BASE_URL_REQUIRES_SECRET, path: ["secret"] });
  }
}).meta({ id: "ProviderUpdateRequest" });

/**
 * What a CLI browser handoff carries for each kind: the reviewable part of the
 * write it will make, never its secret. Strict, so a key, a token or a field
 * the server manages is refused when the handoff is opened rather than after a
 * person has approved it; the secret is supplied on the approval page.
 */
const HandoffTargetFields = {
  /** The existing row the handoff edits. */
  id: z.string().trim().min(1),
  /** The revision the CLI read; the write lands only while the row is still at it. */
  revision: z.number().int().positive(),
};

export const HandoffProviderAddPayloadSchema = ProviderCreateFieldsSchema.strict()
  .superRefine(assertBaseUrlIsDirect);

export const HandoffProviderUpdatePayloadSchema = ProviderUpdateFieldsSchema.extend(HandoffTargetFields)
  .strict()
  .superRefine((value, context) => {
    if (
      value.name === undefined
      && value.gatewayRoute === undefined
      && value.baseUrl === undefined
      && value.pricing === undefined
      && value.status === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Provide at least one of name, gatewayRoute, baseUrl, pricing, or status",
      });
    }
  });

export const HandoffRotatePayloadSchema = z.object(HandoffTargetFields).strict();

/** A gateway create request without its token, which the browser collects. */
export const HandoffProviderGatewayAddPayloadSchema = gatewayUnion(
  { name: ProviderNameSchema },
  { error: GATEWAY_TYPE_ERROR },
);

export const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);

export const OrganizationSelectRequestSchema = z.object({
  organizationId: z.string().trim().min(1),
}).meta({ id: "OrganizationSelectRequest" });

/**
 * The field every credential is created with. Both key surfaces take a name —
 * the token itself is minted here, never supplied — so they share one shape
 * rather than two that could drift apart; a management key adds its grant.
 */
export const CredentialNameRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

/** How much of its holder's role a management key may use. */
export const CredentialGrantSchema = z.enum(["read", "manage"]);

export const ManagementKeyCreateRequestSchema = CredentialNameRequestSchema.extend({
  grant: CredentialGrantSchema.default("manage").meta({
    description:
      "How much of your role the key may use. `read` may list, inspect and validate but cannot change your apps, providers or settings: a change your role would otherwise allow is refused with `403 grant_insufficient`, and the key may still revoke itself. `manage` may do everything your role allows. Defaults to `manage`.",
  }),
}).meta({ id: "ManagementKeyCreateRequest" });
export const ApiKeyCreateRequestSchema = CredentialNameRequestSchema
  .meta({ id: "ApiKeyCreateRequest" });

/**
 * The browser proof an OAuth consent page holds: the fragment of the URL the
 * authorization endpoint sent the browser to, which never reaches a server
 * log. Carried in a body, never a URL, by every consent call.
 */
const OAuthConsentProofTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).meta({
  description: "The proof from the consent page URL's fragment.",
});
export const OAuthConsentProofSchema = z.object({ submissionToken: OAuthConsentProofTokenSchema }).strict();
/** A signed-in person's "allow": which of their accounts, with how much of their role. */
export const OAuthConsentAllowRequestSchema = z.object({
  submissionToken: OAuthConsentProofTokenSchema,
  organizationId: z.string().min(1).max(256).meta({
    description: "The account the connection acts in: one the signed-in person is a member of.",
  }),
  grant: CredentialGrantSchema.meta({
    description: "How much of the person's role the connection may use, whatever the client asked for.",
  }),
}).strict();

/** Inferred request bodies, so a consumer never re-describes one by hand. */
export type AppWrite = z.output<typeof AppWriteSchema>;
/** The same body as a client composes it, before the schema's defaults apply. */
export type AppWriteInput = z.input<typeof AppWriteSchema>;
export type ClaimRequirement = z.output<typeof ClaimRequirementSchema>;
export type OAuthConsentProof = z.output<typeof OAuthConsentProofSchema>;
export type OAuthConsentAllowRequest = z.output<typeof OAuthConsentAllowRequestSchema>;
export type IssuerAuthentication = z.output<typeof IssuerAuthenticationSchema>;
export type IssuerAuthenticationInput = z.input<typeof IssuerAuthenticationSchema>;
export type IssuerProvider = (typeof ISSUER_PROVIDERS)[number];
export type EntitlementCheck = (typeof ENTITLEMENT_CHECKS)[number];
export type ApiKeyEndUser = z.output<typeof ApiKeyEndUserSchema>;
export type AppAttestEndUser = z.output<typeof AppAttestEndUserSchema>;
/** Every way an application of either type can identify its end users, `none` included. */
export type EndUserSource = (ApiKeyEndUser | AppAttestEndUser)["source"];
export type AppAttestEnvironment = (typeof APP_ATTEST_ENVIRONMENTS)[number];
export type AppAttestVerifyOn = (typeof APP_ATTEST_VERIFY_ON)[number];
export type AuthenticationConfig = AppConfig["authentication"];
/** The same block as a client may send it, which is what a half-filled form is. */
export type AuthenticationConfigInput = AppConfigInput["authentication"];
export type AppleAppAttestAuthentication = Extract<
  AuthenticationConfig,
  { type: "apple_app_attest" }
>;
export type ApiKeyAuthentication = Extract<AuthenticationConfig, { type: "api_key" }>;
export type ProviderPolicy = z.output<typeof ProviderPolicySchema>;
export type RoutingConfig = AppConfig["routing"];
export type LimitScopeConfig = z.output<typeof LimitScopeSchema>;
export type PerUserLimitScopeConfig = z.output<typeof PerUserLimitScopeSchema>;
export type LimitsConfig = AppConfig["limits"];
export type EndpointConfig = z.output<typeof EndpointSchema>;
export type EndpointsConfig = AppConfig["endpoints"];
export type GatewayRouteConfigInput = z.infer<typeof GatewayRouteConfigSchema>;
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;
export type OrganizationSelectRequest = z.infer<typeof OrganizationSelectRequestSchema>;
export type ProviderPricing = z.infer<typeof ProviderPricingSchema>;
export type ProviderCreateRequest = z.infer<typeof ProviderCreateRequestSchema>;
export type ProviderUpdateRequest = z.infer<typeof ProviderUpdateRequestSchema>;
export type ProviderTestRequest = z.infer<typeof ProviderTestRequestSchema>;
export type ProviderGatewayCreateRequest = z.infer<typeof ProviderGatewayCreateRequestSchema>;
export type ProviderGatewayTestRequest = z.infer<typeof ProviderGatewayTestRequestSchema>;
export type ProviderGatewayUpdateRequest = z.infer<typeof ProviderGatewayUpdateRequestSchema>;
export type ProviderGatewayRotateRequest = z.infer<typeof ProviderGatewayRotateRequestSchema>;
export type UsageRepriceRequest = z.infer<typeof UsageRepriceRequestSchema>;
export type ManagementKeyCreateRequest = z.infer<typeof ManagementKeyCreateRequestSchema>;
export type ApiKeyCreateRequest = z.infer<typeof ApiKeyCreateRequestSchema>;

/**
 * A console path to come back to once an email is verified: one that begins
 * with a single `/`, so the link can never send the browser off the console.
 */
export const ConsoleReturnPathSchema = z
  .string()
  .max(512)
  .regex(/^\/(?![/\\])[^\\\s]*$/, "Must be a path on the console, beginning with a single /")
  .meta({ description: "A path on the console to return to once the address is verified, such as an approval page." });

/** Asks for a verification link for the person signed in to this browser. */
export const SendVerificationEmailRequestSchema = z.object({
  returnTo: ConsoleReturnPathSchema.optional(),
}).strict();

/** The link a verification email carried, handed back by the page it opened. */
export const ConfirmEmailVerificationRequestSchema = z.object({
  token: z.string().min(1).max(2048).meta({
    description: "The `token` query parameter of the link in the verification email.",
  }),
}).strict();
