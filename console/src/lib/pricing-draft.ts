/**
 * Custom model prices while they are still being typed, and the one reading of
 * a finished set of rows.
 *
 * Pricing is ordinary non-secret data, so nothing here is about credentials:
 * it is the arithmetic of a repeatable form, kept away from the dialog that
 * renders it so it can be read and tested on its own.
 */

import type { ProviderPricing } from "@/lib/types";

type StoredPrice = ProviderPricing[string];

/** The rates the form shows a field for; every other one rides along in `rest`. */
type ShownRate = "input" | "output" | "cached_input" | "cache_write";

/** A repeatable pricing row while it is still being typed. */
export interface PricingDraft {
  model: string;
  input: string;
  output: string;
  /** Optional: blank means it bills at the input price. */
  cachedInput?: string;
  /** Optional: blank means it bills at the input price. */
  cacheWrite?: string;
  /**
   * Whatever else the stored price carries — a one-hour cache-write rate or
   * long-context rates set through the API — which the form has no field for
   * and must send back untouched, or saving the dialog would erase it.
   */
  rest?: Omit<StoredPrice, ShownRate>;
}

/** The stored prices as rows, which is how the form holds them. */
export function toDrafts(pricing: ProviderPricing | null): PricingDraft[] {
  return Object.entries(pricing ?? {}).map(([model, entry]) => {
    const { input, output, cached_input: cachedInput, cache_write: cacheWrite, ...rest } = entry;
    return {
      model,
      input: String(input),
      output: String(output),
      cachedInput: cachedInput === undefined ? "" : String(cachedInput),
      cacheWrite: cacheWrite === undefined ? "" : String(cacheWrite),
      ...(Object.keys(rest).length > 0 && { rest }),
    };
  });
}

/** A typed price, or `null` where it is not a number of zero or more. */
function rate(text: string): number | null {
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Returns the object to send, or a message naming the first unusable row.
 *
 * A row left entirely blank is dropped, so an operator can leave a spare one
 * lying around. Anything else must be complete: `Number("")` is 0, and a price
 * of $0 has to be a deliberate answer rather than an empty field, because
 * entering a price is what allows a model to be proxied at all. The cache
 * prices are the exception: left blank, they are simply not sent, and bill at
 * the input price.
 */
export function draftsToPricing(
  drafts: PricingDraft[],
): { pricing: ProviderPricing } | { error: string } {
  const pricing: ProviderPricing = {};
  for (const draft of drafts) {
    const model = draft.model.trim();
    const input = draft.input.trim();
    const output = draft.output.trim();
    const cachedInput = draft.cachedInput?.trim() ?? "";
    const cacheWrite = draft.cacheWrite?.trim() ?? "";
    if (!model && !input && !output && !cachedInput && !cacheWrite && !draft.rest) continue;
    if (!model) return { error: "Every pricing row needs a model name" };
    if (!input || !output) {
      return { error: `Enter both prices for ${model} — use 0 only if it is genuinely free` };
    }
    const inputPrice = rate(input);
    const outputPrice = rate(output);
    const cachedPrice = cachedInput ? rate(cachedInput) : undefined;
    const cacheWritePrice = cacheWrite ? rate(cacheWrite) : undefined;
    if (inputPrice === null || outputPrice === null || cachedPrice === null || cacheWritePrice === null) {
      return { error: `Prices for ${model} must be numbers of 0 or more` };
    }
    // Two rows for one model would otherwise let the last one win in silence.
    if (Object.hasOwn(pricing, model)) {
      return { error: `${model} is priced twice — remove the duplicate row` };
    }
    pricing[model] = {
      ...draft.rest,
      input: inputPrice,
      output: outputPrice,
      ...(cachedPrice !== undefined && { cached_input: cachedPrice }),
      ...(cacheWritePrice !== undefined && { cache_write: cacheWritePrice }),
    };
  }
  return { pricing };
}
