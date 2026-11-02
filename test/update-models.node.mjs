import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyEdits, formatPrice } from "../scripts/models/catalog-edit.mjs";
import { fromLitellm, fromModelsDev } from "../scripts/models/lists.mjs";
import { parseAnthropic } from "../scripts/models/parsers/anthropic.mjs";
import { parseAnthropicDeprecations } from "../scripts/models/parsers/anthropic-deprecations.mjs";
import { parseCerebras } from "../scripts/models/parsers/cerebras.mjs";
import { parseDeepseek } from "../scripts/models/parsers/deepseek.mjs";
import { parseGemini } from "../scripts/models/parsers/gemini.mjs";
import { parseGeminiDeprecations } from "../scripts/models/parsers/gemini-deprecations.mjs";
import { parseGroq } from "../scripts/models/parsers/groq.mjs";
import { parseGroqDeprecations } from "../scripts/models/parsers/groq-deprecations.mjs";
import { parseMoonshot } from "../scripts/models/parsers/moonshot.mjs";
import { parseOpenai } from "../scripts/models/parsers/openai.mjs";
import { parseOpenaiDeprecations } from "../scripts/models/parsers/openai-deprecations.mjs";
import { parsePerplexity } from "../scripts/models/parsers/perplexity.mjs";
import { parseTogether } from "../scripts/models/parsers/together.mjs";
import { parseTogetherDeprecations } from "../scripts/models/parsers/together-deprecations.mjs";
import { parseXai } from "../scripts/models/parsers/xai.mjs";
import { ParseError, effectivePrice, parseDate, samePrice } from "../scripts/models/price.mjs";
import { renderReport, renderTitle } from "../scripts/models/report.mjs";
import { catalogEdits, compare, decide, needsHuman } from "../scripts/models/rules.mjs";
import { SOURCES, sourceId } from "../scripts/models/sources.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/models/${name}`, import.meta.url), "utf8");
const liveCatalogText = readFileSync(new URL("../src/usage/models.json", import.meta.url), "utf8");
// The editor's tests pin exact lines, so they run on a frozen copy of the
// catalog: the live one changes every time the daily sync is merged.
const catalogText = fixture("catalog.json");
const TODAY = "2026-09-30";

function parse(parser, text, wanted, today = TODAY) {
  return parser(text, { wanted: new Set(wanted), today });
}

