import { z } from "zod";
import { reservedKindName, type ReservedOperationKind } from "../auth/operation-kinds";
import {
  CATALOG,
  type Catalog,
  type OperationName,
  type OperationParams,
  type OperationResponse,
  type OperationSpec,
} from "../contracts/catalog";
import { CliAppKeyAddPayloadSchema, type CliRequestedOperationKind } from "../contracts/cli";
import {
  HandoffProviderAddPayloadSchema,
  HandoffProviderGatewayAddPayloadSchema,
  HandoffProviderUpdatePayloadSchema,
  HandoffRotatePayloadSchema,
  ProviderGatewayUpdateRequestSchema,
  SupportMessageRequestSchema,
} from "../contracts/schemas";
import { GatewayError, type ErrorCode } from "../core/errors";
import type { AdminActor } from "../management/actor";
import { openClaim } from "../management/claims";
import { operationPolicy, type OperationCaller, type OperationRequest } from "../management/executor";
import type { RegisteredOperation } from "../management/handlers";
import { operationId, operationKind } from "../management/operation-kinds";
import { revealUrl } from "../management/operation-links";
import {
  authorizeKind,
  executeReservedOperation,
  newOperationToken,
  openBrowserOperation,
  reserveResourceOperation,
  type RecentOperation,
} from "../management/resource-operations";
import type { ManagementScope } from "../management/scope";
import { supportInbox } from "../management/support";
import { parseRequest } from "../management/validation";
import { isSecretFieldName, secretField, type ResultPath } from "./secret-fields";
import { checkOperatorBaseUrl } from "../core/origin-guard";
import { accountUnclaimed, unclaimedAccessDeadline } from "../policy/accounts";

/**
 * The tools the MCP server offers, as an explicit allowlist over the catalog.
 *
 * Every tool runs a catalog operation through the same executor the HTTP API
 * and the CLI run it through, or opens one of the engine's operations through
 * the same management functions the CLI's operations run through, so its
 * authorization is the operation's policy and its answer is the operation's.
 * What a tool adds is what an agent needs and an HTTP client does not: a
 * verb-first name, a description of when to reach for it, one input object in
 * place of a path and a query, and a sentence summarising the answer.
 *
 * The order is the design's and is deliberate: `tools/list` answers with it,
 * and a stable order is what lets a client cache the list.
 *
 * What a tool may change is checked twice. A tool's operation has the type
 * {@link ToolOperation}: an operation whose catalog policy needs no more than
 * the `read` grant, or one of the writes in {@link MCP_WRITE_OPERATIONS},
 * which is the design's list and nothing more. And the table refuses to build
 * if `operationPolicy` says a tool marked as reading writes, or a writing tool
 * names an operation that list does not — so a write cannot be added by naming
 * it. The creates and the changes whose secret a person enters in a browser are
 * not catalog operations: they open an operation of the engine's, and a tool
 * that does names its kind.
 */

/**
 * The least grant an operation needs, as a type: the entry's own `grant` where
 * it declares one, `read` for a `GET` and `manage` for anything else. The same
 * rule `operationPolicy` applies at run time.
 */
type LeastGrant<K extends OperationName> =
  Catalog[K] extends { readonly policy: { readonly grant: infer G } }
    ? G
    : Catalog[K]["method"] extends "GET"
      ? "read"
      : "manage";

/** A registered operation a `read` credential may run. */
export type ReadOperation = {
  [K in RegisteredOperation]: LeastGrant<K> extends "read" ? K : never;
}[RegisteredOperation];

/**
 * The catalog writes this server runs as they are, each the operation of one
 * tool in the design's table: updates guarded by a revision, deletions and
 * revocations confirmed by the caller, and blocking an app's user. Nothing that
 * takes or returns a secret is here; those open an operation instead.
 */
export const MCP_WRITE_OPERATIONS = [
  "updateApp",
  "deleteApp",
  "revokeAppKey",
  "blockAppUser",
  "unblockAppUser",
  "updateProvider",
  "updateProviderGateway",
  "deleteProvider",
  "deleteProviderGateway",
  "sendSupportMessage",
] as const satisfies readonly RegisteredOperation[];

export type WriteOperation = (typeof MCP_WRITE_OPERATIONS)[number];

/** Every catalog operation a tool here may name. */
export type ToolOperation = ReadOperation | WriteOperation;

/**
 * One operation, the request a tool call makes of it, and — for an argument
 * the operation's own schemas do not cover — the check that refuses it, run by
 * the executor once the application is found and the policy has passed.
 */
export type ToolCall = {
  [K in ToolOperation]: { operation: K; request: OperationRequest<K>; before?: () => void };
}[ToolOperation];

/**
 * The annotations a client shows beside a tool, as the protocol spells them.
 * Declared here rather than imported, so nothing but the adapter in
 * `./server` names the SDK.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpTool {
  /** Verb-first snake_case, the name an agent calls. */
  readonly name: string;
  readonly title: string;
  /** For an agent: what it returns, when to use it, and what it does not do. */
  readonly description: string;
  /** The catalog operation it runs, or the two a dual tool chooses between. */
  readonly operation?: ToolOperation | readonly [ToolOperation, ToolOperation];
  /** The engine's kind of the operation it opens, for a tool that runs none of the catalog's. */
  readonly kind?: CliRequestedOperationKind;
  /** Whether a person completes what it opens by entering a secret in a browser. */
  readonly browserStep?: true;
  /**
   * Whether the deployment offers what the tool does at all. A tool that says
   * no is left out of `tools/list` rather than listed and refused on every
   * call; the answer is the deployment's, so the list stays fixed for it.
   */
  available?(scope: ManagementScope): boolean;
  /**
   * Path parameters and query fields of the operation, reusing the catalog's
   * own field schemas. What `tools/list` advertises, and only that: the
   * arguments of a call reach the executor as they were sent, so it refuses
   * them in the order and the words it refuses an HTTP request in.
   */
  readonly input: z.ZodObject;
  readonly annotations: ToolAnnotations;
  /**
   * Where in its result this tool answers the metadata of an app key it
   * created: the only places a field named `api_key` is shown rather than
   * redacted. See `redactSecrets`.
   */
  readonly keyMetadataAt?: readonly ResultPath[];
  /** What to do after a refusal, where this tool knows better than {@link nextAction}. */
  readonly next?: Partial<Record<ErrorCode, string>>;
  /** The catalog operation to run for one call's arguments, and its request. */
  call?(input: Record<string, unknown>): ToolCall;
  /**
   * For a tool that opens an engine operation: the whole call, through the
   * management layer's functions for it, which apply the kind's authority
   * before they read an argument.
   */
  perform?(input: Record<string, unknown>, caller: OperationCaller): Promise<Record<string, unknown>>;
  /** Where a tool answers with part of the operation's body: that part. */
  result?(body: unknown, input: Record<string, unknown>): unknown;
  /** One or two sentences for the text block beside the structured result. */
  summary(result: unknown, input: Record<string, unknown>): string;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * What each `{name}` segment of an operation's path is, as a tool argument.
 * `app` keeps its name, so an agent passes the same id every tool and every
 * HTTP path calls `app`.
 */
const PATH_ARGUMENTS: Readonly<Record<string, z.ZodType>> = {
  app: z.string().min(1).meta({ description: "The application's id, as list_apps returns it." }),
  user: z.string().min(1).meta({ description: "The end user's id, as list_app_users returns it." }),
  key: z.string().min(1).meta({ description: "The key's id, as list_app_keys returns it." }),
  id: z.string().min(1).meta({ description: "The id of what the tool acts on, as the tool that lists it returns it." }),
};

function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!);
}

/**
 * An operation's path parameters, then its query fields — the catalog's own
 * schemas for both. `described` words a path parameter for this one tool,
 * where `id` means a provider to one and an operation to another.
 */
