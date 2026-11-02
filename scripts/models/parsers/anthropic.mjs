// https://platform.claude.com/docs/en/about-claude/pricing.md
//
// The first table under "## Model pricing". Rows are display names, so
// "Claude Opus 4.5" is read as `claude-opus-4-5`. The 5m cache-write column is
// `cache_write` and the 1h one `cache_write_1h`, which bills the share of a
// write the response reports as kept for an hour. A model priced by
// prompt length has two adjacent rows, "(for prompts up to N tokens)" and
// "(for prompts over N tokens)", read as one price with long-context fields.

import { ParseError, decimal, findLine, put, readTable } from "../price.mjs";

const HEADER = [
  "Model",
  "Base input tokens",
  "5m cache writes",
  "1h cache writes",
  "Cache hits and refreshes",
  "Output tokens",
];

// An optional trailing parenthetical link, like "([limited availability](…))",
// or a prompt-length tier, like "(for prompts up to 100,000 tokens)".
const MODEL_CELL =
  /^(Claude [A-Z][a-z]+ \d+(?:\.\d+)?)(?: \(\[[^\]]+\]\([^)\s]+\)\)| \(for prompts (up to|over) (\d{1,3}(?:,\d{3})*) tokens\))?$/u;
const PRICE_CELL = /^\$(\S+) \/ MTok$/u;
const FOOTNOTE = /<sup>\d+<\/sup>/gu;

export function modelId(displayName) {
  return displayName.toLowerCase().replaceAll(" ", "-").replaceAll(".", "-");
}

function price(text, where) {
  const match = PRICE_CELL.exec(text.replace(FOOTNOTE, ""));
  if (!match) throw new ParseError(`${where}: "${text}" is not a "$N / MTok" price`);
  return decimal(match[1], where);
}

function tokenPrices(row, where) {
  return {
    input: price(row[1], where),
    cached_input: price(row[4], where),
    cache_write: price(row[2], where),
    cache_write_1h: price(row[3], where),
    output: price(row[5], where),
  };
}

export function parseAnthropic(text, { wanted }) {
  const lines = text.split("\n");
  const prices = new Map();
  const heading = findLine(lines, "## Model pricing", "model pricing");
  // A sentence introduces the table; skip it, but only it.
  let start = heading + 1;
  while (lines[start]?.trim() === "") start += 1;
  if (!lines[start]?.trim().startsWith("|")) start += 1;

  const rows = readTable(lines, start, HEADER, "model pricing");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const model = MODEL_CELL.exec(row[0].replace(FOOTNOTE, ""));
    if (!model) throw new ParseError(`model pricing: unexpected model cell "${row[0]}"`);
    const id = modelId(model[1]);
    let long;
    if (model[2] === "over") throw new ParseError(`${id}: a long-context row without its base row`);
    if (model[2] === "up to") {
      long = rows[index + 1];
      const next = long ? MODEL_CELL.exec(long[0].replace(FOOTNOTE, "")) : null;
      if (!next || next[1] !== model[1] || next[2] !== "over" || next[3] !== model[3]) {
        throw new ParseError(`${id}: a base row without its long-context row`);
      }
      index += 1;
    }
    if (!wanted.has(id)) {
      put(prices, id, null);
      continue;
    }
    const where = `model pricing, ${id}`;
    const tokens = tokenPrices(row, where);
    if (long) {
      const longTokens = tokenPrices(long, where);
      tokens.long_context_threshold = Number(model[3].replaceAll(",", ""));
      tokens.long_input = longTokens.input;
      tokens.long_cached_input = longTokens.cached_input;
      tokens.long_cache_write = longTokens.cache_write;
      tokens.long_cache_write_1h = longTokens.cache_write_1h;
      tokens.long_output = longTokens.output;
    }
    put(prices, id, tokens);
  }
  return prices;
}
