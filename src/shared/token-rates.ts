/**
 * The names of every per-token rate a model price may carry, in one place.
 *
 * The shipped catalog, a provider's own custom prices and the cost arithmetic
 * in `src/usage/pricing.ts` all read rates by these names, so a rate added here
 * is at once priceable, overridable and validated: the override schema in
 * `src/contracts/schemas.ts` is built from this list rather than restating it.
 */

/** Rates in USD per 1M tokens. Time- and image-priced rates are not here. */
export const TOKEN_RATE_FIELDS = [
  "input",
  "output",
  "cached_input",
  "cache_write",
  "cache_write_1h",
  "image_input",
  "audio_input",
  "video_input",
  "image_output",
  "long_input",
  "long_output",
  "long_cached_input",
  "long_cache_write",
  "long_cache_write_1h",
] as const;

export type TokenRateField = (typeof TOKEN_RATE_FIELDS)[number];

/** The `long_*` rates, which only apply above `long_context_threshold`. */
export const LONG_RATE_FIELDS = TOKEN_RATE_FIELDS.filter(
  (field): field is Extract<TokenRateField, `long_${string}`> => field.startsWith("long_"),
);

/**
 * A provider's own price for one model. Only input and output are required:
 * every other rate falls back exactly as a catalog entry's does.
 */
export type TokenPrice = { input: number; output: number }
  & Partial<Record<Exclude<TokenRateField, "input" | "output">, number>>
  & { long_context_threshold?: number };

/**
 * Named parts of a canonical token bucket that a provider bills at a rate of
 * their own. The four canonical buckets — uncached input, cached input, cache
 * writes and output — are the only token counts stored as columns; a variant
 * is never extra tokens, only a share of its bucket. Its rate is
 * `<bucket>_<variant>` (and `long_<bucket>_<variant>` above the long-context
 * threshold), which must be one of {@link TOKEN_RATE_FIELDS}.
 *
 * Input and output are not listed: their split is by modality, which has its
 * own record because a modality count also covers the cached part of a prompt.
 *
 * Today the only variant is Anthropic's one-hour cache write, billed at 2x
 * input against 1.25x for the default five minutes.
 */
export const TOKEN_VARIANTS = {
  cache_write: ["1h"],
} as const satisfies Partial<Record<"cached_input" | "cache_write", readonly string[]>>;

export type VariantBucket = keyof typeof TOKEN_VARIANTS;

/**
 * How many of a bucket's tokens were each variant, as a response reported
 * them. Absent means the response did not split the bucket, and every token of
 * it bills at the bucket's own rate.
 */
export type TokenVariants = {
  [B in VariantBucket]?: Partial<Record<(typeof TOKEN_VARIANTS)[B][number], number>>;
};

/** The rate field a variant bills at, held to {@link TOKEN_RATE_FIELDS} by the compiler. */
export type VariantRateField<B extends VariantBucket = VariantBucket> =
  `${B}_${(typeof TOKEN_VARIANTS)[B][number]}`;

// Compile-time proof that every variant's rates, short and long, are rate fields.
type AssertRateFields<T extends TokenRateField> = T;
export type _VariantRatesAreRateFields = AssertRateFields<VariantRateField | `long_${VariantRateField}`>;
