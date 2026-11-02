import { describe, expect, it } from "vitest";
import { ProviderPricingSchema } from "../src/contracts/schemas";
import { computeCost, type UsageObservation } from "../src/usage/pricing";
import { extractUsageText } from "../src/usage/usage-readers";
import { shippedRates } from "./shipped-rates";

const SONNET = "claude-sonnet-5";

function anthropicBody(usage: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", usage });
}

function written(cacheWriteTokens: number, oneHour?: unknown): UsageObservation {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens,
    outputTokens: 0,
    ...(oneHour !== undefined && { tokenVariants: { cache_write: { "1h": oneHour as number } } }),
  };
}

describe("Anthropic cache-write TTL split", () => {
  it("bills the one-hour share at its own rate and the rest at the default write rate", () => {
    const usage = extractUsageText(
      anthropicBody({
        input_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
        output_tokens: 2,
      }),
      "application/json",
      "anthropic_messages",
    );
    expect(usage).toEqual({
      inputTokens: 5,
      cachedInputTokens: 0,
      cacheWriteTokens: 100,
      outputTokens: 2,
      tokenVariants: { cache_write: { "1h": 40 } },
    });
    const rates = shippedRates("anthropic", SONNET);
    expect(computeCost("anthropic", SONNET, usage!)).toBeCloseTo(
      (5 * rates.input + 60 * rates.cache_write + 40 * rates.cache_write_1h + 2 * rates.output) / 1e6,
      12,
    );
  });

  it("keeps the split from message_start when later stream events omit it", () => {
    const usage = extractUsageText(
      [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 30,
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 30 },
              output_tokens: 1,
            },
          },
        })}`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { input_tokens: 10, cache_creation_input_tokens: 30, output_tokens: 9 },
        })}`,
      ].join("\n\n") + "\n\n",
      "text/event-stream",
      "anthropic_messages",
    );
    expect(usage).toMatchObject({ cacheWriteTokens: 30, outputTokens: 9 });
    expect(usage?.tokenVariants).toEqual({ cache_write: { "1h": 30 } });
  });

  it("bills an unsplit write at the default rate, as before the split was read", () => {
    const usage = extractUsageText(
      anthropicBody({ input_tokens: 1, cache_creation_input_tokens: 50, output_tokens: 1 }),
      "application/json",
      "anthropic_messages",
    );
    expect(usage?.tokenVariants).toBeUndefined();
    const rates = shippedRates("anthropic", SONNET);
    expect(computeCost("anthropic", SONNET, usage!)).toBeCloseTo(
      (rates.input + 50 * rates.cache_write + rates.output) / 1e6,
      12,
    );
  });

  it("never bills more variant tokens than the bucket holds", () => {
    const rates = shippedRates("anthropic", SONNET);
    expect(computeCost("anthropic", SONNET, written(10, 500))).toBeCloseTo(10 * rates.cache_write_1h / 1e6, 12);
  });

  it("ignores a stored variant count that is not a non-negative number", () => {
    const rates = shippedRates("anthropic", SONNET);
    for (const bad of [-5, "40", Number.NaN, null]) {
      expect(computeCost("anthropic", SONNET, written(20, bad))).toBeCloseTo(20 * rates.cache_write / 1e6, 12);
    }
  });

  it("uses the long-context one-hour rate above the threshold", () => {
    const rates = shippedRates("anthropic", "claude-haiku-5-5");
    const usage: UsageObservation = {
      inputTokens: rates.long_context_threshold,
      cachedInputTokens: 0,
      cacheWriteTokens: 1000,
      outputTokens: 0,
      tokenVariants: { cache_write: { "1h": 1000 } },
    };
    expect(computeCost("anthropic", "claude-haiku-5-5", usage)).toBeCloseTo(
      (rates.long_context_threshold * rates.long_input + 1000 * rates.long_cache_write_1h) / 1e6,
      12,
    );
  });
});

describe("custom prices", () => {
  const usage: UsageObservation = {
    inputTokens: 100,
    cachedInputTokens: 200,
    cacheWriteTokens: 50,
    outputTokens: 10,
    tokenVariants: { cache_write: { "1h": 20 } },
  };

  it("bill each bucket at the rates the custom price sets", () => {
    const pricing = {
      [SONNET]: { input: 1, output: 4, cached_input: 0.1, cache_write: 1.5, cache_write_1h: 3 },
    };
    expect(computeCost("anthropic", SONNET, usage, pricing)).toBeCloseTo(
      (100 * 1 + 200 * 0.1 + 30 * 1.5 + 20 * 3 + 10 * 4) / 1e6,
      12,
    );
  });

  it("replace the catalog's rates instead of inheriting its cache discount", () => {
    // Only input and output given: cache reads and writes, one-hour ones
    // included, bill at input — never at the catalog's cheaper cache rates.
    const pricing = { [SONNET]: { input: 1, output: 4 } };
    expect(computeCost("anthropic", SONNET, usage, pricing)).toBeCloseTo((350 * 1 + 10 * 4) / 1e6, 12);
  });

  it("bill an unpriced variant at its bucket's rate", () => {
    const pricing = { [SONNET]: { input: 1, output: 4, cache_write: 1.5 } };
    expect(computeCost("anthropic", SONNET, usage, pricing)).toBeCloseTo(
      (100 * 1 + 200 * 1 + 50 * 1.5 + 10 * 4) / 1e6,
      12,
    );
  });

  it("carry no field the rate list does not name into the arithmetic", () => {
    const pricing = { [SONNET]: { input: 1, output: 4, per_minute: 100 } } as never;
    expect(computeCost("anthropic", SONNET, usage, pricing)).toBeCloseTo((350 * 1 + 10 * 4) / 1e6, 12);
  });
});

describe("the custom price schema", () => {
  it("accepts every per-token rate", () => {
    const parsed = ProviderPricingSchema.safeParse({
      m: {
        input: 1,
        output: 2,
        cached_input: 0.1,
        cache_write: 1.25,
        cache_write_1h: 2,
        image_input: 3,
        long_context_threshold: 200_000,
        long_input: 2,
        long_cache_write_1h: 4,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("still requires input and output", () => {
    expect(ProviderPricingSchema.safeParse({ m: { input: 1, cached_input: 0.1 } }).success).toBe(false);
  });

  it("refuses a field that is not a per-token rate", () => {
    expect(ProviderPricingSchema.safeParse({ m: { input: 1, output: 2, per_minute: 1 } }).success).toBe(false);
    expect(ProviderPricingSchema.safeParse({ m: { input: 1, output: 2, kind: "text" } }).success).toBe(false);
  });

  it("refuses a negative rate", () => {
    expect(ProviderPricingSchema.safeParse({ m: { input: 1, output: 2, cache_write: -1 } }).success).toBe(false);
  });

  it("refuses long-context rates without their threshold", () => {
    expect(ProviderPricingSchema.safeParse({ m: { input: 1, output: 2, long_input: 2 } }).success).toBe(false);
  });
});
