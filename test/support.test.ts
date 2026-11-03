import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingAccess, BillingRuntime } from "../src/billing/contract";
import type { HelpdeskRuntime, HelpdeskTicketInput, HelpdeskTicketResult } from "../src/helpdesk/contract";
import worker from "../src/index";
import { clearIsolateCaches, seedHuman, type SeededHuman } from "./helpers";

vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "https://example.test";

function plan(planName: string, isDefault: boolean): BillingAccess {
  return { plan: { planKey: planName.toLowerCase(), planName, isDefault }, subscription: null };
}

/** A deployment as a test needs it: with or without billing, a help desk and an inbox. */
function runtime(
  options: {
    access?: BillingAccess | "unreachable" | null;
    helpdesk?: false | "unreachable" | ((input: HelpdeskTicketInput) => HelpdeskTicketResult);
    inbox?: string | null;
  } = {},
) {
  const tickets: HelpdeskTicketInput[] = [];
  const helpdesk: HelpdeskRuntime = {
    createTicket: async (input) => {
      if (options.helpdesk === "unreachable") throw new Error("the help desk is down");
      tickets.push(input);
      if (typeof options.helpdesk === "function") return options.helpdesk(input);
      return { ok: true, reference: "SUP-7F3K2Q", duplicate: false, delivered: true, replyTo: input.customer.email };
    },
  };
  const billing = options.access === null ? undefined : ({
    getTenantAccess: async () => {
      if (options.access === "unreachable") throw new Error("billing is down");
      return options.access ?? plan("Pro", false);
    },
  } as Partial<BillingRuntime>);
  const testEnv = new Proxy(env, {
    get(target, property, receiver) {
      if (property === "BILLING") return billing;
      if (property === "HELPDESK") return options.helpdesk === false ? undefined : helpdesk;
      if (property === "SUPPORT_EMAIL") return options.inbox === null ? undefined : options.inbox ?? "support@example.test";
      if (property === "DEPLOYMENT_ID") return "support-test-deployment";
      if (property === "CLI_CONSOLE_ORIGIN") return ORIGIN;
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
  return { env: testEnv, tickets };
}

async function capabilities(testEnv: Env): Promise<{ supportEmail?: string }> {
  const response = await worker.fetch(new Request(`${ORIGIN}/v1/console/capabilities`), testEnv, createExecutionContext());
  return response.json();
}

/** Sent as the console sends it, with the session cookie, or as the CLI does, with a key. */
async function send(testEnv: Env, credential: { cookie: string } | { key: string }, body: Record<string, unknown>) {
  const auth: Record<string, string> = "cookie" in credential
    ? { cookie: credential.cookie, "x-console-request": "1" }
    : { authorization: `Bearer ${credential.key}` };
  return worker.fetch(
    new Request(`${ORIGIN}/v1/admin/support`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    testEnv,
    createExecutionContext(),
  );
}

async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code;
}

/** A management key for this person, with the grant asked for. */
async function managementKey(human: SeededHuman, grant: "read" | "manage"): Promise<string> {
  const created = await worker.fetch(
    new Request(`${ORIGIN}/v1/admin/keys`, {
      method: "POST",
      headers: { cookie: human.cookie, "x-console-request": "1", "content-type": "application/json" },
      body: JSON.stringify({ name: `support ${grant}`, grant }),
    }),
    env,
    createExecutionContext(),
  );
  expect(created.status).toBe(201);
  return (await created.json<{ key: { plaintext: string } }>()).key.plaintext;
}

async function listedTools(testEnv: Env, key: string): Promise<string[]> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "support-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
    testEnv,
    createExecutionContext(),
  );
  expect(response.status).toBe(200);
  const message = await response.json<{ result: { tools: { name: string }[] } }>();
  return message.result.tools.map((tool) => tool.name);
}

const MESSAGE = { kind: "bug", message: "Streams stop halfway.", page: "/apps/demo/usage" };

beforeEach(() => clearIsolateCaches());

describe("support", () => {
  it("is advertised only where billing, a help desk and an inbox are all configured", async () => {
    expect((await capabilities(runtime().env)).supportEmail).toBe("support@example.test");
    expect((await capabilities(runtime({ access: null }).env)).supportEmail).toBeUndefined();
    expect((await capabilities(runtime({ helpdesk: false }).env)).supportEmail).toBeUndefined();
    expect((await capabilities(runtime({ inbox: null }).env)).supportEmail).toBeUndefined();
    expect((await capabilities(runtime({ inbox: "not an address" }).env)).supportEmail).toBeUndefined();
  });

  it("opens a ticket for a paid plan, as the person, with their account and the page", async () => {
    const human = await seedHuman();
    const { env: testEnv, tickets } = runtime();
    const response = await send(testEnv, human, MESSAGE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "sent", reference: "SUP-7F3K2Q", replyTo: human.email, duplicate: false });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      serviceId: "app-ai-gateway",
      kind: "bug",
      message: "Streams stop halfway.",
      customer: { email: human.email, userId: expect.any(String) },
      account: { tenantId: expect.any(String), plan: "Pro" },
      channel: "console",
      page: `${ORIGIN}/apps/demo/usage`,
    });
  });

  it("takes a manage key, as the CLI sends, with its diagnostics, and refuses a read key", async () => {
    const human = await seedHuman();
    const { env: testEnv, tickets } = runtime();
    const read = await send(testEnv, { key: await managementKey(human, "read") }, MESSAGE);
    expect(read.status).toBe(403);
    expect(await errorCode(read)).toBe("grant_insufficient");

    const response = await send(testEnv, { key: await managementKey(human, "manage") }, {
      kind: "support",
      message: "How do I rotate a key?",
      context: { app_id: "demo", agw_version: "0.10.3" },
      client: "agw 0.10.3",
    });
    expect(response.status).toBe(200);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      kind: "support",
      customer: { email: human.email },
      channel: expect.stringMatching(/^(cli|api)$/u),
      client: "agw 0.10.3",
      context: { app_id: "demo", agw_version: "0.10.3" },
    });
  });

  it("lists contact_support over MCP only where the deployment offers support", async () => {
    const human = await seedHuman();
    const key = await managementKey(human, "manage");
    expect(await listedTools(runtime().env, key)).toContain("contact_support");
    expect(await listedTools(runtime({ access: null }).env, key)).not.toContain("contact_support");
    expect(await listedTools(runtime({ helpdesk: false }).env, key)).not.toContain("contact_support");
  });

  it("refuses the free default plan with its own code, and a deployment that offers no support", async () => {
    const human = await seedHuman();
    const free = runtime({ access: plan("Free", true) });
    const refused = await send(free.env, human, MESSAGE);
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("support_plan_required");
    expect(free.tickets).toHaveLength(0);

    for (const options of [{ access: null }, { helpdesk: false }] as const) {
      const unsupported = runtime(options);
      expect((await send(unsupported.env, human, MESSAGE)).status).toBe(404);
      expect(unsupported.tickets).toHaveLength(0);
    }
  });

  it("still sends while billing cannot be reached, and says the plan is unknown", async () => {
    const human = await seedHuman();
    const { env: testEnv, tickets } = runtime({ access: "unreachable" });
    expect((await send(testEnv, human, MESSAGE)).status).toBe(200);
    expect(tickets[0]!.account?.plan).toBe("unknown (billing unreachable)");
  });

  it("answers what the help desk refuses with the gateway's own errors", async () => {
    const human = await seedHuman();
    const cases: [HelpdeskTicketResult & { ok: false }, number, string][] = [
      [{ ok: false, code: "credential_detected", message: "The message looks like it contains a provider API key." }, 400, "invalid_request"],
      [{ ok: false, code: "invalid_input", message: "page: Invalid URL" }, 400, "invalid_request"],
      [{ ok: false, code: "rate_limited", message: "Too many tickets.", retryAfterSeconds: 120 }, 429, "rate_limited"],
      [{ ok: false, code: "unknown_service", message: "Unknown service." }, 404, "not_found"],
    ];
    for (const [result, status, code] of cases) {
      const response = await send(runtime({ helpdesk: () => result }).env, human, MESSAGE);
      expect(response.status, result.code).toBe(status);
      if (result.code !== "unknown_service") {
        expect(await response.clone().text()).toContain(result.message);
      }
      expect(await errorCode(response)).toBe(code);
      if (result.code === "rate_limited") expect(response.headers.get("Retry-After")).toBe("120");
    }
  });

  it("passes on a repeat the help desk recognised", async () => {
    const human = await seedHuman();
    const { env: testEnv } = runtime({
      helpdesk: (input) => ({ ok: true, reference: "SUP-7F3K2Q", duplicate: true, delivered: true, replyTo: input.customer.email }),
    });
    expect(await (await send(testEnv, human, MESSAGE)).json()).toMatchObject({ reference: "SUP-7F3K2Q", duplicate: true });
  });

  it("asks to try again later when the help desk cannot be reached", async () => {
    const human = await seedHuman();
    const failed = await send(runtime({ helpdesk: "unreachable" }).env, human, MESSAGE);
    expect(failed.status).toBe(503);
    expect(await errorCode(failed)).toBe("email_unavailable");
  });

  it("refuses an empty message, a page off the console and malformed context", async () => {
    const human = await seedHuman();
    const { env: testEnv, tickets } = runtime();
    expect((await send(testEnv, human, { ...MESSAGE, message: "   " })).status).toBe(400);
    expect((await send(testEnv, human, { ...MESSAGE, page: "//evil.test" })).status).toBe(400);
    expect((await send(testEnv, human, { ...MESSAGE, context: { "bad name": "x" } })).status).toBe(400);
    expect(tickets).toHaveLength(0);
  });
});
