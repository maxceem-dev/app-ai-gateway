import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CfAuth, CredentialGrant } from "@maxceem/cf-auth";
import worker from "../src/index";
import { hashApiKey } from "../src/client-auth/api-keys";
import { SERVER_VERSION } from "../src/core/version";
import { authenticateMcp } from "../src/mcp/auth";
import { CATALOG } from "../src/contracts/catalog";
import { operationPolicy } from "../src/management/executor";
import { OPERATION_HANDLERS } from "../src/management/handlers";
import { MCP_TOOLS, MCP_WRITE_OPERATIONS, type ToolOperation } from "../src/mcp/tools";
import { resolveDeployment } from "../src/policy/deployment";
import { TEST_MANAGEMENT_KEY } from "./apply-migrations";
import { seedHuman, seedProvider, seedServerApp, serverConfig, TEST_ORGANIZATION_ID } from "./helpers";

/**
 * The MCP endpoint: its handshake in both protocol eras, the bearer gate, the
 * host and origin rules, and every read tool run as its catalog operation.
 *
 * Driven with plain JSON-RPC requests through the Worker, the way a client
 * sends them, so what is tested is the wire rather than an SDK client's view
 * of it. Each test that needs an account makes its own.
 */

const ORIGIN = "https://example.test";
const BROWSER_ORIGIN = "https://inspector.example.test";
const MODERN = "2026-07-28";
const LEGACY = "2025-06-18";

/** A deployment with an identity, a separate API host, and one listed browser origin beside an invalid entry. */
const runtime = new Proxy(env, {
  get(target, key, receiver) {
    if (key === "DEPLOYMENT_ID") return "mcp-tests";
    if (key === "CLI_CONSOLE_ORIGIN") return ORIGIN;
    if (key === "PUBLIC_API_URL") return "https://api.example.test";
    if (key === "MCP_ALLOWED_ORIGINS") return `${BROWSER_ORIGIN}, not-an-origin, https://path.example.test/app`;
    return Reflect.get(target, key, receiver);
  },
});

/** What a 2026-07-28 client puts in every request's `_meta`. */
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "mcp-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface Sent {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

let nextId = 1;

