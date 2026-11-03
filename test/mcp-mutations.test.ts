import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialGrant } from "@maxceem/cf-auth";
import worker from "../src/index";
import { hashApiKey } from "../src/client-auth/api-keys";
import { AppKeyMetadataSchema } from "../src/contracts/responses";
import { MCP_GUIDE } from "../src/mcp/guide";
import { REDACTED, redactSecrets, SECRET_FIELDS } from "../src/mcp/secret-fields";
import { credentialParameter, MCP_TOOLS } from "../src/mcp/tools";
import { TEST_MANAGEMENT_KEY } from "./apply-migrations";
import { seedHuman, seedProvider, seedServerApp, seedUnaffiliatedHuman, serverConfig } from "./helpers";

/**
 * The MCP server's change tools: creates under a reservation, changes whose
 * secret a person enters in a browser, the catalog writes it runs as they
 * are, `get_operation`, `claim_account`, and the console API the reveal page
 * calls.
 *
 * Driven through the Worker with plain JSON-RPC, as `./mcp.test.ts` drives the
 * read tools. Every answer an MCP client receives is kept, so the last test
 * can look for every key this file made in all of them.
 */

const ORIGIN = "https://example.test";
const MODERN = "2026-07-28";

const runtime = new Proxy(env, {
  get(target, key, receiver) {
    if (key === "DEPLOYMENT_ID") return "mcp-mutation-tests";
    if (key === "CLI_CONSOLE_ORIGIN") return ORIGIN;
    if (key === "PUBLIC_API_URL") return "https://api.example.test";
    return Reflect.get(target, key, receiver);
  },
});

/**
 * A barrier for one execution: once armed, the first provider lookup — which
 * an app creation makes inside the engine's execution, holding the
 * reservation — waits until it is released. Every other query passes.
 */
const barrier = {
  armed: false,
  entered: () => {},
  release: () => {},
};

function heldStatement(statement: D1PreparedStatement, hold: () => Promise<void>): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values: unknown[]) => heldStatement(target.bind(...values), hold);
      if (property === "all" || property === "raw" || property === "first" || property === "run") {
        const method = (target as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[property]!;
        return async (...args: unknown[]) => {
          await hold();
          return method.apply(target, args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const heldDatabase = new Proxy(env.DB, {
  get(target, property, receiver) {
    if (property !== "prepare") return Reflect.get(target, property, receiver);
    return (query: string) => {
      const statement = target.prepare(query);
      if (!barrier.armed || !/from "provider"/u.test(query)) return statement;
      barrier.armed = false;
      const released = new Promise<void>((resolve) => {
        barrier.release = resolve;
      });
      return heldStatement(statement, async () => {
        barrier.entered();
        await released;
      });
    };
  },
});

const heldRuntime = new Proxy(runtime, {
  get(target, key, receiver) {
    return key === "DB" ? heldDatabase : Reflect.get(target, key, receiver);
  },
}) as Env;

/** Bound parameters that make the database fail, quoting them, as drizzle's errors do. */
const FAILING_MARKER = "fault-marker-";
/** Bound parameters that make the database lose its connection, as D1 reports it. */
const LOST_MARKER = "lost-marker-";

function failingStatement(statement: D1PreparedStatement, query: string, values: unknown[] = []): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...bound: unknown[]) => failingStatement(target.bind(...bound), query, bound);
      }
      if (property === "all" || property === "raw" || property === "first" || property === "run") {
        const method = (target as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[property]!;
        return async (...args: unknown[]) => {
          if (values.some((value) => String(value).includes(FAILING_MARKER))) {
            throw new Error(`Failed query: ${query}\nparams: ${values.join(",")}`);
          }
          if (values.some((value) => String(value).includes(LOST_MARKER))) {
            throw new Error("D1_ERROR: Network connection lost.");
          }
          return method.apply(target, args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const failingRuntime = new Proxy(runtime, {
  get(target, key, receiver) {
    if (key !== "DB") return Reflect.get(target, key, receiver);
    return new Proxy(env.DB, {
      get(database, property, inner) {
        if (property !== "prepare") return Reflect.get(database, property, inner);
        return (query: string) => failingStatement(database.prepare(query), query);
      },
    });
  },
}) as Env;

/** Every console line written while `run` runs. */
async function consoleLines(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }
  return lines;
}

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "mcp-mutation-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** Every body an MCP client was answered with, for the last test's search. */
const answered: string[] = [];
/** Every key value the reveal endpoint handed out, and every secret a test typed in a browser. */
const secrets: string[] = [];

let nextId = 1;

function send(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  through: Env = runtime,
) {
  return worker.request(url, {
    method: init.method ?? "POST",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }, through);
}

/** Every secret this file makes, from fixtures to what a person types or is shown. */
function secret<T extends string>(value: T): T {
  secrets.push(value);
  return value;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent: any;
}

async function callTool(
  key: string,
  name: string,
  args: Record<string, unknown> = {},
  through: Env = runtime,
): Promise<ToolResult> {
  const response = await send(`${ORIGIN}/mcp`, {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: {
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args, _meta: ENVELOPE },
    },
  }, through);
  const text = await response.text();
  answered.push(text);
  expect(response.status, text).toBe(200);
  const message = JSON.parse(text) as { result?: ToolResult; error?: unknown };
  expect(message.error, text).toBeUndefined();
  return message.result!;
}

function expectRefusal(result: ToolResult, code: string): void {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  expect(result.structuredContent.error, JSON.stringify(result.structuredContent)).toBe(code);
  expect(result.structuredContent.next).toEqual(expect.any(String));
}

/** The published tool list, as a client discovers it. */
async function listTools(): Promise<{ name: string; inputSchema: any; annotations: any }[]> {
  const response = await send(`${ORIGIN}/mcp`, {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TEST_MANAGEMENT_KEY}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/list",
    },
    body: { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: { _meta: ENVELOPE } },
  });
  return (await response.json<{ result: { tools: any[] } }>()).result.tools;
}

/** A browser step approved the way its page approves it, with the secret a person typed. */
async function approve(url: string, typed?: string): Promise<void> {
  const id = new URL(url).pathname.split("/").pop()!;
  const submitted = await send(`${ORIGIN}/v1/cli/browser/${id}/submit`, {
    headers: { origin: ORIGIN },
    body: {
      submissionToken: new URL(url).hash.slice(1),
      approve: true,
      ...(typed === undefined ? {} : { secret: secret(typed) }),
    },
  });
  expect(submitted.status, await submitted.clone().text()).toBe(200);
}

/** A person with an account of their own, a provider in it, and a management key of each grant. */
async function account(email: string) {
  const human = await seedHuman(email);
  secret(human.cookie);
  await seedProvider({
    type: "openai",
    organizationId: human.organizationId,
    id: `${human.organizationId}-openai`,
    secret: secret(`sk-fixture-${crypto.randomUUID()}`),
  });
  const issue = async (grant: CredentialGrant) => {
    const created = await send(`${ORIGIN}/v1/admin/keys`, {
      headers: { cookie: human.cookie, "x-console-request": "1" },
      body: { name: `MCP ${grant}`, grant },
    });
    expect(created.status).toBe(201);
    return secret((await created.json<{ key: { plaintext: string } }>()).key.plaintext);
  };
  return { ...human, key: await issue("manage"), read: await issue("read") };
}

/** A server app document: its key is minted on creation. */
function appDocument(name: string) {
  return { name, config: serverConfig({ proxy: { openai: { allowed_paths: [], allowed_models: [] } } }) };
}

async function appCount(organizationId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM app WHERE organization_id = ?")
    .bind(organizationId)
    .first<{ n: number }>();
  return row!.n;
}

/**
 * An account nobody has claimed: a service identity owns it, with a
 * management key of each grant, as a bootstrap leaves one.
 */
async function unclaimedAccount(): Promise<{ manage: string; read: string }> {
  const accountId = `mcp-claim-${crypto.randomUUID()}`;
  const userId = `service-${accountId}`;
  const manage = secret(`agw_mgmt_${crypto.randomUUID().replaceAll("-", "")}`);
  const read = secret(`agw_mgmt_${crypto.randomUUID().replaceAll("-", "")}`);
  const now = Date.now();
  const createdAt = new Date(now - 86_400_000).toISOString();
  const key = async (token: string, grant: CredentialGrant) =>
    env.DB.prepare(
      "INSERT INTO mgmt_api_key(id, user_id, organization_id, name, token_hash, token_hint, enabled, created_at, \"grant\") VALUES (?, ?, ?, 'Bootstrap', ?, ?, 1, ?, ?)",
    ).bind(`${accountId}-${grant}`, userId, accountId, await hashApiKey(token), token.slice(-4), now, grant);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO mgmt_user(id, name, email, kind, email_verified, created_at, updated_at) VALUES (?, 'Service', NULL, 'service', 0, ?, ?)",
    ).bind(userId, now, now),
    env.DB.prepare(
      "INSERT INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at, expires_at) VALUES (?, 'Unclaimed', ?, ?, ?, ?)",
    ).bind(accountId, userId, createdAt, createdAt, new Date(now + 60 * 86_400_000).toISOString()),
    env.DB.prepare(
      "INSERT INTO mgmt_organization_user(id, organization_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
    ).bind(`${accountId}-owner`, accountId, userId, createdAt),
    await key(manage, "manage"),
    await key(read, "read"),
  ]);
  return { manage, read };
}

