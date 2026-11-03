import type { CallToolResult, McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";
import {
  clientOf,
  endingOf,
  knownClient,
  recordManagementCall,
  refusalOf,
  versionOf,
  type CallEnding,
} from "../analytics/management";
import { asGatewayAuthError, isCfAuthError } from "../auth/identity";
import { GatewayError } from "../core/errors";
import { asGatewayError } from "../core/platform-errors";
import { errorFacts } from "../core/error-facts";
import { log } from "../core/log";
import { requestIdOf } from "../core/request-id";
import { SERVER_VERSION } from "../core/version";
import {
  runOperation,
  type OperationCaller,
  type OperationRequest,
} from "../management/executor";
import { OPERATION_HANDLERS } from "../management/handlers";
import { MCP_GUIDE, MCP_GUIDE_URI, MCP_INSTRUCTIONS } from "./guide";
import { redactSecrets } from "./secret-fields";
import { MCP_TOOLS, nextAction, type McpTool, type ToolOperation } from "./tools";

type Sdk = typeof import("@modelcontextprotocol/server");

/**
 * The MCP SDK, loaded on the first MCP request and shared by every one after
 * it in the isolate — the same deferral `cfAuth()` gives the identity library.
 *
 * This module is the only one that names the SDK, and it is itself reached only
 * through the lazily mounted MCP app, so neither the SDK nor the zod protocol
 * schemas it builds on evaluate on a proxied request's cold start. A rejection
 * is forgotten rather than pinned, for the reason `cfAuth()` forgets one.
 */
const mcpSdk = (): Promise<Sdk> => (loaded ??= import("@modelcontextprotocol/server").catch(forget));

let loaded: Promise<Sdk> | undefined;

function forget(error: unknown): never {
  loaded = undefined;
  throw error;
}

/**
 * Discovery is the same for everyone — the tool table and the guide do not
 * depend on who asks — so a client, and any cache between, may keep it a day.
 * Authorization is enforced when a tool runs, never by hiding one.
 */
const PUBLIC_DAY = { ttlMs: 86_400_000, cacheScope: "public" } as const;

/**
 * Serves one MCP request for one authenticated caller.
 *
 * Stateless by construction: a fresh server per request, no session, nothing a
 * later request could find. 2026-07-28 requests are answered as JSON; a
 * 2025-era client is served by the SDK's stateless legacy fallback from the
 * same factory, which also answers `GET` and `DELETE` — the old session
 * operations — with `405`.
 *
 * The caller reaches the factory as the request's `authInfo`, which the SDK
 * passes through untouched and never derives from a header.
 */
export async function serveMcp(request: Request, caller: OperationCaller): Promise<Response> {
  const mcp = await mcpHandler();
  return mcp.fetch(request, {
    authInfo: {
      // Never the credential itself: nothing reads this but the SDK's own
      // bearer helpers, which this endpoint does not use.
      token: "",
      clientId: caller.auth?.actor.credentialId ?? "",
      scopes: caller.auth ? [caller.auth.actor.grant] : [],
      extra: {
        caller,
        request: {
          userAgent: request.headers.get("user-agent") ?? undefined,
          requestId: requestIdOf(request.headers.get("cf-ray")),
        } satisfies McpRequest,
      },
    },
  });
}

type McpHttpHandler = ReturnType<Sdk["createMcpHandler"]>;

/**
 * One handler per isolate, since nothing in it belongs to a request: the
 * factory builds each request's server from the caller it is handed.
 *
 * No event bus is supplied, and `maxSubscriptions: 0` refuses every
 * `subscriptions/listen` in-band before it opens a stream: nothing here ever
 * publishes a change, so a stream held open would only hold the Worker. A
 * failed build is forgotten, as a failed SDK load is.
 */
const mcpHandler = (): Promise<McpHttpHandler> =>
  (handler ??= mcpSdk().then((sdk) =>
    sdk.createMcpHandler((context) => mcpServer(sdk, callerOf(context.authInfo?.extra), requestOf(context.authInfo?.extra)), {
      legacy: "stateless",
      responseMode: "json",
      maxSubscriptions: 0,
      // Reporting only: what the SDK refused, it has already answered.
      onerror: (error) => log("warn", "mcp_request_rejected", { error: errorFacts(error) }),
    })).catch((error: unknown) => {
      handler = undefined;
      throw error;
    }));

let handler: Promise<McpHttpHandler> | undefined;


function callerOf(extra: Record<string, unknown> | undefined): OperationCaller {
  const caller = extra?.caller as OperationCaller | undefined;
  // `serveMcp` is the only way in, and it always passes one.
  if (!caller) throw new Error("An MCP server was built without its caller");
  return caller;
}

/** What a tool call's analytics and log lines need of the HTTP request that carried it. */
interface McpRequest {
  userAgent: string | undefined;
  /** Cloudflare's id for the request, which the call's log lines and data point both carry. */
  requestId: string | null;
}

function requestOf(extra: Record<string, unknown> | undefined): McpRequest {
  // `serveMcp` is the only way in, and it always passes one.
  return (extra?.request as McpRequest | undefined) ?? { userAgent: undefined, requestId: null };
}

function mcpServer(sdk: Sdk, caller: OperationCaller, request: McpRequest): McpServer {
  const server = new sdk.McpServer(
    { name: "app-ai-gateway", version: SERVER_VERSION },
    {
      instructions: MCP_INSTRUCTIONS,
      // The table is fixed for the life of a deployment and nothing publishes
      // a change to it, so no change notification is offered.
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      cacheHints: {
        "tools/list": PUBLIC_DAY,
        "resources/list": PUBLIC_DAY,
        "resources/read": PUBLIC_DAY,
      },
    },
  );
  for (const tool of MCP_TOOLS) {
    if (tool.available && !tool.available(caller.scope)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: advertised(tool.input),
        annotations: tool.annotations,
      },
      (input, ctx) => callTool(tool, input, caller, toolClient(ctx.mcpReq.envelope, request.userAgent), request.requestId),
    );
  }
  server.registerResource(
    "guide",
    MCP_GUIDE_URI,
    {
      title: "How to work with this gateway over MCP",
      description: "The rules, the tools and the workflows, in full. Read it before changing anything.",
      mimeType: "text/markdown",
      cacheHint: PUBLIC_DAY,
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: MCP_GUIDE }] }),
  );
  return server;
}