async function send({ method = "POST", url = `${ORIGIN}/mcp`, headers = {}, body }: Sent): Promise<Response> {
  return worker.request(url, {
    method,
    headers: {
      accept: "application/json, text/event-stream",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, runtime);
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

/**
 * A 2026-07-28 request: the per-request envelope in `_meta`, and the headers
 * the revision requires beside it.
 */
function modern(method: string, params: Record<string, unknown> = {}, name?: string) {
  return {
    headers: {
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body: { jsonrpc: "2.0", id: nextId++, method, params: { ...params, _meta: ENVELOPE } },
  };
}

interface RpcAnswer {
  status: number;
  headers: Headers;
  // The JSON-RPC message, whichever way it was framed.
  message: { result?: any; error?: { code: number; message: string } };
}

/** Reads one JSON-RPC answer, from a JSON body or the single event of a legacy stream. */
async function answer(response: Response): Promise<RpcAnswer> {
  const text = await response.text();
  const data = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").find((line) => line.startsWith("data: "))!.slice(6)
    : text;
  return { status: response.status, headers: response.headers, message: JSON.parse(data) };
}

async function rpc(key: string, method: string, params: Record<string, unknown> = {}, name?: string, headers: Record<string, string> = {}) {
  const request = modern(method, params, name);
  return answer(await send({ headers: { ...bearer(key), ...request.headers, ...headers }, body: request.body }));
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent: any;
}

async function callTool(key: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const { status, message } = await rpc(key, "tools/call", { name, arguments: args }, name);
  expect(status, JSON.stringify(message)).toBe(200);
  expect(message.error, JSON.stringify(message.error)).toBeUndefined();
  return message.result as ToolResult;
}

/** A person with an account of their own, and a management key they made for it in the console. */
async function account(email: string, grant: CredentialGrant = "manage") {
  const human = await seedHuman(email);
  const created = await send({
    url: `${ORIGIN}/v1/admin/keys`,
    headers: { cookie: human.cookie, "x-console-request": "1" },
    body: { name: "MCP", grant },
  });
  expect(created.status).toBe(201);
  const { key } = await created.json<{ key: { plaintext: string } }>();
  return { ...human, key: key.plaintext };
}

/** An account with a provider, a server app naming it, and one end user. */
async function populated(email: string) {
  const owner = await account(email);
  const read = await issueKey(owner.cookie, "read");
  const suffix = email.split("@")[0]!.replace(/[^a-z0-9]/gu, "");
  const app = `mcp-${suffix}`;
  await seedProvider({ type: "openai", organizationId: owner.organizationId, id: `${app}-openai`, secret: `sk-${suffix}-plaintext-secret` });
  const appKey = await seedServerApp(app, {
    organizationId: owner.organizationId,
    proxy: { openai: { allowed_paths: [], allowed_models: [] } },
  });
  await env.DB.prepare("INSERT INTO app_user(app_id, id, status) VALUES (?, 'mcp-user', 'active')").bind(app).run();
  return { ...owner, read, app, appKey, providerSecret: `sk-${suffix}-plaintext-secret` };
}

async function issueKey(cookie: string, grant: CredentialGrant): Promise<string> {
  const created = await send({
    url: `${ORIGIN}/v1/admin/keys`,
    headers: { cookie, "x-console-request": "1" },
    body: { name: `MCP ${grant}`, grant },
  });
  expect(created.status).toBe(201);
  return (await created.json<{ key: { plaintext: string } }>()).key.plaintext;
}

/** The design's read tools, in its order. */
const READ_TOOL_NAMES = [
  "get_account",
  "get_capabilities",
  "list_models",
  "list_providers",
  "get_provider",
  "list_provider_gateways",
  "list_apps",
  "get_app",
  "validate_app",
  "check_app",
  "get_app_snippet",
  "list_app_keys",
  "list_app_users",
  "get_app_user",
  "list_app_events",
  "list_auth_events",
  "get_auth_event_summary",
  "list_rejection_events",
  "get_usage",
  "get_usage_breakdown",
  "get_usage_timeseries",
];

/** The design's change tools, in its order, after the reads. */
const CHANGE_TOOL_NAMES = [
  "get_operation",
  "add_provider",
  "add_provider_gateway",
  "update_provider",
  "update_provider_gateway",
  "rotate_provider_key",
  "rotate_provider_gateway_key",
  "remove_provider",
  "remove_provider_gateway",
  "add_app",
  "update_app",
  "remove_app",
  "add_app_key",
  "revoke_app_key",
  "block_app_user",
  "unblock_app_user",
  "claim_account",
  "contact_support",
];

/** The design's whole table, in its order. */
const TOOL_NAMES = [...READ_TOOL_NAMES, ...CHANGE_TOOL_NAMES];

/**
 * What a deployment without human support lists: the table less
 * contact_support, which `test/support.test.ts` lists where it is offered.
 */
const LISTED_TOOL_NAMES = TOOL_NAMES.filter((name) => name !== "contact_support");

/** Arguments every tool succeeds with, in an account made by {@link populated}. */
function argumentsFor(app: string): Record<string, Record<string, unknown>> {
  return {
    get_account: {},
    get_capabilities: {},
    list_models: {},
    list_providers: {},
    get_provider: { provider: "openai" },
    list_provider_gateways: {},
    list_apps: {},
    get_app: { app },
    validate_app: {
      app,
      config: { name: "Renamed", config: serverConfig({ proxy: { openai: { allowed_paths: [], allowed_models: [] } } }) },
    },
    check_app: { app },
    get_app_snippet: { app },
    list_app_keys: { app },
    list_app_users: { app },
    get_app_user: { app, user: "mcp-user" },
    list_app_events: { app, limit: 10 },
    list_auth_events: { app },
    get_auth_event_summary: { app, days: 7 },
    list_rejection_events: { app },
    get_usage: {},
    get_usage_breakdown: { app, by: "provider" },
    get_usage_timeseries: { app },
  };
}

/** Every key of every object in a value, however deep. */
function fieldNames(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) fieldNames(item, into);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      fieldNames(item, into);
    }
  }
  return into;
}

/** A field that would carry a secret rather than a hint of one. */
const SECRET_FIELD = /^(secret|secretBlob|secret_blob|key|key_hash|keyHash|token|token_hash|tokenHash|plaintext|password|apiKey|api_key)$/iu;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP tool table", () => {
  it("names only registered operations a read grant may run, and the design's writes", () => {
    for (const tool of MCP_TOOLS) {
      const operations = tool.operation === undefined
        ? []
        : typeof tool.operation === "string" ? [tool.operation] : tool.operation;
      // Every tool runs a catalog operation or opens one of the engine's kinds.
      expect(operations.length > 0 || tool.kind !== undefined, tool.name).toBe(true);
      for (const operation of operations) {
        expect(Object.keys(OPERATION_HANDLERS), tool.name).toContain(operation);
        if (tool.annotations.readOnlyHint) {
          expect(operationPolicy(CATALOG[operation]).grant, tool.name).toBe("read");
        } else {
          expect(MCP_WRITE_OPERATIONS as readonly string[], tool.name).toContain(operation);
        }
      }
    }
    // Every exposed write is some tool's, and nothing more is exposed.
    const named = MCP_TOOLS.flatMap((tool) => tool.operation === undefined ? [] : [tool.operation].flat());
    expect([...MCP_WRITE_OPERATIONS].sort()).toEqual(
      named.filter((operation) => operationPolicy(CATALOG[operation]).grant !== "read").sort(),
    );
    // A writing operation outside the design's list is not a `ToolOperation`,
    // so a tool cannot name one.
    // @ts-expect-error createApp is not exposed
    const writes: ToolOperation = "createApp";
    expect(writes).toBe("createApp");
  });
});