/** Runs `parser` on a mutated fixture and expects the page to fail. */
function assertFails(parser, text, wanted, pattern) {
  assert.throws(() => parse(parser, text, wanted), (error) => {
    assert.ok(error instanceof ParseError, `expected a ParseError, got ${error}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

function replaceOnce(text, from, to) {
  assert.ok(text.includes(from), `fixture does not contain "${from}"`);
  return text.replace(from, to);
}

// Parsers -------------------------------------------------------------------

test("openai: reads every standard, the specialized and the transcription tables", () => {
  const text = fixture("openai.md");
  const wanted = ["gpt-5.6-sol", "gpt-5.5", "gpt-5.5-pro", "gpt-5.4-mini", "gpt-5.2-pro", "gpt-5.6-cyber", "gpt-5.3-codex", "text-embedding-3-small", "gpt-4o-transcribe", "Whisper"];
  const prices = parse(parseOpenai, text, wanted);
  assert.deepEqual(prices.get("gpt-5.6-sol"), {
    input: 4,
    output: 20,
    cached_input: 0.4,
    cache_write: 5,
    long_context_threshold: 272000,
    long_input: 8,
    long_cached_input: 0.8,
    long_cache_write: 10,
    long_output: 30,
  });
  assert.deepEqual(prices.get("gpt-5.5"), {
    input: 5,
    output: 30,
    cached_input: 0.5,
    long_context_threshold: 272000,
    long_input: 10,
    long_cached_input: 1,
    long_output: 45,
  });
  // The plain table under the first standard one, with no heading of its own.
  assert.deepEqual(prices.get("gpt-5.4-mini"), { input: 0.75, output: 4.5, cached_input: 0.075 });
  assert.deepEqual(prices.get("gpt-5.2-pro"), { input: 21, output: 168 });
  // The Cyber family's standard table, with the 30-minute cache write.
  assert.deepEqual(prices.get("gpt-5.6-cyber"), { input: 12.5, output: 75, cached_input: 1.25, cache_write: 15.625 });
  // The standard specialized table, not the Fast one below it.
  assert.deepEqual(prices.get("gpt-5.3-codex"), { input: 1.75, output: 14, cached_input: 0.175 });
  // An embedding generates nothing, so its missing output price is 0.
  assert.deepEqual(prices.get("text-embedding-3-small"), { input: 0.02, output: 0 });
  assert.deepEqual(prices.get("gpt-4o-transcribe"), { input: 2.5, output: 10 });
  assert.deepEqual(prices.get("Whisper"), { per_minute: 0.006 });
  // Listed but not read, so unknown cells such as "Free" do not matter.
  assert.equal(prices.get("gpt-6-astra"), null);
  assert.equal(prices.get("omni-moderation-latest"), null);
  // A grouped table under its own heading is not a standard one.
  assert.equal(prices.has("gpt-rosalind-research"), false);
});

test("openai: fails on a renamed header, an added column, an unknown cell or a duplicate", () => {
  const text = fixture("openai.md");
  const wanted = ["gpt-5.6-sol"];
  assertFails(parseOpenai, replaceOnce(text, "| Model | Short context input |", "| Model | Short-context input |"), wanted, /header changed/);
  assertFails(
    parseOpenai,
    text.replace(/\| Long context 12h write \|\n\| --- /u, "| Long context 12h write | Notes |\n| --- | --- "),
    wanted,
    /header changed/,
  );
  assertFails(parseOpenai, replaceOnce(text, "| gpt-5.6-sol | $4.00 |", "| gpt-5.6-sol | 4.00 USD |"), wanted, /not a price/);
  assertFails(parseOpenai, replaceOnce(text, "| gpt-5.6-sol | $4.00 |", "| gpt-5.6-sol | $4 00 |"), wanted, /plain decimal/);
  assertFails(parseOpenai, replaceOnce(text, "Short context: ≤272K", "Short context: ≤256K"), wanted, /threshold/);
  assertFails(
    parseOpenai,
    replaceOnce(text, "| gpt-5.4-mini |", "| gpt-5.6-sol | $5.00 | $30.00 | $0.50 |\n| gpt-5.4-mini |"),
    wanted,
    /twice/,
  );
  // The same model in two families' tables must carry the same price.
  assertFails(parseOpenai, replaceOnce(text, "| gpt-5.6-sol | $4.00 | $20.00 | $0.40 | $5.00 | $10.00 | $8.00 | $30.00 | $0.80 | $10.00 | $20.00 |\n| gpt-5.6-cyber", "| gpt-5.6-sol | $4.00 | $20.00 | $0.40 | $5.00 | $10.00 | $8.00 | $31.00 | $0.80 | $10.00 | $20.00 |\n| gpt-5.6-cyber"), wanted, /twice/);
  assertFails(parseOpenai, replaceOnce(text, "| Model | Input | Output | Cached input |", "| Model | Input | Cached input | Output |"), wanted, /header changed/);
  assertFails(parseOpenai, text.replaceAll("### Standard pricing data", "### Standard pricing"), wanted, /missing/);
  assertFails(parseOpenai, replaceOnce(text, "Transcription models", "Speech models"), wanted, /missing/);
});

test("openai: reads the Standard image generation table, one price from two modality rows", () => {
  const text = fixture("openai.md");
  const prices = parse(parseOpenai, text, ["gpt-image-2", "gpt-image-1.5", "gpt-image-1-mini"]);
  // Text output is "-": the model writes only images, so its image output is
  // every output token's rate. Standard, not the Batch table below it.
  assert.deepEqual(prices.get("gpt-image-2"), { input: 5, output: 30, image_input: 8, cached_input: 2 });
  // A model that also writes text keeps its image output rate apart.
  assert.deepEqual(prices.get("gpt-image-1.5"), { input: 5, output: 10, image_input: 8, image_output: 32, cached_input: 2 });
  // Cached tokens are not split by modality, so the higher cached rate is kept.
  assert.deepEqual(prices.get("gpt-image-1-mini"), { input: 2, output: 8, image_input: 2.5, cached_input: 0.25 });
  // Discovered, not read.
  assert.equal(prices.get("chatgpt-image-latest"), null);
});

test("openai: fails on an image table it was not written against", () => {
  const text = fixture("openai.md");
  const wanted = ["gpt-image-2"];
  assertFails(parseOpenai, replaceOnce(text, "Image generation models", "Image models"), wanted, /missing/);
  assertFails(parseOpenai, replaceOnce(text, "Image generation models\n\nPrices per 1M tokens.", "Image generation models\n\nPrices per image."), wanted, /Standard per-1M-token/);
  assertFails(parseOpenai, replaceOnce(text, "\nStandard\n\n      For image", "\nBatch\n\n      For image"), wanted, /Standard per-1M-token/);
  assertFails(parseOpenai, replaceOnce(text, "| Model | Modality | Input | Output | Cached input |", "| Model | Modality | Input | Output / image | Cached input |"), wanted, /header changed/);
  assertFails(parseOpenai, replaceOnce(text, "| gpt-image-2 | Text | $5.00 |", "| gpt-image-2 | Audio | $5.00 |"), wanted, /unexpected modality "Audio"/);
  assertFails(parseOpenai, replaceOnce(text, "| gpt-image-2 | Text | $5.00 |", "| gpt-image-2 | Image | $5.00 |"), wanted, /two Image rows/);
  assertFails(parseOpenai, replaceOnce(text, "| gpt-image-2 | Image | $8.00 | $30.00 | $2.00 |", "| gpt-image-2 | Image | $8.00 | $0.04 / image | $2.00 |"), wanted, /plain decimal/);
  assertFails(parseOpenai, replaceOnce(text, "| gpt-image-2 | Image | $8.00 | $30.00 | $2.00 |", "| gpt-image-2 | Image | $8.00 | - | $2.00 |"), wanted, /image output price/);
  assertFails(parseOpenai, replaceOnce(text, "| gpt-image-2 | Image | $8.00 | $30.00 | $2.00 |", "| gpt-image-2 | Image | $8.00 | $30.00 | - |"), wanted, /only one modality has a cached price/);
  assertFails(parseOpenai, replaceOnce(text, "| gpt-image-2 | Text | $5.00 | - | $1.25 |\n", ""), wanted, /both a Text and an Image row/);
});

test("anthropic: reads display names, footnotes and both cache-write durations", () => {
  const prices = parse(parseAnthropic, fixture("anthropic.md"), ["claude-mythos-5", "claude-sonnet-5", "claude-haiku-4-5"]);
  assert.deepEqual(prices.get("claude-mythos-5"), { input: 10, cached_input: 1, cache_write: 12.5, cache_write_1h: 20, output: 50 });
  assert.deepEqual(prices.get("claude-sonnet-5"), { input: 2, cached_input: 0.2, cache_write: 2.5, cache_write_1h: 4, output: 10 });
  assert.deepEqual(prices.get("claude-haiku-4-5"), { input: 1, cached_input: 0.1, cache_write: 1.25, cache_write_1h: 2, output: 5 });
  assert.equal(prices.get("claude-opus-5-5"), null);
  assert.equal(prices.get("claude-opus-4-1"), null);
});

test("anthropic: fails on a changed header or price grammar", () => {
  const text = fixture("anthropic.md");
  const wanted = ["claude-haiku-4-5"];
  assertFails(parseAnthropic, replaceOnce(text, "| 5m cache writes |", "| 5-minute cache writes |"), wanted, /header changed/);
  assertFails(parseAnthropic, replaceOnce(text, "| $1 / MTok             | $1.25", "| $1 per MTok           | $1.25"), wanted, /MTok/);
  assertFails(parseAnthropic, replaceOnce(text, "## Model pricing", "## Models"), wanted, /missing/);
});

test("anthropic: pairs prompt-length rows into long-context prices", () => {
  const text = fixture("anthropic.md");
  const wanted = ["claude-haiku-5-5"];
  assert.deepEqual(parse(parseAnthropic, text, wanted).get("claude-haiku-5-5"), {
    input: 0.1,
    cached_input: 0.01,
    cache_write: 0.125,
    cache_write_1h: 0.2,
    output: 0.5,
    long_context_threshold: 100000,
    long_input: 0.5,
    long_cached_input: 0.05,
    long_cache_write: 0.625,
    long_cache_write_1h: 1,
    long_output: 2.5,
  });
  assert.equal(parse(parseAnthropic, text, ["claude-haiku-4-5"]).get("claude-haiku-5-5"), null);
  assertFails(parseAnthropic, replaceOnce(text, "(for prompts over 100,000 tokens)", "(for prompts over 200,000 tokens)"), wanted, /long-context row/);
  assertFails(parseAnthropic, replaceOnce(text, "(for prompts up to 100,000 tokens)", "(for prompts over 100,000 tokens)"), wanted, /without its base row/);
});

test("gemini: reads dated, long-context and per-modality prices", () => {
  const text = fixture("gemini.md");
  const wanted = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools", "gemini-2.5-flash", "gemini-3-pro-image"];
  const prices = parse(parseGemini, text, wanted);
  assert.deepEqual(prices.get("gemini-3.6-flash"), {
    input: 0.75,
    output: 3.75,
    cached_input: 0.075,
    upcoming: [
      { date: "2027-01-01", field: "input", value: 1.5 },
      { date: "2027-01-01", field: "output", value: 7.5 },
      { date: "2027-01-01", field: "cached_input", value: 0.15 },
    ],
  });
  assert.deepEqual(prices.get("gemini-3.5-flash"), { input: 1.5, output: 9, cached_input: 0.15 });
  const pro = {
    input: 2,
    output: 12,
    cached_input: 0.2,
    long_context_threshold: 200000,
    long_input: 4,
    long_cached_input: 0.4,
    long_output: 18,
  };
  assert.deepEqual(prices.get("gemini-3.1-pro-preview"), pro);
  assert.deepEqual(prices.get("gemini-3.1-pro-preview-customtools"), pro);
  assert.deepEqual(prices.get("gemini-2.5-flash"), { input: 0.3, output: 2.5, cached_input: 0.03 });
  // Generated images bill at their own output rate; the per-image restatements are dropped.
  assert.deepEqual(prices.get("gemini-3-pro-image"), { input: 2, output: 12, image_output: 120 });
});

test("gemini: reads a speech model's dated per-modality prices", () => {
  const prices = parse(parseGemini, fixture("gemini.md"), ["gemini-3.8-flash-tts"]);
  // Audio is all a speech model outputs, so its audio price is every output token's.
  assert.deepEqual(prices.get("gemini-3.8-flash-tts"), {
    input: 0.5,
    output: 9,
    cached_input: 0.125,
    upcoming: [
      { date: "2027-01-01", field: "input", value: 1 },
      { date: "2027-01-01", field: "output", value: 18 },
      { date: "2027-01-01", field: "cached_input", value: 0.25 },
    ],
  });
});

test("gemini: reads an embedding model's per-modality input rows", () => {
  const text = fixture("gemini.md");
  const prices = parse(parseGemini, text, ["gemini-embedding-2"]);
  assert.deepEqual(prices.get("gemini-embedding-2"), {
    input: 0.2,
    output: 0,
    image_input: 0.45,
    audio_input: 6.5,
    video_input: 12,
  });
  assertFails(parseGemini, replaceOnce(text, "| Text input price |", "| Text price |"), ["gemini-embedding-2"], /no input or output row/);
  assertFails(parseGemini, replaceOnce(text, "$0.45 ($0.00012 per image)", "$0.45 (or $0.00012 per image)"), ["gemini-embedding-2"], /unknown price format/);
});

test("gemini: a dated price switches on its day", () => {
  const text = fixture("gemini.md");
  const lastDay = parse(parseGemini, text, ["gemini-3.6-flash"], "2026-12-31").get("gemini-3.6-flash");
  assert.equal(lastDay.input, 0.75);
  assert.equal(lastDay.upcoming.length, 3);
  const firstDay = parse(parseGemini, text, ["gemini-3.6-flash"], "2027-01-01").get("gemini-3.6-flash");
  assert.deepEqual(firstDay, { input: 1.5, output: 7.5, cached_input: 0.15 });
});

test("gemini: fails on an unknown cell, a changed header or a dated gap", () => {
  const text = fixture("gemini.md");
  assertFails(parseGemini, replaceOnce(text, "$120.00 (images)", "$120.00 (images) $60.00 (image)"), ["gemini-3-pro-image"], /two image prices/);
  assertFails(parseGemini, replaceOnce(text, "$120.00 (images)", "$120.00 (video)"), ["gemini-3-pro-image"], /not metered/);
  assertFails(
    parseGemini,
    replaceOnce(text, "$18.00 (audio) starting", "$18.00 (text) starting"),
    ["gemini-3.8-flash-tts"],
    /different modalities/,
  );
  assertFails(
    parseGemini,
    replaceOnce(text, "and $0.24 per 4K image^\\*\\*^ |", "and $0.24 per 4K image through December 31, 2026. |"),
    ["gemini-3-pro-image"],
    /unknown price format/,
  );
  assertFails(parseGemini, replaceOnce(text, "| $1.50 |", "| $1.50 per million |"), ["gemini-3.5-flash"], /unknown price format/);
  assertFails(
    parseGemini,
    text.replaceAll("Paid Tier, per 1M tokens in USD", "Paid Tier (USD)"),
    ["gemini-3.5-flash"],
    /header changed/,
  );
  assertFails(
    parseGemini,
    replaceOnce(text, "$0.75 through December 31, 2026. $1.50 starting January 1, 2027.", "$0.75 through December 30, 2026. $1.50 starting January 1, 2027."),
    ["gemini-3.6-flash"],
    /gap/,
  );
  assertFails(parseGemini, replaceOnce(text, "$0.15 $1.00 / 1,000,000", "$0.15 $1.00 / 1M"), ["gemini-3.5-flash"], /storage/);
});

test("gemini: a model with implicit caching only has no storage price", () => {
  const text = fixture("gemini.md");
  assert.deepEqual(parse(parseGemini, text, ["gemini-4-argon"]).get("gemini-4-argon"), {
    input: 2,
    output: 10,
    cached_input: 0.1,
    upcoming: [
      { date: "2026-12-01", field: "input", value: 4 },
      { date: "2026-12-01", field: "output", value: 20 },
      { date: "2026-12-01", field: "cached_input", value: 0.2 },
    ],
  });
  assertFails(
    parseGemini,
    replaceOnce(text, "Implicit caching only (explicit caching is not supported).", "Implicit caching only."),
    ["gemini-4-argon"],
    /storage/,
  );
});

test("xai: pairs long-context rows and reads speech to text per hour", () => {
  const text = fixture("xai.md");
  const prices = parse(parseXai, text, ["grok-4.5", "Speech to Text"]);
  assert.deepEqual(prices.get("grok-4.5"), {
    input: 2,
    cached_input: 0.3,
    output: 6,
    long_context_threshold: 200000,
    long_input: 4,
    long_cached_input: 0.6,
    long_output: 12,
  });
  assert.deepEqual(prices.get("Speech to Text"), { per_hour: 0.1 });
  assert.equal(prices.get("grok-4.7"), null);
  assert.equal(prices.has("grok-imagine-image"), false);
  assertFails(parseXai, replaceOnce(text, "| grok-4.5 (≥ 200k prompt tokens) | 500k | $4.00 | $0.60 | $12.00 |\n", ""), ["grok-4.5"], /long-context row/);
  assertFails(parseXai, replaceOnce(text, "$0.10 / hr (REST)", "$0.10 per hour (REST)"), ["Speech to Text"], /speech to text/);
});

test("together: reads escaped prices by API model string", () => {
  const text = fixture("together.md");
  const prices = parse(parseTogether, text, ["moonshotai/Kimi-K3", "openai/gpt-oss-120b"]);
  assert.deepEqual(prices.get("moonshotai/Kimi-K3"), { input: 3, cached_input: 0.3, output: 15, author: "Moonshot" });
  assert.deepEqual(prices.get("openai/gpt-oss-120b"), { input: 0.15, output: 0.6, author: "OpenAI" });
  assert.equal(prices.get("Prism-ML/Ternary-Bonsai-27B"), null);
  assertFails(parseTogether, text, ["Prism-ML/Ternary-Bonsai-27B"], /not a price/);
  assertFails(parseTogether, replaceOnce(text, "| API model string |", "| Model string |"), ["openai/gpt-oss-120b"], /header changed/);
});

test("together: discovers image models and refuses a per-image or per-megapixel price", () => {
  const text = fixture("together.md");
  const prices = parse(parseTogether, text, ["openai/gpt-oss-120b"]);
  assert.equal(prices.get("black-forest-labs/FLUX.1.1-pro"), null);
  assert.equal(prices.get("openai/gpt-image-2"), null);
  assertFails(parseTogether, text, ["black-forest-labs/FLUX.1.1-pro"], /billed per megapixel, which the catalog cannot price/);
  assertFails(parseTogether, text, ["openai/gpt-image-2"], /billed per image, which the catalog cannot price/);
  assertFails(parseTogether, replaceOnce(text, "| `image` |", "| `1M tokens` |"), ["openai/gpt-image-2"], /unknown billing unit/);
  assertFails(parseTogether, replaceOnce(text, "| Unit | Price |", "| Billing unit | Price |"), ["openai/gpt-oss-120b"], /header changed/);
  assertFails(parseTogether, replaceOnce(text, "## Image models", "## Images"), ["openai/gpt-oss-120b"], /missing/);
});

test("groq: reads the link id, token, hourly and contact-sales prices", () => {
  const text = fixture("groq.md");
  const prices = parse(parseGroq, text, ["openai/gpt-oss-120b", "whisper-large-v3", "llama-3.3-70b-versatile", "qwen/qwen3.8-27b"]);
  assert.deepEqual(prices.get("openai/gpt-oss-120b"), { input: 0.15, output: 0.6 });
  assert.deepEqual(prices.get("whisper-large-v3"), { per_hour: 0.111 });
  assert.deepEqual(prices.get("qwen/qwen3.8-27b"), { input: 0.8, output: 4 });
  assert.ok(prices.get("llama-3.3-70b-versatile").unpriced);
  assertFails(parseGroq, text, ["canopylabs/orpheus-arabic-saudi"], /unknown price format/);
  assertFails(parseGroq, replaceOnce(text, "## [Preview Models](#preview-models)", "## Preview"), ["openai/gpt-oss-120b"], /missing/);
});

test("moonshot: reads each DocTable layout without evaluating it", () => {
  const text = fixture("moonshot.md");
  const prices = parse(parseMoonshot, text, ["kimi-k3", "kimi-k2.6"]);
  assert.deepEqual(prices.get("kimi-k3"), { input: 3, output: 15, cached_input: 0.3, cache_write: 3 });
  assert.deepEqual(prices.get("kimi-k2.6"), { input: 0.95, output: 4, cached_input: 0.16 });
  assert.equal(prices.get("kimi-k2.7-code"), null);
  assertFails(parseMoonshot, replaceOnce(text, '"Cached Input Price"', '"Cache Hit Price"'), ["kimi-k3"], /unknown table columns/);
  assertFails(parseMoonshot, replaceOnce(text, '<>{"$"}0.16</>', '<>{"$"}{0.16}</>'), ["kimi-k2.6"], /unexpected cell/);
  assertFails(parseMoonshot, replaceOnce(text, '"kimi-k2.6", "1M tokens"', '"kimi-k2.6", "1K tokens"'), ["kimi-k2.6"], /unit/);
});

test("deepseek: reads the PEAK row of the transposed table", () => {
  const text = fixture("deepseek.html");
  const prices = parse(parseDeepseek, text, ["deepseek-flash", "deepseek-v4-pro"]);
  assert.deepEqual(prices.get("deepseek-flash"), { input: 0.3, cached_input: 0.006, output: 1.2 });
  assert.deepEqual(prices.get("deepseek-v4-pro"), { input: 1.32, cached_input: 0.044, output: 3.96 });
  assertFails(parseDeepseek, text.replaceAll("<td>PEAK</td>", "<td>STANDARD</td>"), ["deepseek-flash"], /PEAK/);
  assertFails(parseDeepseek, replaceOnce(text, "<td>$1.2</td>", "<td>$1.2 USD</td>"), ["deepseek-flash"], /not a price/);
});

test("perplexity: reads only Perplexity's own section of the Agent API rate card", () => {
  const text = fixture("perplexity.md");
  const prices = parse(parsePerplexity, text, ["perplexity/sonar"]);
  assert.deepEqual(prices.get("perplexity/sonar"), { input: 0.25, cached_input: 0.0625, output: 2.5 });
  // Resold models carry the same prefix in another section, and are not Perplexity's.
  assert.equal(prices.has("perplexity/nemotron-3.5-super-120b-a12b"), false);
  assert.deepEqual([...prices.keys()], ["perplexity/sonar"]);
  const noCache = replaceOnce(text, "| 2.50 | 0.0625 |", "| 2.50 | — |");
  assert.deepEqual(parse(parsePerplexity, noCache, ["perplexity/sonar"]).get("perplexity/sonar"), { input: 0.25, output: 2.5 });
  assertFails(parsePerplexity, replaceOnce(text, "| 0.0625 | — |", "| 0.0625 | `flex`, `priority` |"), ["perplexity/sonar"], /service tiers/);
  assertFails(parsePerplexity, replaceOnce(text, "| 0.25 | 2.50 |", "| 0.25 (≤200k)<br />0.50 (>200k) | 2.50 |"), ["perplexity/sonar"], /plain decimal/);
  assertFails(parsePerplexity, replaceOnce(text, "`perplexity/sonar`", "`sonar`"), ["perplexity/sonar"], /unexpected model/);
  assertFails(parsePerplexity, text.replaceAll("Cache read (\\$/1M)", "Cache hit (\\$/1M)"), ["perplexity/sonar"], /header changed/);
  assertFails(parsePerplexity, replaceOnce(text, "> [tab] Perplexity", "> [tab] Sonar"), ["perplexity/sonar"], /Perplexity/);
  // A tab that lost its table never reads the next family's, whether a blank
  // line separates the two or not.
  const renamed = replaceOnce(text, "> [tab] Perplexity", "> [tab] Other");
  for (const between of ["\n\n", "\n"]) {
    const moved = replaceOnce(renamed, "> [tab] NVIDIA", `> [tab] Perplexity${between}> [tab] NVIDIA`);
    assertFails(parsePerplexity, moved, ["perplexity/sonar"], /table is missing/);
  }
});

test("cerebras: converts $ per token strings to $ per 1M", () => {
  const text = fixture("cerebras.json");
  const prices = parse(parseCerebras, text, ["gpt-oss-120b"]);
  assert.deepEqual(prices.get("gpt-oss-120b"), { input: 0.35, output: 0.75 });
  assertFails(parseCerebras, replaceOnce(text, '"0.00000035"', '"3.5e-7"'), ["gpt-oss-120b"], /decimal/);
});

test("lists: Models.dev and LiteLLM read into the same shape", () => {
  const modelsDev = JSON.parse(fixture("models-dev.json"));
  const litellm = JSON.parse(fixture("litellm.json"));
  const fromMd = fromModelsDev(modelsDev, "openai", "gpt-5.6-sol");
  const fromLl = fromLitellm(litellm, "gpt-5.6-sol");
  assert.deepEqual(fromMd, {
    input: 4,
    output: 20,
    cached_input: 0.4,
    cache_write: 5,
    long_context_threshold: 272000,
    long_input: 8,
    long_cached_input: 0.8,
    long_cache_write: 10,
    long_output: 30,
  });
  assert.ok(samePrice(fromMd, fromLl));
  assert.ok(samePrice(fromModelsDev(modelsDev, "google", "gemini-2.5-pro"), fromLitellm(litellm, "gemini/gemini-2.5-pro")));
  assert.deepEqual(fromLitellm(litellm, "whisper-1"), { per_minute: 0.006 });
  assert.equal(fromModelsDev(modelsDev, "openai", "constructor"), undefined);
  assert.equal(fromLitellm(litellm, "constructor"), undefined);
});

// Deprecation pages -----------------------------------------------------------

test("dates: every written form the deprecation pages use", () => {
  assert.equal(parseDate("October 23, 2026", "t"), "2026-10-23");
  assert.equal(parseDate("Feb 26, 2027", "t"), "2027-02-26");
  assert.equal(parseDate("Sept 1, 2026", "t"), "2026-09-01");
  assert.equal(parseDate("2026-09-24", "t"), "2026-09-24");
  assert.equal(parseDate("2026\u201103\u201126", "t"), "2026-03-26");
  assert.equal(parseDate("09/14/26", "t"), "2026-09-14");
  assert.equal(parseDate("1/6/25", "t"), "2025-01-06");
  for (const bad of ["February 30, 2026", "Octember 1, 2026", "2026-13-01", "soon", "Q4 2026"]) {
    assert.throws(() => parseDate(bad, "t"), ParseError, bad);
  }
});

test("openai deprecations: every id in a model cell, and the newest date for one named twice", () => {
  const text = fixture("openai-deprecations.md");
  const dates = parse(parseOpenaiDeprecations, text, ["whisper-1", "gpt-4o-transcribe", "gpt-5", "gpt-4-1106-preview", "gpt-4-0314"]);
  assert.deepEqual(dates.get("whisper-1"), { date: "2027-02-26" });
  assert.deepEqual(dates.get("gpt-4o-transcribe"), { date: "2027-02-26" });
  // A snapshot shutting down says nothing about its alias.
  assert.equal(dates.has("gpt-5"), false);
  // Moved from 2026-03-26 to October 23, announced again above the first.
  assert.deepEqual(dates.get("gpt-4-1106-preview"), { date: "2026-10-23" });
  assert.deepEqual(dates.get("gpt-4-0314"), { date: "2026-03-26" });
  assertFails(parseOpenaiDeprecations, replaceOnce(text, "| Shutdown date | Model / system              |", "| Shutdown date | Model name                  |"), ["whisper-1"], /unknown model column/);
  assertFails(parseOpenaiDeprecations, replaceOnce(text, "| Feb 26, 2027  | `whisper-1`", "| Early 2027    | `whisper-1`"), ["whisper-1"], /not a date/);
});

test("anthropic deprecations: a promise is not a date, a retirement is", () => {
  const text = fixture("anthropic-deprecations.md");
  const wanted = ["claude-fable-5", "claude-mythos-preview", "claude-opus-4-1-20250805", "claude-opus-4-5-20251101"];
  const dates = parse(parseAnthropicDeprecations, text, wanted);
  assert.equal(dates.has("claude-fable-5"), false);
  assert.equal(dates.has("claude-opus-4-5-20251101"), false);
  assert.deepEqual(dates.get("claude-mythos-preview"), { deprecated: true });
  assert.deepEqual(dates.get("claude-opus-4-1-20250805"), { date: "2026-08-05" });
  // The catalog names aliases; the table names the snapshot behind them.
  assert.equal(sourceId(SOURCES.anthropic.deprecations, "claude-opus-4-5"), "claude-opus-4-5-20251101");
  // A routed model is priced as its replacement but keeps its own deprecation row.
  assert.equal(sourceId(SOURCES.gemini.official, "gemini-3.7-flash"), "gemini-3.8-flash");
  assert.equal(sourceId(SOURCES.gemini.deprecations, "gemini-3.7-flash"), "gemini-3.7-flash");
  assertFails(parseAnthropicDeprecations, replaceOnce(text, "| Current state |", "| State         |"), wanted, /header changed/);
  assertFails(parseAnthropicDeprecations, replaceOnce(text, "| Active        | N/A               | Not sooner than June 9, 2027", "| Active        | N/A               | Soon                        "), wanted, /active model/);
  assertFails(parseAnthropicDeprecations, replaceOnce(text, "| Retired       |", "| Sunset        |"), wanted, /unknown state/);
});

test("gemini deprecations: a shutdown date, none announced or N/A", () => {
  const text = fixture("gemini-deprecations.md");
  const dates = parse(parseGeminiDeprecations, text, ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash-image", "gemini-3-pro-preview"]);
  assert.equal(dates.has("gemini-3.6-flash"), false);
  // "N/A": the endpoint is not shutting down, it routes to its replacement.
  assert.equal(dates.has("gemini-3.5-flash"), false);
  assert.deepEqual(dates.get("gemini-3.1-flash-lite"), { date: "2027-05-07" });
  assert.deepEqual(dates.get("gemini-2.5-flash-image"), { date: "2026-10-02" });
  assert.deepEqual(dates.get("gemini-3-pro-preview"), { date: "2026-03-09" });
  assertFails(parseGeminiDeprecations, text.replaceAll("**Shutdown date**", "**Retirement date**"), ["gemini-3.6-flash"], /no model tables/);
  assertFails(parseGeminiDeprecations, replaceOnce(text, "| May 7, 2027 |", "| Mid 2027 |"), ["gemini-3.1-flash-lite"], /not a date/);
});

test("groq deprecations: month-first dates, newest announcement first", () => {
  const text = fixture("groq-deprecations.md");
  const dates = parse(parseGroqDeprecations, text, ["qwen/qwen3.6-27b", "llama-3.3-70b-versatile", "deepseek-r1-distill-llama-70b-specdec", "llama3-groq-8b-8192-tool-use-preview"]);
  assert.deepEqual(dates.get("qwen/qwen3.6-27b"), { date: "2026-09-14" });
  assert.deepEqual(dates.get("llama-3.3-70b-versatile"), { date: "2026-08-16" });
  assert.deepEqual(dates.get("deepseek-r1-distill-llama-70b-specdec"), { date: "2025-04-14" });
  assert.deepEqual(dates.get("llama3-groq-8b-8192-tool-use-preview"), { date: "2025-01-06" });
  assertFails(parseGroqDeprecations, replaceOnce(text, "## [Deprecation History](#deprecation-history)", "## History"), ["qwen/qwen3.6-27b"], /missing/);
  assertFails(parseGroqDeprecations, replaceOnce(text, "| Deprecated Model | Shutdown Date |", "| Old Model        | Shutdown Date |"), ["qwen/qwen3.6-27b"], /header/);
});

test("together deprecations: the removal history wins over the schedule", () => {
  const text = fixture("together-deprecations.md");
  const dates = parse(parseTogetherDeprecations, text, ["google/gemma-4-31B-it", "openai/gpt-oss-20b", "Qwen/Qwen3-235B-A22B-Thinking-2507", "nvidia/NVIDIA-Nemotron-Nano-9B-v2"]);
  assert.deepEqual(dates.get("google/gemma-4-31B-it"), { date: "2026-09-15" });
  assert.deepEqual(dates.get("openai/gpt-oss-20b"), { date: "2026-09-14" });
  assert.deepEqual(dates.get("Qwen/Qwen3-235B-A22B-Thinking-2507"), { date: "2026-04-16" });
  // Removed from fine-tuning is not removed from inference.
  assert.equal(dates.has("nvidia/NVIDIA-Nemotron-Nano-9B-v2"), false);
  assertFails(parseTogetherDeprecations, replaceOnce(text, "| Removal date | Model | Supported by", "| Date | Model | Supported by"), ["openai/gpt-oss-20b"], /history table/);
});

// Rules ---------------------------------------------------------------------

test("effective prices follow computeCost's fallbacks", () => {
  assert.ok(samePrice({ input: 1, output: 2 }, { input: 1, cached_input: 1, cache_write: 1, output: 2 }));
  assert.ok(!samePrice({ input: 1, output: 2 }, { input: 1, cached_input: 0.1, output: 2 }));
  // Long-context cached input falls back to the base cached price first.
  assert.deepEqual(
    effectivePrice({ input: 1, cached_input: 0.1, output: 2, long_context_threshold: 1000, long_input: 2 }),
    {
      input: 1,
      output: 2,
      cached_input: 0.1,
      cache_write: 1,
      cache_write_1h: 1,
      image_input: 1,
      audio_input: 1,
      video_input: 1,
      image_output: 2,
      long_input: 2,
      long_output: 2,
      long_cached_input: 0.1,
      long_cache_write: 2,
      long_cache_write_1h: 2,
    },
  );
  assert.ok(!samePrice({ input: 1, output: 2 }, { input: 1, output: 2, long_context_threshold: 1000 }));
  assert.deepEqual(compare({ input: 1, output: 2 }, { input: 1, cached_input: 1, output: 2 }), { edits: [] });
  // An image rate the catalog cannot bill would under-charge every generated image.
  assert.equal(compare({ input: 1, output: 2 }, { input: 1, output: 2, image_output: 30 }).problem, "field");
  assert.deepEqual(
    compare({ input: 1, output: 2, image_output: 30 }, { input: 1, output: 2, image_output: 40 }),
    { edits: [{ field: "image_output", from: 30, to: 40 }] },
  );
});

const page = (entries) => ({ prices: new Map(Object.entries(entries)) });
const noLists = { modelsDev: {}, litellm: {} };
const mdList = (provider, models) => ({ [provider]: { models: Object.fromEntries(Object.entries(models).map(([id, cost]) => [id, { cost }])) } });
const llList = (entries) =>
  Object.fromEntries(
    Object.entries(entries).map(([key, price]) => [
      key,
      { input_cost_per_token: price.input / 1e6, output_cost_per_token: price.output / 1e6 },
    ]),
  );

const cases = [
  {
    name: "official equal: nothing to do",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 2 } }) },
    changes: [],
    attention: [],
  },
  {
    name: "official different: update",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1.5, output: 2 } }) },
    changes: [["cerebras/a", "input", 1, 1.5, "official"]],
    attention: [],
  },
  {
    name: "official missing: reported, and the lists are not consulted",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 }, b: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 2 } }) },
    lists: { modelsDev: mdList("cerebras", { b: { input: 5, output: 6 } }), litellm: llList({ "cerebras/b": { input: 5, output: 6 } }) },
    changes: [],
    attention: ["cerebras/b: not on official page"],
  },
  {
    name: "under half found: the parser fails and the lists answer",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 }, b: { input: 1.0, output: 2.0 }, c: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 2 } }) },
    changes: [],
    attention: ["cerebras: parser failed"],
    noSource: ["cerebras/a", "cerebras/b", "cerebras/c"],
  },
  {
    name: "a per-image price is compared as one, never against token prices",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 }, i: { per_image: 0.03 }, j: { per_image: 0.04 }, k: { per_image: 0.04 } } },
    official: { cerebras: page({ a: { input: 1, output: 2 }, i: { per_image: 0.03 }, j: { per_image: 0.045 }, k: { input: 1, output: 2 } }) },
    changes: [["cerebras/j", "per_image", 0.04, 0.045, "official"]],
    attention: ["cerebras/k: cannot compare"],
  },
  {
    name: "parser failed, lists agree: update from the lists",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 } } },
    official: { cerebras: { error: "the table header changed" } },
    lists: { modelsDev: mdList("cerebras", { a: { input: 1.25, output: 2 } }), litellm: llList({ "cerebras/a": { input: 1.25, output: 2 } }) },
    changes: [["cerebras/a", "input", 1, 1.25, "models.dev + litellm"]],
    attention: ["cerebras: parser failed"],
  },
  {
    name: "lists disagree: no update",
    catalog: { mistral: { a: { input: 1.0, output: 2.0 } } },
    lists: { modelsDev: mdList("mistral", { a: { input: 1.25, output: 2 } }), litellm: llList({ "mistral/a": { input: 1.5, output: 2 } }) },
    changes: [],
    attention: ["mistral/a: lists disagree"],
  },
  {
    name: "only one list, and it differs: no update",
    catalog: { mistral: { a: { input: 1.0, output: 2.0 } } },
    lists: { modelsDev: mdList("mistral", { a: { input: 1.25, output: 2 } }), litellm: {} },
    changes: [],
    attention: ["mistral/a: only one list"],
  },
  {
    name: "only one list, and it agrees: nothing to report",
    catalog: { mistral: { a: { input: 1.0, output: 2.0 } } },
    lists: { modelsDev: {}, litellm: llList({ "mistral/a": { input: 1, output: 2 } }) },
    changes: [],
    attention: [],
  },
  {
    name: "no source at all: informational",
    catalog: { mistral: { a: { input: 1.0, output: 2.0 } } },
    changes: [],
    attention: [],
    noSource: ["mistral/a"],
  },
  {
    name: "a price our entry has no field for: reported, not edited",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1.5, cached_input: 0.15, output: 2 } }) },
    changes: [],
    attention: ["cerebras/a: needs a new field"],
  },
  {
    name: "a different long-context threshold: reported, not edited",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0, long_context_threshold: 200000, long_input: 2.0, long_output: 4.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 2, long_context_threshold: 272000, long_input: 2, long_output: 4 } }) },
    changes: [],
    attention: ["cerebras/a: threshold differs"],
  },
  {
    name: "a move of more than 3x: suspicious, not applied",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 8 } }) },
    changes: [],
    attention: ["cerebras/a: suspicious change"],
  },
  {
    name: "a price outside the per-1M band: suspicious, not applied",
    catalog: { cerebras: { a: { input: 0.002, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 0.001, output: 2 } }) },
    changes: [],
    attention: ["cerebras/a: suspicious change"],
  },
  {
    name: "an acknowledged item no longer needs a person",
    catalog: { cerebras: { a: { input: 1.0, output: 2.0 }, b: { input: 1.0, output: 2.0 } } },
    official: { cerebras: page({ a: { input: 1, output: 2 } }) },
    acknowledged: [{ key: "cerebras/b: not on official page", reason: "kept for existing apps" }],
    changes: [],
    attention: [],
    acknowledged_: ["cerebras/b: not on official page"],
  },
  {
    name: "an audio price is compared in its own unit",
    catalog: { groq: { w: { per_hour: 0.111 }, x: { input: 1.0, output: 2.0 } } },
    official: { groq: page({ w: { per_hour: 0.04 }, x: { input: 1, output: 2 } }) },
    changes: [["groq/w", "per_hour", 0.111, 0.04, "official"]],
    attention: [],
  },
];

for (const scenario of cases) {
  test(`rules: ${scenario.name}`, () => {
    const decision = decide({
      catalog: scenario.catalog,
      official: scenario.official ?? {},
      lists: scenario.lists ?? noLists,
      acknowledged: scenario.acknowledged ?? [],
    });
    assert.deepEqual(
      decision.changes.map((change) => [`${change.provider}/${change.model}`, change.field, change.from, change.to, change.source]),
      scenario.changes,
    );
    assert.deepEqual(decision.attention.map((item) => item.key), scenario.attention);
    assert.equal(needsHuman(decision), scenario.attention.length > 0);
    if (scenario.noSource) {
      assert.deepEqual(decision.noSource.map((item) => `${item.provider}/${item.model}`), scenario.noSource);
    }
    if (scenario.acknowledged_) {
      assert.deepEqual(decision.acknowledged.map((item) => item.key), scenario.acknowledged_);
    }
  });
}

test("lists: a price one list leaves out is not a disagreement", () => {
  const md = (models) => ({ baseten: { models: Object.fromEntries(Object.entries(models).map(([id, cost]) => [id, { cost }])) } });
  const ll = (entries) => Object.fromEntries(Object.entries(entries).map(([id, price]) => [`baseten/${id}`, {
    input_cost_per_token: price.input / 1e6,
    output_cost_per_token: price.output / 1e6,
    ...(price.cached_input !== undefined && { cache_read_input_token_cost: price.cached_input / 1e6 }),
  }]));
  const run = (catalog, modelsDev, litellm) => decide({ catalog: { baseten: catalog }, official: {}, lists: { modelsDev: md(modelsDev), litellm: ll(litellm) }, today: TODAY });

  // Models.dev gives no cached price, LiteLLM gives ours: nothing to report.
  const agreeing = run({ k: { input: 3.0, cached_input: 0.3, output: 15.0 } }, { k: { input: 3, output: 15 } }, { k: { input: 3, cached_input: 0.3, output: 15 } });
  assert.deepEqual([agreeing.changes, agreeing.attention], [[], []]);

  // The one list that has a cached price differs from ours: reported, never applied.
  const single = run({ k: { input: 3.0, cached_input: 0.3, output: 15.0 } }, { k: { input: 3, output: 15 } }, { k: { input: 3, cached_input: 0.25, output: 15 } });
  assert.deepEqual(single.changes, []);
  assert.deepEqual(single.attention.map((item) => item.key), ["baseten/k: only one list"]);
  assert.match(single.attention[0].text, /LiteLLM gives cached \$0\.25, ours bills \$0\.3/);

  // Both state a cached price and they differ: the field is named.
  const conflict = run({ k: { input: 3.0, cached_input: 0.3, output: 15.0 } }, { k: { input: 3, cache_read: 0.2, output: 15 } }, { k: { input: 3, cached_input: 0.25, output: 15 } });
  assert.deepEqual(conflict.attention.map((item) => item.key), ["baseten/k: lists disagree"]);
  assert.match(conflict.attention[0].text, /disagree on cached: Models\.dev \$0\.2, LiteLLM \$0\.25/);

  // Both agree on a new input price and say nothing of cached: only input moves.
  const moved = run({ k: { input: 3.0, cached_input: 0.3, output: 15.0 } }, { k: { input: 2.5, output: 15 } }, { k: { input: 2.5, output: 15 } });
  assert.deepEqual(moved.changes.map((change) => [change.field, change.to]), [["input", 2.5]]);
  assert.deepEqual(moved.attention, []);
});

test("rules: a dated price is applied on its day and announced before it", () => {
  const catalog = { gemini: { "gemini-3.6-flash": { input: 0.75, cached_input: 0.075, output: 3.75 } } };
  const run = (today) =>
    decide({
      catalog,
      official: { gemini: { prices: parse(parseGemini, fixture("gemini.md"), ["gemini-3.6-flash"], today) } },
      lists: noLists,
      today,
    });
  const before = run("2026-12-31");
  assert.deepEqual(before.changes, []);
  assert.deepEqual(catalogEdits(before), [], "a future announcement must not trigger a catalog update");
  assert.deepEqual(before.upcoming.map((item) => [item.field, item.value, item.date]), [
    ["input", 1.5, "2027-01-01"],
    ["output", 7.5, "2027-01-01"],
    ["cached_input", 0.15, "2027-01-01"],
  ]);
  assert.equal(needsHuman(before), false);
  assert.match(renderReport(before), /### Upcoming price changes[\s\S]*2027-01-01/u);
  const after = run("2027-01-01");
  assert.deepEqual(after.changes.map((change) => [change.field, change.to]), [["input", 1.5], ["cached_input", 0.15], ["output", 7.5]]);
  assert.equal(catalogEdits(after).length, 3);
  assert.deepEqual(after.upcoming, []);
});

test("rules: a provider no source covers is reported as such, not as a disagreement", () => {
  const decision = decide({
    catalog: { bytedance: { a: { input: 1.0, output: 2.0 } } },
    official: {},
    lists: { modelsDev: { volcengine: { models: { a: { cost: { input: 9, output: 9 } } } } }, litellm: { "volcengine/a": { input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 } } },
    today: TODAY,
  });
  assert.deepEqual(decision.noSource.map((item) => item.model), ["a"]);
  assert.deepEqual(decision.attention, []);
  assert.deepEqual(decision.sources, [{ provider: "bytedance", text: "no source" }]);
});

test("sources: every catalog provider has an entry", () => {
  for (const provider of Object.keys(JSON.parse(liveCatalogText))) {
    assert.ok(SOURCES[provider], `scripts/models/sources.mjs has no entry for ${provider}`);
  }
});

// Catalog editor ------------------------------------------------------------

test("catalog editor: no edits leave the file byte for byte", () => {
  assert.equal(applyEdits(liveCatalogText, []), liveCatalogText);
  assert.equal(applyEdits(catalogText, []), catalogText);
});

test("catalog editor: one edit changes exactly one literal", () => {
  const edited = applyEdits(catalogText, [{ provider: "openai", model: "gpt-5.6-sol", field: "input", to: 4 }]);
  const before = catalogText.split("\n");
  const after = edited.split("\n");
  assert.equal(after.length, before.length);
  const changed = before.flatMap((line, index) => (line === after[index] ? [] : [[line, after[index]]]));
  assert.deepEqual(changed, [['      "input": 5.0,', '      "input": 4.0,']]);
  // gpt-5.6, the entry just above with the same prices, is untouched.
  assert.equal(JSON.parse(edited).openai["gpt-5.6"].input, 5);
});

test("catalog editor: numbers are written short and without float noise", () => {
  assert.equal(formatPrice(0.1 + 0.2), "0.3");
  assert.equal(formatPrice(4), "4.0");
  assert.equal(formatPrice(0.075), "0.075");
});

test("catalog editor: a model id with braces or quotes does not confuse it", () => {
  const text = '{\n  "p": {\n    "a{\\"}b": { "input": 1.0, "output": 2.0 },\n    "x": { "input": 1.0, "output": 2.0 }\n  }\n}\n';
  const edited = applyEdits(text, [{ provider: "p", model: "x", field: "input", to: 1.5 }]);
  assert.equal(edited, text.replace('"x": { "input": 1.0', '"x": { "input": 1.5'));
  const quoted = applyEdits(text, [{ provider: "p", model: 'a{"}b', field: "output", to: 3 }]);
  assert.equal(quoted, text.replace('"a{\\"}b": { "input": 1.0, "output": 2.0', '"a{\\"}b": { "input": 1.0, "output": 3.0'));
});

test("catalog editor: a retirement date joins a one-line entry that still fits", () => {
  const edited = applyEdits(catalogText, [{ provider: "openai", model: "whisper-1", field: "retirement_date", to: "2027-02-26" }]);
  const changed = catalogText.split("\n").flatMap((line, index) => (line === edited.split("\n")[index] ? [] : [[line, edited.split("\n")[index]]]));
  assert.deepEqual(changed, [['    "whisper-1": { "per_minute": 0.006 }', '    "whisper-1": { "per_minute": 0.006, "retirement_date": "2027-02-26" }']]);
});

test("catalog editor: a one-line entry that would pass 100 columns is spread out", () => {
  const edited = applyEdits(catalogText, [
    { provider: "groq", model: "qwen/qwen3.6-27b", field: "retirement_date", to: "2026-09-14" },
    { provider: "groq", model: "qwen/qwen3.6-27b", field: "input", to: 0.5 },
  ]);
  assert.ok(edited.includes(
    '    "qwen/qwen3.6-27b": {\n      "input": 0.5,\n      "output": 3.0,\n      "author": "Alibaba",\n      "retirement_date": "2026-09-14"\n    },\n',
  ));
  const before = new Set(catalogText.split("\n"));
  assert.ok(edited.split("\n").filter((line) => !before.has(line)).every((line) => line.length <= 100));
});

test("catalog editor: a multi-line entry gains a line after its last field", () => {
  const edited = applyEdits(catalogText, [{ provider: "openai", model: "gpt-5.4", field: "retirement_date", to: "2027-06-01" }]);
  assert.ok(edited.includes('      "long_output": 22.5,\n      "retirement_date": "2027-06-01"\n    },\n    "gpt-5.4-pro"'));
  const moved = applyEdits(edited, [{ provider: "openai", model: "gpt-5.4", field: "retirement_date", to: "2027-07-01" }]);
  assert.equal(moved, edited.replace('"retirement_date": "2027-06-01"', '"retirement_date": "2027-07-01"'));
});

test("catalog editor: refuses to add a field", () => {
  assert.throws(
    () => applyEdits(catalogText, [{ provider: "openai", model: "gpt-5-pro", field: "cached_input", to: 1 }]),
    /missing/,
  );
});

// Retirement rules ------------------------------------------------------------

const dates = (entries) => ({ dates: new Map(Object.entries(entries)) });
const mdDeprecated = (provider, ids) => ({
  [provider]: { models: Object.fromEntries(ids.map((id) => [id, { status: "deprecated", cost: { input: 1, output: 2 } }])) },
});

test("retirement: an official date is added, and a moved one updated", () => {
  const decision = decide({
    catalog: { openai: { a: { input: 1.0, output: 2.0 }, b: { input: 1.0, output: 2.0, retirement_date: "2026-12-01" }, c: { input: 1.0, output: 2.0 } } },
    official: { openai: page({ a: { input: 1, output: 2 }, b: { input: 1, output: 2 }, c: { input: 1, output: 2 } }) },
    deprecations: { openai: dates({ a: { date: "2027-02-26" }, b: { date: "2027-01-15" } }) },
    lists: noLists,
    today: TODAY,
  });
  assert.deepEqual(
    decision.retirements.map((item) => [item.model, item.from, item.to, item.source]),
    [["a", undefined, "2027-02-26", "official"], ["b", "2026-12-01", "2027-01-15", "official"]],
  );
  assert.equal(needsHuman(decision), false);
  assert.deepEqual(catalogEdits(decision), [], "retirement-only changes must not trigger a catalog update");
  assert.match(renderReport(decision), /### Retirement dates[\s\S]*2027-02-26/u);
});

test("retirement: dates accompany an actual price update", () => {
  const decision = decide({
    catalog: { openai: { a: { input: 1.0, output: 2.0 }, b: { input: 1.0, output: 2.0 } } },
    official: { openai: page({ a: { input: 1.25, output: 2 }, b: { input: 1, output: 2 } }) },
    deprecations: { openai: dates({ b: { date: "2027-02-26" } }) },
    lists: noLists,
    today: TODAY,
  });
  assert.deepEqual(catalogEdits(decision), [
    { provider: "openai", model: "a", field: "input", to: 1.25 },
    { provider: "openai", model: "b", field: "retirement_date", to: "2027-02-26" },
  ]);
  const text = JSON.stringify({ openai: { a: { input: 1.0, output: 2.0 }, b: { input: 1.0, output: 2.0 } } });
  assert.deepEqual(JSON.parse(applyEdits(text, catalogEdits(decision))).openai, {
    a: { input: 1.25, output: 2 },
    b: { input: 1, output: 2, retirement_date: "2027-02-26" },
  });
});

test("retirement: a date the official page withdrew needs a person, and stays", () => {
  const decision = decide({
    catalog: { openai: { a: { input: 1.0, output: 2.0, retirement_date: "2027-02-26" } } },
    official: { openai: page({ a: { input: 1, output: 2 } }) },
    deprecations: { openai: dates({}) },
    lists: noLists,
    today: TODAY,
  });
  assert.deepEqual(decision.retirements, []);
  assert.deepEqual(decision.attention.map((item) => item.key), ["openai/a: retirement date withdrawn"]);
});

test("retirement: deprecated without a date is noted, not dated", () => {
  const decision = decide({
    catalog: { anthropic: { a: { input: 1.0, output: 2.0 } } },
    official: { anthropic: page({ a: { input: 1, output: 2 } }) },
    deprecations: { anthropic: dates({ a: { deprecated: true } }) },
    lists: noLists,
    today: TODAY,
  });
  assert.deepEqual(decision.retirements, []);
  assert.deepEqual(decision.deprecationNotes.map((item) => item.model), ["a"]);
  assert.equal(needsHuman(decision), false);
});

test("retirement: the lists date a model only when both mark it", () => {
  const catalog = { mistral: { both: { input: 1.0, output: 2.0 }, flag: { input: 1.0, output: 2.0 }, date: { input: 1.0, output: 2.0 } } };
  const litellm = {
    "mistral/both": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, deprecation_date: "2026-12-31" },
    "mistral/flag": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    "mistral/date": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, deprecation_date: "2026-11-30" },
  };
  const modelsDev = { mistral: { models: { ...mdDeprecated("mistral", ["both", "flag"]).mistral.models, date: { cost: { input: 1, output: 2 } } } } };
  const decision = decide({ catalog, official: {}, lists: { modelsDev, litellm }, today: TODAY });
  assert.deepEqual(decision.retirements.map((item) => [item.model, item.to, item.source]), [["both", "2026-12-31", "models.dev + litellm"]]);
  assert.deepEqual(decision.deprecationNotes.map((item) => item.model), ["flag", "date"]);
  assert.equal(needsHuman(decision), false);
});

test("retirement: a retired model missing from its pricing page is expected", () => {
  const decision = decide({
    catalog: { groq: { gone: { input: 1.0, output: 2.0 }, live: { input: 1.0, output: 2.0 }, lost: { input: 1.0, output: 2.0 } } },
    official: { groq: page({ live: { input: 1, output: 2 } }) },
    deprecations: { groq: dates({ gone: { date: "2026-09-14" } }) },
    lists: noLists,
    today: TODAY,
  });
  assert.deepEqual(decision.retired.map((item) => [item.model, item.date]), [["gone", "2026-09-14"]]);
  assert.deepEqual(decision.attention.map((item) => item.key), ["groq/lost: not on official page"]);
});

test("retirement: retired models do not count against the half-found check", () => {
  const decision = decide({
    catalog: { groq: { a: { input: 1.0, output: 2.0 }, b: { input: 1.0, output: 2.0, retirement_date: "2026-01-01" }, c: { input: 1.0, output: 2.0, retirement_date: "2026-01-01" } } },
    official: { groq: page({ a: { input: 1, output: 2 } }) },
    deprecations: { groq: dates({ b: { date: "2026-01-01" }, c: { date: "2026-01-01" } }) },
    lists: noLists,
    today: TODAY,
  });
  assert.equal(decision.attention.some((item) => item.key === "groq: parser failed"), false);
});

test("retirement: a failed deprecation parser needs a person and falls back to the lists", () => {
  const decision = decide({
    catalog: { openai: { a: { input: 1.0, output: 2.0 } } },
    official: { openai: page({ a: { input: 1, output: 2 } }) },
    deprecations: { openai: { error: "no Shutdown date tables" } },
    lists: { modelsDev: mdDeprecated("openai", ["a"]), litellm: { a: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, deprecation_date: "2027-01-01" } } },
    today: TODAY,
  });
  assert.deepEqual(decision.attention.map((item) => item.key), ["openai: deprecation parser failed"]);
  assert.deepEqual(decision.retirements.map((item) => [item.to, item.source]), [["2027-01-01", "models.dev + litellm"]]);
});

// Report --------------------------------------------------------------------

for (const changed of [false, true]) {
  test(`report: ${changed ? "current prices trigger a PR" : "informational changes do not trigger a PR"}`, () => {
    const decision = decide({
      catalog: { openai: { a: { input: 1.0, output: 2.0 }, b: { input: 1.0, output: 2.0 } } },
      official: { openai: page({
        a: { input: changed ? 1.25 : 1, output: 2, upcoming: [{ field: "input", value: 1.5, date: "2027-01-01" }] },
        b: { input: 1, output: 2 },
      }) },
      deprecations: { openai: dates({ b: { date: "2027-02-26" } }) },
      lists: noLists,
      today: TODAY,
    });
    const report = renderReport(decision);
    assert.deepEqual(report.match(/^## .+$/gmu), [
      ...(changed ? ["## ✅ Current price changes"] : []),
      "## ℹ️ Additional information",
    ]);
    const [trigger, additional] = report.split("## ℹ️ Additional information");
    assert.doesNotMatch(trigger, /Retirement dates|Upcoming price changes|2027-01-01|2027-02-26/u);
    assert.match(additional, /For information only/u);
    assert.match(additional, /### Retirement dates[\s\S]*2027-02-26/u);
    assert.match(additional, /### Upcoming price changes[\s\S]*2027-01-01/u);
    assert.doesNotMatch(additional, /Current price changes/u);
    if (changed) {
      assert.match(trigger, /## ✅ Current price changes[\s\S]*1 → \*\*1\.25\*\*/u);
      assert.doesNotMatch(trigger, /No pull request is needed/u);
      assert.ok(catalogEdits(decision).length > 0);
    } else {
      assert.match(trigger, /No current price changes or newly discovered models\. No pull request is needed\./u);
      assert.doesNotMatch(trigger, /Current price changes/u);
      assert.deepEqual(catalogEdits(decision), []);
    }
  });
}

test("title: counts what the pull request holds, with a short date", () => {
  const empty = { changes: [], newModels: [], attention: [] };
  assert.equal(renderTitle(empty, "2026-10-10"), "Model catalog: no changes (Oct 10)");
  // One model with several changed fields is one price change.
  const changes = [
    { provider: "p", model: "a", field: "input" },
    { provider: "p", model: "a", field: "output" },
    { provider: "q", model: "a", field: "input" },
  ];
  assert.equal(renderTitle({ ...empty, changes }, "2027-01-05"), "Model catalog: 2 price changes (Jan 5)");
  assert.equal(
    renderTitle({ changes: changes.slice(0, 1), newModels: [{ provider: "p", ids: ["x", "y"] }, { provider: "q", ids: ["z"] }], attention: [{}] }, "2026-12-31"),
    "Model catalog: 1 price change, 3 new models, 1 needs attention (Dec 31)",
  );
  assert.equal(renderTitle({ ...empty, newModels: [{ provider: "p", ids: ["x"] }], attention: [{}, {}] }, "2026-10-10"), "Model catalog: 1 new model, 2 need attention (Oct 10)");
});

test("report: fetched text is escaped", () => {
  const report = renderReport({
    changes: [{ provider: "p", model: "m`|<b>", field: "input", from: 1, to: 2, source: "official" }],
    retirements: [],
    retired: [],
    deprecationNotes: [{ provider: "p", model: "m", text: "<script>alert(1)</script>" }],
    attention: [{ key: "p: parser failed", text: 'official parser failed: "<img src=x onerror=alert(1)>" | [link](https://evil) `x`' }],
    acknowledged: [],
    upcoming: [],
    noSource: [],
    newModels: [{ provider: "p", ids: ["</details><script>", "a`b"] }],
    sources: [{ provider: "p", text: "official failed → lists" }],
  });
  assert.doesNotMatch(report, /<img|<script|<b>/u);
  assert.doesNotMatch(report, /(?<!\\)\[link\]/u, "a fetched link must not render as one");
  assert.match(report, /&lt;img/u);
  const row = report.split("\n").find((line) => line.startsWith("| `p/m"));
  assert.equal(row.split(/(?<!\\)\|/u).length, 6, "the model id must not add a table cell");
  assert.deepEqual(report.match(/^## .+$/gmu), [
    "## ✅ Current price changes",
    "## ✅ Newly discovered models",
    "## ❌ Needs your attention",
    "## ℹ️ Additional information",
  ]);
  assert.match(report, /## ❌ Needs your attention[\s\S]*parser failed[\s\S]*## ℹ️ Additional information[\s\S]*<summary>Sources<\/summary>/u);
  assert.doesNotMatch(report.split("## ℹ️ Additional information")[1], /parser failed/u);
});
