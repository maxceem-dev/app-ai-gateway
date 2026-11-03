import { randomUUID } from "node:crypto";
import { need, type SmokeEnv } from "./env.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Sent as JSON unless it is already a string. */
  body?: unknown;
  /** Sent as `Authorization: Bearer <key>`. */
  key?: string;
  timeoutMs?: number;
  /** Sent to the console's origin rather than the gateway's. */
  console?: boolean;
}

/** One request to the gateway, bounded by a timeout so a hung deployment fails rather than stalls. */
export async function call(env: SmokeEnv, path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.key !== undefined) headers.authorization = `Bearer ${options.key}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    headers["content-type"] ??= "application/json";
  }
  return fetch(`${options.console ? env.consoleUrl : env.gatewayUrl}${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

/**
 * A refusal the gateway answered, described by its status and error code only.
 * The message is the gateway's own and safe to show; bodies never are, because
 * a proxied one is the provider's and a management one may hold a new key.
 */
export class GatewayFailure extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(what: string, status: number, code: string | undefined, message: string | undefined) {
    super(`${what} answered ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`);
    this.status = status;
    this.code = code;
  }
}

/** The gateway's `{ error: { code, message } }`, when the body is one. */
export async function gatewayError(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof body.error?.code === "string" ? body.error.code : undefined;
    const message = typeof body.error?.message === "string" ? body.error.message.slice(0, 200) : undefined;
    return { code, message };
  } catch {
    return {};
  }
}

/** A management API call with the test account's key; throws {@link GatewayFailure} on any non-2xx. */
export async function admin<T>(env: SmokeEnv, method: string, path: string, body?: unknown): Promise<T> {
  const response = await call(env, path, {
    method,
    body,
    key: need(env, "managementKey", "SMOKE_MANAGEMENT_KEY"),
  });
  if (!response.ok) {
    const { code, message } = await gatewayError(response);
    throw new GatewayFailure(`${method} ${path}`, response.status, code, message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * A marker for one request. It travels inside the body, which the gateway
 * passes through untouched, so the mock provider can file what it saw under it
 * and echo it back.
 */
export function smokeId(): string {
  return `smoke-${randomUUID()}`;
}