describe("MCP handshake", () => {
  it("serves a 2025-era client through the stateless legacy fallback", async () => {
    const response = await send({
      headers: bearer(TEST_MANAGEMENT_KEY),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
      },
    });
    const { status, message } = await answer(response);
    expect(status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(message.result).toMatchObject({
      protocolVersion: LEGACY,
      serverInfo: { name: "app-ai-gateway", version: SERVER_VERSION },
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    });
    expect(message.result.instructions).toContain("claim_account");
    expect(message.result.instructions).toContain("get_operation");

    // No session was opened, so the next request needs none.
    const listed = await answer(await send({
      headers: { ...bearer(TEST_MANAGEMENT_KEY), "mcp-protocol-version": LEGACY },
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    }));
    expect(listed.message.result.tools.map((tool: { name: string }) => tool.name)).toEqual(LISTED_TOOL_NAMES);
  });

  it("answers an initialize naming 2026-07-28 with the legacy handshake, since that revision has none", async () => {
    // A 2026-07-28 client discovers with `server/discover`, below; `initialize`
    // is the 2025 handshake by definition, so the SDK serves it from the
    // legacy path and offers the newest revision that path speaks, as a
    // single-event stream: the legacy transport does not take `responseMode`.
    const response = await send({
      headers: bearer(TEST_MANAGEMENT_KEY),
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: MODERN, capabilities: {}, clientInfo: { name: "eager", version: "1" } },
      },
    });
    const { status, headers, message } = await answer(response);
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("text/event-stream");
    expect(headers.get("mcp-session-id")).toBeNull();
    expect(message.result.protocolVersion).toMatch(/^2025-/u);
    expect(message.result.serverInfo).toEqual({ name: "app-ai-gateway", version: SERVER_VERSION });
  });

  it("discovers the server on 2026-07-28 without a session, and advertises no subscription", async () => {
    const { status, headers, message } = await rpc(TEST_MANAGEMENT_KEY, "server/discover");
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("application/json");
    expect(message.result.supportedVersions).toContain(MODERN);
    expect(message.result.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
    });
    expect(message.result.instructions).toContain("agw://guide");
    expect(message.result._meta["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "app-ai-gateway",
      version: SERVER_VERSION,
    });
  });

  it("lists the tools in the fixed order, annotated by what they change, with a public day-long cache hint", async () => {
    const { message } = await rpc(TEST_MANAGEMENT_KEY, "tools/list");
    const tools = message.result.tools as { name: string; annotations: unknown; inputSchema: any }[];
    expect(tools.map((tool) => tool.name)).toEqual(LISTED_TOOL_NAMES);
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    const READS = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
    const effect = (destructive: boolean, idempotent: boolean) =>
      ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false });
    const expected: Record<string, unknown> = {
      ...Object.fromEntries(READ_TOOL_NAMES.map((name) => [name, READS])),
      get_operation: READS,
      add_provider: effect(false, false),
      add_provider_gateway: effect(false, false),
      update_provider: effect(false, true),
      update_provider_gateway: effect(false, true),
      rotate_provider_key: effect(false, false),
      rotate_provider_gateway_key: effect(false, false),
      remove_provider: effect(true, true),
      remove_provider_gateway: effect(true, true),
      add_app: effect(false, false),
      update_app: effect(false, true),
      remove_app: effect(true, true),
      add_app_key: effect(false, false),
      revoke_app_key: effect(true, true),
      block_app_user: effect(true, true),
      unblock_app_user: effect(false, true),
      claim_account: effect(false, false),
    };
    // It emails a person outside the gateway, which no other tool does.
    expect(MCP_TOOLS.find((tool) => tool.name === "contact_support")!.annotations).toEqual({
      ...effect(false, false),
      openWorldHint: true,
    });
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toEqual(expected[tool.name]);
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }
    expect(message.result).toMatchObject({ ttlMs: 86_400_000, cacheScope: "public" });
    // `app` is the argument every app tool takes, and the catalog's query fields ride beside it.
    const events = tools.find((tool) => tool.name === "list_app_events")!.inputSchema;
    expect(events.required).toEqual(["app"]);
    expect(Object.keys(events.properties)).toEqual(["app", "limit", "status", "provider", "user", "install", "model", "before_id"]);
    // validate_app advertises the catalog's app document, nested configuration included.
    const validate = tools.find((tool) => tool.name === "validate_app")!.inputSchema;
    expect(validate.required).toEqual(["config"]);
    // Named schemas are shared through `$defs`, as the OpenAPI document shares them.
    const resolve = (node: any): any =>
      typeof node?.$ref === "string" ? resolve(validate.$defs[node.$ref.replace("#/$defs/", "")]) : node;
    const document = resolve(validate.properties.config);
    expect(document.required).toEqual(["name", "config"]);
    expect(Object.keys(document.properties)).toEqual(["name", "config", "status"]);
    const configuration = resolve(document.properties.config);
    expect(configuration.required).toEqual(expect.arrayContaining(["authentication", "routing"]));
    expect(configuration.properties.authentication.oneOf.length).toBeGreaterThan(1);
    expect(resolve(configuration.properties.routing).properties).toHaveProperty("providers");
  });

  it("lists and reads the guide, with the same cache hint", async () => {
    const listed = await rpc(TEST_MANAGEMENT_KEY, "resources/list");
    expect(listed.message.result.resources).toEqual([
      expect.objectContaining({ uri: "agw://guide", name: "guide", mimeType: "text/markdown" }),
    ]);
    expect(listed.message.result).toMatchObject({ ttlMs: 86_400_000, cacheScope: "public" });

    const read = await rpc(TEST_MANAGEMENT_KEY, "resources/read", { uri: "agw://guide" }, "agw://guide");
    expect(read.message.result).toMatchObject({ ttlMs: 86_400_000, cacheScope: "public" });
    const [contents] = read.message.result.contents;
    expect(contents.uri).toBe("agw://guide");
    expect(contents.text).toContain("# Working with App AI Gateway over MCP");
    expect(contents.text).toContain("claim_account");
    expect(contents.text).not.toMatch(/organization|tenant|operator/iu);
  });

  it("refuses a subscription in-band rather than holding a stream open", async () => {
    const { status, headers, message } = await rpc(TEST_MANAGEMENT_KEY, "subscriptions/listen", {
      notifications: { toolsListChanged: true },
    });
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("application/json");
    expect(message.error?.code).toBe(-32603);
  });

  it("answers GET and DELETE, the old session operations, with 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await send({ method, headers: bearer(TEST_MANAGEMENT_KEY) });
      expect(response.status, method).toBe(405);
    }
  });
});