/**
 * A tool's input schema as the SDK takes one, for discovery only.
 *
 * The SDK publishes `~standard.jsonSchema` in `tools/list` and runs
 * `~standard.validate` on every call's arguments before the tool does. The
 * first is the zod schema's own; the second hands the arguments over as they
 * were sent. Judging them is the executor's, after it has found the
 * application and applied the policy — the order an HTTP request is refused
 * in — and in the words `schemaIssueMessage` gives every refusal, with the
 * structured result an agent reads. Were the SDK to judge them first, a call
 * naming another account's app with a bad argument would be told about the
 * argument, in the SDK's words and with nothing structured.
 */
function advertised(schema: z.ZodObject): StandardSchemaWithJSON<Record<string, unknown>> {
  return {
    "~standard": {
      version: 1,
      vendor: "app-ai-gateway",
      jsonSchema: schema["~standard"].jsonSchema,
      // The protocol already requires `arguments` to be an object; anything
      // else is the empty one, which the operation then refuses as it would.
      validate: (value) => ({
        value: value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {},
      }),
    },
  };
}

/**
 * Runs one tool call as its catalog operation, or as the engine operation it
 * opens.
 *
 * The arguments arrive as the client sent them. The executor parses them with
 * the operation's own schemas, exactly as it parses a request from the API,
 * after it has resolved the application and applied the operation's policy to
 * the caller; an argument no operation schema covers is checked by the tool's
 * `before`, at the same point. A tool that opens an engine operation hands
 * them to the management function for it, which applies the kind's authority
 * first in the same way. The callback itself parses nothing.
 *
 * A refusal is an answer, not a failure of the protocol: a gateway error
 * becomes a tool result marked as an error, carrying its code, its message and
 * what to do next. Only the bearer gate answers with an HTTP status.
 */
async function callTool(
  tool: McpTool,
  input: Record<string, unknown>,
  caller: OperationCaller,
  client: ToolClient,
  requestId: string | null,
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const body = tool.perform ? await tool.perform(input, caller) : await call(tool, input, caller);
    // Redacted before the summary is written from it: what a tool answers may
    // have been stored by any transport, and an app document stored through
    // the API may hold provider-native parameters of any name.
    const result = redactSecrets(tool.result ? tool.result(body, input) : body, tool.keyMetadataAt);
    const answer: CallToolResult = {
      content: [{ type: "text", text: tool.summary(result, redactSecrets(input)) }],
      structuredContent: result as Record<string, unknown>,
    };
    recordToolCall(tool, caller, client, requestId, started, endingOf(200));
    return answer;
  } catch (error) {
    // A platform failure is refused like any gateway error, so the caller is
    // told to retry rather than that the gateway broke.
    const refusal = isCfAuthError(error) ? asGatewayAuthError(error) : asGatewayError(error) ?? error;
    recordToolCall(tool, caller, client, requestId, started, refusalOf(refusal));
    if (refusal instanceof GatewayError) return refused(tool, caller, refusal, requestId);
    // Answered with nothing of it, and logged with nothing of it either: a
    // failure's message can carry what the call sent — a database error
    // quotes its bound parameters — so only what kind of failure it was is
    // logged, beside where it happened.
    log("error", "unhandled_error", {
      path: "/mcp",
      method: "POST",
      tool: tool.name,
      source: actionSource(caller),
      ray: requestId ?? undefined,
      error: errorFacts(error),
    });
    return {
      isError: true,
      content: [{ type: "text", text: "internal_error: The gateway failed to answer this call. Try again later." }],
      structuredContent: {
        error: "internal_error",
        message: "Internal server error",
        status: 500,
        next: "Try again later; the failure was the gateway's, not the call's.",
      },
    };
  }
}