function operationInput(operation: ToolOperation, described: Record<string, z.ZodType> = {}): z.ZodObject {
  const spec: OperationSpec = CATALOG[operation];
  const params: Record<string, z.ZodType> = {};
  for (const name of pathParameterNames(spec.path)) {
    const argument = described[name] ?? PATH_ARGUMENTS[name];
    if (!argument) throw new Error(`${operation} names {${name}}, which no tool argument describes`);
    params[name] = argument;
  }
  return z.object(params).extend(spec.query?.shape ?? {});
}

/** A tool argument as the string it would have been in a path or a query string. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * The request one call's arguments make of one operation: the path parameters
 * it names, and everything else as the query string it would have been over
 * HTTP, so the executor parses the query with the operation's own schema
 * exactly as it parses one from the API.
 *
 * Nothing here judges an argument. `app` is the executor's to resolve, which
 * it does first; any other path parameter is checked by the returned `before`,
 * after the policy, because no schema of the operation's covers it.
 */
function operationCall<K extends ToolOperation>(
  operation: K,
  input: Record<string, unknown>,
  body?: unknown,
): ToolCall {
  const names = pathParameterNames(CATALOG[operation].path);
  const params: Record<string, string> = {};
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (names.includes(key)) params[key] = asText(value);
    else query[key] = Array.isArray(value) ? value.map(asText) : asText(value);
  }
  const request: OperationRequest<K> = {
    params: params as OperationParams<K>,
    query,
    ...(body === undefined ? {} : { body: async () => body }),
  };
  const checked = names.filter((name) => name !== "app");
  const before = checked.length === 0
    ? undefined
    : () => {
      parseRequest(z.object(Object.fromEntries(checked.map((name) => [name, PATH_ARGUMENTS[name]!]))), input);
    };
  // Correct by construction — `request` is `operation`'s own — but a mapped
  // union does not narrow on a generic key.
  return { operation, request, ...(before ? { before } : {}) } as unknown as ToolCall;
}

/** The same call, with one more refusal of the tool's own after the operation's. */
function withCheck(call: ToolCall, check: () => void): ToolCall {
  const before = call.before;
  return {
    ...call,
    before: () => {
      before?.();
      check();
    },
  } as ToolCall;
}

/**
 * `readOnlyHint` from the operation's policy, and the refusal of a tool whose
 * operation writes: a `manage` operation marked as reading is a mistake to
 * catch when the table is built, not a hint to get wrong.
 */
function readOnly(name: string, operations: readonly ToolOperation[]): ToolAnnotations {
  for (const operation of operations) {
    if (operationPolicy(CATALOG[operation]).grant !== "read") {
      throw new Error(`MCP tool ${name} runs ${operation}, which writes, and is marked as reading`);
    }
  }
  return { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
}

/**
 * The annotations of a tool that runs a catalog write, and the refusal of one
 * whose operation is not among the writes this server exposes.
 */
function writing(
  name: string,
  operation: WriteOperation,
  effect: { destructive: boolean; idempotent: boolean },
): ToolAnnotations {
  if (!(MCP_WRITE_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error(`MCP tool ${name} runs ${operation}, which this server does not expose`);
  }
  return {
    readOnlyHint: false,
    destructiveHint: effect.destructive,
    idempotentHint: effect.idempotent,
    openWorldHint: false,
  };
}

/**
 * A tool that opens an operation: it changes something, nothing it changes is
 * lost, and calling it twice asks twice — which is why the creates reserve
 * first and the browser steps report a recent identical request.
 */
const OPENS_OPERATION: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** A tool that runs one operation with its own input: a read, or one of the exposed writes. */
function tool<K extends ToolOperation>(definition: {
  name: string;
  title: string;
  description: string;
  operation: K;
  input?: z.ZodObject;
  /** For a write, what it does to what it names; a read says nothing. */
  effect?: K extends WriteOperation ? { destructive: boolean; idempotent: boolean } : never;
  check?: (input: Record<string, unknown>) => void;
  next?: Partial<Record<ErrorCode, string>>;
  keyMetadataAt?: readonly ResultPath[];
  summary: (result: OperationResponse<K>) => string;
}): McpTool {
  const { operation, effect, check } = definition;
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    operation,
    input: definition.input ?? operationInput(operation),
    annotations: effect
      ? writing(definition.name, operation as WriteOperation, effect)
      : readOnly(definition.name, [operation]),
    ...(definition.next ? { next: definition.next } : {}),
    ...(definition.keyMetadataAt ? { keyMetadataAt: definition.keyMetadataAt } : {}),
    call: (input) => {
      const call = operationCall(operation, input);
      return check ? withCheck(call, () => check(input)) : call;
    },
    summary: (result) => definition.summary(result as OperationResponse<K>),
  };
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2)}`;
}

/** A short list of names, and how many more there are. */
function listed(names: readonly string[], limit = 10): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

function page(count: number, noun: string, next: number | null): string {
  const more = next === null ? "" : ` Pass before_id ${next} for older ones.`;
  return `${plural(count, noun)}, newest first.${more}`;
}

function accountSummary(result: OperationResponse<"getCliAccount">): string {
  const { account, deployment, usage } = result;
  const standing = usage === null ? "" : ` ${usage.used} of ${usage.limit} requests used this period, which resets ${usage.resetAt}.`;
  const base = `Account "${account.name}" (${account.id}) on ${deployment.consoleOrigin}.${standing}`;
  if (account.claimed) return base;
  if (accountUnclaimed(account)) {
    const accessEnds = unclaimedAccessDeadline(account.createdAt);
    const access = accessEnds === null ? "" : ` Its free access ends ${new Date(accessEnds).toISOString()}, and it`;
    return `${base} This account is unclaimed:${access || " it"} is deleted after ${account.expiresAt} unless a person claims it. Call claim_account to start the claim.`;
  }
  return `${base} Nobody has claimed this account yet; call claim_account to give it a person as its owner.`;
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** The caller an operation is opened for. The bearer gate has always authenticated one. */
function authenticated(caller: OperationCaller): { state: NonNullable<OperationCaller["auth"]>["state"]; actor: AdminActor } {
  if (!caller.auth) throw new GatewayError(401, "auth_required", "Authentication is required");
  return caller.auth;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Refuses a secret passed as an argument, before anything else about the
 * arguments is judged and before any part of them is extracted: a field named
 * like a credential anywhere in them, at any depth, in any case, inside an
 * array or beside the documented payload. A provider key and a gateway token
 * are entered by a person in a browser; one that reached a tool has already
 * been seen by the agent, and storing it would make that the normal way in.
 * The refusal names the field, never its value.
 */
function refuseSecret(input: Record<string, unknown>, tool: string): void {
  refuseCredential(input, `${tool} returns a URL where a person enters it in a browser`);
}

/** {@link refuseSecret}, with what to do instead in the tool's own words. */
function refuseCredential(input: Record<string, unknown>, remedy: string): void {
  const field = secretField(input);
  if (field === null) return;
  throw new GatewayError(
    400,
    "invalid_request",
    `${field}: a provider key or gateway token is never a tool argument. ${remedy}`,
  );
}

/**
 * Refuses an app document carrying a field named like a credential, wherever
 * in it. Applied by the MCP tools only: the catalog's provider-native
 * parameters stay open for the API, where a caller may hold a credential, but
 * nothing an agent sends is one.
 */
function refuseAppCredential(input: Record<string, unknown>): void {
  refuseCredential(
    input,
    "An app document holds no credentials: an app reaches providers with the keys add_provider has a person enter in a browser",
  );
}

/**
 * Refuses a URL that carries a credential, before the request is stored for a
 * person to review, wherever in the arguments it is. The value is trimmed and
 * read with the platform's URL parser, as a browser or a client would read it.
 *
 * - A `baseUrl` is judged by the guard the write itself applies.
 * - Any other URL is refused when it carries credentials (`user:pass@`), or a
 *   query or fragment parameter named like one (`?api_key=`, `#access_token=`);
 *   any other query, such as `?version=2`, passes.
 *
 * The refusal names the field, never the URL.
 */
