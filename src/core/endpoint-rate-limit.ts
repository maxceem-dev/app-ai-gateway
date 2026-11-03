import { GatewayError } from "./errors";

const encoder = new TextEncoder();

/**
 * One endpoint abuse policy: how often, over what, and how to say so.
 *
 * `action` names what the caller did too often and `sharedBy` what the counter
 * is taken over. Those two carry the whole difference between a limit the
 * caller can wait out alone and one that somebody else on the same network
 * already spent, which is the first thing a person needs in order to decide
 * what to do — and a bare count cannot tell them either. `CAPPED_RESOURCES` in
 * plan-caps.ts carries a `subject` for the same reason.
 */
interface EndpointRateLimit {
  limit: number;
  windowMs: number;
  action: string;
  sharedBy: string;
}

/**
 * Every abuse policy this gateway enforces on its own endpoints.
 *
 * Each key is also the prefix of the subject it counts, so one name identifies
 * a policy here, in the Durable Object that counts it, and in the `scope` a
 * refusal reports. Changing a key renames the object and so forgives every
 * counter currently held under it; the numbers beside it can be changed freely.
 *
 * These are not a plan allowance and not an application's own limits. Nothing
 * here is bought, sold or configured by anyone, and neither quota system reads
 * this table: it exists only to stop one caller from hammering one endpoint.
 */
export const ENDPOINT_RATE_LIMITS = {
  bootstrap: {
    limit: 3,
    windowMs: 86_400_000,
    action: "create an account",
    sharedBy: "everyone sharing your network address",
  },
  // Anyone may ask for a login, and a login its asker declines at once frees
  // its pending slot again, so the engine's cap on waiting logins does not
  // bound how many are asked for. Twenty an hour is far above a person logging
  // a few machines in and far below what filling the table needs.
  login: {
    limit: 20,
    windowMs: 3_600_000,
    action: "ask for a CLI login",
    sharedBy: "everyone sharing your network address",
  },
  // An OAuth authorization request is public, and one naming a client's
  // metadata document makes the gateway fetch it, so it is counted before the
  // request is read. Thirty in ten minutes is far above a person connecting a
  // few clients, retries included, and far below what a fetch flood needs;
  // what waits for consent is capped separately, by the engine.
  oauth_authorize: {
    limit: 30,
    windowMs: 600_000,
    action: "start an OAuth connection",
    sharedBy: "everyone sharing your network address",
  },
  operation: {
    limit: 10,
    windowMs: 60_000,
    action: "start a management operation",
    sharedBy: "your account",
  },
  submission: {
    limit: 10,
    windowMs: 60_000,
    action: "answer an approval page",
    sharedBy: "this operation",
  },
  // A user code is eight characters, short enough to guess in bulk, and
  // looking one up is the only way a guess can be tried without already
  // holding an approval link. Ten a minute is far above a person retyping a
  // code they misread and far below what guessing needs.
  user_code: {
    limit: 10,
    windowMs: 60_000,
    action: "look up an approval code",
    sharedBy: "everyone sharing your network address",
  },
  // Password sign-in is counted twice, because the two counters refuse two
  // different attacks and neither one sees the other's. The address counter
  // stops one client hammering the endpoint; the email counter stops a spread
  // of addresses grinding through one account's passwords, which is invisible
  // to a per-address count. A person who mistypes their own password ten times
  // in a minute is already reaching for the reset link.
  sign_in_address: {
    limit: 10,
    windowMs: 60_000,
    action: "try to sign in",
    sharedBy: "everyone sharing your network address",
  },
  // Ten attempts per ten minutes is 1,440 guesses a day against one account.
  // Against any password worth the name that is nothing, and it is far above
  // what a person who knows their password ever spends, so the window buys the
  // account real protection at no cost to its owner.
  sign_in_email: {
    limit: 10,
    windowMs: 600_000,
    action: "try to sign in to one account",
    sharedBy: "everyone signing in to that email address",
  },
  // A password sign-up answers whether its email is taken, so an unbounded one
  // is a way to test addresses in bulk, and on a hosted deployment it is also
  // how throwaway accounts are made. Ten an hour is far above a household or an
  // office signing up and far below either use.
  sign_up_address: {
    limit: 10,
    windowMs: 3_600_000,
    action: "create a sign-in",
    sharedBy: "everyone sharing your network address",
  },
  // Each one sends an email to a real inbox. Five an hour covers a person who
  // missed the first and a few retries, and keeps the deployment's sender from
  // being turned on somebody's inbox.
  verification_email: {
    limit: 5,
    windowMs: 3_600_000,
    action: "send a verification email",
    sharedBy: "your sign-in",
  },
  // Each one lands in the support inbox. Ten an hour is far above a person
  // writing in about a problem and following up, and keeps one sign-in from
  // flooding the inbox.
  support_message: {
    limit: 10,
    windowMs: 3_600_000,
    action: "send a message to support",
    sharedBy: "your sign-in",
  },
  // The three application authentication endpoints are unauthenticated by
  // design, so each is counted per application and network address. They are
  // deliberately three counters rather than one: a client that registers a key
  // has not spent the token exchange that follows it, and a refusal has to name
  // the endpoint that was flooded for the app's developer to act on it.
  //
  // Sixty a minute per address is far above real use and still bounds a flood.
  // A gateway token lasts an hour, so an address exchanging sixty a minute
  // speaks for about 3,600 devices — more than sits behind one carrier NAT for
  // a single application — and a challenge or a registration happens once per
  // install, not per session.
  app_auth_challenge: {
    limit: 60,
    windowMs: 60_000,
    action: "ask this app for a challenge",
    sharedBy: "everyone sharing your network address",
  },
  app_auth_register: {
    limit: 60,
    windowMs: 60_000,
    action: "register a key with this app",
    sharedBy: "everyone sharing your network address",
  },
  app_auth_token: {
    limit: 60,
    windowMs: 60_000,
    action: "exchange a token with this app",
    sharedBy: "everyone sharing your network address",
  },
} as const satisfies Record<string, EndpointRateLimit>;

