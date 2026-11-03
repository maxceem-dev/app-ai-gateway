import { fail, origin, VERSION } from "./common.ts";
import type { CliErrorDetails } from "./errors.ts";

export interface RequestOptions {
  key?: string | undefined;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface WireResponse {
  data: unknown;
}

/** The HTTP surface a `Transport` is built on; swapped out wholesale in tests. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The two shapes a rejected request arrives in; both carry only public fields. */
interface WireError {
  error?: { code?: unknown; message?: unknown; data?: Record<string, unknown> };
  code?: unknown;
  message?: unknown;
}

/** How much of a deployment's own explanation is worth repeating. */
const MESSAGE_LIMIT = 300;

/** Every string the request carried, however deeply the body nested it. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const entry of value) yield* strings(entry);
  else if (value && typeof value === "object")
    for (const entry of Object.values(value)) yield* strings(entry);
}

/**
 * The deployment's own explanation of a refusal, made safe to print.
 *
 * Without it a caller cannot tell a duplicate slug from an unacceptable field,
 * which is the difference between changing the request and giving up. It is
 * remote text, so it is stripped of control characters, capped, and cleared of
 * anything the request itself sent — a refusal that quotes back a submitted
 * provider key must not turn into a key on stdout.
 */
export function reported(value: unknown, sent?: unknown): string {
  if (typeof value !== "string") return "";
  let text = value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
  for (const secret of strings(sent))
    if (secret.length >= 8) text = text.split(secret).join("[redacted]");
  return text.length > MESSAGE_LIMIT ? text.slice(0, MESSAGE_LIMIT) + "…" : text;
}

/**
 * The refusals that name a ceiling, and the facts each one reports about it.
 *
 * Carried through to `details` because the message is prose: a script deciding
 * how long to wait, or whether waiting helps at all, needs the numbers rather
 * than the sentence they were written into. Split by type only because the two
 * groups are assigned separately below.
 */
const LIMIT_CODES = [
  "rate_limited",
  "app_rate_limited",
  "app_budget_exhausted",
  "billing_request_quota_exceeded",
  "billing_plan_limit_reached",
];
const LIMIT_TEXT_FIELDS = ["scope", "resetAt"] as const;
const LIMIT_NUMBER_FIELDS = ["limit", "used", "windowSeconds", "retryAfterSeconds"] as const;

/**
 * What to do about a refusal, as far as its status can say.
 *
 * A limit that resets says so and is worth retrying unchanged; a plan ceiling
 * is answered with 409 because nothing resets on a schedule, so the same
 * request will never succeed and telling the caller to wait would be wrong.
 */
function nextActionFor(status: number, code: string, details: CliErrorDetails): string {
  if (status === 401) return "Run agw account login.";
  if (code === "billing_plan_limit_reached")
    return "Delete one you no longer need, or move to a plan whose limits are higher.";
  if (code === "support_plan_required")
    return "Tell the person human support is included with paid plans; an account owner can choose one on the console's Billing page.";
  if (status === 429) {
    const seconds = details.retryAfterSeconds;
    if (seconds === undefined)
      return "Wait for the limit named in the message to reset, then run the same command again.";
    // Same split the deployment's own message makes: nobody converts a wait of
    // 65580 seconds in their head, and a wait of 50 is over before an instant
    // written out in UTC would have been read.
    return seconds >= 3600 && details.resetAt !== undefined
      ? `Wait until ${details.resetAt}, then run the same command again.`
      : `Wait ${seconds} seconds, then run the same command again.`;
  }
  return "Review command configuration and account status.";
}

export class Transport {
  private readonly fetch: FetchLike;

  constructor(fetchImpl: FetchLike = fetch) {
    this.fetch = fetchImpl;
  }

  async request(
    url: string,
    path: string,
    { key, method = "GET", body, headers = {} }: RequestOptions = {},
  ): Promise<WireResponse> {
    const base = origin(url);
    if (!path.startsWith("/") || path.startsWith("//"))
      fail("invalid_request", "Invalid API path.");
    let response: Response;
    try {
      response = await this.fetch(base + path, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
        headers: {
          accept: "application/json",
          "user-agent": `agw/${VERSION}`,
          ...(body ? { "content-type": "application/json" } : {}),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      fail(
        "connection_failed",
        "Could not reach the selected deployment.",
        "Check connectivity and the selected URL; no fallback was attempted.",
        3,
      );
    }
    if (response.status >= 300 && response.status < 400)
      fail(
        "redirect_refused",
        "API redirects are refused to keep credentials bound to their origin.",
        "Connect explicitly to the intended deployment.",
        3,
      );
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      fail(
        "invalid_response",
        "Deployment returned an invalid JSON response.",
        "Check deployment version and connectivity.",
        3,
        // The status this arrived with, which is the whole difference between
        // an edge error page in front of a Worker that is not serving yet and
        // a deployment that answered 200 with a body no client can read.
        { status: response.status },
      );
    }
    if (!response.ok) {
      const wire: WireError = (data ?? {}) as WireError;
      const code =
        typeof wire.error?.code === "string"
          ? wire.error.code
          : typeof wire.code === "string"
            ? wire.code
            : `http_${response.status}`;
      const details: CliErrorDetails = { status: response.status };
      const facts = wire.error?.data ?? {};
      if (LIMIT_CODES.includes(code)) {
        for (const field of LIMIT_TEXT_FIELDS) {
          const value = facts[field];
          if (typeof value === "string") details[field] = value;
        }
        for (const field of LIMIT_NUMBER_FIELDS) {
          const value = facts[field];
          if (typeof value === "number") details[field] = value;
        }
      }
      const explanation = reported(wire.error?.message ?? wire.message, body);
      fail(
        code,
        `Deployment rejected the request (HTTP ${response.status})` +
          (explanation ? `: ${explanation}` : "."),
        nextActionFor(response.status, code, details),
        3,
        details,
      );
    }
    return { data };
  }
}
