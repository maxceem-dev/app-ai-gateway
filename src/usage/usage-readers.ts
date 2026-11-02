/**
 * Reading what a provider reported off its own response body.
 *
 * One reader per {@link UsageFormat}, the one its protocol declares, rather than
 * one found by sniffing the answer: the gateway knows which API it called
 * before the first byte comes back, and a body that does not say what that API
 * says is unreadable rather than an invitation to guess. `unknown` — a
 * provider-native operation this gateway does not classify — is the one format
 * that still sniffs, because there is nothing else to go on.
 */

import { readProviderReport, type ProviderReport } from "../shared/cost-report";
import { PROTOCOLS, type UsageFormat } from "../providers/protocols";
import { type ObservedText, wholeBody } from "./body-observer";
import { EMPTY_USAGE, type UsageObservation } from "./pricing";
import { asRecord } from "../shared/records";
import type { Modality, ModalityCounts } from "../core/types";
import type { TokenVariants } from "../shared/token-rates";
import { type ProviderType, routeCostReport } from "../shared/providers";
import type { ApiStyle, ProviderRoute } from "../shared/capabilities";


function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = finiteNumber(record[key]);
  return value === null ? 0 : Math.max(0, Math.trunc(value));
}

/**
 * Whether a `usage` object carries at least one counter this pipeline can
 * price. An object made only of fields we do not know — Cohere's
 * `usage.billed_units`, for instance — reads as all-zero and is otherwise
 * indistinguishable from a genuinely free request, which is exactly the silent
 * $0 the caller must never be handed.
 */
function countsAny(usage: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => finiteNumber(usage[key]) !== null);
}

/**
 * One side of an OpenAI usage object broken down by modality, as the image
 * endpoints report it in `input_tokens_details` and `output_tokens_details`:
 * `text_tokens` and `image_tokens`, with `audio_tokens` alongside where a model
 * hears. Undefined where the details say nothing of the kind — a Chat
 * Completions `audio_tokens` or `reasoning_tokens` alone is not a split of the
 * side. As with Gemini, only what the split accounts for is believed, and the
 * rest of `total` is `unknown` rather than text.
 */
function openAiModalities(details: Record<string, unknown> | null, total: number): ModalityCounts | undefined {
  if (!details || !countsAny(details, ["text_tokens", "image_tokens"])) return undefined;
  const counts: ModalityCounts = {};
  const image = numberAt(details, "image_tokens");
  const audio = numberAt(details, "audio_tokens");
  if (image > 0) counts.image = image;
  if (audio > 0) counts.audio = audio;
  const accounted = numberAt(details, "text_tokens") + image + audio;
  if (accounted < total) counts.unknown = total - accounted;
  return counts;
}

function openAiUsage(value: unknown): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const response = asRecord(root.response) ?? root;
  const usage = asRecord(response.usage);
  if (!usage) return null;
  if (
    !countsAny(usage, ["input_tokens", "prompt_tokens", "output_tokens", "completion_tokens", "generated_images"])
  ) {
    return null;
  }
  const inputTotal = numberAt(usage, "input_tokens") || numberAt(usage, "prompt_tokens");
  const details = asRecord(usage.input_tokens_details) ?? asRecord(usage.prompt_tokens_details);
  // Cache hits are the same fact under four spellings. OpenAI, Mistral,
  // Fireworks and Cerebras nest it in `*_tokens_details`; Moonshot and
  // Together's non-reasoning models put `cached_tokens` at the usage root;
  // DeepSeek names it `prompt_cache_hit_tokens`. Read positionally, not per
  // provider — the field names are unambiguous, and a provider that reports
  // none simply has no cache hits to price. Missing it is not free: the cached
  // bucket falls back to the full input price, so every one of these providers
  // would over-bill exactly the traffic their cache discount is for.
  const cached = (details ? numberAt(details, "cached_tokens") : 0)
    || numberAt(usage, "cached_tokens")
    || numberAt(usage, "prompt_cache_hit_tokens");
  const cacheWrite = details ? numberAt(details, "cache_write_tokens") : 0;
  const outputTotal = numberAt(usage, "output_tokens") || numberAt(usage, "completion_tokens");
  // An image model prices its image tokens apart from its text on both sides,
  // and the split counts the whole side, cached part included: `sideCost`
  // takes it out of the uncached tokens, never past them.
  const input = openAiModalities(details, inputTotal);
  const output = openAiModalities(
    asRecord(usage.output_tokens_details) ?? asRecord(usage.completion_tokens_details),
    outputTotal,
  );
  return {
    inputTokens: Math.max(0, inputTotal - cached - cacheWrite),
    cachedInputTokens: cached,
    cacheWriteTokens: cacheWrite,
    outputTokens: outputTotal,
    // BytePlus Seedream bills per image, and counts here the images it billed:
    // those that failed or were withheld by moderation are not in it. Its
    // `output_tokens` is only the pixel count over 256 and prices nothing.
    ...(finiteNumber(usage.generated_images) !== null && { images: numberAt(usage, "generated_images") }),
    ...((input || output) && {
      modalityTokens: { ...(input && { input }), ...(output && { output }) },
    }),
  };
}