function refuseUnsafeUrl(value: unknown, longest: number, path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => refuseUnsafeUrl(item, longest, [...path, String(index)]));
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) refuseUnsafeUrl(item, longest, [...path, key]);
    return;
  }
  if (typeof value !== "string") return;
  const field = path.join(".") || "arguments";
  // Cut off at the door: nothing longer than the browser steps' schemas
  // accept anywhere is worth reading as a URL, and reading it costs time.
  if (value.trim().length > longest) {
    throw new GatewayError(400, "invalid_request", `${field}: longer than the ${longest} characters any argument of a browser step may hold`);
  }
  if (path[path.length - 1] === "baseUrl") {
    const checked = checkOperatorBaseUrl(value);
    // Only the guard's verdicts that cannot echo the value are worded here.
    if (!checked.ok) throw new GatewayError(400, "invalid_request", `${field}: ${baseUrlRefusal(checked.message)}`);
    return;
  }
  // As the platform's parser reads it, after the trim the schemas apply: a
  // string it does not read as a URL is not one, and a name such as
  // "OpenAI: production" reads as one with no credentials in it.
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return;
  }
  const refuse = (what: string): never => {
    throw new GatewayError(400, "invalid_request", `${field}: a URL here may not carry ${what}`);
  };
  if (url.username !== "" || url.password !== "") refuse("credentials");
  if (credentialParameter(url.search + url.hash)) refuse("a credential in its query string or fragment");
}

/**
 * Whether a query and fragment name a credential anywhere.
 *
 * The text is percent-decoded first, again until it stops changing (a few
 * rounds at most, so a doubly encoded `%253D` is read too), keeping whatever
 * does not decode as written: an encoded delimiter delimits. Then it is split
 * on every `?`, `&`, `#` and `;`, so a query inside a fragment
 * (`#/callback?api_key=`) or a doubled delimiter (`??token=`) is read as the
 * parameters it is. Each piece with an `=` is a parameter, its name stripped
 * of leading `?`, `#` and `/`; a piece without one is a route or a flag.
 */
export function credentialParameter(tail: string): boolean {
  for (const piece of decodedRepeatedly(tail).split(/[?&#;]/u)) {
    if (!piece.includes("=")) continue;
    const name = piece.split("=", 1)[0]!;
    if (isSecretFieldName(name.replace(/^[?#/]+/u, "").trim())) return true;
  }
  return false;
}

/** How many times a value is percent-decoded before it is judged. */
const DECODE_ROUNDS = 4;

function decodedRepeatedly(text: string): string {
  let current = text;
  for (let round = 0; round < DECODE_ROUNDS; round += 1) {
    const next = decodedOnce(current.replace(/\+/gu, " "));
    if (next === current) break;
    current = next;
  }
  return current;
}

const utf8 = new TextEncoder();

/** Non-fatal: an invalid sequence becomes U+FFFD rather than an exception to probe around. */
const lenientUtf8 = new TextDecoder("utf-8");

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

/**
 * One round of percent-decoding, in one linear pass and without exceptions:
 * the text becomes bytes — plain text as its UTF-8, each `%XX` as its byte, a
 * `%` that starts no escape as itself — and the bytes are read back as UTF-8
 * once, an invalid sequence becoming U+FFFD. Every escape of an ASCII
 * character, `=`, `&`, `?`, `#` and `;` among them, surfaces whatever bytes
 * stand beside it.
 */
function decodedOnce(text: string): string {
  if (!text.includes("%")) return text;
  const bytes: number[] = [];
  let plainFrom = 0;
  const flushPlain = (to: number) => {
    if (to > plainFrom) for (const byte of utf8.encode(text.slice(plainFrom, to))) bytes.push(byte);
  };
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 37) continue;
    const high = hexValue(text.charCodeAt(index + 1));
    const low = hexValue(text.charCodeAt(index + 2));
    if (high < 0 || low < 0) continue;
    flushPlain(index);
    bytes.push(high * 16 + low);
    index += 2;
    plainFrom = index + 1;
  }
  flushPlain(text.length);
  return lenientUtf8.decode(Uint8Array.from(bytes));
}

/**
 * The guard's refusal without the URL: its verdicts about the host quote part
 * of it, so those are worded generally; every other one names only the rule.
 */
function baseUrlRefusal(message: string): string {
  const said = message.startsWith("Base URL host")
    ? "Base URL must name a public domain name"
    : message;
  return said.replace(/^Base URL /u, "");
}

/**
 * Refuses an argument beside the one a wrapped payload is passed in, which no
 * schema would otherwise see: the payload's own schema judges only what is
 * inside the wrapper.
 */
function refuseSiblings(input: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(input).find((key) => !allowed.includes(key));
  if (extra === undefined) return;
  throw new GatewayError(400, "invalid_request", `${extra}: not an argument of this tool; pass only ${allowed.join(", ")}`);
}

/** A deletion's `confirm`, which has to repeat the id of what it deletes. */
function confirmed(what: string): (input: Record<string, unknown>) => void {
  return (input) => {
    if (input.confirm !== input.id) {
      throw new GatewayError(400, "invalid_request", `confirm: pass the ${what}'s id as confirm to delete it`);
    }
  };
}

const CONFIRM_ARGUMENT = z.string().min(1).meta({
  description: "The same id again. A deletion without it is refused, and nothing is deleted.",
});

/** What an agent is told about an identical request this account made within the hour. */
function recentNotice(recent: RecentOperation): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(recent.createdAt)) / 60_000));
  const when = minutes === 0 ? "less than a minute ago" : `${plural(minutes, "minute")} ago`;
  const what = recent.state === "completed" ? "completed" : "was opened";
  return `An identical request ${what} ${when} as operation ${recent.id}; use get_operation to inspect it before creating another.`;
}

/**
 * What a tool answers when it opens an engine operation a person completes in
 * a browser: the operation's `id`, which `get_operation` takes, and the URL.
 */
type OpenedOperationResult = {
  id: string;
  url: string;
  expiresAt: string;
  notice?: string;
  next: string;
};

/**
 * What a reserved create answers on its first call: the `handle` its second
 * call takes, and the `id` of the operation it reserved, which `get_operation`
 * takes. The two are never the same string and never share a name.
 */
type ReservedResult = {
  handle: string;
  id: string;
  expiresAt: string;
  notice?: string;
  next: string;
};

const RESERVATION_HANDLE = z.object({
  handle: z.string({ error: "handle must be the string an earlier call of this tool answered with" })
    .min(1)
    .max(512)
    .optional(),
});

const RESERVATION_ARGUMENT = z.string().min(1).max(512).optional().meta({
  description:
    "Omit it to reserve: nothing is created, and the answer's `handle` is this argument. Then call again with the same arguments and that handle to create it, once. Calling again with the same handle repeats the first answer rather than creating another.",
});

/** What to do after each refusal particular to a reserved create. */
function reservationNext(tool: string): Partial<Record<ErrorCode, string>> {
  return {
    operation_not_found: `This server never gave out that handle. Call ${tool} without handle to reserve again.`,
    operation_mismatch: `The handle was reserved for other arguments, or for another account. Call ${tool} without handle to reserve these arguments, or send the arguments you reserved.`,
    operation_expired: `The reservation lapsed after 15 minutes. Call ${tool} without handle to reserve again.`,
    already_completed: `That create ran more than 15 minutes ago. Call get_operation with the id its reservation answered to see what it created before creating another.`,
    conflict: `Nothing was written. Call ${tool} again with the same arguments and handle in a few seconds.`,
  };
}

const REVEAL_NEXT =
  "Give reveal_url to the person: signed in to the console as an owner or admin, they see the key there once. Never ask them to paste it into this conversation.";

/**
 * A create an agent may retry but that must happen once: a call without
 * `handle` reserves it and creates nothing, and a call with the `handle` it
 * answered creates it — once, however often that call is repeated. A key it
 * creates is never in the answer; a person reveals it on the page `reveal_url`
 * names.
 */
