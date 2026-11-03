import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Everything the smoke tests are configured with.
 *
 * Secrets arrive only through the environment, never as arguments. What
 * `setup` creates in the test account (application ids and their API keys) is
 * kept in a state file beside them, one per gateway, so a local gateway and a
 * deployed one never share fixtures.
 */
export interface SmokeEnv {
  /** Origin of the gateway under test, with no trailing slash. */
  gatewayUrl: string;
  /**
   * Origin of its console, sign-in and console API. The same as `gatewayUrl`
   * unless the deployment gives the console a host of its own, whose API host
   * then refuses those paths.
   */
  consoleUrl: string;
  /** A `manage` management key of the dedicated test account. */
  managementKey: string | undefined;
  /** Public https origin the mock provider answers on. */
  mockUrl: string | undefined;
  /** The fake provider key the mock accepts; stored in the gateway as each mock provider's secret. */
  mockSecret: string | undefined;
  /** Private JWK (JSON) the test issuer signs end-user tokens with. */
  issuerKey: string | undefined;
  /** Who runs these tests; names the application keys this runner owns. */
  runner: string;
  stateFile: string;
}

const SMOKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function value(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

function origin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${name} must be an http(s) URL`);
  return url.origin;
}

/**
 * Reads the configuration. `SMOKE_ENV_FILE` names a dotenv file to load first,
 * for running by hand; variables already set take precedence over it.
 */
export function smokeEnv(): SmokeEnv {
  const envFile = value("SMOKE_ENV_FILE");
  if (envFile) process.loadEnvFile(envFile);
  const gateway = value("SMOKE_GATEWAY_URL");
  if (!gateway) throw new Error("Set SMOKE_GATEWAY_URL to the gateway under test");
  const gatewayUrl = origin(gateway, "SMOKE_GATEWAY_URL");
  const consoleOrigin = value("SMOKE_CONSOLE_URL");
  const mock = value("SMOKE_MOCK_URL");
  return {
    gatewayUrl,
    consoleUrl: consoleOrigin === undefined ? gatewayUrl : origin(consoleOrigin, "SMOKE_CONSOLE_URL"),
    managementKey: value("SMOKE_MANAGEMENT_KEY"),
    mockUrl: mock === undefined ? undefined : origin(mock, "SMOKE_MOCK_URL"),
    mockSecret: value("SMOKE_MOCK_SECRET"),
    issuerKey: value("SMOKE_ISSUER_KEY"),
    runner: value("SMOKE_RUNNER") ?? "local",
    stateFile: value("SMOKE_STATE_FILE")
      ?? resolve(SMOKE_ROOT, ".state", `${new URL(gatewayUrl).host.replaceAll(":", "_")}.json`),
  };
}

/** A setting a step cannot do without, with the variable to set named in the failure. */
export function need<K extends keyof SmokeEnv>(env: SmokeEnv, key: K, variable: string): NonNullable<SmokeEnv[K]> {
  const setting = env[key];
  if (setting === undefined || setting === null) throw new Error(`Set ${variable}`);
  return setting as NonNullable<SmokeEnv[K]>;
}

/** What `setup` created, which every test reads. Holds application keys: written owner-only. */
export interface SmokeState {
  gatewayUrl: string;
  runner: string;
  apps: {
    server: { id: string; key: string };
    signedIn: { id: string; key: string };
    ios: { id: string };
  };
}

export function readState(env: SmokeEnv): SmokeState {
  let text: string;
  try {
    text = readFileSync(env.stateFile, "utf8");
  } catch {
    throw new Error(`No smoke fixtures for ${env.gatewayUrl}; run \`pnpm --filter @app-ai-gateway/smoke run setup\` first`);
  }
  const state = JSON.parse(text) as SmokeState;
  if (state.gatewayUrl !== env.gatewayUrl) {
    throw new Error(`${env.stateFile} belongs to ${state.gatewayUrl}, not ${env.gatewayUrl}`);
  }
  return state;
}

export function readStateIfAny(env: SmokeEnv): SmokeState | undefined {
  try {
    return readState(env);
  } catch {
    return undefined;
  }
}

export function writeState(env: SmokeEnv, state: SmokeState): void {
  mkdirSync(dirname(env.stateFile), { recursive: true, mode: 0o700 });
  writeFileSync(env.stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(env.stateFile, 0o600);
}