const session = (cookie: string) => ({ cookie, "x-console-request": "1" });

/** The console's reveal call, as the reveal page makes it, or as `from` sends it. */
function reveal(id: string, headers: Record<string, string>, from: { host?: string; origin?: string | null } = {}) {
  const origin = from.origin === undefined ? ORIGIN : from.origin;
  return send(`${from.host ?? ORIGIN}/v1/admin/operations/${encodeURIComponent(id)}/reveal`, {
    headers: { ...(origin === null ? {} : { origin }), ...headers },
    body: {},
  });
}

interface Revealed {
  kind: string;
  result: { api_key: { key: string; id: string } };
}

/** A key revealed to a person on the console, registered as the secret it is. */
async function revealedKey(id: string, cookie: string): Promise<Revealed> {
  const response = await reveal(id, session(cookie));
  expect(response.status, await response.clone().text()).toBe(200);
  const revealed = await response.json<Revealed>();
  secret(revealed.result.api_key.key);
  return revealed;
}

/**
 * The one way a test collects a key a create made: revealed to its person as
 * soon as the create answers, long before its window can pass, and registered
 * for the final scan. Every successful `add_app` and `add_app_key` goes
 * through here; one that made a key has to offer its reveal page.
 */
async function collectKey(result: ToolResult, cookie: string): Promise<Revealed | null> {
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  const created = result.structuredContent;
  if (created.api_key && created.replayed === false) expect(created.reveal_url).toEqual(expect.any(String));
  if (typeof created.reveal_url !== "string") return null;
  return revealedKey(created.id, cookie);
}



afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MCP reserved creates", () => {
  it("reserves without writing, creates once, replays, and never answers the key", async () => {
    const owner = await account("mcp-reserve@example.test");
    const config = appDocument("Reserved");

    const reserved = await callTool(owner.key, "add_app", { config });
    expect(reserved.isError).toBeFalsy();
    const { handle, id } = reserved.structuredContent;
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // The handle and the operation's id are two strings under two names.
    expect(id).not.toBe(handle);
    expect(reserved.structuredContent).not.toHaveProperty("operation");
    expect(reserved.structuredContent.next).toContain("add_app");
    expect(reserved.structuredContent.notice).toBeUndefined();
    expect(await appCount(owner.organizationId)).toBe(0);

    // The reservation is visible, pending, to any credential of the account.
    const pending = await callTool(owner.read, "get_operation", { id });
    expect(pending.structuredContent).toMatchObject({ id, kind: "app.add.reserved", state: "pending" });

    const created = await callTool(owner.key, "add_app", { config, handle });
    expect(created.isError, created.content[0]?.text).toBeFalsy();
    expect(created.structuredContent).toMatchObject({
      id,
      kind: "app.add.reserved",
      replayed: false,
      app: { name: "Reserved", revision: 1 },
      reveal_url: `${ORIGIN}/reveal/${encodeURIComponent(id)}`,
    });
    expect(created.structuredContent.api_key).toMatchObject({ name: "Default key" });
    expect(created.structuredContent.api_key).not.toHaveProperty("key");
    expect(created.structuredContent).not.toHaveProperty("requestHash");
    expect(created.content[0]!.text).toContain("reveal");
    expect(await appCount(owner.organizationId)).toBe(1);

    const again = await callTool(owner.key, "add_app", { config, handle });
    expect(again.isError).toBeFalsy();
    expect(again.structuredContent).toMatchObject({ id, replayed: true, app: created.structuredContent.app });
    expect(again.structuredContent.reveal_url).toBe(created.structuredContent.reveal_url);
    expect(await appCount(owner.organizationId)).toBe(1);

    // Completed, with the redacted record and the reveal page, and no key.
    const status = await callTool(owner.read, "get_operation", { id });
    expect(status.structuredContent).toMatchObject({
      state: "completed",
      result: { app: { id: created.structuredContent.app.id } },
      reveal_url: created.structuredContent.reveal_url,
    });
    expect(status.structuredContent.result.api_key).toEqual(created.structuredContent.api_key);
    expect(status.structuredContent.result.api_key).toMatchObject({ id: expect.any(String), name: "Default key" });
    expect(status.structuredContent.result.api_key).not.toHaveProperty("key");

    // A person reveals it once; the page link then stops being offered.
    const revealed = (await collectKey(created, owner.cookie))!;
    expect(revealed.kind).toBe("app.add.reserved");
    expect(revealed.result.api_key.key).toMatch(/^agw_/u);
    expect(revealed.result.api_key.id).toBe(created.structuredContent.api_key.id);
    const second = await reveal(id, session(owner.cookie));
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: { code: "already_revealed" } });
    const after = await callTool(owner.read, "get_operation", { id });
    expect(after.structuredContent.reveal_url).toBeUndefined();
    // The replay outlives the reveal, and still carries nothing secret.
    const replayed = await callTool(owner.key, "add_app", { config, handle });
    expect(replayed.structuredContent).toMatchObject({ replayed: true });
    expect(replayed.structuredContent.reveal_url).toBeUndefined();
  });

  it("refuses a handle after the replay window, after it lapsed, and while another call executes it", async () => {
    const owner = await account("mcp-reserve-windows@example.test");
    const config = appDocument("Windows");
    const executed = await callTool(owner.key, "add_app", { config });
    await collectKey(
      await callTool(owner.key, "add_app", { config, handle: executed.structuredContent.handle }),
      owner.cookie,
    );
    const lapsed = await callTool(owner.key, "add_app", { config: appDocument("Lapsed") });
    const busy = await callTool(owner.key, "add_app", { config: appDocument("Busy") });

    // Another execution holds this one.
    await env.DB.prepare("UPDATE mgmt_operation SET execution_claim = 'held-elsewhere' WHERE id = ?")
      .bind(busy.structuredContent.id)
      .run();
    const held = await callTool(owner.key, "add_app", {
      config: appDocument("Busy"),
      handle: busy.structuredContent.handle,
    });
    expectRefusal(held, "conflict");
    expect(held.structuredContent.next).toContain("same arguments and handle");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const late = await callTool(owner.key, "add_app", { config, handle: executed.structuredContent.handle });
    expectRefusal(late, "already_completed");
    const expired = await callTool(owner.key, "add_app", {
      config: appDocument("Lapsed"),
      handle: lapsed.structuredContent.handle,
    });
    expectRefusal(expired, "operation_expired");
    expect(expired.structuredContent.next).toContain("without handle");
    vi.useRealTimers();
    expect(await appCount(owner.organizationId)).toBe(1);
  });

  it("refuses a handle sent with other input, from another account, or with a read key", async () => {
    const owner = await account("mcp-reserve-mismatch@example.test");
    const stranger = await account("mcp-reserve-stranger@example.test");
    const reserved = await callTool(owner.key, "add_app", { config: appDocument("Original") });
    const { handle } = reserved.structuredContent;

    const changed = await callTool(owner.key, "add_app", { config: appDocument("Changed"), handle });
    expectRefusal(changed, "operation_mismatch");
    const foreign = await callTool(stranger.key, "add_app", { config: appDocument("Original"), handle });
    expectRefusal(foreign, "operation_mismatch");
    const unknown = await callTool(owner.key, "add_app", { config: appDocument("Original"), handle: "x".repeat(43) });
    expectRefusal(unknown, "operation_not_found");
    expect(await appCount(owner.organizationId)).toBe(0);
    expect(await appCount(stranger.organizationId)).toBe(0);

    // A refused execution gave the handle back: the reserved input still creates.
    await collectKey(await callTool(owner.key, "add_app", { config: appDocument("Original"), handle }), owner.cookie);

    for (const args of [{ config: appDocument("Read") }, { config: appDocument("Original"), handle }]) {
      expectRefusal(await callTool(owner.read, "add_app", args), "grant_insufficient");
    }
    expectRefusal(await callTool(owner.read, "add_app_key", { app: "anything", name: "Read" }), "grant_insufficient");
  });

  it("publishes handle as optional, so a client that validates can reserve", async () => {
    const tools = await listTools();
    for (const name of ["add_app", "add_app_key"]) {
      const schema = tools.find((tool) => tool.name === name)!.inputSchema;
      expect(schema.properties, name).toHaveProperty("handle");
      expect(schema.required ?? [], name).not.toContain("handle");
    }
    expect(tools.find((tool) => tool.name === "add_app")!.inputSchema.required).toEqual(["config"]);
    expect(tools.find((tool) => tool.name === "add_app_key")!.inputSchema.required).toEqual(["app", "name"]);
  });

  it("answers other input as a mismatch while the handle is executing and after it completed", async () => {
    const owner = await account("mcp-reserve-busy@example.test");
    const config = appDocument("Busy");
    const { handle } = (await callTool(owner.key, "add_app", { config })).structuredContent;

    // Hold the execution inside the engine, after it claimed the handle.
    const entered = new Promise<void>((resolve) => {
      barrier.entered = resolve;
    });
    barrier.armed = true;
    const executing = callTool(owner.key, "add_app", { config, handle }, heldRuntime);
    await entered;
    try {
      const other = await callTool(owner.key, "add_app", { config: appDocument("Other"), handle }, heldRuntime);
      expectRefusal(other, "operation_mismatch");
      const same = await callTool(owner.key, "add_app", { config, handle }, heldRuntime);
      expectRefusal(same, "conflict");
    } finally {
      barrier.release();
    }
    const created = await executing;
    expect(created.isError, created.content[0]?.text).toBeFalsy();
    expect(created.structuredContent.replayed).toBe(false);

    // Completed: other input is still a mismatch, not a replay of the first.
    const after = await callTool(owner.key, "add_app", { config: appDocument("Other"), handle });
    expectRefusal(after, "operation_mismatch");
    // A key handle sent to the app tool names another kind.
    const keyHandle = (await callTool(owner.key, "add_app_key", { app: created.structuredContent.app.id, name: "K" }))
      .structuredContent.handle;
    expectRefusal(await callTool(owner.key, "add_app", { config, handle: keyHandle }), "operation_mismatch");
    expect(await appCount(owner.organizationId)).toBe(1);
    await collectKey(created, owner.cookie);
  });

  it("refuses a credential anywhere in an app document on add, update and validate, and writes nothing", async () => {
    const owner = await account("mcp-app-credential@example.test");
    const app = `mcp-cred-${crypto.randomUUID().slice(0, 8)}`;
    secret(await seedServerApp(app, {
      organizationId: owner.organizationId,
      proxy: { openai: { allowed_paths: [], allowed_models: [] } },
    }));
    const leaked = secret(`sk-in-a-document-${crypto.randomUUID()}`);
    const leaky = (name: string) => {
      const document = appDocument(name) as { name: string; config: Record<string, unknown> };
      return {
        ...document,
        config: { ...document.config, endpoints: { chat: { params: { credentials: { token: leaked } } } } },
      };
    };
    // A reservation of a clean document, so the leaky one is also sent with a handle.
    const clean = await callTool(owner.key, "add_app", { config: appDocument("Clean") });
    const { handle, id } = clean.structuredContent;

    const attempts: [string, Record<string, unknown>][] = [
      ["add_app", { config: leaky("Leaky") }],
      ["add_app", { config: leaky("Clean"), handle }],
      ["update_app", { app, config: { ...leaky("Leaky"), revision: 1 } }],
      ["validate_app", { app, config: leaky("Leaky") }],
      ["validate_app", { config: leaky("Leaky") }],
    ];
    for (const [tool, args] of attempts) {
      const refused = await callTool(owner.key, tool, args);
      expectRefusal(refused, "invalid_request");
      expect(refused.structuredContent.message, tool).toMatch(
        /^config\.config\.endpoints\.chat\.params\.credentials: .*never a tool argument/u,
      );
      expect(JSON.stringify(refused)).not.toContain(leaked);
    }
    // A read key is refused before the document is looked at.
    expectRefusal(await callTool(owner.read, "update_app", { app, config: { ...leaky("Leaky"), revision: 1 } }), "grant_insufficient");

    // Nothing was written: one clean reservation, the app untouched.
    const stored = await env.DB.prepare(
      "SELECT count(*) AS n FROM mgmt_operation WHERE organization_id = ? AND (instr(coalesce(payload, ''), ?) OR instr(coalesce(outcome, ''), ?))",
    ).bind(owner.organizationId, leaked, leaked).first<{ n: number }>();
    expect(stored!.n).toBe(0);
    const row = await env.DB.prepare("SELECT revision, instr(config_json, ?) AS found FROM app WHERE id = ?")
      .bind(leaked, app)
      .first<{ revision: number; found: number }>();
    expect(row).toEqual({ revision: 1, found: 0 });

    // The clean reservation creates, replays and reports without it.
    const created = await callTool(owner.key, "add_app", { config: appDocument("Clean"), handle });
    await collectKey(created, owner.cookie);
    const replayed = await callTool(owner.key, "add_app", { config: appDocument("Clean"), handle });
    const status = await callTool(owner.read, "get_operation", { id });
    for (const answer of [created, replayed, status]) expect(JSON.stringify(answer)).not.toContain(leaked);
    expect(await appCount(owner.organizationId)).toBe(2);
  });

  it("refuses a document the write would refuse before reserving it", async () => {
    const owner = await account("mcp-reserve-invalid@example.test");
    const refused = await callTool(owner.key, "add_app", {
      config: { name: "Bad", config: serverConfig({ proxy: { anthropic: { allowed_paths: [], allowed_models: [] } } }) },
    });
    expectRefusal(refused, "invalid_request");
    const unnamed = await callTool(owner.key, "add_app", { config: { config: appDocument("x").config } });
    expectRefusal(unnamed, "invalid_request");
    expect(unnamed.structuredContent.message).toContain("name");
    const count = await env.DB.prepare("SELECT count(*) AS n FROM mgmt_operation WHERE organization_id = ?")
      .bind(owner.organizationId)
      .first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("notes an identical request made within the hour, and never merges it", async () => {
    const owner = await account("mcp-reserve-notice@example.test");
    const config = appDocument("Twice");
    const first = await callTool(owner.key, "add_app", { config });
    const second = await callTool(owner.key, "add_app", { config });
    expect(second.structuredContent.notice).toContain(first.structuredContent.id);
    expect(second.structuredContent.notice).toContain("get_operation");
    expect(second.content[0]!.text).toContain(first.structuredContent.id);
    expect(second.structuredContent.handle).not.toBe(first.structuredContent.handle);

    await collectKey(
      await callTool(owner.key, "add_app", { config, handle: first.structuredContent.handle }),
      owner.cookie,
    );
    const third = await callTool(owner.key, "add_app", { config });
    expect(third.structuredContent.notice).toMatch(/completed .* as operation/u);
    expect(third.structuredContent.notice).toContain(first.structuredContent.id);
    // A different document is a different request.
    const other = await callTool(owner.key, "add_app", { config: appDocument("Another") });
    expect(other.structuredContent.notice).toBeUndefined();
  });

  it("creates an app key under a reservation, revealed once to an admin session only", async () => {
    const owner = await account("mcp-key-reserve@example.test");
    const app = `mcp-keys-${crypto.randomUUID().slice(0, 8)}`;
    secret(await seedServerApp(app, {
      organizationId: owner.organizationId,
      proxy: { openai: { allowed_paths: [], allowed_models: [] } },
    }));
    const missing = await callTool(owner.key, "add_app_key", { app: "not-an-app", name: "Nope" });
    expectRefusal(missing, "app_not_found");

    const reserved = await callTool(owner.key, "add_app_key", { app, name: "Agent key" });
    const { handle, id } = reserved.structuredContent;
    const created = await callTool(owner.key, "add_app_key", { app, name: "Agent key", handle });
    expect(created.isError, created.content[0]?.text).toBeFalsy();
    expect(created.structuredContent.api_key).toMatchObject({ id: expect.any(String), name: "Agent key", key_prefix: expect.any(String) });
    expect(created.structuredContent.api_key).not.toHaveProperty("key");
    expect(created.structuredContent.reveal_url).toBe(`${ORIGIN}/reveal/${encodeURIComponent(id)}`);

    // A management key, however privileged, cannot reveal.
    const byKey = await reveal(id, { authorization: `Bearer ${owner.key}` });
    expect(byKey.status).toBe(403);
    await expect(byKey.json()).resolves.toMatchObject({ error: { code: "session_required" } });

    // A member of the account cannot either.
    const member = await seedUnaffiliatedHuman("mcp-key-member@example.test");
    await env.DB.prepare(
      "INSERT INTO mgmt_organization_user(id, organization_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'member', 'active', ?)",
    ).bind(`${owner.organizationId}-member`, owner.organizationId, member.userId, new Date().toISOString()).run();
    const byMember = await reveal(id, session(member.cookie));
    expect(byMember.status).toBe(403);
    await expect(byMember.json()).resolves.toMatchObject({ error: { code: "forbidden" } });

    // A person of another account does not learn it exists.
    const stranger = await account("mcp-key-stranger@example.test");
    const byStranger = await reveal(id, session(stranger.cookie));
    expect(byStranger.status).toBe(404);
    await expect(byStranger.json()).resolves.toMatchObject({ error: { code: "operation_not_found" } });

    // The owner's own session, from anywhere but the console's own page: a
    // foreign page, no page at all, or the API host. None of them spends it.
    const foreign = await reveal(id, session(owner.cookie), { origin: "https://elsewhere.test" });
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
    const originless = await reveal(id, session(owner.cookie), { origin: null });
    expect(originless.status).toBe(403);
    await expect(originless.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
    const apiHost = await reveal(id, session(owner.cookie), { host: "https://api.example.test" });
    expect(apiHost.status).toBe(404);
    expect((await callTool(owner.read, "get_operation", { id })).structuredContent.reveal_url).toBeDefined();

    await collectKey(created, owner.cookie);
    // The revealed key works, and is the key the tool named.
    const listed = await callTool(owner.read, "list_app_keys", { app });
    expect(listed.structuredContent.keys.map((key: { id: string }) => key.id)).toContain(created.structuredContent.api_key.id);
    expect((await reveal(id, session(owner.cookie))).status).toBe(409);
  });
});

describe("MCP browser steps", () => {
  it("opens add_provider with a URL, and reports it completed once a person approves", async () => {
    const owner = await account("mcp-add-provider@example.test");
    const slug = `browser-${crypto.randomUUID().slice(0, 8)}`;
    const opened = await callTool(owner.key, "add_provider", { type: "openai", name: "Through a browser", slug });
    expect(opened.isError, opened.content[0]?.text).toBeFalsy();
    const { id, url, expiresAt } = opened.structuredContent;
    expect(opened.structuredContent).not.toHaveProperty("operation");
    expect(url).toMatch(new RegExp(`^${ORIGIN}/cli/approve/${encodeURIComponent(id)}#`, "u"));
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    expect(opened.structuredContent.next).toContain("get_operation");

    const pending = await callTool(owner.read, "get_operation", { id });
    expect(pending.structuredContent).toMatchObject({ state: "pending", kind: "provider.add.browser" });
    expect(pending.structuredContent).not.toHaveProperty("url");

    const typed = `sk-mcp-browser-${crypto.randomUUID()}`;
    await approve(url, typed);

    const completed = await callTool(owner.read, "get_operation", { id });
    expect(completed.structuredContent).toMatchObject({
      state: "completed",
      result: { provider: { slug, type: "openai", secretHint: typed.slice(-4) } },
    });
    expect(completed.structuredContent.reveal_url).toBeUndefined();

    // The same request again is noted, and opens a second step rather than merging.
    const again = await callTool(owner.key, "add_provider", { type: "openai", name: "Through a browser", slug });
    expect(again.structuredContent.notice).toContain(id);
    expect(again.structuredContent.id).not.toBe(id);
  });

  it("refuses a secret passed as an argument, wherever it is put, and a read key", async () => {
    const owner = await account("mcp-browser-secret@example.test");
    const leaked = secret(`sk-never-an-argument-${crypto.randomUUID()}`);
    const withSecret = await callTool(owner.key, "add_provider", { type: "openai", name: "Leaky", secret: leaked });
    expectRefusal(withSecret, "invalid_request");
    expect(withSecret.structuredContent.message).toContain("never a tool argument");
    expect(withSecret.structuredContent.next).toContain("page this tool returns");
    // Inside the gateway's own object, and beside it.
    for (const args of [
      { gateway: { type: "vercel", name: "Leaky gateway", token: leaked } },
      { gateway: { type: "vercel", name: "Leaky gateway" }, token: leaked },
      { gateway: { type: "vercel", name: "Leaky gateway" }, secret: leaked },
    ]) {
      const refused = await callTool(owner.key, "add_provider_gateway", args);
      expectRefusal(refused, "invalid_request");
      expect(refused.structuredContent.message).toContain("never a tool argument");
    }
    for (const field of ["token", "secret"]) {
      const refused = await callTool(owner.key, "rotate_provider_gateway_key", { id: "gateway", revision: 1, [field]: leaked });
      expectRefusal(refused, "invalid_request");
      expect(refused.structuredContent.message).toContain("never a tool argument");
    }
    const update = await callTool(owner.key, "update_provider", {
      id: `${owner.organizationId}-openai`,
      revision: 1,
      secret: leaked,
    });
    expectRefusal(update, "invalid_request");
    expect(update.structuredContent.message).toContain("rotate_provider_key");

    expectRefusal(await callTool(owner.read, "add_provider", { type: "openai", name: "Read" }), "grant_insufficient");
    expectRefusal(
      await callTool(owner.read, "rotate_provider_key", { id: `${owner.organizationId}-openai`, revision: 1 }),
      "grant_insufficient",
    );
    const opened = await env.DB.prepare("SELECT count(*) AS n FROM mgmt_operation WHERE organization_id = ?")
      .bind(owner.organizationId)
      .first<{ n: number }>();
    expect(opened!.n).toBe(0);
  });

  it("refuses a credential at any depth, in any case, beside or inside the payload, for every browser step", async () => {
    const owner = await account("mcp-browser-deep@example.test");
    const leaked = secret(`sk-deep-${crypto.randomUUID()}`);
    const bases: Record<string, Record<string, unknown>> = {
      add_provider: { type: "openai", name: "Deep" },
      add_provider_gateway: { gateway: { type: "vercel", name: "Deep gateway" } },
      rotate_provider_key: { id: `${owner.organizationId}-openai`, revision: 1 },
      rotate_provider_gateway_key: { id: "gateway", revision: 1 },
    };
    const browserTools = MCP_TOOLS.filter((tool) => tool.browserStep).map((tool) => tool.name);
    expect(Object.keys(bases).sort()).toEqual([...browserTools].sort());
    const placements = (base: Record<string, unknown>): Record<string, unknown>[] => [
      { ...base, credentials: { token: leaked } },
      { ...base, credentials: [{ secret: leaked }] },
      { ...base, Token: leaked },
      { ...base, API_KEY: leaked },
      { ...base, options: { auth: [{ headers: { Authorization: `Bearer ${leaked}` } }] } },
      { ...base, wrapper: { inner: { password: leaked } } },
      ...("gateway" in base
        ? [{ gateway: { ...(base.gateway as object), credential: leaked } }, { gateway: { ...(base.gateway as object), nested: { apiKey: leaked } } }]
        : []),
    ];
    for (const [tool, base] of Object.entries(bases)) {
      for (const args of placements(base)) {
        const refused = await callTool(owner.key, tool, args);
        expectRefusal(refused, "invalid_request");
        expect(refused.structuredContent.message, `${tool} ${JSON.stringify(Object.keys(args))}`).toContain("never a tool argument");
      }
    }
    // Anything else beside the gateway's own object is refused, not dropped.
    const sibling = await callTool(owner.key, "add_provider_gateway", { ...bases.add_provider_gateway, note: "hello" });
    expectRefusal(sibling, "invalid_request");
    expect(sibling.structuredContent.message).toContain("note");
    const opened = await env.DB.prepare("SELECT count(*) AS n FROM mgmt_operation WHERE organization_id = ?")
      .bind(owner.organizationId)
      .first<{ n: number }>();
    expect(opened!.n).toBe(0);
  });

  it("logs a refusal without anything the caller sent", async () => {
    const owner = await account("mcp-browser-logs@example.test");
    const leaked = secret(`sk-logged-${crypto.randomUUID()}`);
    const lines = await consoleLines(async () => {
      const refused = await callTool(owner.key, "add_provider", { type: "openai", name: "Logged", secret: leaked, app: leaked });
      expectRefusal(refused, "invalid_request");
    });
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toContainEqual(expect.objectContaining({ message: "gateway_error", code: "invalid_request", tool: "add_provider" }));
    for (const line of lines) expect(line.includes(leaked)).toBe(false);
  });

  it("logs a failure it did not expect by its kind, never by its message", async () => {
    const marker = secret(`${FAILING_MARKER}${crypto.randomUUID()}`);
    let result: ToolResult | undefined;
    const lines = await consoleLines(async () => {
      result = await callTool(TEST_MANAGEMENT_KEY, "get_app", { app: marker }, failingRuntime);
    });
    expectRefusal(result!, "internal_error");
    expect(JSON.stringify(result)).not.toContain(marker);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toContainEqual(expect.objectContaining({ message: "unhandled_error", tool: "get_app", error: expect.objectContaining({ class: "DrizzleQueryError", cause: expect.objectContaining({ class: "Error" }) }) }));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.includes(marker)).toBe(false);
  });

  it("refuses a platform failure as service_unavailable, telling the caller to retry", async () => {
    const result = await callTool(TEST_MANAGEMENT_KEY, "get_app", { app: `${LOST_MARKER}${crypto.randomUUID()}` }, failingRuntime);
    expectRefusal(result, "service_unavailable");
    expect(result.structuredContent).toMatchObject({ status: 503 });
    expect(String(result.structuredContent.next)).toContain("call the tool again");
  });

  it("judges a URL anywhere in a browser step as it will be stored: trimmed, and refused only for what leaks", async () => {
    const owner = await account("mcp-browser-url-names@example.test");
    const leaked = secret(`urlname${crypto.randomUUID().replaceAll("-", "")}`);
    const refusedNames = [
      ` https://user:${leaked}@example.com/v1 `,
      `\thttps://example.com/v1?token=${leaked}`,
      `https://example.com/v1?api_key=${leaked}`,
      `https://example.com/callback#access_token=${leaked}`,
      `https://example.com/v1?version=2&Client-Secret=${leaked}`,
      // What the parser reads as userinfo though no `://` is written.
      `https:/user:${leaked}@example.com/`,
      `https:\n//user:${leaked}@example.com/`,
      // A query inside a fragment, and doubled or mixed delimiters.
      `https://example.com/#/callback?api_key=${leaked}`,
      `https://example.com/??api_key=${leaked}`,
      `https://example.com/#?token=${leaked}`,
      `https://example.com/?a=1&Client-Secret=${leaked}`,
      `https://example.com/?a=1;%74oken=${leaked}`,
      `https://example.com/#/callback?token=${leaked}`,
      `https://example.com/#token=${leaked}`,
      // Encoded delimiters delimit, however many times they were encoded.
      `https://example.com/#token%3D${leaked}`,
      `https://example.com/#/callback%3Ftoken%3D${leaked}`,
      `https://example.com/?a%3D1%26api_key%3D${leaked}`,
      `https://example.com/#token%253D${leaked}`,
      // A malformed byte beside an encoded delimiter hides nothing.
      `https://example.com/#token%3D%FF${leaked}`,
      `https://example.com/#token%3d%C0%AF${leaked}`,
      `https://example.com/#x=%FF%26token%3D${leaked}`,
      `https://example.com/#token%3D%C3${leaked}`,
      `https://example.com/#token%3D%E0%80%AF${leaked}`,
    ];
    for (const name of refusedNames) {
      const provider = await callTool(owner.key, "add_provider", { type: "openai", name });
      expectRefusal(provider, "invalid_request");
      expect(provider.structuredContent.message).toMatch(/^name: a URL here may not carry /u);
      const gateway = await callTool(owner.key, "add_provider_gateway", { gateway: { type: "vercel", name } });
      expectRefusal(gateway, "invalid_request");
      expect(gateway.structuredContent.message).toMatch(/^gateway\.name: a URL here may not carry /u);
      for (const refused of [provider, gateway]) expect(JSON.stringify(refused)).not.toContain(leaked);
    }
    const none = await env.DB.prepare("SELECT count(*) AS n FROM mgmt_operation WHERE organization_id = ?")
      .bind(owner.organizationId)
      .first<{ n: number }>();
    expect(none!.n).toBe(0);

    // A URL that carries nothing of the kind is a name like any other, and so
    // is a name the parser happens to read as a URL.
    const harmless = [
      "https://example.com/?version=2",
      "https://example.com/#/settings",
      "https://example.com/?page=2&sort=name",
      "OpenAI: production",
      "foo:bar",
    ];
    const operations: string[] = [];
    for (const name of harmless) {
      const opened = await callTool(owner.key, "add_provider", { type: "openai", name });
      expect(opened.isError, `${name}: ${opened.content[0]?.text}`).toBeFalsy();
      operations.push(opened.structuredContent.id);
    }
    for (const name of harmless.slice(0, 2)) {
      const gateway = await callTool(owner.key, "add_provider_gateway", { gateway: { type: "vercel", name } });
      expect(gateway.isError, `${name}: ${gateway.content[0]?.text}`).toBeFalsy();
      operations.push(gateway.structuredContent.id);
    }
    // A fragment route names no parameter, whatever its words. Another
    // account, whose operation allowance this test has not spent.
    const routed = await account("mcp-browser-url-routes@example.test");
    for (const name of [
      "https://example.com/#/token",
      "https://example.com/#/settings/password",
      "https://example.com/#/callback",
      "https://example.com/#/docs%2Fsettings",
      "https://example.com/?q=caf%C3%A9",
      "https://example.com/?q=%FF",
    ]) {
      const opened = await callTool(routed.key, "add_provider", { type: "openai", name });
      expect(opened.isError, `${name}: ${opened.content[0]?.text}`).toBeFalsy();
      const row = await env.DB.prepare("SELECT json_extract(payload, '$.review.name') AS name FROM mgmt_operation WHERE id = ?")
        .bind(opened.structuredContent.id)
        .first<{ name: string }>();
      expect(row!.name).toBe(name);
    }
    const routedGateway = await callTool(routed.key, "add_provider_gateway", {
      gateway: { type: "vercel", name: "https://example.com/#/settings/password" },
    });
    expect(routedGateway.isError, routedGateway.content[0]?.text).toBeFalsy();
    for (const [index, id] of operations.entries()) {
      const row = await env.DB.prepare("SELECT json_extract(payload, '$.review.name') AS name FROM mgmt_operation WHERE id = ?")
        .bind(id)
        .first<{ name: string }>();
      expect(row!.name).toBe(index < harmless.length ? harmless[index] : harmless[index - harmless.length]);
    }
  });

  it("cuts off a pathological argument at the door, and decodes in linear time", async () => {
    const owner = await account("mcp-browser-huge@example.test");
    const leaked = secret(`hugetail${crypto.randomUUID().replaceAll("-", "")}`);
    const name = `https://example.com/#q=${"%FF".repeat(100_000)}%26token%3D${leaked}`;
    for (const [tool, args, field] of [
      ["add_provider", { type: "openai", name }, "name"],
      ["add_provider_gateway", { gateway: { type: "vercel", name } }, "gateway.name"],
    ] as const) {
      const started = Date.now();
      const refused = await callTool(owner.key, tool, args);
      expect(Date.now() - started, tool).toBeLessThan(500);
      expectRefusal(refused, "invalid_request");
      expect(refused.structuredContent.message).toMatch(new RegExp(`^${field.replace(".", "\\.")}: longer than the \\d+ characters`, "u"));
      expect(JSON.stringify(refused)).not.toContain(leaked);
    }
    // The decoder itself is linear, and finds the escaped parameter past the malformed bytes.
    const started = Date.now();
    expect(credentialParameter(`#q=${"%FF".repeat(100_000)}%26token%3DX`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    expect(credentialParameter("#/docs%2Fsettings")).toBe(false);
    const opened = await env.DB.prepare("SELECT count(*) AS n FROM mgmt_operation WHERE organization_id = ?")
      .bind(owner.organizationId)
      .first<{ n: number }>();
    expect(opened!.n).toBe(0);
  });

  it("refuses a URL carrying credentials or a query before anything is stored", async () => {
    const owner = await account("mcp-browser-url@example.test");
    const leaked = secret(`urlsecret${crypto.randomUUID().replaceAll("-", "")}`);
    const urls = [`https://user:${leaked}@api.example.com/v1`, `https://api.example.com/v1?key=${leaked}`];
    for (const baseUrl of urls) {
      const provider = await callTool(owner.key, "add_provider", { type: "openai", name: "Url", baseUrl });
      expectRefusal(provider, "invalid_request");
      expect(provider.structuredContent.message).toMatch(/^baseUrl: /u);
      const gateway = await callTool(owner.key, "add_provider_gateway", {
        gateway: { type: "vercel", name: "Url gateway", baseUrl },
      });
      expectRefusal(gateway, "invalid_request");
      expect(gateway.structuredContent.message).toMatch(/^gateway\.baseUrl: /u);
    }
    const opened = await env.DB.prepare("SELECT count(*) AS n FROM mgmt_operation WHERE organization_id = ?")
      .bind(owner.organizationId)
      .first<{ n: number }>();
    expect(opened!.n).toBe(0);
  });

  it("opens a key rotation for a provider", async () => {
    const owner = await account("mcp-rotate@example.test");
    const opened = await callTool(owner.key, "rotate_provider_key", { id: `${owner.organizationId}-openai`, revision: 1 });
    expect(opened.isError, opened.content[0]?.text).toBeFalsy();
    expect(opened.structuredContent.url).toContain("/cli/approve/");
  });
});

describe("MCP direct changes", () => {
  async function withApp(email: string) {
    const owner = await account(email);
    const app = `mcp-direct-${crypto.randomUUID().slice(0, 8)}`;
    secret(await seedServerApp(app, {
      organizationId: owner.organizationId,
      proxy: { openai: { allowed_paths: [], allowed_models: [] } },
    }));
    return { ...owner, app };
  }

  it("updates an app against the revision it was read at", async () => {
    const owner = await withApp("mcp-update-app@example.test");
    const read = await callTool(owner.key, "get_app", { app: owner.app });
    // Warnings are computed on read and refused on write, like the id.
    const { name: _name, id: _id, revision, created_at: _c, updated_at: _u, warnings: _w, ...rest } = read.structuredContent.app;
    const document = { ...rest, name: "Renamed", revision };
    const updated = await callTool(owner.key, "update_app", { app: owner.app, config: document });
    expect(updated.isError, updated.content[0]?.text).toBeFalsy();
    expect(updated.structuredContent.app).toMatchObject({ name: "Renamed", revision: revision + 1 });

    const stale = await callTool(owner.key, "update_app", { app: owner.app, config: { ...document, name: "Stale" } });
    expectRefusal(stale, "app_revision_conflict");
    expect(stale.structuredContent.next).toContain("get_app");
    expectRefusal(
      await callTool(owner.read, "update_app", { app: owner.app, config: { ...document, revision: revision + 1 } }),
      "grant_insufficient",
    );
  });

  it("removes an app only with confirm equal to its id", async () => {
    const owner = await withApp("mcp-remove-app@example.test");
    expectRefusal(await callTool(owner.key, "remove_app", { app: owner.app }), "invalid_request");
    expectRefusal(await callTool(owner.key, "remove_app", { app: owner.app, confirm: "other" }), "invalid_request");
    expect(await appCount(owner.organizationId)).toBe(1);
    const removed = await callTool(owner.key, "remove_app", { app: owner.app, confirm: owner.app });
    expect(removed.structuredContent).toMatchObject({ deleted: true, app_id: owner.app });
    expect(await appCount(owner.organizationId)).toBe(0);
  });

  it("removes a provider only with confirm equal to its id", async () => {
    const owner = await account("mcp-remove-provider@example.test");
    const id = `${owner.organizationId}-openai`;
    expectRefusal(await callTool(owner.key, "remove_provider", { id }), "invalid_request");
    const removed = await callTool(owner.key, "remove_provider", { id, confirm: id });
    expect(removed.structuredContent).toMatchObject({ deleted: true, provider_id: id });
  });

  it("updates a provider's non-secret fields", async () => {
    const owner = await account("mcp-update-provider@example.test");
    const id = `${owner.organizationId}-openai`;
    const listed = await callTool(owner.read, "get_provider", { provider: id });
    const updated = await callTool(owner.key, "update_provider", {
      id,
      revision: listed.structuredContent.provider.revision,
      status: "disabled",
    });
    expect(updated.isError, updated.content[0]?.text).toBeFalsy();
    expect(updated.structuredContent.provider).toMatchObject({ id, status: "disabled" });
  });

  it("revokes an app key, and blocks and unblocks a user", async () => {
    const owner = await withApp("mcp-revoke-block@example.test");
    const keys = await callTool(owner.read, "list_app_keys", { app: owner.app });
    const key = keys.structuredContent.keys[0].id;
    const revoked = await callTool(owner.key, "revoke_app_key", { app: owner.app, key });
    expect(revoked.structuredContent.key).toMatchObject({ id: key, status: "revoked" });
    expectRefusal(await callTool(owner.read, "revoke_app_key", { app: owner.app, key }), "grant_insufficient");

    await env.DB.prepare("INSERT INTO app_user(app_id, id, status) VALUES (?, 'mcp-blocked', 'active')").bind(owner.app).run();
    const blocked = await callTool(owner.key, "block_app_user", { app: owner.app, user: "mcp-blocked" });
    expect(blocked.structuredContent).toMatchObject({ user_id: "mcp-blocked", blocked: true });
    const unblocked = await callTool(owner.key, "unblock_app_user", { app: owner.app, user: "mcp-blocked" });
    expect(unblocked.structuredContent).toMatchObject({ user_id: "mcp-blocked", blocked: false });

    // Another account's app is not there, whatever the tool.
    const stranger = await account("mcp-revoke-stranger@example.test");
    expectRefusal(await callTool(stranger.key, "block_app_user", { app: owner.app, user: "mcp-blocked" }), "app_not_found");
  });
});

describe("MCP result redaction", () => {
  it("redacts a credential-named field whole, whatever it holds, but for an app key's metadata", () => {
    const metadata = { id: "key_1", name: "Default key", key_prefix: "agw_1234", created_at: "2026-10-01T00:00:00.000Z" };
    expect(redactSecrets({
      secretHint: "abcd",
      tokenHint: "wxyz",
      max_tokens: 4096,
      key_prefix: "agw_1234",
      api_key: metadata,
      Token: "t",
      "API-KEY": "k",
      nested: [{ credentials: { token: "deep", note: "gone with it" } }, { access_token: "a" }, { port: 443 }],
      wrapped: { credentials: { value: "x" }, token: { raw: "x" }, authorization: ["Bearer x"], secret: 1234 },
      keys: [{ api_key: { value: "x" } }, { api_key: { ...metadata, key: "agw_plaintext" } }],
      credentials: null,
    }, [["api_key"]])).toEqual({
      secretHint: "abcd",
      tokenHint: "wxyz",
      max_tokens: 4096,
      key_prefix: "agw_1234",
      api_key: metadata,
      Token: REDACTED,
      "API-KEY": REDACTED,
      nested: [{ credentials: REDACTED }, { access_token: REDACTED }, { port: 443 }],
      wrapped: { credentials: REDACTED, token: REDACTED, authorization: REDACTED, secret: REDACTED },
      // An extra field, the key's own value included, gives up the exemption.
      keys: [{ api_key: REDACTED }, { api_key: REDACTED }],
      credentials: null,
    });
    // The exemption is a place, not a shape: the metadata's own shape anywhere
    // else, or with anything but plain values where it is exempt, is redacted.
    expect(redactSecrets({ api_key: metadata })).toEqual({ api_key: REDACTED });
    expect(redactSecrets({ app: { params: { api_key: { name: "X" } } } }, [["api_key"]]))
      .toEqual({ app: { params: { api_key: REDACTED } } });
    expect(redactSecrets({ api_key: { name: ["X"] } }, [["api_key"]])).toEqual({ api_key: REDACTED });
    expect(redactSecrets({ result: { api_key: metadata } }, [["result", "api_key"]]))
      .toEqual({ result: { api_key: metadata } });
  });

  it("names every credential name in the guide an agent reads", () => {
    for (const name of SECRET_FIELDS) expect(MCP_GUIDE, name).toContain(`\`${name}\``);
    // And the app key metadata the redaction keeps, as the schema has it.
    for (const field of Object.keys(AppKeyMetadataSchema.shape)) expect(MCP_GUIDE, field).toContain(`\`${field}\``);
    expect(MCP_GUIDE).toContain(REDACTED);
  });

  it("never shows a credential an app document was stored with outside MCP", async () => {
    const owner = await account("mcp-redact-stored@example.test");
    const stored = secret(`sk-stored-outside-${crypto.randomUUID()}`);
    const endpoint = { api_style: "responses", provider: "openai", model: "gpt-5.6-luna" };
    const document = (name: string) => ({
      name,
      config: serverConfig({
        proxy: { openai: { allowed_paths: [], allowed_models: [] } },
        endpoints: {
          chat: {
            api_style: "responses",
            provider: "openai",
            model: "gpt-5.6-luna",
            params: {
              store: false,
              credentials: { value: stored },
              token: { raw: stored },
              authorization: [`Bearer ${stored}`],
              api_key: { value: stored },
            },
          },
          // App key metadata in shape, stored where no key is ever created.
          named: { ...endpoint, params: { api_key: { name: stored } } },
          populated: {
            ...endpoint,
            params: { api_key: { id: stored, name: stored, key_prefix: stored, created_at: stored } },
          },
          listed: { ...endpoint, params: { api_key: { name: [stored] } } },
        },
      }),
    });

    // Through the admin API, which takes provider-native parameters as they are.
    const created = await send(`${ORIGIN}/v1/admin/apps`, {
      headers: { authorization: `Bearer ${owner.key}` },
      body: document("Stored over HTTP"),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { app, api_key } = await created.json<{ app: { id: string }; api_key: { key: string } }>();
    secret(api_key.key);

    // Through the CLI's operation, whose record keeps the app document.
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const sent = await send(`${ORIGIN}/v1/cli/operations`, {
      headers: { authorization: `Bearer ${owner.key}` },
      body: { kind: "app.add", payload: document("Stored by the CLI"), token },
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const operation = await sent.json<{ id: string; result: { api_key: { key: string } } }>();
    secret(operation.result.api_key.key);

    const read = await callTool(owner.read, "get_app", { app: app.id });
    // The app's read-only warnings pass through as the API returns them.
    expect(read.structuredContent.app.warnings).toEqual([]);
    const redactedParams = {
      store: false,
      credentials: REDACTED,
      token: REDACTED,
      authorization: REDACTED,
      api_key: REDACTED,
    };
    const listed = await callTool(owner.read, "list_apps");
    const status = await callTool(owner.read, "get_operation", { id: operation.id });
    for (const endpoints of [read.structuredContent.app.config.endpoints, status.structuredContent.result.app.config.endpoints]) {
      expect(endpoints.chat.params).toEqual(redactedParams);
      for (const name of ["named", "populated", "listed"]) expect(endpoints[name].params, name).toEqual({ api_key: REDACTED });
    }
    // The app key the CLI's create made is metadata, and is shown as it is.
    expect(status.structuredContent.result.api_key).toMatchObject({ name: "Default key", key_prefix: expect.any(String) });
    expect(status.structuredContent.result.api_key).not.toHaveProperty("key");
    for (const answer of [read, listed, status]) {
      expect(answer.isError, answer.content[0]?.text).toBeFalsy();
      expect(JSON.stringify(answer.structuredContent)).not.toContain(stored);
      expect(answer.content[0]!.text).not.toContain(stored);
    }

    // A hint is not a credential, and still reads as one.
    const providers = await callTool(owner.read, "list_providers");
    expect(providers.structuredContent.providers[0].secretHint).toMatch(/^.{2,4}$/u);
    expect(providers.structuredContent.providers[0].secretHint).not.toBe(REDACTED);
  });
});

describe("MCP get_operation", () => {
  it("hides another account's operations and the engine's internal kinds", async () => {
    const owner = await account("mcp-status-owner@example.test");
    const stranger = await account("mcp-status-stranger@example.test");
    const reserved = await callTool(owner.key, "add_app", { config: appDocument("Mine") });
    expectRefusal(await callTool(stranger.read, "get_operation", { id: reserved.structuredContent.id }), "operation_not_found");
    expectRefusal(await callTool(owner.read, "get_operation", { id: "op:does-not-exist" }), "operation_not_found");

    // A row of cf-auth's own namespace, in this very account, is not there.
    const now = Date.now();
    const internal = `internal-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO mgmt_operation(id, kind, state, organization_id, request_hash, poll_token_hash, outcome, created_at, updated_at, expires_at, retain_until)
       VALUES (?, 'cf-auth:oauth.authorize', 'completed', ?, 'x', ?, '{"secret":"never"}', ?, ?, ?, ?)`,
    ).bind(internal, owner.organizationId, crypto.randomUUID(), now, now, now + 600_000, now + 600_000).run();
    expectRefusal(await callTool(owner.read, "get_operation", { id: internal }), "operation_not_found");
  });

  it("shows a login only to its own account, and never its credential", async () => {
    const owner = await account("mcp-status-login@example.test");
    const stranger = await account("mcp-status-login-stranger@example.test");
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const opened = await send(`${ORIGIN}/v1/cli/login`, { body: { token, client: { label: "CLI on test" } } });
    expect(opened.status).toBe(200);
    const login = await opened.json<{ id: string; url: string }>();
    const approved = await send(`${ORIGIN}/v1/cli/browser/${encodeURIComponent(login.id)}/submit`, {
      headers: { origin: ORIGIN, cookie: owner.cookie },
      body: { submissionToken: new URL(login.url).hash.slice(1), approve: true, organizationId: owner.organizationId },
    });
    expect(approved.status, await approved.clone().text()).toBe(200);

    expectRefusal(await callTool(stranger.read, "get_operation", { id: login.id }), "operation_not_found");
    const own = await callTool(owner.read, "get_operation", { id: login.id });
    expect(own.structuredContent).toMatchObject({ kind: "login", state: "completed", result: { accountId: owner.organizationId } });
    expect(JSON.stringify(own.structuredContent)).not.toContain("credential");
    expect(own.structuredContent.reveal_url).toBeUndefined();
    // Reading the status collected nothing: the CLI still gets its key.
    const polled = await send(`${ORIGIN}/v1/cli/operations/${encodeURIComponent(login.id)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    const poll = await polled.json<{ result: { credential?: { token: string } } }>();
    expect(poll.result.credential?.token).toMatch(/^agw_mgmt_/u);
    secret(poll.result.credential!.token);
  });
});

describe("MCP claim_account", () => {
  it("opens a claim of an unclaimed account, and refuses one a person owns", async () => {
    const { manage: token } = await unclaimedAccount();

    const claim = await callTool(token, "claim_account");
    expect(claim.isError, claim.content[0]?.text).toBeFalsy();
    expect(claim.structuredContent.url).toMatch(new RegExp(`^${ORIGIN}/cli/approve/`, "u"));
    const status = await callTool(token, "get_operation", { id: claim.structuredContent.id });
    expect(status.structuredContent).toMatchObject({ kind: "claim", state: "pending" });

    const owned = await account("mcp-claim-owned@example.test");
    const refused = await callTool(owned.key, "claim_account");
    expectRefusal(refused, "conflict");
    expect(refused.structuredContent.next).toContain("already owns");
  });
});

describe("MCP every change tool", () => {
  /**
   * One account's whole lifecycle through the change tools, every one of them
   * run to success — every browser step approved, every reservation executed
   * and revealed — and each first refused to the account's read key. The
   * table is checked against the server's own, so a change tool added without
   * a step here fails.
   */
  it("runs every change tool to success, and refuses each to a read key", async () => {
    const owner = await account("mcp-every-change@example.test");
    const state: Record<string, any> = {};
    const unclaimed = await unclaimedAccount();

    interface Step {
      tool: string;
      args: () => Record<string, unknown>;
      /** The key the step runs with; the account's own unless the step needs another. */
      keys?: () => { manage: string; read: string };
      /** The deployment the step runs on; this file's own unless the step needs another. */
      through?: Env;
      after?: (result: ToolResult) => Promise<void> | void;
    }
    const opened = (result: ToolResult) => {
      expect(result.structuredContent.url).toContain("/cli/approve/");
      return result.structuredContent as { id: string; url: string };
    };
    const completed = async (id: string) => {
      const status = await callTool(owner.read, "get_operation", { id });
      expect(status.structuredContent.state, JSON.stringify(status.structuredContent)).toBe("completed");
      return status.structuredContent.result;
    };
    const steps: Step[] = [
      {
        tool: "add_provider_gateway",
        args: () => ({ gateway: { type: "vercel", name: "Every gateway" } }),
        after: async (result) => {
          const { id, url } = opened(result);
          await approve(url, `vck_gateway_${crypto.randomUUID()}`);
          state.gateway = (await completed(id)).gateway;
        },
      },
      {
        tool: "rotate_provider_gateway_key",
        args: () => ({ id: state.gateway.id, revision: state.gateway.revision }),
        after: async (result) => {
          const { id, url } = opened(result);
          await approve(url, `vck_rotated_${crypto.randomUUID()}`);
          state.gateway = (await completed(id)).gateway;
        },
      },
      {
        tool: "update_provider_gateway",
        args: () => ({ id: state.gateway.id, name: "Renamed gateway", revision: state.gateway.revision }),
        after: (result) => {
          expect(result.structuredContent.gateway).toMatchObject({ name: "Renamed gateway" });
          state.gateway = result.structuredContent.gateway;
        },
      },
      {
        tool: "add_provider",
        args: () => ({ type: "anthropic", name: "Every provider", slug: `every-${crypto.randomUUID().slice(0, 8)}` }),
        after: async (result) => {
          const { id, url } = opened(result);
          await approve(url, `sk-ant-every-${crypto.randomUUID()}`);
          state.provider = (await completed(id)).provider;
        },
      },
      {
        tool: "update_provider",
        args: () => ({ id: state.provider.id, revision: state.provider.revision, name: "Renamed provider" }),
        after: (result) => {
          state.provider = result.structuredContent.provider;
        },
      },
      {
        tool: "rotate_provider_key",
        args: () => ({ id: state.provider.id, revision: state.provider.revision }),
        after: async (result) => {
          const { id, url } = opened(result);
          const typed = `sk-ant-rotated-${crypto.randomUUID()}`;
          await approve(url, typed);
          state.provider = (await completed(id)).provider;
          expect(state.provider.secretHint).toBe(typed.slice(-4));
        },
      },
      {
        tool: "remove_provider",
        args: () => ({ id: state.provider.id, confirm: state.provider.id }),
        after: (result) => expect(result.structuredContent.deleted).toBe(true),
      },
      {
        tool: "remove_provider_gateway",
        args: () => ({ id: state.gateway.id, confirm: state.gateway.id }),
        after: (result) => expect(result.structuredContent.deleted).toBe(true),
      },
      {
        tool: "add_app",
        args: () => ({ config: appDocument("Every app") }),
        after: (result) => {
          state.appHandle = result.structuredContent.handle;
        },
      },
      {
        tool: "add_app",
        args: () => ({ config: appDocument("Every app"), handle: state.appHandle }),
        after: async (result) => {
          state.app = result.structuredContent.app;
          state.defaultKey = result.structuredContent.api_key;
          await collectKey(result, owner.cookie);
        },
      },
      {
        tool: "update_app",
        args: () => ({
          app: state.app.id,
          config: { name: "Every app, renamed", config: state.app.config, status: state.app.status, revision: state.app.revision },
        }),
        after: (result) => {
          state.app = result.structuredContent.app;
        },
      },
      {
        tool: "add_app_key",
        args: () => ({ app: state.app.id, name: "Every key" }),
        after: (result) => {
          state.keyHandle = result.structuredContent.handle;
        },
      },
      {
        tool: "add_app_key",
        args: () => ({ app: state.app.id, name: "Every key", handle: state.keyHandle }),
        after: async (result) => {
          await collectKey(result, owner.cookie);
        },
      },
      {
        tool: "revoke_app_key",
        args: () => ({ app: state.app.id, key: state.defaultKey.id }),
        after: async (result) => {
          expect(result.structuredContent.key.status).toBe("revoked");
          await env.DB.prepare("INSERT INTO app_user(app_id, id, status) VALUES (?, 'every-user', 'active')")
            .bind(state.app.id)
            .run();
        },
      },
      {
        tool: "block_app_user",
        args: () => ({ app: state.app.id, user: "every-user" }),
        after: (result) => expect(result.structuredContent.blocked).toBe(true),
      },
      {
        tool: "unblock_app_user",
        args: () => ({ app: state.app.id, user: "every-user" }),
        after: (result) => expect(result.structuredContent.blocked).toBe(false),
      },
      {
        tool: "remove_app",
        args: () => ({ app: state.app.id, confirm: state.app.id }),
        after: (result) => expect(result.structuredContent.deleted).toBe(true),
      },
      {
        tool: "claim_account",
        args: () => ({}),
        keys: () => unclaimed,
        after: (result) => {
          opened(result);
        },
      },
    ];

    // Offered only by a deployment with billing, a help desk and an inbox, to
    // an account on a paid plan; `test/support.test.ts` covers the refusals.
    const supported = new Proxy(runtime, {
      get(target, key, receiver) {
        if (key === "BILLING") {
          return {
            getTenantAccess: async () => ({
              plan: { planKey: "pro", planName: "Pro", isDefault: false },
              subscription: null,
            }),
          };
        }
        if (key === "HELPDESK") {
          return {
            createTicket: async () => ({ ok: true, reference: "SUP-7F3K2Q", duplicate: false, delivered: true, replyTo: "x@example.test" }),
          };
        }
        if (key === "SUPPORT_EMAIL") return "support@example.test";
        return Reflect.get(target, key, receiver);
      },
    }) as Env;
    steps.push({
      tool: "contact_support",
      args: () => ({ kind: "feedback", message: `Every change tool ran (${crypto.randomUUID()}).` }),
      through: supported,
      after: (result) => {
        expect(result.structuredContent).toMatchObject({ status: "sent", duplicate: false });
        expect(result.structuredContent.reference).toMatch(/^SUP-[2-9A-Z]{6}$/u);
      },
    });

    const changeTools = MCP_TOOLS.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name);
    expect([...new Set(steps.map((step) => step.tool))].sort()).toEqual([...changeTools].sort());

    for (const step of steps) {
      const keys = step.keys?.() ?? { manage: owner.key, read: owner.read };
      const args = step.args();
      expectRefusal(await callTool(keys.read, step.tool, args, step.through), "grant_insufficient");
      const result = await callTool(keys.manage, step.tool, args, step.through);
      expect(result.isError, `${step.tool}: ${result.content[0]?.text}`).toBeFalsy();
      await step.after?.(result);
    }
  });
});

describe("MCP answers", () => {
  it("never carried a key or a secret this file made", () => {
    expect(secrets.length).toBeGreaterThan(4);
    for (const secret of secrets) {
      for (const body of answered) expect(body.includes(secret)).toBe(false);
    }
  });
});
