import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, test } from "vitest";
import { need } from "../../../src/env.ts";
import { APP_NAMES } from "../../../src/fixtures.ts";
import { env } from "../../support.ts";

// A real MCP client, connected the way an agent connects with a management key.
const client = new Client({ name: "app-ai-gateway-smoke", version: "1.0.0" });

beforeAll(async () => {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", env.gatewayUrl), {
    requestInit: { headers: { authorization: `Bearer ${need(env, "managementKey", "SMOKE_MANAGEMENT_KEY")}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
});

test("an MCP client lists the gateway's tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["list_apps", "list_providers"]));
});

test("an MCP client reads the account's apps", async () => {
  const result = await client.callTool({ name: "list_apps", arguments: {} });
  expect(result.isError ?? false).toBe(false);
  expect(JSON.stringify(result.content)).toContain(APP_NAMES.server);
});