function reservationTool(definition: {
  name: string;
  title: string;
  description: string;
  kind: ReservedOperationKind;
  input: z.ZodObject;
  /** The kind's payload: the arguments, less the handle. */
  payload: (input: Record<string, unknown>) => unknown;
  /** What the reservation is for, for its summary. */
  reserving: (input: Record<string, unknown>) => string;
  /** What was created, for the summary of an execution. */
  created: (result: Record<string, unknown>) => string;
}): McpTool {
  const { name, kind } = definition;
  return {
    name,
    title: definition.title,
    description: definition.description,
    kind,
    input: definition.input,
    annotations: OPENS_OPERATION,
    // Where an execution answers the key it created, without its value.
    keyMetadataAt: [["api_key"]],
    next: reservationNext(name),
    perform: async (input, caller) => {
      const auth = authenticated(caller);
      await authorizeKind(caller.scope, auth, operationKind(kind));
      // Before anything is hashed, reserved or written.
      refuseAppCredential(input);
      const { handle } = parseRequest(RESERVATION_HANDLE, input);
      const payload = definition.payload(input);
      if (handle === undefined) {
        const reserved = await reserveResourceOperation(caller.scope, auth.actor, auth.state, { kind, payload });
        return {
          handle: reserved.handle,
          id: reserved.id,
          expiresAt: reserved.expiresAt,
          ...(reserved.recent ? { notice: recentNotice(reserved.recent) } : {}),
          next: `Nothing is created yet. Call ${name} again with the same arguments and this handle before ${reserved.expiresAt} to create it.`,
        } satisfies ReservedResult;
      }
      const executed = await executeReservedOperation(caller.scope, auth.actor, auth.state, {
        kind,
        payload,
        handle,
      });
      return {
        id: executed.id,
        kind: reservedKindName(kind),
        replayed: executed.replayed,
        ...executed.result,
        ...(executed.revealable
          ? { reveal_url: revealUrl(caller.scope.deployment, executed.id), next: REVEAL_NEXT }
          : {}),
      };
    },
    summary: (raw, input) => {
      const result = raw as Record<string, unknown>;
      if (typeof result.handle === "string") {
        const reserved = raw as ReservedResult;
        const notice = reserved.notice === undefined ? "" : ` ${reserved.notice}`;
        return `Reserved ${definition.reserving(input)} as operation ${reserved.id}; nothing is created yet. Call ${name} again with the same arguments and handle "${reserved.handle}" to create it.${notice}`;
      }
      const repeated = result.replayed === true ? " This repeats the answer of the call that created it; nothing new was created." : "";
      const reveal = typeof result.reveal_url === "string"
        ? ` Its key is not shown here: a person signed in as an owner or admin reveals it once at ${result.reveal_url}.`
        : "";
      return `${definition.created(result)}${repeated}${reveal}`;
    },
  };
}

/**
 * The longest string any browser step accepts anywhere in what it stores: the
 * largest `maxLength` the handoff schemas' JSON Schema declares — a base URL,
 * a name, a gateway's connection field — read off the schemas rather than
 * written here, so it follows the contract. A string longer than this in a
 * browser step's arguments is refused before anything reads it.
 */
const BROWSER_STEP_LONGEST = (() => {
  let longest = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isObject(node)) return;
    if (typeof node.maxLength === "number") longest = Math.max(longest, node.maxLength);
    Object.values(node).forEach(walk);
  };
  for (const schema of [
    HandoffProviderAddPayloadSchema,
    HandoffProviderGatewayAddPayloadSchema,
    HandoffProviderUpdatePayloadSchema,
    HandoffRotatePayloadSchema,
  ]) {
    walk(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
  }
  if (longest === 0) throw new Error("The browser-step schemas declare no string length");
  return longest;
})();

const BROWSER_NEXT =
  "Give the URL to the person: they open it in their browser, enter the secret there and approve. Then call get_operation with this answer's id until it completes. Do not open the URL yourself.";

/**
 * A change whose secret a person supplies: the tool opens it with what can be
 * reviewed, and answers the URL of the page where the person enters the
 * secret and approves. The secret never passes through the agent.
 */
function browserTool(definition: {
  name: string;
  title: string;
  description: string;
  kind: CliRequestedOperationKind;
  input: z.ZodObject;
  payload: (input: Record<string, unknown>) => unknown;
  /**
   * For a payload passed inside one argument, the arguments the tool takes:
   * anything beside them is refused rather than dropped.
   */
  wrapped?: readonly string[];
  /** What is asked for, for the summary. */
  asking: (input: Record<string, unknown>) => string;
}): McpTool {
  const { name, kind } = definition;
  return {
    name,
    title: definition.title,
    description: definition.description,
    kind,
    browserStep: true,
    input: definition.input,
    annotations: OPENS_OPERATION,
    next: {
      invalid_request: `Correct the arguments as the message says and call ${name} again. A key or token is never an argument: the person enters it on the page this tool returns.`,
    },
    perform: async (input, caller) => {
      const auth = authenticated(caller);
      await authorizeKind(caller.scope, auth, operationKind(kind));
      // Wherever it was put: beside the payload is no better than inside it.
      refuseSecret(input, name);
      if (definition.wrapped) refuseSiblings(input, definition.wrapped);
      refuseUnsafeUrl(input, BROWSER_STEP_LONGEST);
      const payload = definition.payload(input);
      const step = await openBrowserOperation(caller.scope, auth.actor, auth.state, { kind, payload });
      return {
        id: step.view.id,
        url: step.url,
        expiresAt: step.view.expiresAt,
        ...(step.recent ? { notice: recentNotice(step.recent) } : {}),
        next: BROWSER_NEXT,
      } satisfies OpenedOperationResult;
    },
    summary: (raw, input) => {
      const result = raw as OpenedOperationResult;
      const notice = result.notice === undefined ? "" : ` ${result.notice}`;
      return `Opened operation ${result.id} to ${definition.asking(input)}. A person opens ${result.url} in their browser before ${result.expiresAt}, enters the secret there and approves; then call get_operation.${notice}`;
    },
  };
}

function appName(result: Record<string, unknown>): string {
  const app = result.app as { id?: string; name?: string } | undefined;
  return app ? `"${app.name}" (${app.id})` : "the app";
}

const PROVIDER_ID = z.string().min(1).meta({ description: "The provider's id, as list_providers returns it." });
const GATEWAY_ID = z.string().min(1).meta({ description: "The provider gateway's id, as list_provider_gateways returns it." });

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const GET_PROVIDER_INPUT = z.object({
  provider: z.string().min(1).meta({
    description: "The provider's id or its slug, as list_providers returns them.",
  }),
});

