import { expect, test } from "vitest";
import { call } from "../../src/gateway.ts";
import { env, expectStatus, json } from "../support.ts";

test("the console page and its script load", async () => {
  const page = await call(env, "/", { console: true });
  await expectStatus(page, 200, "GET /");
  expect(page.headers.get("content-type")).toContain("text/html");
  const html = await page.text();
  const script = /<script[^>]+type="module"[^>]+src="([^"]+)"/u.exec(html)?.[1];
  expect(script, "the console page names no module script").toBeTruthy();

  const asset = await fetch(new URL(script!, env.consoleUrl), { signal: AbortSignal.timeout(15_000) });
  expect(asset.status, `GET ${script}`).toBe(200);
  await asset.arrayBuffer();
});

test("the console's capabilities answer", async () => {
  const response = await call(env, "/v1/console/capabilities", { console: true });
  await expectStatus(response, 200, "GET /v1/console/capabilities");
  expect(await json(response, "GET /v1/console/capabilities")).toHaveProperty("registrationOpen");
});
