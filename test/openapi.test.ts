import { describe, expect, it } from "vitest";
import { createOpenAPIDocument } from "../src/contracts/openapi";
import { AppWriteSchema } from "../src/contracts/schemas";
import { appleConfig, serverConfig } from "./helpers";

describe("generated OpenAPI contract", () => {
  it("hides marked endpoints from documentation without rewriting visible contracts", () => {
    const full = createOpenAPIDocument();
    const docs = createOpenAPIDocument({ includeHidden: false });
    const hiddenPaths = [
      "/v1/admin/billing/plans", "/v1/admin/billing/status",
      "/v1/admin/billing/checkout", "/v1/admin/billing/change",
      "/v1/admin/billing/resume", "/v1/admin/billing/cancel",
      "/v1/admin/billing/trial", "/v1/admin/support",
    ];
    for (const path of hiddenPaths) {
      expect(full.paths).toHaveProperty(path);
      expect(docs.paths).not.toHaveProperty(path);
    }
    for (const [path, operation] of Object.entries(full.paths ?? {})) {
      if (!hiddenPaths.includes(path)) expect(docs.paths?.[path]).toEqual(operation);
    }
    for (const [name, schema] of Object.entries(docs.components?.schemas ?? {})) {
      expect(schema).toEqual(full.components?.schemas?.[name]);
    }
    expect(createOpenAPIDocument()).toEqual(full);
  });

  it("has unique operation IDs and covers every public API family", () => {
    const document = createOpenAPIDocument();
    const operations = Object.values(document.paths ?? {}).flatMap((path) =>
      Object.values(path ?? {}).filter(
        (operation): operation is { operationId?: string } =>
          typeof operation === "object" && operation !== null && "operationId" in operation,
      ),
    );
    const ids = operations.map((operation) => operation.operationId);

    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(document.paths).toHaveProperty("/v1/healthz");
    expect(document.paths).toHaveProperty("/v1/apps/{app}/auth/token");
    expect(document.paths).toHaveProperty("/v1/apps/{app}/proxy/{provider}/{path}");
    expect(document.paths).toHaveProperty("/v1/apps/{app}/endpoints/{slug}");
    expect(document.paths).toHaveProperty("/v1/admin/apps");
    expect(document.paths).toHaveProperty("/v1/admin/apps/{app}/usage");
    expect(document.paths).toHaveProperty("/v1/auth/sign-up/email");
    expect(document.paths).toHaveProperty("/v1/auth/sign-in/email");
    expect(document.paths).toHaveProperty("/v1/admin/keys");
    expect(document.paths).toHaveProperty("/v1/console/capabilities");
    expect(document.paths).toHaveProperty("/v1/admin/billing/status");
    expect(document.paths).toHaveProperty("/v1/admin/billing/checkout");
    expect(document.components?.securitySchemes).toHaveProperty("ConsoleSession");
    expect(document.components?.securitySchemes).toHaveProperty("ManagementBearer");
    expect(document.components?.schemas?.UsageEvent).toHaveProperty(
      "properties.api_key_id.type",
      ["string", "null"],
    );
  });

  // The zod-to-OpenAPI conversion stringifies a flagged RegExp with its flag
  // still attached ("…$/u"), which every standard validator then reads as part
  // of the expression and uses to reject values the gateway accepts.
  it("publishes bare regular expressions, never JavaScript literals", () => {
    const patterns: { path: string; pattern: string }[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}/${index}`));
      } else if (typeof node === "object" && node !== null) {
        for (const [key, value] of Object.entries(node)) {
          if (key === "pattern" && typeof value === "string") {
            patterns.push({ path, pattern: value });
          }
          walk(value, `${path}/${key}`);
        }
      }
    };
    walk(createOpenAPIDocument(), "");

    expect(patterns.length).toBeGreaterThan(0);
    for (const { path, pattern } of patterns) {
      expect(pattern, path).not.toMatch(/\/[dgimsuvy]*$/);
      expect(new RegExp(pattern).source, path).toBe(pattern);
    }

    // The documented patterns must accept the values the gateway itself does.
    const documented = (path: string) =>
      patterns.find((entry) => entry.path.endsWith(path))?.pattern;
    const slug = documented("/components/schemas/ProviderCreateRequest/properties/slug");
    expect(slug).toBeDefined();
    expect(new RegExp(slug!).test("openai")).toBe(true);
    expect(new RegExp(slug!).test("openai-dev")).toBe(true);
    expect(new RegExp(slug!).test("Openai")).toBe(false);
  });

  it("accepts representative server and mobile application examples", () => {
    for (const [name, config] of [
      ["server", serverConfig()],
      ["mobile", appleConfig({ jwks_url: "https://issuer.example/.well-known/jwks.json" })],
    ] as const) {
      expect(AppWriteSchema.safeParse({ name: `${name} example`, config }), name).toMatchObject({
        success: true,
      });
    }
  });
});