export const MCP_TOOLS: readonly McpTool[] = [
  tool({
    name: "get_account",
    title: "Get the account",
    description:
      "Returns the account these credentials act in: its id and name, whether a person has claimed it and its deadlines, the deployment it lives on, its access and how many requests it has used this period. Call it first. An unclaimed account expires unless a person claims it; the summary says so and names claim_account. Changes nothing.",
    operation: "getCliAccount",
    summary: accountSummary,
  }),
  tool({
    name: "get_capabilities",
    title: "Get deployment capabilities",
    description:
      "Returns what this deployment supports: its identity and console origin, the server version, every provider type with its API styles, base URL and example path, and the provider gateway types. Use it to learn which provider types exist before reading or planning configuration. It says nothing about what your account has configured; list_providers does.",
    operation: "getCliCapabilities",
    summary: (result) =>
      `Deployment ${result.deployment.id} (${result.deployment.mode}) at ${result.consoleOrigin}, server ${result.serverVersion}: ${plural(result.providers.length, "provider type")} and ${plural(result.providerGateways.length, "provider gateway type")}.`,
  }),
  tool({
    name: "list_models",
    title: "List priced models",
    description:
      "Returns the model catalog this deployment prices, grouped by provider type: per-token prices and, where known, the day a model retires. Use it to choose a model an app may allow, or to explain a cost. A model missing here has no price, and an app that allows it by name is refused when validated.",
    operation: "listModelPrices",
    summary: (result) => {
      const providers = Object.keys(result.prices);
      const models = providers.reduce((sum, provider) => sum + Object.keys(result.prices[provider]!).length, 0);
      return `${plural(models, "priced model")} across ${plural(providers.length, "provider type")}.`;
    },
  }),
  tool({
    name: "list_providers",
    title: "List providers",
    description:
      "Returns every provider credential your account holds, disabled ones included: id, type, slug, name, status, route, capability and pricing. Metadata only; a credential is never returned, only the last characters of a direct key as secretHint. Use it before configuring an app, whose routing names providers by slug.",
    operation: "listProviders",
    summary: (result) =>
      result.providers.length === 0
        ? "No providers yet. A provider credential is only ever entered in a browser, never passed to a tool."
        : `${plural(result.providers.length, "provider")}: ${listed(result.providers.map((provider) => `${provider.slug} (${provider.type}, ${provider.status})`))}.`,
  }),
  {
    name: "get_provider",
    title: "Get a provider",
    description:
      "Returns one provider credential's metadata by its id or its slug: type, name, status, route, capability, pricing and secretHint. Never the credential itself. Answers provider_not_found when none of your providers has that id or slug.",
    operation: "listProviders",
    input: GET_PROVIDER_INPUT,
    annotations: readOnly("get_provider", ["listProviders"]),
    call: (input) => ({
      ...operationCall("listProviders", {}),
      // `provider` is this tool's own argument, so this tool judges it.
      before: () => {
        parseRequest(GET_PROVIDER_INPUT, input);
      },
    }),
    result: (body, input) => {
      const { providers } = body as OperationResponse<"listProviders">;
      const wanted = String(input.provider);
      const provider = providers.find((candidate) => candidate.id === wanted)
        ?? providers.find((candidate) => candidate.slug === wanted);
      if (!provider) {
        throw new GatewayError(404, "provider_not_found", `None of your providers has the id or slug ${wanted}`);
      }
      return { provider };
    },
    summary: (result) => {
      const { provider } = result as { provider: OperationResponse<"listProviders">["providers"][number] };
      const route = provider.route === null ? "an unavailable route" : provider.route === "direct" ? "direct" : `through a ${provider.route} provider gateway`;
      return `Provider ${provider.slug} (${provider.type}) is ${provider.status}, routed ${route}.`;
    },
  },
  tool({
    name: "list_provider_gateways",
    title: "List provider gateways",
    description:
      "Returns the reusable provider gateways your account holds, such as a Cloudflare AI Gateway several providers route through: id, type, name, status and how many providers use each. Metadata only; a gateway token is never returned, only its secretHint.",
    operation: "listProviderGateways",
    summary: (result) =>
      result.gateways.length === 0
        ? "No provider gateways."
        : `${plural(result.gateways.length, "provider gateway")}: ${listed(result.gateways.map((gateway) => `${gateway.name} (${gateway.type}, ${gateway.status})`))}.`,
  }),
  tool({
    name: "list_apps",
    title: "List apps",
    description:
      "Returns every app in your account with its status, authentication type, the providers it reaches and its usage for one month. Use it to find an app's id, which every other app tool takes as `app`. Does not return an app's configuration; get_app does.",
    operation: "listApps",
    summary: (result) =>
      result.apps.length === 0
        ? `No apps yet (${result.month}).`
        : `${plural(result.apps.length, "app")} in ${result.month}: ${listed(result.apps.map((app) => `${app.id} (${app.status})`))}.`,
  }),
  tool({
    name: "get_app",
    title: "Get an app",
    description:
      "Returns one app's whole stored document: name, status, revision and its complete configuration, plus its read-only warnings. Read it before proposing a change: a change is judged against this document and must carry its revision. A warning describes behaviour that stops on its stated date: tell the person about each one. Answers app_not_found for an id that is not one of your apps.",
    operation: "getApp",
    summary: (result) =>
      `App "${result.app.name}" (${result.app.id}) is ${result.app.status}, at revision ${result.app.revision}.${
        result.app.warnings.length === 0
          ? ""
          : ` Warnings: ${result.app.warnings.map((warning) => warning.message).join(" ")}`
      }`,
  }),
  {
    name: "validate_app",
    title: "Validate an app configuration",
    description:
      "Checks an app document without saving anything: the same {name, config, status?} body creating or updating an app takes, whose every field the `config` argument's schema describes. With `app`, it is judged as an update of that app; without, as a new app. Answers the reason it would be refused, in the gateway's own words, as a tool error. Use it before any change to an app; to change an existing app, start from the document get_app returns, without id and revision.",
    operation: ["validateApp", "validateAppDraft"],
    input: z.object({
      app: z.string().min(1).optional().meta({
        description: "The id of the app this would update. Omit it to judge the document as a new app.",
      }),
      // The catalog's own body schema, so discovery shows every field of an
      // app's configuration. It is advertised, not applied here: the executor
      // parses the document with this same schema and words what it refuses.
      config: CATALOG.validateApp.request.meta({
        description: "The app document to judge: {name, config, status?}, exactly the body creating or updating an app takes, without id or revision.",
      }),
    }),
    annotations: readOnly("validate_app", ["validateApp", "validateAppDraft"]),
    call: (input) => {
      const { app, config } = input;
      const call = app === undefined || app === null
        ? operationCall("validateAppDraft", {}, config)
        : operationCall("validateApp", { app }, config);
      return withCheck(call, () => refuseAppCredential(input));
    },
    summary: (result) => {
      const appId = (result as { app_id?: string }).app_id;
      return appId === undefined
        ? "The document would be accepted as a new app."
        : `The document would be accepted as an update of ${appId}.`;
    },
  },
  tool({
    name: "check_app",
    title: "Check whether an app is ready",
    description:
      "Checks whether an app can serve requests, without sending any: validates its stored configuration, lists every provider its routing names with that provider's status, and reports ready when the app is active, at least one of them is active and the account would serve its requests (accountRefusal names the error code its clients would get otherwise). It does not exercise App Attest, issuer sign-in, entitlements or the upstream credentials, and says so in limitations.",
    operation: "checkApp",
    summary: (result) => {
      const active = result.providers.filter((provider) => provider.status === "active").length;
      const standing = `${result.status}, and ${active} of ${plural(result.providers.length, "provider")} it names ${active === 1 ? "is" : "are"} active`;
      const refusal = result.accountRefusal === null
        ? ""
        : ` Its account refuses requests with ${result.accountRefusal}: ${NEXT_ACTIONS[result.accountRefusal] ?? "see the error reference."}`;
      return result.ready
        ? `App ${result.appId} is ready: it is ${standing}. No request was sent.`
        : `App ${result.appId} is not ready: it is ${standing}.${refusal} No request was sent.`;
    },
  }),
  tool({
    name: "get_app_snippet",
    title: "Get an app's first request",
    description:
      "Returns the first request an app can send, written against what it has today: Swift for an App Attest app, curl for a server app, with named placeholders explained in notes where a value is missing. It never contains a credential; a server app's example reads its key from APP_AI_GATEWAY_KEY. Hand it to the person building the app; do not run it unless they ask, since it calls a paid model.",
    operation: "getAppSnippet",
    summary: (result) =>
      `A ${result.language} example${result.notes.length === 0 ? "" : ` with ${plural(result.notes.length, "note")} on what it stands in for`}. It holds no credential.`,
  }),
  tool({
    name: "list_app_keys",
    title: "List an app's keys",
    description:
      "Returns a server app's API keys as metadata: id, name, the key's first characters, status, when it was created and last used. A key's value is shown once, when it is created, and never by this tool.",
    operation: "listAppKeys",
    summary: (result) => {
      const active = result.keys.filter((key) => key.status === "active").length;
      return `${plural(result.keys.length, "key")} for ${result.app_id}, ${active} active. Key values are never returned.`;
    },
  }),
  tool({
    name: "list_app_users",
    title: "List an app's users",
    description:
      "Returns the end users an app has seen, with their status and usage for one month, a page at a time (limit, offset). Filter by a substring of the user id or by status. Use it to find a user before get_app_user, or to see who is blocked. It does not block or unblock anyone.",
    operation: "listAppUsers",
    summary: (result) =>
      `${plural(result.users.length, "user")} of ${result.total} for ${result.app_id} in ${result.month}, from offset ${result.offset}.`,
  }),
  tool({
    name: "get_app_user",
    title: "Get an app user",
    description:
      "Returns one end user of an app: status, attestation state and usage for one month. Use it to explain why one user is refused or what they cost.",
    operation: "getAppUser",
    summary: (result) => `User ${result.user.id} of ${result.app_id} is ${result.user.status} (${result.month}).`,
  }),
  tool({
    name: "list_app_events",
    title: "List an app's usage events",
    description:
      "Returns an app's proxied requests one event each, newest first: user, provider, model, tokens, cost, status and latency. Filter by status, provider, user or model; page back with before_id. Use it to debug failures or to trace one user's traffic. For totals use get_usage.",
    operation: "listAppEvents",
    summary: (result) => page(result.events.length, "usage event", result.next_before_id),
  }),
  tool({
    name: "list_auth_events",
    title: "List an app's authentication events",
    description:
      "Returns an app's authentication attempts one each, newest first: token exchanges and App Attest registrations with their outcome and reason. Filter by outcome, event or user; page back with before_id. Use it to explain why an app's users cannot sign in.",
    operation: "listAppAuthEvents",
    summary: (result) => page(result.events.length, "authentication event", result.next_before_id),
  }),
  tool({
    name: "get_auth_event_summary",
    title: "Summarize an app's authentication",
    description:
      "Returns an app's authentication outcomes per day over a trailing window of days: attempts by outcome and reason, non-ok proxied requests, the token-exchange success rate, entitlement-claim delays and users waiting on a claim. Start here when an app's sign-in looks unhealthy, then drill in with list_auth_events.",
    operation: "getAppAuthEventSummary",
    summary: (result) => {
      const attempts = result.daily.reduce((sum, day) => sum + day.count, 0);
      return `${plural(attempts, "authentication attempt")} for ${result.app_id} from ${result.from} to ${result.to}.`;
    },
  }),
  tool({
    name: "list_rejection_events",
    title: "List an app's refused requests",
    description:
      "Returns samples of an app's requests the gateway refused before contacting a provider — a limit, a disallowed model or path, a blocked user — newest first, with the reason and scope. At most one sample per caller per minute, so counts are not exact totals. Filter by reason, scope, user or day; page back with before_id.",
    operation: "listAppRejectionEvents",
    summary: (result) => page(result.events.length, "refusal sample", result.next_before_id),
  }),
  {
    name: "get_usage",
    title: "Get usage totals",
    description:
      "Returns one month's usage totals: requests, tokens and cost. With `app`, for that app; without, for the whole account, with a line per app including deleted ones. For a breakdown by model, provider or user use get_usage_breakdown; for days use get_usage_timeseries.",
    operation: ["getAppUsage", "getCliUsage"],
    input: z.object({ app: PATH_ARGUMENTS.app!.optional() }).extend(CATALOG.getAppUsage.query.shape),
    annotations: readOnly("get_usage", ["getAppUsage", "getCliUsage"]),
    call: (input) =>
      input.app === undefined
        ? operationCall("getCliUsage", input)
        : operationCall("getAppUsage", input),
    summary: (result) => {
      if ("app_id" in (result as object)) {
        const usage = result as OperationResponse<"getAppUsage">;
        return `${plural(usage.requests, "request")} costing ${usd(usage.cost_usd)} for ${usage.app_id} in ${usage.month}.`;
      }
      const usage = result as OperationResponse<"getCliUsage">;
      return `${plural(usage.totals.requests, "request")} costing ${usd(usage.totals.cost_usd)} across ${plural(usage.apps.length, "app")} in ${usage.month}.`;
    },
  },
  tool({
    name: "get_usage_breakdown",
    title: "Get an app's usage by dimension",
    description:
      "Returns an app's usage totals grouped by one dimension — model, provider, user, status, route, endpoint and others — over a day range, largest first. Use it to find what drives an app's cost or errors.",
    operation: "getAppUsageBreakdown",
    summary: (result) =>
      `${plural(result.rows.length, "row")} by ${result.by} for ${result.app_id} from ${result.from} to ${result.to}.`,
  }),
  tool({
    name: "get_usage_timeseries",
    title: "Get an app's usage per day",
    description:
      "Returns an app's usage per day and provider over a day range: requests, tokens, cost and errors. Use it to see when a change in traffic or cost began.",
    operation: "getAppUsageTimeseries",
    summary: (result) =>
      `${plural(result.buckets.length, "daily bucket")} for ${result.app_id} from ${result.from} to ${result.to}.`,
  }),
  tool({
    name: "get_operation",
    title: "Get an operation",
    description:
      "Returns where an operation a change tool opened stands: pending with when it lapses, completed with what it created or changed, or expired (with denied when a person declined it). Use it after giving a person a URL to see when they have finished, and to inspect an operation a notice names before creating another. It never returns a key or a secret: when a key the operation created can still be revealed, reveal_url is the page a person opens to see it once.",
    operation: "getOperation",
    // Where a completed create reports the key it made, without its value.
    keyMetadataAt: [["result", "api_key"]],
    input: operationInput("getOperation", {
      id: z.string().min(1).meta({ description: "The operation's id: the id the tool that opened it answered, never a reservation's handle." }),
    }),
    summary: (result) => {
      const declined = result.denied ? ": a person declined it" : "";
      const standing = result.state === "pending" ? ` It lapses at ${result.expiresAt}.` : "";
      const reveal = result.reveal_url === undefined
        ? ""
        : ` A person signed in as an owner or admin reveals the key it created once at ${result.reveal_url}.`;
      return `Operation ${result.id} (${result.kind}) is ${result.state}${declined}.${standing}${reveal}`;
    },
  }),
  browserTool({
    name: "add_provider",
    title: "Add a provider",
    description:
      "Opens adding a provider credential, such as an OpenAI key, and answers a URL. A person opens it in their browser, enters the key there and approves; the key never passes through you, and an argument carrying one is refused. Takes the provider's type, name, slug and the rest of what list_providers shows, or providerGatewayId to route it through a provider gateway, in which case the person only approves. Call get_operation with the answer's id until it completes. Answers a notice when an identical request was made in the last hour.",
    kind: "provider.add",
    input: HandoffProviderAddPayloadSchema,
    payload: (input) => input,
    asking: (input) => `add the ${String(input.type)} provider "${String(input.name ?? input.type)}"`,
  }),
  browserTool({
    name: "add_provider_gateway",
    title: "Add a provider gateway",
    description:
      "Opens adding a reusable provider gateway, such as a Cloudflare AI Gateway several providers route through, and answers a URL. A person opens it in their browser, enters the gateway's token there and approves; the token never passes through you, and an argument carrying one is refused. Call get_operation with the answer's id until it completes.",
    kind: "provider-gateway.add",
    input: z.object({
      gateway: HandoffProviderGatewayAddPayloadSchema.meta({
        description: "The gateway: its type, its name and the connection fields its type needs, without its token.",
      }),
    }),
    payload: (input) => input.gateway,
    wrapped: ["gateway"],
    asking: (input) => `add the provider gateway "${String((input.gateway as { name?: unknown } | undefined)?.name)}"`,
  }),
  {
    name: "update_provider",
    title: "Update a provider",
    description:
      "Changes a provider's non-secret fields: its name, routing, custom pricing, or status (\"disabled\" pauses it reversibly; prefer that to removing it). Send the revision list_providers returned; a provider changed since is refused rather than overwritten. A key is never an argument: rotate_provider_key changes it, through a browser.",
    operation: "updateProvider",
    input: z.object({ ...HandoffProviderUpdatePayloadSchema.shape, id: PROVIDER_ID }),
    annotations: writing("update_provider", "updateProvider", { destructive: false, idempotent: true }),
    next: {
      conflict: "The provider changed since you read it. Call list_providers for its current revision and call update_provider again.",
    },
    call: (input) => {
      const { id, ...body } = input;
      return withCheck(operationCall("updateProvider", { id }, body), () =>
        refuseSecret(input, "rotate_provider_key"));
    },
    summary: (result) => {
      const { provider } = result as OperationResponse<"updateProvider">;
      return `Provider ${provider.slug} (${provider.id}) is updated and ${provider.status}.`;
    },
  },
  {
    name: "update_provider_gateway",
    title: "Rename a provider gateway",
    description:
      "Renames a provider gateway. Send the revision list_provider_gateways returned; a gateway changed since is refused rather than overwritten. Its token is changed with rotate_provider_gateway_key, through a browser.",
    operation: "updateProviderGateway",
    input: z.object({ id: GATEWAY_ID }).extend(ProviderGatewayUpdateRequestSchema.shape),
    annotations: writing("update_provider_gateway", "updateProviderGateway", { destructive: false, idempotent: true }),
    next: {
      conflict: "The gateway changed since you read it. Call list_provider_gateways for its current revision and call update_provider_gateway again.",
    },
    call: (input) => {
      const { id, ...body } = input;
      return withCheck(operationCall("updateProviderGateway", { id }, body), () =>
        refuseSecret(input, "rotate_provider_gateway_key"));
    },
    summary: (result) => {
      const { gateway } = result as OperationResponse<"updateProviderGateway">;
      return `Provider gateway ${gateway.id} is now named "${gateway.name}".`;
    },
  },
  browserTool({
    name: "rotate_provider_key",
    title: "Rotate a provider's key",
    description:
      "Opens replacing a provider's key and answers a URL. A person opens it in their browser, enters the new key there and approves; the key never passes through you. Send the provider's id and the revision list_providers returned. Call get_operation with the answer's id until it completes.",
    kind: "provider.rotate-key",
    input: z.object({ ...HandoffRotatePayloadSchema.shape, id: PROVIDER_ID }),
    payload: (input) => input,
    asking: (input) => `replace the key of provider ${String(input.id)}`,
  }),
  browserTool({
    name: "rotate_provider_gateway_key",
    title: "Rotate a provider gateway's token",
    description:
      "Opens replacing a provider gateway's token and answers a URL. A person opens it in their browser, enters the new token there and approves; the token never passes through you. Send the gateway's id and the revision list_provider_gateways returned. Call get_operation with the answer's id until it completes.",
    kind: "provider-gateway.rotate-key",
    input: z.object({ ...HandoffRotatePayloadSchema.shape, id: GATEWAY_ID }),
    payload: (input) => input,
    asking: (input) => `replace the token of provider gateway ${String(input.id)}`,
  }),
  tool({
    name: "remove_provider",
    title: "Remove a provider",
    description:
      "Deletes a provider and its key and custom pricing, for good: apps that use it start failing within a minute. Only when the person asked for the deletion; update_provider with status \"disabled\" pauses one reversibly. Pass the provider's id twice, as id and as confirm; without confirm nothing is deleted.",
    operation: "deleteProvider",
    input: operationInput("deleteProvider", { id: PROVIDER_ID }).extend({ confirm: CONFIRM_ARGUMENT }),
    effect: { destructive: true, idempotent: true },
    check: confirmed("provider"),
    summary: (result) => `Provider ${result.provider_id} is deleted, with its key and pricing.`,
  }),
  tool({
    name: "remove_provider_gateway",
    title: "Remove a provider gateway",
    description:
      "Deletes a provider gateway no provider uses any more, token included. Refused with gateway_in_use while a provider, disabled ones included, still routes through it. Pass the gateway's id twice, as id and as confirm; without confirm nothing is deleted.",
    operation: "deleteProviderGateway",
    input: operationInput("deleteProviderGateway", { id: GATEWAY_ID }).extend({ confirm: CONFIRM_ARGUMENT }),
    effect: { destructive: true, idempotent: true },
    check: confirmed("provider gateway"),
    next: {
      gateway_in_use: "Move or remove the providers that route through it first; list_providers shows them.",
    },
    summary: (result) => `Provider gateway ${result.provider_gateway_id} is deleted.`,
  }),
  reservationTool({
    name: "add_app",
    title: "Create an app",
    description:
      "Creates an app from a document {name, config, status?}, the same one validate_app judges: call validate_app first. Two calls: without handle it checks the document and reserves the creation, creating nothing; with the same config and the answer's handle it creates the app, once — repeating that call answers the same app again rather than creating another. The gateway assigns the app's id. A server app's key is never in the answer: reveal_url names the page where a person signed in as an owner or admin sees it once.",
    kind: "app.add",
    input: z.object({
      config: CATALOG.createApp.request.meta({
        description: "The app document: {name, config, status?}, exactly the body validate_app takes for a new app.",
      }),
      handle: RESERVATION_ARGUMENT,
    }),
    payload: (input) => input.config,
    reserving: (input) => `creating the app "${String((input.config as { name?: unknown } | undefined)?.name)}"`,
    created: (result) => `Created app ${appName(result)}.`,
  }),
  {
    name: "update_app",
    title: "Update an app",
    description:
      "Replaces an app's whole document {name, config, status?} with the one given, which carries the revision get_app returned: start from get_app's document, change it, check it with validate_app, then send it. A document read before someone else changed the app is refused with app_revision_conflict rather than overwriting their change. Setting status to \"disabled\" pauses an app reversibly.",
    operation: "updateApp",
    input: z.object({
      app: PATH_ARGUMENTS.app!,
      config: CATALOG.updateApp.request.meta({
        description: "The whole app document {name, config, status?, revision}, as get_app returns it without its id.",
      }),
    }),
    annotations: writing("update_app", "updateApp", { destructive: false, idempotent: true }),
    next: {
      app_revision_conflict: "Someone changed the app since you read it. Call get_app for its current document and revision, reapply your change and call update_app again.",
      app_revision_required: "Send the revision get_app returned inside config.",
    },
    call: (input) => withCheck(operationCall("updateApp", { app: input.app }, input.config), () => refuseAppCredential(input)),
    summary: (result) => {
      const { app } = result as OperationResponse<"updateApp">;
      return `App "${app.name}" (${app.id}) is ${app.status}, now at revision ${app.revision}. Changes reach live traffic within a minute.`;
    },
  },
  tool({
    name: "remove_app",
    title: "Remove an app",
    description:
      "Deletes an app for good, with its keys and its end users; its usage history is kept. Only when the person asked for the deletion; update_app with status \"disabled\" pauses one reversibly. Pass the app's id twice, as app and as confirm; without confirm nothing is deleted.",
    operation: "deleteApp",
    input: operationInput("deleteApp").extend({ confirm: CONFIRM_ARGUMENT }),
    effect: { destructive: true, idempotent: true },
    next: {
      invalid_request: "Pass the app's id as confirm, exactly as app; nothing was deleted.",
    },
    summary: (result) =>
      `App ${result.app_id} is deleted, with ${plural(result.removed_users, "end user")}. Its usage history is kept.`,
  }),
  reservationTool({
    name: "add_app_key",
    title: "Create an app key",
    description:
      "Creates another API key for a server app. Two calls: without handle it reserves the key, creating nothing; with the same arguments and the answer's handle it creates it, once — repeating that call answers the same key again rather than creating another. The key's value is never in the answer: reveal_url names the page where a person signed in as an owner or admin sees it once.",
    kind: "app.key.add",
    input: z.object({
      app: PATH_ARGUMENTS.app!,
      name: CliAppKeyAddPayloadSchema.shape.name.meta({ description: "A name to tell the key apart by in list_app_keys." }),
      handle: RESERVATION_ARGUMENT,
    }),
    payload: ({ handle: _handle, ...payload }) => payload,
    reserving: (input) => `a key named "${String(input.name)}" for ${String(input.app)}`,
    created: (result) => {
      const key = result.api_key as { id?: string; name?: string } | undefined;
      return `Created key "${key?.name}" (${key?.id}).`;
    },
  }),
  tool({
    name: "revoke_app_key",
    title: "Revoke an app key",
    description:
      "Revokes one of a server app's keys: requests sending it are refused within a minute, and it cannot be restored. Revoking a key that already is answers the same.",
    operation: "revokeAppKey",
    effect: { destructive: true, idempotent: true },
    summary: (result) => `Key ${result.key.name} (${result.key.id}) of ${result.app_id} is ${result.key.status}.`,
  }),
  tool({
    name: "block_app_user",
    title: "Block an app user",
    description:
      "Blocks one end user of an app: the gateway refuses their requests until they are unblocked. Blocking a user who already is answers the same.",
    operation: "blockAppUser",
    effect: { destructive: true, idempotent: true },
    summary: (result) => `User ${result.user_id} of ${result.app_id} is ${result.blocked ? "blocked" : "not blocked"}.`,
  }),
  tool({
    name: "unblock_app_user",
    title: "Unblock an app user",
    description: "Lifts a block on one end user of an app, so their requests are served again.",
    operation: "unblockAppUser",
    effect: { destructive: false, idempotent: true },
    summary: (result) => `User ${result.user_id} of ${result.app_id} is ${result.blocked ? "blocked" : "not blocked"}.`,
  }),
  {
    name: "claim_account",
    title: "Start claiming the account",
    description:
      "Starts a person's claim of an account nobody owns yet, and answers a URL. The person who should own it opens it in their own browser, signs up or signs in there and approves; the account, its apps and providers and this connection stay as they are, and the account no longer expires. Never open the URL yourself or approve it. Call get_operation with the answer's id until it completes. Refused with conflict when a person already owns the account.",
    kind: "claim",
    input: z.object({}),
    annotations: OPENS_OPERATION,
    next: {
      conflict: "A person already owns this account; there is nothing to claim.",
    },
    perform: async (_input, caller) => {
      const auth = authenticated(caller);
      await authorizeKind(caller.scope, auth, operationKind("claim"));
      const token = newOperationToken();
      const { view, url } = await openClaim(
        caller.scope,
        auth.actor,
        auth.state,
        (await caller.scope.identity()).operations,
        { token, id: await operationId(token) },
      );
      if (url === null) throw new GatewayError(409, "conflict", "This claim can no longer be approved");
      return {
        id: view.id,
        url,
        expiresAt: view.expiresAt,
        next: "Give the URL to the person who should own this account, to open in their own browser before it lapses. Then call get_operation with this answer's id until it completes.",
      } satisfies OpenedOperationResult;
    },
    summary: (raw) => {
      const result = raw as OpenedOperationResult;
      return `Opened claim ${result.id}. The person who should own the account opens ${result.url} in their own browser before ${result.expiresAt} and approves; then call get_operation.`;
    },
  },
  {
    name: "contact_support",
    title: "Contact human support",
    description:
      "Emails the gateway's human support team on the person's behalf: a bug report, a question, or feedback. Only when the person asked you to contact support. First show them the exact message you will send and wait for their yes; send it in their words, as plainly as they would. Support replies to the person's own email address, never to you. Put what helps support act in context — app id, request id, error code, what was tried — and never a key, token or password: a message carrying one is refused. Sending the same message again within ten minutes sends nothing new and answers the first reference. Not for questions you can answer with the other tools or the guide.",
    operation: "sendSupportMessage",
    input: z.object({
      kind: SupportMessageRequestSchema.shape.kind.meta({
        description: "bug for something that is broken, support for a question or a request for help, feedback for an idea or a missing feature.",
      }),
      message: SupportMessageRequestSchema.shape.message,
      context: SupportMessageRequestSchema.shape.context,
    }),
    // It reaches a person outside the gateway, and each call that is not a
    // repeat sends a new email; it removes nothing.
    annotations: {
      ...writing("contact_support", "sendSupportMessage", { destructive: false, idempotent: false }),
      openWorldHint: true,
    },
    available: (scope) => supportInbox(scope.env, scope.deployment) !== null,
    next: {
      support_plan_required: "Tell the person that human support is included with paid plans, and that an account owner can choose one on the Billing page of the console. Do not retry.",
      invalid_request: "Remove whatever looks like a credential, show the person the corrected message, and send it only once they agree.",
      not_found: "This deployment does not offer human support. Tell the person.",
      conflict: "The credential's owner has no email address for support to reply to. Ask the person to contact support from the console instead.",
      rate_limited: "Too many messages were sent. Tell the person, and do not retry until the wait the message names has passed.",
    },
    call: (input) => operationCall("sendSupportMessage", {}, {
      kind: input.kind,
      message: input.message,
      ...(input.context === undefined ? {} : { context: input.context }),
    }),
    summary: (raw) => {
      const result = raw as OperationResponse<"sendSupportMessage">;
      return result.duplicate
        ? `This message was already sent as ${result.reference} in the last ten minutes; nothing new was sent. Support will reply to ${result.replyTo} by email.`
        : `Sent to human support as ${result.reference}. Support will reply to ${result.replyTo} by email; tell the person the reference.`;
    },
  },
];

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * What an agent should do after a refusal, naming a tool or a browser step.
 * The gateway's message says what is wrong; this says what to do about it.
 */
