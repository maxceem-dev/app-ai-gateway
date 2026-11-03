/**
 * The three wire formats the mock speaks. Every OpenAI-compatible provider type
 * shares the first, so these cover every request shape the proxy forwards.
 *
 * Responses are fixed apart from the smoke id they echo and carry usage in each
 * format's own fields, so the gateway records usage exactly as it would for a
 * real provider.
 */
export type Format = "openai" | "anthropic" | "gemini";

export const MODEL = "smoke-model";
/** Models that make the mock fail, to check the gateway passes provider errors through. */
export const FAILING_MODELS: Record<string, number> = { "smoke-429": 429, "smoke-500": 500 };

const USAGE = { input: 5, output: 2 };

export interface Reply {
  status: number;
  contentType: string;
  body: string;
}

function json(status: number, body: unknown): Reply {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

function sse(events: { event?: string; data: unknown }[]): Reply {
  const body = events
    .map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
    .join("");
  return { status: 200, contentType: "text/event-stream", body };
}

/** Where each format's auth header is, and what it must hold. */
export function authorized(format: Format, headers: Record<string, string | string[] | undefined>, secret: string): boolean {
  switch (format) {
    case "openai":
      return headers.authorization === `Bearer ${secret}`;
    case "anthropic":
      return headers["x-api-key"] === secret && headers.authorization === undefined;
    case "gemini":
      return headers["x-goog-api-key"] === secret && headers.authorization === undefined;
  }
}

export function error(format: Format, status: number, message: string): Reply {
  switch (format) {
    case "openai":
      return json(status, { error: { message, type: "smoke_error", code: String(status) } });
    case "anthropic":
      return json(status, { type: "error", error: { type: "smoke_error", message } });
    case "gemini":
      return json(status, { error: { code: status, message, status: "SMOKE_ERROR" } });
  }
}

export function models(format: Format): Reply {
  switch (format) {
    case "openai":
      return json(200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "smoke" }] });
    case "anthropic":
      return json(200, { data: [{ id: MODEL, type: "model", display_name: "Smoke" }], has_more: false });
    case "gemini":
      return json(200, { models: [{ name: `models/${MODEL}`, supportedGenerationMethods: ["generateContent"] }] });
  }
}

export function openaiChat(text: string, model: string, stream: boolean): Reply {
  const usage = { prompt_tokens: USAGE.input, completion_tokens: USAGE.output, total_tokens: USAGE.input + USAGE.output };
  const base = { id: "chatcmpl-smoke", created: Math.floor(Date.now() / 1000), model };
  if (!stream) {
    return json(200, {
      ...base,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    });
  }
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
    data: { ...base, object: "chat.completion.chunk", choices, ...extra },
  });
  return sse([
    chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: text }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
    chunk([], { usage }),
    { data: "[DONE]" },
  ]);
}

export function openaiResponse(text: string, model: string, stream: boolean): Reply {
  const response = {
    id: "resp_smoke",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: "msg_smoke",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: USAGE.input, output_tokens: USAGE.output, total_tokens: USAGE.input + USAGE.output },
  };
  if (!stream) return json(200, response);
  return sse([
    {
      event: "response.created",
      data: { type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } },
    },
    {
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", item_id: "msg_smoke", output_index: 0, content_index: 0, delta: text },
    },
    { event: "response.completed", data: { type: "response.completed", response } },
  ]);
}

export function anthropicMessage(text: string, model: string, stream: boolean): Reply {
  const message = {
    id: "msg_smoke",
    type: "message",
    role: "assistant",
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
  };
  if (!stream) {
    return json(200, {
      ...message,
      content: [{ type: "text", text }],
      usage: { input_tokens: USAGE.input, output_tokens: USAGE.output },
    });
  }
  return sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: { ...message, content: [], stop_reason: null, usage: { input_tokens: USAGE.input, output_tokens: 0 } },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: USAGE.output } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

export function geminiContent(text: string, model: string, stream: boolean): Reply {
  const usageMetadata = {
    promptTokenCount: USAGE.input,
    candidatesTokenCount: USAGE.output,
    totalTokenCount: USAGE.input + USAGE.output,
  };
  const candidate = (part: string, finished: boolean) => ({
    content: { role: "model", parts: [{ text: part }] },
    index: 0,
    ...(finished ? { finishReason: "STOP" } : {}),
  });
  if (!stream) return json(200, { candidates: [candidate(text, true)], usageMetadata, modelVersion: model });
  return sse([
    { data: { candidates: [candidate("", false)], modelVersion: model } },
    { data: { candidates: [candidate(text, true)], usageMetadata, modelVersion: model } },
  ]);
}