export type EndpointRateLimitName = keyof typeof ENDPOINT_RATE_LIMITS;

/**
 * The caller's address, as the only header that cannot be set by the caller.
 *
 * `cf-connecting-ip` is written by Cloudflare's edge and overwritten on every
 * inbound request, so a client cannot choose its own counter. `x-forwarded-for`
 * is attacker-controlled and is never read here: trusting it would let one
 * client spend a different address's allowance, or spread its own attempts over
 * as many counters as it cares to invent. Direct `workerd` runs have no edge in
 * front of them and share the one `local` counter.
 */
export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

const UNITS = [
  { ms: 86_400_000, singular: "day", plural: "days" },
  { ms: 3_600_000, singular: "hour", plural: "hours" },
  { ms: 60_000, singular: "minute", plural: "minutes" },
  { ms: 1_000, singular: "second", plural: "seconds" },
] as const;

/** A duration as a person says it, in the largest unit that fits it whole. */
function spoken(ms: number): string {
  for (const unit of UNITS) {
    if (ms < unit.ms) continue;
    const count = Math.floor(ms / unit.ms);
    return `${count} ${count === 1 ? unit.singular : unit.plural}`;
  }
  return "1 second";
}

/** The same duration as the unit alone, for "at most 3 times per day". */
function perWindow(ms: number): string {
  const text = spoken(ms);
  return text.startsWith("1 ") ? text.slice(2) : text;
}

async function subjectDigest(subject: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(subject)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Claims the sole diagnostic sample for one subject in one fixed window.
 *
 * The same Durable Object used for endpoint limits is a good fit here: after
 * the first claim it only reads its one counter, and D1 is not touched until a
 * claim succeeds. `category` is part of both the digest and object prefix so a
 * diagnostic sampler can never spend an endpoint's enforcement counter.
 */
export async function claimDiagnosticSample(
  env: Env,
  category: string,
  scopeId: string,
  windowMs: number,
): Promise<boolean> {
  const subject = `${category}:${scopeId}`;
  const objectName = `diagnostic-${category}:${await subjectDigest(subject)}`;
  const result = await env.ENDPOINT_RATE_LIMITER
    .getByName(objectName)
    .check({ limit: 1, windowMs });
  return result.allowed;
}

/**
 * Enforces a gateway endpoint's fixed-window abuse policy for one subject.
 *
 * `scopeId` is whatever the policy counts over — a network address, an account,
 * one pending operation — and never reaches the Durable Object's name in the
 * clear, because the digest below is what the object is named after.
 */
export async function enforceEndpointRateLimit(
  env: Env,
  name: EndpointRateLimitName,
  scopeId: string,
): Promise<void> {
  const policy = ENDPOINT_RATE_LIMITS[name];
  const subject = `${name}:${scopeId}`;
  const objectName = `endpoint-rate:${await subjectDigest(subject)}`;
  const result = await env.ENDPOINT_RATE_LIMITER
    .getByName(objectName)
    .check({ limit: policy.limit, windowMs: policy.windowMs });
  if (result.allowed) return;

  const resetAt = new Date(
    Date.now() + result.retryAfterSeconds * 1_000,
  ).toISOString();
  // A wait measured in seconds is best said as a wait. One measured in hours is
  // best said as an instant: the window is aligned to the clock rather than to
  // the caller's last attempt, so "about 18 hours" is the one part of this they
  // would otherwise have to work out for themselves.
  const retry =
    result.retryAfterSeconds >= 3_600
      ? `Try again after ${resetAt}.`
      : `Try again in ${spoken(result.retryAfterSeconds * 1_000)}.`;
  throw new GatewayError(
    429,
    "rate_limited",
    `You can ${policy.action} at most ${policy.limit} times per ` +
      `${perWindow(policy.windowMs)}, counted across ${policy.sharedBy}. ${retry}`,
    { "Retry-After": String(result.retryAfterSeconds) },
    {
      data: {
        scope: name,
        limit: policy.limit,
        windowSeconds: policy.windowMs / 1_000,
        retryAfterSeconds: result.retryAfterSeconds,
        resetAt,
      },
    },
  );
}