describe("MCP for a 2025-era client", () => {
  /** A legacy request: no envelope, the version only in its header, as a stateless 2025 client sends it. */
  async function legacy(key: string, message: Record<string, unknown>): Promise<Response> {
    return send({ headers: { ...bearer(key), "mcp-protocol-version": LEGACY }, body: { jsonrpc: "2.0", ...message } });
  }

  /** One answer, framed as the legacy transport frames it: a stream of one event that ends. */
  async function streamed(response: Response) {
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    // Resolves only once the stream has closed.
    const text = await response.text();
    const events = text.split("\n").filter((line) => line.startsWith("data: "));
    expect(events).toHaveLength(1);
    return JSON.parse(events[0]!.slice(6)) as { id: number; result?: any; error?: unknown };
  }

  it("acknowledges the initialized notification without a session", async () => {
    const response = await legacy(TEST_MANAGEMENT_KEY, { method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("runs a tool and answers its structured result", async () => {
    const fixture = await populated("mcp-legacy-call@example.test");
    const message = await streamed(await legacy(fixture.read, {
      id: 11,
      method: "tools/call",
      params: { name: "get_app", arguments: { app: fixture.app } },
    }));
    expect(message.id).toBe(11);
    expect(message.error).toBeUndefined();
    expect(message.result.isError).toBeFalsy();
    expect(message.result.content).toEqual([
      { type: "text", text: `App "Test ${fixture.app}" (${fixture.app}) is active, at revision 1.` },
    ]);
    expect(message.result.structuredContent.app).toMatchObject({ id: fixture.app, revision: 1, status: "active" });
  });

  it("answers a refusal as a tool error, not a protocol one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const message = await streamed(await legacy(TEST_MANAGEMENT_KEY, {
      id: 12,
      method: "tools/call",
      params: { name: "get_app", arguments: { app: "mcp-legacy-missing" } },
    }));
    expect(message.error).toBeUndefined();
    expect(message.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "app_not_found: App is not registered. Call list_apps for the ids of your apps." }],
      structuredContent: {
        error: "app_not_found",
        message: "App is not registered",
        status: 404,
        next: "Call list_apps for the ids of your apps.",
      },
    });
  });

  it("reads the guide", async () => {
    const message = await streamed(await legacy(TEST_MANAGEMENT_KEY, {
      id: 13,
      method: "resources/read",
      params: { uri: "agw://guide" },
    }));
    const [contents] = message.result.contents;
    expect(contents).toMatchObject({ uri: "agw://guide", mimeType: "text/markdown" });
    expect(contents.text).toContain("# Working with App AI Gateway over MCP");
  });
});

