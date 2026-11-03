import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isMain } from "../cli.ts";
import { publicJwks } from "../issuer.ts";
import {
  anthropicMessage,
  authorized,
  error,
  FAILING_MODELS,
  geminiContent,
  models,
  openaiChat,
  openaiResponse,
  type Format,
  type Reply,
} from "./formats.ts";

/**
 * A fake AI provider for the smoke tests, and the test issuer's JWKS.
 *
 * Mock providers in the test account point their base URL here, one path
 * prefix per wire format (`/openai/`, `/anthropic/`, `/gemini/`). It answers
 * fixed responses, so it costs nothing and never forwards anything anywhere.
 *
 * It also checks the gateway on the way in. A request is refused unless it
 * carries the exact fake key in that format's own header, which proves the
 * gateway decrypted the stored secret and attached it correctly, and the mock
 * notes whether any client credential (`agw_…`) leaked through. Each
 * observation is filed under the smoke id found in the body; a test reads it
 * back from `/_seen/<id>`, authenticated with the same fake key.
 *
 * Nothing is logged but method, path prefix and status: never a body or a header.
 */

export interface Observation {
  format: Format;
  method: string;
  path: string;
  authorized: boolean;
  clientCredentialLeaked: boolean;
}

const MAX_BODY_BYTES = 1024 * 1024;
const OBSERVATION_TTL_MS = 10 * 60_000;
const MAX_OBSERVATIONS = 2_000;
const SMOKE_ID = /smoke-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

export interface MockOptions {
  secret: string;
  issuerKey: string;
  log?: (line: string) => void;
}

export function createMockServer(options: MockOptions): Server {
  const jwks = JSON.stringify(publicJwks(options.issuerKey));
  const seen = new Map<string, { at: number; observation: Observation }>();

  function remember(id: string, observation: Observation): void {
    const now = Date.now();
    for (const [key, entry] of seen) {
      if (seen.size < MAX_OBSERVATIONS && now - entry.at < OBSERVATION_TTL_MS) break;
      seen.delete(key);
    }
    seen.set(id, { at: now, observation });
  }

  async function handle(request: IncomingMessage): Promise<Reply> {
    const url = new URL(request.url ?? "/", "http://mock.invalid");
    const method = request.method ?? "GET";

    if (url.pathname === "/healthz") return reply(200, { ok: true });
    if (url.pathname === "/.well-known/jwks.json") return { status: 200, contentType: "application/json", body: jwks };

    const seenMatch = /^\/_seen\/(smoke-[0-9a-f-]{36})$/u.exec(url.pathname);
    if (seenMatch) {
      if (request.headers.authorization !== `Bearer ${options.secret}`) return reply(401, { error: "unauthorized" });
      const entry = seen.get(seenMatch[1]!);
      return entry ? reply(200, entry.observation) : reply(404, { error: "not_seen" });
    }

    const [, prefix, ...rest] = url.pathname.split("/");
    if (prefix !== "openai" && prefix !== "anthropic" && prefix !== "gemini") return reply(404, { error: "not_found" });
    const format: Format = prefix;
    const path = rest.join("/");

    const body = method === "GET" || method === "HEAD" ? "" : await readBody(request);
    const ok = authorized(format, request.headers, options.secret);
    const id = SMOKE_ID.exec(body)?.[0];
    if (id) {
      const leaked = Object.values(request.headers).some((value) => String(value).includes("agw_"));
      remember(id, { format, method, path, authorized: ok, clientCredentialLeaked: leaked });
    }
    if (!ok) return error(format, 401, "The smoke mock did not receive its key in this format's auth header");

    if (method === "GET" && (path === "v1/models" || path === "v1beta/models")) return models(format);
    if (method !== "POST") return error(format, 404, `No mock route for ${method} ${format}/${path}`);

    const parsed = parseJson(body);
    const text = `pong ${id ?? "no-smoke-id"}`;
    if (format === "gemini") {
      const route = /^v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/u.exec(path);
      if (!route) return error(format, 404, `No mock route for POST gemini/${path}`);
      const failure = FAILING_MODELS[route[1]!];
      if (failure) return error(format, failure, `Smoke failure ${failure}`);
      return geminiContent(text, route[1]!, route[2] === "streamGenerateContent");
    }

    const model = typeof parsed.model === "string" ? parsed.model : "";
    const failure = FAILING_MODELS[model];
    if (failure) return error(format, failure, `Smoke failure ${failure}`);
    const stream = parsed.stream === true;
    if (format === "openai" && path === "v1/chat/completions") return openaiChat(text, model, stream);
    if (format === "openai" && path === "v1/responses") return openaiResponse(text, model, stream);
    if (format === "anthropic" && path === "v1/messages") return anthropicMessage(text, model, stream);
    return error(format, 404, `No mock route for POST ${format}/${path}`);
  }

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    handle(request)
      .catch((): Reply => reply(400, { error: "bad_request" }))
      .then((result) => {
        // Provider calls only: health checks and observation reads would drown them.
        const prefix = new URL(request.url ?? "/", "http://mock.invalid").pathname.split("/")[1] ?? "";
        if (prefix !== "healthz" && prefix !== "_seen") options.log?.(`${request.method} ${prefix} ${result.status}`);
        response.writeHead(result.status, { "content-type": result.contentType, "cache-control": "no-store" });
        response.end(result.body);
      });
  });
}

function reply(status: number, body: unknown): Reply {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

if (isMain(import.meta.url)) {
  const secret = process.env.SMOKE_MOCK_SECRET?.trim();
  const issuerKey = process.env.SMOKE_ISSUER_KEY?.trim();
  if (!secret || !issuerKey) {
    console.error("Set SMOKE_MOCK_SECRET and SMOKE_ISSUER_KEY; `keygen` generates both");
    process.exit(2);
  }
  const port = Number(process.env.SMOKE_MOCK_PORT ?? 8787);
  const host = process.env.SMOKE_MOCK_HOST ?? "127.0.0.1";
  createMockServer({ secret, issuerKey, log: (line) => console.log(line) }).listen(port, host, () => {
    console.log(`Smoke mock provider listening on http://${host}:${port}`);
  });
}