/**
 * The one-hour share of an Anthropic cache write, which bills at 2x input
 * against 1.25x for the default five minutes. `usage.cache_creation` splits
 * `cache_creation_input_tokens` by TTL; where it is absent, as on an older API
 * version or a route that strips it, the whole write bills at the default rate,
 * exactly as it did before the split was read.
 */
function anthropicCacheWriteVariants(usage: Record<string, unknown>): TokenVariants | undefined {
  const creation = asRecord(usage.cache_creation);
  if (!creation || finiteNumber(creation.ephemeral_1h_input_tokens) === null) return undefined;
  return { cache_write: { "1h": numberAt(creation, "ephemeral_1h_input_tokens") } };
}

function anthropicUsage(value: unknown): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const message = asRecord(root.message) ?? root;
  const usage = asRecord(message.usage) ?? asRecord(root.usage);
  if (!usage) return null;
  if (
    !countsAny(usage, [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ])
  ) {
    return null;
  }
  const tokenVariants = anthropicCacheWriteVariants(usage);
  return {
    inputTokens: numberAt(usage, "input_tokens"),
    cachedInputTokens: numberAt(usage, "cache_read_input_tokens"),
    cacheWriteTokens: numberAt(usage, "cache_creation_input_tokens"),
    outputTokens: numberAt(usage, "output_tokens"),
    ...(tokenVariants && { tokenVariants }),
  };
}

/**
 * Gemini's modality names, as the ones a price can tell apart. A PDF is read
 * as page images, and is priced as one rather than at the cheaper text rate.
 */
const GEMINI_MODALITIES = new Map<unknown, Modality>([
  ["IMAGE", "image"],
  ["DOCUMENT", "image"],
  ["AUDIO", "audio"],
  ["VIDEO", "video"],
]);

/**
 * One side of a Gemini usage object broken down by modality; undefined where
 * it gives no breakdown. Only what a breakdown accounts for is believed: a
 * modality nobody priced, and whatever the entries fall short of `total` by,
 * is counted `unknown` rather than taken to be text.
 */
function geminiModalities(details: unknown, total: number): ModalityCounts | undefined {
  if (!Array.isArray(details)) return undefined;
  const counts: ModalityCounts = {};
  let accounted = 0;
  for (const detail of details) {
    const entry = asRecord(detail);
    if (!entry) continue;
    const tokens = numberAt(entry, "tokenCount");
    accounted += tokens;
    if (entry.modality === "TEXT") continue;
    const modality = GEMINI_MODALITIES.get(entry.modality) ?? "unknown";
    counts[modality] = (counts[modality] ?? 0) + tokens;
  }
  if (accounted < total) counts.unknown = (counts.unknown ?? 0) + total - accounted;
  return counts;
}