const NEXT_ACTIONS: Partial<Record<ErrorCode, string>> = {
  app_not_found: "Call list_apps for the ids of your apps.",
  provider_not_found: "Call list_providers for the ids and slugs of your providers.",
  endpoint_not_found: "Call get_app to see the app's custom endpoints.",
  invalid_request: "Correct the arguments as the message says and call the tool again.",
  validation_error: "Correct the arguments as the message says and call the tool again.",
  unsupported_snippet: "Ask for the other language: swift for an App Attest app, curl for a server app.",
  provider_unavailable: "Call check_app to see which providers the app can reach.",
  grant_insufficient: "This credential has the read grant. A change needs a management key with the manage grant, or a connection a person allowed with the manage grant.",
  forbidden: "Your role in this account does not allow this. Ask an owner or admin of the account.",
  session_required: "This needs a person signed in to the console. Ask them to do it there, in a browser.",
  auth_required: "Reconnect with a valid management key.",
  unclaimed_access_expired: "Call claim_account and give a person the URL to open in their browser; claiming lifts the limit.",
  account_expired: "This account passed its recovery deadline and can no longer be used.",
  email_unverified: "Ask the account's owner to open the link in the verification email sent to their address, or to send a new one from the console. Requests are served once they do; nothing needs to be reconfigured.",
  rate_limited: "Wait a minute and call the tool again.",
  service_unavailable: "The gateway's infrastructure failed for a moment; nothing about the call was wrong. Wait a few seconds and call the tool again. For a change, first read it back with the matching get or list tool: it may have landed.",
  not_found: "Check the id and call the matching list tool.",
  operation_not_found: "Check the id: get_operation takes the id a change tool answered with, and sees only your account's operations.",
  operation_expired: "It lapsed before it completed. Call the tool that opened it again to start a new one.",
  operation_mismatch: "Call the tool again without handle to reserve these arguments.",
  already_completed: "Call get_operation with its id to see what it did.",
  conflict: "Something changed while the call ran. Read it again with the matching get or list tool and retry with what it returns.",
  app_revision_conflict: "Call get_app for the current document and revision, reapply your change and call update_app again.",
  app_revision_required: "Send the revision get_app returned.",
  billing_plan_limit_reached: "The account cannot hold more of these. Remove one it no longer needs, or ask the person.",
  slug_taken: "Choose another slug; list_providers shows the ones in use.",
  gateway_in_use: "Move or remove the providers that route through it first; list_providers shows them.",
};

export function nextAction(code: ErrorCode): string {
  return NEXT_ACTIONS[code] ?? "Read the message; call get_account to check the account's standing if it is unclear.";
}
