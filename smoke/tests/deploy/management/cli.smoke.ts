import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { need } from "../../../src/env.ts";
import { APP_NAMES, PROVIDERS } from "../../../src/fixtures.ts";
import { env } from "../../support.ts";

const run = promisify(execFile);
const SMOKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Where the CLI connects. The CLI accepts only HTTPS, or plain HTTP on a
 * loopback address, so a local gateway behind an `http://….localhost` name
 * needs SMOKE_CLI_URL set to its loopback address.
 */
const cliUrl = process.env.SMOKE_CLI_URL?.trim() || env.gatewayUrl;
const reachable = (() => {
  const { protocol, hostname } = new URL(cliUrl);
  return protocol === "https:" || hostname === "localhost" || hostname === "[::1]" || /^127\./u.test(hostname);
})();

/**
 * The CLI versions to run: `current` is the CLI built from this checkout, and
 * the others are published versions, such as the oldest one still supported.
 * That promise is kept by whoever monitors the deployment, not here, so a
 * change in this repository cannot quietly drop an old version.
 */
const versions = (process.env.SMOKE_CLI_VERSIONS?.trim() || "current")
  .split(",")
  .map((version) => version.trim())
  .filter(Boolean);

/** The `agw` entry point for a version: this checkout's build, or the published package, installed once. */
async function cliFor(version: string): Promise<string> {
  if (version === "current") {
    const built = resolve(SMOKE_ROOT, "../cli/dist/agw.mjs");
    if (!existsSync(built)) throw new Error("Build this checkout's CLI first: pnpm cli:build");
    return built;
  }
  const prefix = resolve(SMOKE_ROOT, ".state/cli", version);
  const entry = join(prefix, "node_modules/@maxceem/agw/dist/agw.mjs");
  if (!existsSync(entry)) {
    await run("npm", ["install", "--prefix", prefix, "--no-save", "--no-audit", "--no-fund", `@maxceem/agw@${version}`], {
      timeout: 120_000,
    });
  }
  return entry;
}

const homes: string[] = [];
afterAll(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

for (const version of versions) {
  describe.skipIf(!reachable)(`agw ${version}`, () => {
    // A home of its own per version: no stored login, nothing shared with the
    // person running the tests, and only the management key in the environment.
    const home = mkdtempSync(join(tmpdir(), "agw-smoke-"));
    homes.push(home);
    const cli = cliFor(version);
    const agw = async (...args: string[]) => {
      try {
        const { stdout } = await run(process.execPath, [await cli, ...args], {
          timeout: 60_000,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            XDG_STATE_HOME: join(home, "state"),
            XDG_CACHE_HOME: join(home, "cache"),
            XDG_CONFIG_HOME: join(home, "config"),
            NO_COLOR: "1",
            AGW_MANAGEMENT_KEY: need(env, "managementKey", "SMOKE_MANAGEMENT_KEY"),
          },
        });
        return stdout;
      } catch (error) {
        // With --json the CLI reports its refusal on stdout, as one JSON object.
        const { code, signal, stdout, stderr } = error as { code?: number; signal?: string; stdout?: string; stderr?: string };
        if (code === undefined && signal === undefined) throw error;
        const output = `${String(stdout ?? "")}${String(stderr ?? "")}`.trim().slice(0, 500);
        throw new Error(`agw ${version} ${args.join(" ")} ${signal ? `was stopped by ${signal}` : `exited ${code}`}: ${output}`);
      }
    };

    test("connects to the gateway and lists apps and providers", { timeout: 180_000 }, async () => {
      await agw("deployment", "connect", "--url", cliUrl, "--json");
      expect(await agw("app", "list", "--json")).toContain(APP_NAMES.server);
      expect(await agw("provider", "list", "--json")).toContain(PROVIDERS[0]!.slug);
    });
  });
}