function geminiUsage(value: unknown): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const usage = asRecord(root.usageMetadata);
  if (!usage) return null;
  if (
    !countsAny(usage, [
      "promptTokenCount",
      "cachedContentTokenCount",
      "candidatesTokenCount",
      "thoughtsTokenCount",
    ])
  ) {
    return null;
  }
  const promptTotal = numberAt(usage, "promptTokenCount");
  const cached = numberAt(usage, "cachedContentTokenCount");
  const candidates = numberAt(usage, "candidatesTokenCount");
  const thoughts = numberAt(usage, "thoughtsTokenCount");
  // `promptTokenDetails` is how an embedding answer spells it.
  const input = geminiModalities(usage.promptTokensDetails ?? usage.promptTokenDetails, promptTotal);
  // Thinking is text even where the candidates are not broken down, so it is
  // never billed at an image rate for want of a breakdown.
  const output = geminiModalities(usage.candidatesTokensDetails, candidates)
    ?? (thoughts > 0 ? { unknown: candidates } : undefined);
  return {
    inputTokens: Math.max(0, promptTotal - cached),
    cachedInputTokens: cached,
    cacheWriteTokens: 0,
    // Thinking is not part of the candidates, and Gemini bills it as output.
    outputTokens: candidates + thoughts,
    ...((input || output) && {
      modalityTokens: { ...(input && { input }), ...(output && { output }) },
    }),
  };
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

/**
 * A transcription reports whatever its model is billed by, and the reader does
 * not choose between them: OpenAI's token-priced models answer with a `usage`
 * of tokens, its duration-priced ones with `usage: {type: "duration", seconds}`,
 * and xAI and `verbose_json` with a top-level `duration`. Every measure present
 * is kept, and the model's price decides which one is billed — so a response
 * shape can never move a model onto another model's unit.
 *
 * `usage.seconds` wins over `duration` where both appear: it is the figure the
 * usage block bills, and `duration` is the length of the audio as transcribed.
 */
function audioUsage(value: unknown): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const usage = asRecord(root.usage);
  // Mistral names the billed audio `prompt_audio_seconds`, beside its tokens.
  const seconds = nonNegativeNumber(usage?.seconds)
    ?? nonNegativeNumber(usage?.prompt_audio_seconds)
    ?? nonNegativeNumber(root.duration);
  const tokens = openAiUsage(root);
  if (tokens) return seconds === null ? tokens : { ...tokens, audioSeconds: seconds };
  return seconds === null ? null : { ...EMPTY_USAGE, audioSeconds: seconds, durationOnly: true };
}

/** Marks a block that carries no value: empty, `[DONE]`, or malformed. */
const NO_VALUE = Symbol("no SSE value");

/** One SSE block's `data:` payload, or null when it carries nothing to parse. */
function sseData(block: string): string | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return !data || data === "[DONE]" ? null : data;
}

/**
 * One SSE window as its events, parsed only where a reader reaches one.
 *
 * Splitting the text into blocks is cheap work over the window; parsing them is
 * what costs, and every shape this file reads reports at one end of a stream.
 * Walking from the last block back therefore costs the few events that carry
 * the answer rather than a `JSON.parse` per delta chunk. Each block is parsed
 * at most once however many readers reach it, because usage and a cost report
 * are read off the same window.
 */
function sseEvents(text: string): {
  forwards(): Iterable<unknown>;
  backwards(): Iterable<unknown>;
} {
  const blocks = text.replace(/\r\n/gu, "\n").split("\n\n");
  const parsed = new Array<unknown>(blocks.length);
  function valueAt(index: number): unknown {
    const seen = parsed[index];
    // `JSON.parse` never answers `undefined`, so an untouched slot is the only
    // thing that reads as one.
    if (seen !== undefined) return seen;
    const data = sseData(blocks[index]!);
    let value: unknown = NO_VALUE;
    if (data !== null) {
      try {
        value = JSON.parse(data) as unknown;
      } catch {
        // A malformed event is ignored; another event may still be usable.
      }
    }
    parsed[index] = value;
    return value;
  }
  return {
    *forwards() {
      for (let index = 0; index < blocks.length; index += 1) {
        const value = valueAt(index);
        if (value !== NO_VALUE) yield value;
      }
    },
    *backwards() {
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const value = valueAt(index);
        if (value !== NO_VALUE) yield value;
      }
    },
  };
}

/**
 * Two Anthropic events as one figure. Field-wise `max`, because each event
 * reports its own half of the request and every counter it omits reads as zero:
 * `message_start` names the input tokens and `message_delta` the cumulative
 * output tokens, and neither may pull the other's counter back down.
 */
