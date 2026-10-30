import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingAccess, BillingRuntime } from "../src/billing/contract";
import worker from "../src/index";
import { clearIsolateCaches, seedHuman } from "./helpers";

vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "https://example.test";

type Sent = { from: { email: string; name: string }; replyTo?: string; to: string; subject: string; text: string; html: string };

function plan(planName: string, isDefault: boolean): BillingAccess {
  return { plan: { planKey: planName.toLowerCase(), planName, isDefault }, subscription: null };
}

/** A deployment as a test needs it: with or without billing, email and an inbox. */
function runtime(options: { access?: BillingAccess | "unreachable" | null; email?: boolean; inbox?: string | null } = {}) {
  const sent: Sent[] = [];
  const binding = { send: vi.fn(async (message: Sent) => void sent.push(message)) };
  const billing = options.access === null ? undefined : ({
    getTenantAccess: async () => {
      if (options.access === "unreachable") throw new Error("billing is down");
      return options.access ?? plan("Pro", false);
    },
  } as Partial<BillingRuntime>);
  const testEnv = new Proxy(env, {
    get(target, property, receiver) {
      if (property === "BILLING") return billing;
      if (property === "EMAIL") return options.email === false ? undefined : binding;
      if (property === "EMAIL_FROM") return "gateway@example.test";
      if (property === "SUPPORT_EMAIL") return options.inbox === null ? undefined : options.inbox ?? "support@example.test";
      if (property === "DEPLOYMENT_ID") return "support-test-deployment";
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
  return { env: testEnv, sent };
}

async function capabilities(testEnv: Env): Promise<{ supportEmail?: string }> {
  const response = await worker.fetch(new Request(`${ORIGIN}/v1/console/capabilities`), testEnv, createExecutionContext());
  return response.json();
}

async function send(testEnv: Env, cookie: string, body: Record<string, unknown>) {
  return worker.fetch(
    new Request(`${ORIGIN}/v1/admin/support`, {
      method: "POST",
      headers: { cookie, "x-console-request": "1", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    testEnv,
    createExecutionContext(),
  );
}

const MESSAGE = { kind: "bug", message: "Halfway <b>through</b>.", page: "/apps/demo/usage" };

beforeEach(() => clearIsolateCaches());

describe("support", () => {
  it("is advertised only where billing, email and an inbox are all configured", async () => {
    expect((await capabilities(runtime().env)).supportEmail).toBe("support@example.test");
    expect((await capabilities(runtime({ access: null }).env)).supportEmail).toBeUndefined();
    expect((await capabilities(runtime({ email: false }).env)).supportEmail).toBeUndefined();
    expect((await capabilities(runtime({ inbox: null }).env)).supportEmail).toBeUndefined();
    expect((await capabilities(runtime({ inbox: "not an address" }).env)).supportEmail).toBeUndefined();
  });

  it("emails the inbox for a paid plan, with the sender as reply-to and the context below", async () => {
    const human = await seedHuman();
    const { env: testEnv, sent } = runtime();
    const response = await send(testEnv, human.cookie, MESSAGE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "sent", replyTo: human.email });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "support@example.test", replyTo: human.email, subject: `Bug report from ${human.email}` });
    expect(sent[0]!.from.email).toBe("gateway@example.test");
    expect(sent[0]!.text).toContain("Halfway <b>through</b>.");
    expect(sent[0]!.text).toContain(`Organization: `);
    expect(sent[0]!.text).toContain("Plan: Pro");
    expect(sent[0]!.text).toContain(`Page: ${ORIGIN}/apps/demo/usage`);
    // The message is the customer's text, never markup.
    expect(sent[0]!.html).toContain("Halfway &lt;b&gt;through&lt;/b&gt;.");
  });

  it("refuses the free default plan and a deployment that offers no support", async () => {
    const human = await seedHuman();
    const free = runtime({ access: plan("Free", true) });
    const refused = await send(free.env, human.cookie, MESSAGE);
    expect(refused.status).toBe(403);
    expect(free.sent).toHaveLength(0);

    const selfHosted = runtime({ access: null });
    expect((await send(selfHosted.env, human.cookie, MESSAGE)).status).toBe(404);
    expect(selfHosted.sent).toHaveLength(0);
  });

  it("still sends while billing cannot be reached, and says the plan is unknown", async () => {
    const human = await seedHuman();
    const { env: testEnv, sent } = runtime({ access: "unreachable" });
    expect((await send(testEnv, human.cookie, MESSAGE)).status).toBe(200);
    expect(sent[0]!.text).toContain("Plan: unknown (billing unreachable)");
  });

  it("refuses an empty message and a page off the console", async () => {
    const human = await seedHuman();
    const { env: testEnv, sent } = runtime();
    expect((await send(testEnv, human.cookie, { ...MESSAGE, message: "   " })).status).toBe(400);
    expect((await send(testEnv, human.cookie, { ...MESSAGE, page: "//evil.test" })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});
