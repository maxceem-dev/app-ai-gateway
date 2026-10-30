import type { CredentialRefusalReason } from "../auth/credential-refusal";
import type { IssuerRejectionReason } from "../client-auth/issuer";
import type { PlatformFailureReason } from "./platform-errors";

export type ErrorCode =
  | "auth_required"
  | "forbidden"
  | "session_required"
  /**
   * The credential is valid and its holder has the role, but it was issued
   * with the `read` grant and the operation writes. Retrying with the same
   * key never helps; a session or a key with the `manage` grant does.
   */
  | "grant_insufficient"
  /**
   * A claim was refused because the signed-in human already belongs to another
   * account. Claiming is how a person gets their first account, so it is taken
   * from a browser that owns none but the one being claimed.
   */
  | "account_exists"
  | "registration_disabled"
  /**
   * A CLI login's approver belongs to no account they could log it in to, and
   * this deployment does not give a person one of their own.
   */
  | "no_eligible_organization"
  /** A browser step that ran out of time, or a one-time outcome past its window. */
  | "operation_expired"
  /** A browser step its approver declined. */
  | "operation_denied"
  /** Redeeming a login nobody has approved yet. */
  | "operation_pending"
  /** Approving, completing or redeeming a step that already was; executing a reservation past its replay window. */
  | "already_completed"
  /** No operation of the caller's account has this id, or no reservation answers to this handle. */
  | "operation_not_found"
  /**
   * A reservation's handle sent for another request than the one reserved:
   * another kind, another account, or other input. Nothing was written;
   * reserve again for the new request.
   */
  | "operation_mismatch"
  /** The key an operation created was already revealed, and is shown once. */
  | "already_revealed"
  | "validation_error"
  | "rate_limited"
  | "conflict"
  | "not_found"
  | "not_a_member"
  | "last_owner"
  /**
   * An account nobody has claimed yet may serve traffic and change resources
   * only for its first thirty days; claiming it lifts that. Not billing, and
   * not the billing service's own trial: this is the gateway's window for an
   * account a CLI bootstrap created and no person owns.
   */
  | "unclaimed_access_expired"
  | "account_expired"
  /**
   * The deployment verifies email addresses, and this account's owner has not
   * verified theirs: its applications serve no requests until they do. Never
   * stops traffic that already flowed — an account that served traffic before
   * the deployment verified anything is activated. Also answers a claim
   * approved by a person whose address is not verified yet.
   */
  | "email_unverified"
  | "billing_payment_required"
  /**
   * Human support is offered by this deployment, but not on the account's
   * plan. Its own code rather than `forbidden`, which is about the caller's
   * role: no role changes this, and an agent has to tell the person why.
   */
  | "support_plan_required"
  | "billing_unavailable"
  | "billing_not_found"
  | "billing_action_forbidden"
  | "billing_conflict"
  /**
   * An App Attest proof was refused: at the token exchange, or on a request —
   * an `X-AppAttest-Proof` that is malformed, signed by a key the application
   * has no record of or whose environment it no longer accepts, signed over a
   * different request, or whose assertion counter was already used. The
   * message says which.
   */
  | "attest_failed"
  /**
   * A request authenticated with the gateway token of an App Attest
   * application whose `verify_on` is `every_request` arrived without the
   * `X-AppAttest-Proof` header every such request must carry. The client is
   * older than that setting needs: AppAIGateway Swift package 1.x. The message
   * stands alone for clients that show unknown codes' messages verbatim.
   */
  | "assertion_required"
  | "issuer_token_rejected"
  /**
   * The issuer token verified, but the app's `required_claims` are not all
   * present yet — the entitlement is still propagating from whatever writes it.
   * Its own code because the client's correct action differs: wait and retry,
   * rather than re-authenticate.
   */
  | "issuer_claims_missing"
  /**
   * The gateway could not reach or read the issuer's JWKS, so no verdict on the
   * token was ever reached. Not the caller's fault, hence 5xx and a retry.
   */
  | "issuer_verification_unavailable"
  /**
   * The application is not configured for what was asked: a token exchange it
   * has no source for, or per-user standing on an application that identifies
   * no end users. The request was well-formed, so it is not `invalid_request` —
   * nothing the caller could rephrase would make it work.
   */
  | "auth_method_not_supported"
  /**
   * The organization used up its plan's monthly request allowance. The
   * accompanying `data` carries the allowance, the count, and when the next
   * period begins.
   *
   * Billing, not app configuration: this is the gateway operator metering what
   * an organization pays for. The limits an organization sets on its own app's
   * end users raise `app_rate_limited` or `app_budget_exhausted` instead, and
   * are checked first, so a request refused by them never spends this.
   */
  | "billing_request_quota_exceeded"
  /**
   * The organization's plan caps how much configuration it may store, and this
   * write would have gone past that ceiling. `data` carries `limit` and the
   * `used` count that met it.
   *
   * Billing again, not app configuration, and a different remedy from
   * `billing_request_quota_exceeded`: nothing resets on a schedule, so the
   * caller either deletes something it already owns or moves to a plan whose
   * limits are higher. Retrying the same request unchanged never succeeds.
   */
  | "billing_plan_limit_reached"
  /**
   * An app's per-minute or per-day request limit refused this call. Set by the
   * organization on its own app, applied to that app's end users, and unrelated
   * to the plan allowance above. `data.scope` says whether the per-user or the
   * per-app limit is the one that refused.
   */
  | "app_rate_limited"
  /**
   * An app's monthly spending budget is exhausted. Same ownership as
   * `app_rate_limited`, and the same `data.scope`.
   *
   * Cost settles after a response completes, so this stops the request after
   * the one that crossed the budget, never the one that crossed it.
   */
  | "app_budget_exhausted"
  | "pricing_not_configured"
  | "model_not_allowed"
  | "path_not_allowed"
  | "api_style_not_supported"
  | "max_output_tokens_exceeded"
  | "payload_too_large"
  | "provider_error"
  | "provider_not_configured"
  | "provider_disabled"
  | "provider_unavailable"
  /** A management read named a provider slug the account holds no instance under. */
  | "provider_not_found"
  | "slug_taken"
  | "provider_not_supported_by_gateway"
  | "provider_gateway_managed"
  | "gateway_in_use"
  | "provider_key_invalid"
  | "invalid_request"
  | "app_not_found"
  | "app_revision_required"
  | "app_revision_conflict"
  | "app_disabled"
  | "endpoint_not_found"
  /**
   * An application's example was asked for in a language its callers cannot
   * authenticate with: curl for an App Attest app, Swift for a server app.
   */
  | "unsupported_snippet"
  /**
   * The deployment verifies email addresses but could not send a verification
   * email: its email settings are incomplete, or the transport (Cloudflare
   * Email Service or SMTP) refused the message.
   * Worth trying again later; the person managing the deployment fixes it.
   */
  | "email_unavailable"
  /**
   * The platform the gateway runs on failed underneath it — its database or
   * one of its Durable Objects was unreachable or overloaded — or the request
   * ran past its deadline waiting on one. Nothing about the request is known
   * to be wrong: retry after `Retry-After`.
   */
  | "service_unavailable"
  | "internal_error";