describe("MCP bearer gate", () => {
  async function refused(headers: Record<string, string>, challenge: string) {
    const request = modern("tools/list");
    const response = await send({ headers: { ...headers, ...request.headers }, body: request.body });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(challenge);
    const body = await response.json<{ jsonrpc: string; error: { code: number; message: string }; id: null }>();
    expect(body).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
  }

  // The deployment runs OAuth, so every challenge names the endpoint's own
  // protected resource metadata, which is where a client discovers it.
  const METADATA = `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`;
  const REALM = 'realm="management"';

  it("asks for a bearer token when there is none", async () => {
    await refused({}, `Bearer ${REALM}, ${METADATA}`);
  });

  it("never takes a console session, even with the console's own header", async () => {
    const human = await seedHuman("mcp-cookie@example.test");
    await refused({ cookie: human.cookie, "x-console-request": "1" }, `Bearer ${REALM}, ${METADATA}`);
  });

  it("refuses a token that is not a live management key", async () => {
    await refused(bearer("agw_mgmt_not-a-real-key"), `Bearer ${REALM}, error="invalid_token", ${METADATA}`);
    await refused(bearer("agw_0123456789abcdef"), `Bearer ${REALM}, error="invalid_token", ${METADATA}`);
    await refused(bearer("agw_oat_not-a-real-connection.token"), `Bearer ${REALM}, error="invalid_token", ${METADATA}`);
    await refused({ authorization: "Basic dXNlcjpwYXNz" }, `Bearer ${REALM}, ${METADATA}`);
  });

  it("takes the scheme in any case", async () => {
    const { status } = await rpc(TEST_MANAGEMENT_KEY, "tools/list", {}, undefined, {
      authorization: `bearer ${TEST_MANAGEMENT_KEY}`,
    });
    expect(status).toBe(200);
  });

  it("lets a read key and a manage key call every read tool", async () => {
    const fixture = await populated("mcp-every-tool@example.test");
    const args = argumentsFor(fixture.app);
    expect(Object.keys(args)).toEqual(READ_TOOL_NAMES);
    for (const key of [fixture.read, fixture.key]) {
      for (const name of READ_TOOL_NAMES) {
        const result = await callTool(key, name, args[name]);
        expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeFalsy();
        expect(result.content[0]!.type).toBe("text");
        expect(result.content[0]!.text.length, name).toBeGreaterThan(0);
        expect(result.structuredContent, name).toBeTypeOf("object");
      }
    }
  });
});