/** Who is calling a tool, as the client names itself. */
interface ToolClient {
  name: string | null;
  version: string | null;
}

/**
 * The client's own name and version: what a 2026-07-28 client declares in each
 * request's envelope, else the name its `user-agent` gives, since a 2025-era
 * client declared one only in an `initialize` this stateless server never
 * keeps. Either is labelled by `knownClient`, never copied.
 */
function toolClient(envelope: object | undefined, userAgent: string | undefined): ToolClient {
  const info = (envelope as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientInfo"];
  const declared = info !== null && typeof info === "object" ? (info as Record<string, unknown>) : {};
  const name = typeof declared.name === "string" ? knownClient(declared.name) : null;
  return {
    name: name ?? clientOf(userAgent),
    // A version means something only beside a client this gateway knows.
    version: name !== null && name !== "other" && typeof declared.version === "string"
      ? versionOf(declared.version)
      : null,
  };
}

/** One tool call's data point, where the deployment records management calls. */
function recordToolCall(
  tool: McpTool,
  caller: OperationCaller,
  client: ToolClient,
  requestId: string | null,
  started: number,
  ending: CallEnding,
): void {
  const actor = caller.auth?.actor;
  recordManagementCall(caller.scope.env, {
    accountId: actor?.organizationId ?? null,
    channel: "mcp",
    credential: actor?.credentialType ?? "none",
    identity: actor?.identityKind ?? null,
    // A dual tool chooses between two by its arguments; its name says which.
    operation: typeof tool.operation === "string" ? tool.operation : null,
    tool: tool.name,
    kind: tool.kind ?? null,
    ...ending,
    client: client.name,
    clientVersion: client.version,
    requestId,
    durationMs: Date.now() - started,
  });
}

function call(tool: McpTool, input: Record<string, unknown>, caller: OperationCaller): Promise<unknown> {
  if (!tool.call) throw new Error(`MCP tool ${tool.name} has neither an operation nor a perform`);
  const { operation, request, before } = tool.call(input);
  return run(operation, request as never, caller, before);
}

/** One operation, run with its own registered handler and the tool's own check. */
function run<K extends ToolOperation>(
  operation: K,
  request: OperationRequest<K>,
  caller: OperationCaller,
  before: (() => void) | undefined,
): Promise<unknown> {
  return runOperation(operation, caller, request, OPERATION_HANDLERS[operation], before ? { before } : {});
}

/**
 * Where the call came from, as cf-auth resolved the credential: `mcp`, which
 * the bearer gate asked for because this is the MCP endpoint. Read from the
 * state rather than written here, so a log line says what the authorization
 * actually carried.
 */
function actionSource(caller: OperationCaller): string | undefined {
  return caller.auth?.state.source ?? undefined;
}

/**
 * A business refusal as a tool result, logged as the entry module logs one it
 * answers over HTTP — code, status and where, never a body — plus the tool and
 * the credential's action source, and never an argument.
 */
function refused(
  tool: McpTool,
  caller: OperationCaller,
  error: GatewayError,
  requestId: string | null,
): CallToolResult {
  log(error.status >= 500 ? "error" : "warn", "gateway_error", {
    code: error.code,
    reason: error.reason,
    status: error.status,
    path: "/mcp",
    method: "POST",
    tool: tool.name,
    // Nothing the caller sent: an argument may be a secret the tool has just
    // refused, wherever the caller put it, so a refusal is logged by its code
    // and the tool alone.
    source: actionSource(caller),
    ray: requestId ?? undefined,
  });
  const next = tool.next?.[error.code] ?? nextAction(error.code);
  const message = error.message.replace(/[.\s]+$/u, "");
  return {
    isError: true,
    content: [{ type: "text", text: `${error.code}: ${message}. ${next}` }],
    structuredContent: {
      error: error.code,
      message: error.message,
      status: error.status,
      next,
      ...(error.data === undefined ? {} : { data: redactSecrets(error.data) }),
    },
  };
}