/**
 * Machine-readable facts a client can act on, serialized beside the code as
 * `error.data`. Used where the code alone leaves a client with no way to decide
 * what to do next — a quota rejection, which is worth retrying only after a
 * stated instant.
 */
export type GatewayErrorData = Record<string, string | number | boolean>;

/**
 * The granular causes a refusal may carry: a closed set, so a `reason` is
 * always a constant this codebase spells, and logging one copies no text.
 */
export type GatewayErrorReason = IssuerRejectionReason | PlatformFailureReason | CredentialRefusalReason;

/**
 * What a rejection knows about itself beyond the wire contract. `reason` and
 * `userId` are never serialized: they are for the operator's logs and the auth
 * event log. `data` is, and is part of the public contract.
 */
export interface GatewayErrorDetails {
  /**
   * The granular cause behind a behaviour-class code — `claims_missing`,
   * `bad_signature`, `jwks_unreachable`, and so on. Never sent to a client, so
   * the vocabulary grows without any client having to learn a new code; a
   * closed set all the same, so a log line names one without copying text.
   */
  reason?: GatewayErrorReason;
  /**
   * The end-user identity the verification had already established when it
   * failed. Only set where the signature was checked first, so it is a verified
   * claim rather than an assertion the caller made about itself.
   */
  userId?: string;
  /** Serialized into the response body as `error.data`. */
  data?: GatewayErrorData;
  /**
   * The request field a validation refusal is about, for management analytics.
   * Never serialized: the message already names it for the client.
   */
  field?: RequestFieldIssue;
  /**
   * The failure this refusal stands for, which the error log describes. Never
   * serialized.
   */
  cause?: unknown;
}

/**
 * Which field a schema refused, in constants only: the field's top-level name,
 * which is the schema's own — null where it is not, such as an unknown key the
 * caller sent — and the schema's issue code. Never the value.
 */
export interface RequestFieldIssue {
  name: string | null;
  issue: string;
}

export class GatewayError extends Error {
  readonly reason?: GatewayErrorReason;
  readonly userId?: string;
  readonly data?: GatewayErrorData;
  readonly field?: RequestFieldIssue;

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers?: HeadersInit,
    details: GatewayErrorDetails = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "GatewayError";
    this.reason = details.reason;
    this.userId = details.userId;
    this.data = details.data;
    this.field = details.field;
  }
}

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

/**
 * The body every unrouted path answers with, shared by the entry module and by
 * each lazily mounted route bundle so a path that falls through an inner app
 * is refused in exactly the shape the outer app would have used.
 */
export const ROUTE_NOT_FOUND = {
  error: { code: "invalid_request", message: "Route not found" },
} as const;