describe("MCP host and origin", () => {
  const listTools = (headers: Record<string, string>, url?: string) => {
    const request = modern("tools/list");
    return send({ url, headers: { ...bearer(TEST_MANAGEMENT_KEY), ...headers, ...request.headers }, body: request.body });
  };

  it("serves a client that sends no origin, and the console's own", async () => {
    for (const headers of [{}, { origin: ORIGIN }] as Record<string, string>[]) {
      const response = await listTools(headers);
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("answers a listed browser origin with CORS, its preflight and its refusals included", async () => {
    const cors = {
      "access-control-allow-origin": BROWSER_ORIGIN,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
      // So a browser client can read the challenge that says where to authorize.
      "access-control-expose-headers": "WWW-Authenticate",
      vary: "Origin",
    };
    const preflight = await send({
      method: "OPTIONS",
      headers: { origin: BROWSER_ORIGIN, "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    for (const [name, value] of Object.entries(cors)) expect(preflight.headers.get(name), name).toBe(value);

    const served = await listTools({ origin: BROWSER_ORIGIN });
    expect(served.status).toBe(200);
    for (const [name, value] of Object.entries(cors)) expect(served.headers.get(name), name).toBe(value);

    const request = modern("tools/list");
    const unauthenticated = await send({ headers: { origin: BROWSER_ORIGIN, ...request.headers }, body: request.body });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("access-control-allow-origin")).toBe(BROWSER_ORIGIN);
  });

  it("refuses any other origin, before asking who it is", async () => {
    for (const origin of ["https://evil.example.test", "null", "http://example.test", "https://example.test:8443"]) {
      const response = await listTools({ origin });
      expect(response.status, origin).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const preflight = await send({ method: "OPTIONS", headers: { origin } });
      expect(preflight.status, origin).toBe(403);
    }
  });

  it("drops an allowlist entry that is not an origin", () => {
    expect(resolveDeployment(runtime, `${ORIGIN}/mcp`).mcp.allowedOrigins).toEqual([BROWSER_ORIGIN]);
    expect(resolveDeployment(env, `${ORIGIN}/mcp`).mcp.allowedOrigins).toEqual([]);
  });

  it("normalises allowlist entries as a browser writes an origin, and drops wildcards, paths and credentials", () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entries = [
      "HTTPS://Upper.Example.TEST",
      "https://slash.example.test/",
      "https://port.example.test:8443",
      "https://default-port.example.test:443",
      "http://localhost:5173",
      "https://*.example.test",
      "https://wild*.example.test",
      "https://user:hunter2@credentials.example.test",
      "https://path.example.test/app",
      "https://query.example.test/?a=1",
      "http://plain.example.test",
      "https://user:hunter3@badport.example.test:99999",
      "https://user:hunter4@bad host.example.test",
    ];
    const listed = new Proxy(env, {
      get(target, key, receiver) {
        if (key === "MCP_ALLOWED_ORIGINS") return entries.join(",");
        return Reflect.get(target, key, receiver);
      },
    });
    expect(resolveDeployment(listed, `${ORIGIN}/mcp`).mcp.allowedOrigins).toEqual([
      "https://upper.example.test",
      "https://slash.example.test",
      "https://port.example.test:8443",
      "https://default-port.example.test",
      "http://localhost:5173",
    ]);
    const ignored = warnings.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((line) => line.message === "mcp_allowed_origin_ignored");
    // Each by its position and why, never by the entry, which may carry a password.
    expect(ignored.map((line) => line.position)).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
    expect(ignored.slice(-2).map((line) => line.reason)).toEqual(["not a URL", "not a URL"]);
    for (const line of ignored) expect(Object.keys(line)).not.toContain("entry");
    const logged = JSON.stringify(warnings.mock.calls);
    for (const secret of ["hunter2", "hunter3", "hunter4", "example.test"]) expect(logged).not.toContain(secret);
  });

  it("takes the request's own origin as the console's when CLI_CONSOLE_ORIGIN is unset", async () => {
    // The documented default the rest of the gateway shares: every host the
    // Worker answers on is then a console host, and only its own origin is
    // same-origin. A management key is still required either way.
    const unset = new Proxy(env, {
      get(target, key, receiver) {
        if (key === "CLI_CONSOLE_ORIGIN" || key === "PUBLIC_API_URL" || key === "MCP_ALLOWED_ORIGINS") return undefined;
        return Reflect.get(target, key, receiver);
      },
    });
    const alias = "https://alias.example.test";
    const request = (origin: string) => {
      const sent = modern("tools/list");
      return worker.request(`${alias}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          origin,
          ...bearer(TEST_MANAGEMENT_KEY),
          ...sent.headers,
        },
        body: JSON.stringify(sent.body),
      }, unset);
    };
    expect((await request(alias)).status).toBe(200);
    expect((await request(ORIGIN)).status).toBe(403);
  });

  it("is not there on any host but the console's", async () => {
    for (const url of ["https://other.example.test/mcp", "https://api.example.test/mcp"]) {
      const response = await listTools({}, url);
      expect(response.status, url).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "Route not found" } });
    }
  });
});

describe("MCP read tools", () => {
  it("reports a claimed account without asking for a claim", async () => {
    const owner = await account("mcp-claimed@example.test");
    const result = await callTool(owner.key, "get_account");
    expect(result.structuredContent.account).toMatchObject({ id: owner.organizationId, claimed: true, expiresAt: null });
    expect(result.content[0]!.text).not.toContain("claim_account");
  });

  it("tells an unclaimed account its deadlines and names claim_account", async () => {
    const accountId = `mcp-unclaimed-${crypto.randomUUID()}`;
    const userId = `service-${accountId}`;
    const token = `agw_mgmt_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    const createdAt = new Date(now - 86_400_000).toISOString();
    const expiresAt = new Date(now + 60 * 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mgmt_user(id, name, email, kind, email_verified, created_at, updated_at) VALUES (?, 'Service', NULL, 'service', 0, ?, ?)",
      ).bind(userId, now, now),
      env.DB.prepare(
        "INSERT INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at, expires_at) VALUES (?, 'Unclaimed', ?, ?, ?, ?)",
      ).bind(accountId, userId, createdAt, createdAt, expiresAt),
      env.DB.prepare(
        "INSERT INTO mgmt_organization_user(id, organization_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
      ).bind(`${accountId}-owner`, accountId, userId, createdAt),
      env.DB.prepare(
        "INSERT INTO mgmt_api_key(id, user_id, organization_id, name, token_hash, token_hint, enabled, created_at) VALUES (?, ?, ?, 'Bootstrap', ?, ?, 1, ?)",
      ).bind(`${accountId}-key`, userId, accountId, await hashApiKey(token), token.slice(-4), now),
    ]);

    const result = await callTool(token, "get_account");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.account).toMatchObject({ id: accountId, claimed: false, expiresAt });
    const summary = result.content[0]!.text;
    expect(summary).toContain("unclaimed");
    expect(summary).toContain(expiresAt);
    expect(summary).toContain(new Date(Date.parse(createdAt) + 30 * 86_400_000).toISOString());
    expect(summary).toContain("claim_account");
  });

  it("lists the account's apps and reads one of them", async () => {
    const fixture = await populated("mcp-apps@example.test");
    const listed = await callTool(fixture.read, "list_apps");
    expect(listed.structuredContent.apps.map((app: { id: string }) => app.id)).toEqual([fixture.app]);
    expect(listed.content[0]!.text).toContain(fixture.app);

    const read = await callTool(fixture.read, "get_app", { app: fixture.app });
    expect(read.structuredContent.app).toMatchObject({ id: fixture.app, revision: 1 });
  });

  it("answers another account's app as app_not_found in a tool result, not an HTTP status", async () => {
    const outsider = await account("mcp-outsider@example.test", "read");
    await seedServerApp("mcp-foreign-app", { organizationId: TEST_ORGANIZATION_ID });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await callTool(outsider.key, "get_app", { app: "mcp-foreign-app" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: "app_not_found",
      message: "App is not registered",
      status: 404,
      next: "Call list_apps for the ids of your apps.",
    });
    expect(result.content[0]!.text).toBe("app_not_found: App is not registered. Call list_apps for the ids of your apps.");

    // The refusal is logged once, as the HTTP surface logs one, and says where
    // it came from — but nothing the caller sent, the app id it named included.
    const logged = warnings.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toContainEqual(expect.objectContaining({
      message: "gateway_error",
      code: "app_not_found",
      tool: "get_app",
      source: "mcp",
    }));
    expect(warnings.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain("mcp-foreign-app");
  });

  it("validates an app document as a draft and as an update, and refuses one in the schema's words", async () => {
    const fixture = await populated("mcp-validate@example.test");
    const document = { name: "Draft", config: serverConfig({ proxy: { openai: { allowed_paths: [], allowed_models: [] } } }) };

    const draft = await callTool(fixture.read, "validate_app", { config: document });
    expect(draft.structuredContent).toEqual({ valid: true });
    expect(draft.content[0]!.text).toBe("The document would be accepted as a new app.");

    const update = await callTool(fixture.read, "validate_app", { app: fixture.app, config: document });
    expect(update.structuredContent).toEqual({ valid: true, app_id: fixture.app });

    const invalid = { name: "", config: document.config };
    const refused = await callTool(fixture.read, "validate_app", { config: invalid });
    const http = await send({
      url: `${ORIGIN}/v1/admin/app-drafts/validate`,
      headers: bearer(fixture.read),
      body: invalid,
    });
    const { error } = await http.json<{ error: { code: string; message: string } }>();
    expect(http.status).toBe(400);
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ error: error.code, message: error.message, status: 400 });
    expect(refused.content[0]!.text.startsWith(`invalid_request: `)).toBe(true);
  });

  it("checks an app and writes its first request without a credential", async () => {
    const fixture = await populated("mcp-check@example.test");
    const checked = await callTool(fixture.read, "check_app", { app: fixture.app });
    expect(checked.structuredContent).toMatchObject({ appId: fixture.app, ready: true });
    expect(checked.content[0]!.text).toContain("is ready");

    const snippet = await callTool(fixture.read, "get_app_snippet", { app: fixture.app });
    expect(snippet.structuredContent.language).toBe("shell");
    expect(snippet.structuredContent.snippet).toContain("APP_AI_GATEWAY_KEY");
    expect(JSON.stringify(snippet)).not.toContain(fixture.appKey);
  });

  it("lists an app's keys and the account's providers as metadata only", async () => {
    const fixture = await populated("mcp-metadata@example.test");
    const keys = await callTool(fixture.read, "list_app_keys", { app: fixture.app });
    expect(keys.structuredContent.keys).toHaveLength(1);
    expect(JSON.stringify(keys)).not.toContain(fixture.appKey);
    expect(fieldNames(keys.structuredContent).filter((name) => SECRET_FIELD.test(name))).toEqual([]);

    const providers = await callTool(fixture.read, "list_providers");
    expect(providers.structuredContent.providers.map((provider: { slug: string }) => provider.slug)).toEqual(["openai"]);
    expect(JSON.stringify(providers)).not.toContain(fixture.providerSecret);
    expect(fieldNames(providers.structuredContent).filter((name) => SECRET_FIELD.test(name))).toEqual([]);

    const bySlug = await callTool(fixture.read, "get_provider", { provider: "openai" });
    const byId = await callTool(fixture.read, "get_provider", { provider: `${fixture.app}-openai` });
    expect(bySlug.structuredContent).toEqual(byId.structuredContent);
    expect(bySlug.structuredContent.provider).toMatchObject({ slug: "openai", secretHint: fixture.providerSecret.slice(-4) });
    expect(JSON.stringify(bySlug)).not.toContain(fixture.providerSecret);

    const missing = await callTool(fixture.read, "get_provider", { provider: "nope" });
    expect(missing).toMatchObject({ isError: true, structuredContent: { error: "provider_not_found", status: 404 } });
  });

  it("reads usage for the account and for one app", async () => {
    const fixture = await populated("mcp-usage@example.test");
    const month = new Date().toISOString().slice(0, 7);
    const whole = await callTool(fixture.read, "get_usage");
    expect(whole.structuredContent).toMatchObject({ accountId: fixture.organizationId, month, totals: { requests: 0 } });
    const one = await callTool(fixture.read, "get_usage", { app: fixture.app, month });
    expect(one.structuredContent).toMatchObject({ app_id: fixture.app, month, requests: 0 });
    expect(one.content[0]!.text).toBe(`0 requests costing $0.00 for ${fixture.app} in ${month}.`);
  });

  it("lists the priced models", async () => {
    const result = await callTool(TEST_MANAGEMENT_KEY, "list_models");
    expect(Object.keys(result.structuredContent.prices).length).toBeGreaterThan(0);
    expect(result.content[0]!.text).toMatch(/^\d+ priced models across \d+ provider types\.$/u);
  });

  it("refuses another account's app before judging the arguments, as the API does", async () => {
    const outsider = await account("mcp-order@example.test", "read");
    await seedServerApp("mcp-order-foreign", { organizationId: TEST_ORGANIZATION_ID });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await callTool(outsider.key, "get_usage_breakdown", { app: "mcp-order-foreign", by: "planet" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: "app_not_found",
      message: "App is not registered",
      status: 404,
      next: "Call list_apps for the ids of your apps.",
    });
  });

  it("refuses an argument in the gateway's own words, with the structured result, as the API does", async () => {
    const fixture = await populated("mcp-arguments@example.test");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const next = "Correct the arguments as the message says and call the tool again.";

    const result = await callTool(fixture.read, "get_usage_breakdown", { app: fixture.app, by: "planet" });
    const http = await send({
      method: "GET",
      url: `${ORIGIN}/v1/admin/apps/${fixture.app}/usage/breakdown?by=planet`,
      headers: bearer(fixture.read),
    });
    const { error } = await http.json<{ error: { code: string; message: string } }>();
    expect(http.status).toBe(400);
    expect(error.code).toBe("invalid_request");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: "invalid_request", message: error.message, status: 400, next });
    expect(result.content[0]!.text).toBe(`invalid_request: ${error.message.replace(/[.\s]+$/u, "")}. ${next}`);

    // An argument no operation schema covers is judged at the same point, in the same words.
    const user = await callTool(fixture.read, "get_app_user", { app: fixture.app });
    expect(user).toMatchObject({ isError: true, structuredContent: { error: "invalid_request", status: 400, next } });
    expect(user.structuredContent.message).toMatch(/^user: /u);
    const provider = await callTool(fixture.read, "get_provider", { provider: 7 });
    expect(provider).toMatchObject({ isError: true, structuredContent: { error: "invalid_request", status: 400, next } });
    expect(provider.structuredContent.message).toMatch(/^provider: /u);
  });
});

