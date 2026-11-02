import models from "../src/usage/models.json";

/**
 * A test asserts the cost arithmetic — which rate each kind of token is billed
 * at, and when the long-context rate applies — never what a model costs today.
 * The daily model sync changes the shipped prices, so a test reads the rates
 * from the model's catalog entry instead of repeating them, and keeps only the
 * formula in its own words.
 */
export interface ShippedRates {
  input: number;
  output: number;
  image_input: number;
  audio_input: number;
  video_input: number;
  image_output: number;
  cached_input: number;
  cache_write: number;
  cache_write_1h: number;
  per_minute: number;
  per_hour: number;
  per_image: number;
  long_context_threshold: number;
  long_input: number;
  long_output: number;
  long_cached_input: number;
  long_cache_write: number;
  long_cache_write_1h: number;
}

/**
 * The shipped rates of one model. Reading a rate the entry does not have
 * throws, so a test that depends on, say, a cached price fails with a reason
 * when the catalog stops carrying one, instead of comparing against `NaN`.
 */
export function shippedRates(provider: string, model: string): ShippedRates {
  const catalog = models as Record<string, Record<string, Record<string, unknown>>>;
  const entry = catalog[provider]?.[model];
  if (entry === undefined) throw new Error(`${provider}/${model} is not in src/usage/models.json`);
  return new Proxy(entry, {
    get(target, field) {
      const value = target[field as string];
      if (typeof value !== "number") {
        throw new Error(`${provider}/${model} has no ${String(field)} in src/usage/models.json`);
      }
      return value;
    },
  }) as unknown as ShippedRates;
}

/** A cost as the spend totals hold it: `ROUND(cost_usd * 1000000)` in the triggers. */
export function microusd(costUsd: number): number {
  return Math.round(costUsd * 1_000_000);
}