function mergeAnthropicUsage(left: UsageObservation, right: UsageObservation): UsageObservation {
  // The cache-write split is merged the same way as the counter it splits: an
  // event that does not name it must not erase the one that did.
  const oneHour = [left, right]
    .map((usage) => usage.tokenVariants?.cache_write?.["1h"])
    .filter((count): count is number => count !== undefined);
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    ...(oneHour.length > 0 && { tokenVariants: { cache_write: { "1h": Math.max(...oneHour) } } }),
  };
}

/** The format a value reports usage in, sniffed from its fields; null where it carries none. */
function usageShape(value: unknown): Exclude<UsageFormat, "unknown"> | null {
  const root = asRecord(value);
  if (!root) return null;
  if (asRecord(root.usageMetadata)) return "gemini";
  if (typeof root.type === "string" && root.type.startsWith("message_")) return "anthropic";
  if (asRecord(root.message)?.usage) return "anthropic";
  const response = asRecord(root.response) ?? root;
  const usage = asRecord(response.usage);
  if (
    usage
    && (Object.hasOwn(usage, "cache_read_input_tokens")
      || Object.hasOwn(usage, "cache_creation_input_tokens"))
  ) {
    return "anthropic";
  }
  // After the Anthropic checks: a truncated body's tail document carries any
  // `duration` it saw next to the usage object, and an Anthropic usage read
  // as audio would lose its cache buckets.
  if (typeof root.duration === "number" || usage?.type === "duration") return "audio";
  if (!usage) return null;
  return "openai";
}

/**
 * Whether a value carries usage under `message`, which on an Anthropic stream
 * is `message_start` and nothing else: the deltas report at the root. It is the
 * only event that names the input tokens, and it is the stream's first.
 */
function carriesMessageUsage(value: unknown): boolean {
  return asRecord(asRecord(value)?.message)?.usage !== undefined;
}

/**
 * A tail window opens in the middle of whatever event was in flight, and half
 * an event must never read as a whole one, so the events are only those after
 * the first event boundary. What comes before it is kept apart as `cut`: when
 * one event outgrows the window, as a streamed image does with its base64 and
 * its usage in the same event, that cut-off event is where the stream reports,
 * and the whole tail is one.
 */
function splitTail(tail: string): { cut: string; events: string } {
  const normalized = tail.replace(/\r\n/gu, "\n");
  const boundary = normalized.indexOf("\n\n");
  return boundary === -1
    ? { cut: normalized, events: "" }
    : { cut: normalized.slice(0, boundary), events: normalized.slice(boundary + 2) };
}

/**
 * The JSON object starting at `start`, or null when it does not close inside
 * the window. Braces are counted outside of strings; inside one, a quote ends
 * it and a backslash escapes whatever follows. Nothing else about JSON matters
 * for finding where an object ends.
 */
function jsonObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** The usage objects a truncated document is worth scanning its tail for. */
const TAIL_USAGE_KEYS = ["usage", "usageMetadata"] as const;

/** Audio duration is a number rather than an object, so it is matched as one. */
const TAIL_DURATION = /"duration"\s*:\s*(-?\d+(?:\.\d+)?)/gu;

/**
 * The same key, read off the head instead: the first one, because a verbose
 * transcription states its top-level `duration` before the segments and words
 * that can push it out of the tail window. Inside a string of content the key's
 * quotes are escaped, so a transcript that says "duration" never matches.
 */
const HEAD_DURATION = /"duration"\s*:\s*(-?\d+(?:\.\d+)?)/u;

/**
 * A synthetic document carrying whatever usage the tail of a truncated JSON
 * body still holds. Every shape this file prices reports at the end of the
 * document, so the last such key is the one that counts; `null` means the
 * response said nothing readable, which records as unresolved exactly as an
 * intact response with no usage does.
 *
 * The scan cannot tell a top-level key from a nested one — the head that would
 * say so is long gone — so it takes the last one, which is where every shape
 * here puts the figure that covers the whole request.
 */