describe("MCP attribution", () => {
  it("records a call through /mcp as the mcp action source, whatever the client says it is", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { status, message } = await rpc(
      TEST_MANAGEMENT_KEY,
      "tools/call",
      { name: "get_app", arguments: { app: "mcp-attribution-missing" } },
      "get_app",
      { "x-client": "cli" },
    );
    expect(status).toBe(200);
    expect(message.result.isError).toBe(true);
    const logged = warnings.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toContainEqual(expect.objectContaining({
      message: "gateway_error",
      code: "app_not_found",
      tool: "get_app",
      source: "mcp",
    }));
  });

  it("resolves a key used here as the mcp action source, whatever the client says it is", async () => {
    const url = `${ORIGIN}/mcp`;
    const headers: Record<string, string> = { authorization: `Bearer ${TEST_MANAGEMENT_KEY}`, "x-client": "cli" };
    const deployment = resolveDeployment(runtime, url);
    const cache = new Map<string, Promise<CfAuth>>();
    const context = {
      env: runtime,
      req: { url, header: (name: string) => headers[name.toLowerCase()] },
      get: (key: string) => (key === "deployment" ? deployment : cache),
    } as unknown as Parameters<typeof authenticateMcp>[0];

    const auth = await authenticateMcp(context);
    if (auth instanceof Response) throw new Error(`refused with ${auth.status}`);
    expect(auth.state.source).toBe("mcp");
    expect(auth.state.actor?.actionSource).toBe("mcp");
    expect(auth.actor).toMatchObject({ organizationId: TEST_ORGANIZATION_ID, credentialType: "apiKey" });
  });
});