function tailUsageDocument(tail: string): Record<string, unknown> | null {
  const document: Record<string, unknown> = {};
  for (const key of TAIL_USAGE_KEYS) {
    const marker = `"${key}"`;
    // The step stops at the first character rather than searching from `-1`,
    // which `lastIndexOf` clamps back to 0 — and so would return 0 forever.
    for (
      let at = tail.lastIndexOf(marker);
      at !== -1;
      at = at > 0 ? tail.lastIndexOf(marker, at - 1) : -1
    ) {
      // A key is only a key when a value follows it; the same text inside a
      // string of content is skipped, and the search continues backwards.
      const separator = /^\s*:\s*\{/u.exec(tail.slice(at + marker.length));
      if (!separator) continue;
      const object = jsonObjectAt(tail, at + marker.length + separator[0].length - 1);
      if (!object) continue;
      try {
        document[key] = JSON.parse(object) as unknown;
        break;
      } catch {
        // Not the object it looked like; an earlier occurrence may still be.
      }
    }
  }
  // A duration is kept alongside any usage object: a transcription can report
  // both, and the model's price, not this scan, decides which one is billed.
  // Only the audio reader reads it, so a token-priced response that happens to
  // mention a duration is still priced from its tokens.
  const duration = [...tail.matchAll(TAIL_DURATION)].at(-1)?.[1];
  if (duration !== undefined) document.duration = Number(duration);
  return Object.keys(document).length > 0 ? document : null;
}

/**
 * The values of one response body, parsed where a reader reaches one and
 * nowhere else. Every reader below walks from the last value backwards, because
 * that is where every shape here reports.
 */
export interface ResponseValues {
  /** Every value the body carries, the last one first. */
  backwards(): Iterable<unknown>;
  /**
   * The values of the head window, the first one first. Only Anthropic needs
   * it: its input tokens are in `message_start`, which opens the stream.
   */
  headForwards(): Iterable<unknown>;
}

/** A body already parsed whole; nothing about these values is worth deferring. */
function documentValues(values: unknown[]): ResponseValues {
  return {
    *backwards() {
      for (let index = values.length - 1; index >= 0; index -= 1) yield values[index];
    },
    headForwards: () => values,
  };
}

/** One response body as its values: the document, or every SSE event. */
export function responseValues(body: ObservedText, contentType: string): ResponseValues {
  if (contentType.toLowerCase().includes("text/event-stream")) {
    // Both windows are read: an Anthropic stream reports its input tokens in
    // the `message_start` event at the head and its output tokens at the tail.
    const head = sseEvents(body.head);
    const split = body.truncated ? splitTail(body.tail) : null;
    const tail = split ? sseEvents(split.events) : null;
    // The cut-off event is read only for the usage object at its end, the way
    // a truncated document is, and only after every whole event in the tail:
    // it came before them, and half an event is never parsed as one.
    let cut: Record<string, unknown> | null | undefined;
    return {
      *backwards() {
        if (tail) yield* tail.backwards();
        if (split) {
          if (cut === undefined) cut = tailUsageDocument(split.cut);
          if (cut) yield cut;
        }
        yield* head.backwards();
      },
      headForwards: () => head.forwards(),
    };
  }
  if (body.truncated) {
    const document = tailUsageDocument(body.tail) ?? {};
    if (document.duration === undefined) {
      const duration = HEAD_DURATION.exec(body.head)?.[1];
      if (duration !== undefined) document.duration = Number(duration);
    }
    return documentValues(Object.keys(document).length > 0 ? [document] : []);
  }
  try {
    const parsed = JSON.parse(body.head) as unknown;
    return documentValues(Array.isArray(parsed) ? parsed : [parsed]);
  } catch {
    throw new Error("Provider response was not valid usage JSON or SSE");
  }
}

/**
 * `counts` merged with the `message_start` of the same body. The input tokens
 * of an Anthropic stream are named there and nowhere else, and it is the first
 * event, so the head is walked forwards and stops on it — on a truncated body
 * as on an intact one, and never through the deltas in between.
 */
function withMessageStart(counts: UsageObservation, values: ResponseValues): UsageObservation {
  let merged = counts;
  for (const value of values.headForwards()) {
    const earlier = anthropicUsage(value);
    if (earlier) merged = mergeAnthropicUsage(merged, earlier);
    if (carriesMessageUsage(value)) break;
  }
  return merged;
}

/**
 * Reads the usage a provider reported, or `null` when the response carries none
 * this deployment recognises. That distinction is the whole point: a provider
 * that reports zero tokens and a provider whose usage object we cannot read both
 * cost `$0` to compute, and only the second one is a metering failure.
 *
 * Values are consumed from the last one backwards and the walk stops as soon as
 * the answer is settled, which is what keeps a long stream from being parsed
 * whole.
 */
export type UsageReader = (values: ResponseValues) => UsageObservation | null;

/** The last value that parses to an observation; every shape reports at the end. */
function lastReported(
  values: ResponseValues,
  read: (value: unknown) => UsageObservation | null,
): UsageObservation | null {
  for (const value of values.backwards()) {
    const parsed = read(value);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * OpenAI, Gemini and audio report once, at the end, so the answer is the last
 * value that parses to an observation. A streamed transcription carries its
 * usage on the final `transcript.text.done` event.
 */
const openAiReader: UsageReader = (values) => lastReported(values, openAiUsage);
const geminiReader: UsageReader = (values) => lastReported(values, geminiUsage);
const audioReader: UsageReader = (values) => lastReported(values, audioUsage);

/**
 * Anthropic splits it in two: `message_start` carries the input tokens and
 * every `message_delta` the *cumulative* output tokens. Merging the last
 * Anthropic usage with `message_start` under field-wise `max` therefore gives
 * exactly what merging all of them gave — no other event carries usage, and a
 * cumulative counter is largest in the last one that reports it.
 */
const anthropicReader: UsageReader = (values) => {
  for (const value of values.backwards()) {
    const counts = anthropicUsage(value);
    if (!counts) continue;
    return carriesMessageUsage(value) ? counts : withMessageStart(counts, values);
  }
  return null;
};

/**
 * The fallback for a provider-native operation this gateway does not classify,
 * where nothing but the body itself says what shape it is in. Each value is
 * judged by its own fields, and an Anthropic-shaped value turns the rest of the
 * walk Anthropic, so no other shape's usage is ever read out of an Anthropic
 * body: the rule the shape filter enforced before any value was read, applied
 * from the end inwards.
 */
const sniffUsage: UsageReader = (values) => {
  let anthropicShaped = false;
  for (const value of values.backwards()) {
    const shape = usageShape(value);
    if (shape === "anthropic") {
      anthropicShaped = true;
      const counts = anthropicUsage(value);
      if (!counts) continue;
      return carriesMessageUsage(value) ? counts : withMessageStart(counts, values);
    }
    if (anthropicShaped) continue;
    const parsed = shape === "gemini"
      ? geminiUsage(value)
      : shape === "openai"
        ? openAiUsage(value)
        : shape === "audio"
          ? audioUsage(value)
        : null;
    if (parsed) return parsed;
  }
  return null;
};

/**
 * One reader per usage format, because the request side already classified the
 * operation and the response to a known API has a known shape. A classified
 * style whose reader finds nothing records as unresolved and is logged — the
 * same answer an unreadable body has always had, and deliberately not a second
 * guess at another provider's fields.
 */
const USAGE_READERS: Record<UsageFormat, UsageReader> = {
  openai: openAiReader,
  anthropic: anthropicReader,
  gemini: geminiReader,
  audio: audioReader,
  unknown: sniffUsage,
};

export function readUsage(values: ResponseValues, style: ApiStyle): UsageObservation | null {
  return USAGE_READERS[PROTOCOLS[style].usage](values);
}

export function extractUsageText(
  text: string,
  contentType: string,
  style: ApiStyle,
): UsageObservation | null {
  return readUsage(responseValues(wholeBody(text), contentType), style);
}

/**
 * Everything one response body says about itself, parsed once. The report half
 * is read only by the integration the provider type declared, and only where
 * it covers this route and API: usage is read by the style's own reader, and no
 * type ever has another provider's fields read out of its responses.
 */
export function observeResponse(
  body: ObservedText,
  contentType: string,
  provider: ProviderType,
  route: ProviderRoute,
  style: ApiStyle,
): { usage: UsageObservation | null; report: ProviderReport | null } {
  const values = responseValues(body, contentType);
  const reporting = routeCostReport(provider, route, style);
  return {
    usage: readUsage(values, style),
    // Handed the same backwards walk: the report of a stream is in its final
    // chunk too, and that reader stops as soon as it has one.
    report: reporting ? readProviderReport(values.backwards(), reporting) : null,
  };
}
