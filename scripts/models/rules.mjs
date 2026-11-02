// The decision rules of the model sync, as one pure function: given the
// catalog, what every source said and today's date, which prices and
// retirement dates change and what a person has to look at. No network, no
// filesystem.
//
// A retirement date only ever documents when a provider stops serving a
// model. The entry stays in the catalog and stays priced, so an app that
// still names it keeps billing exactly; nothing here removes a model.
//
// Every item that needs a person has a stable `key`. An owner who has seen one
// and accepts it adds that key to scripts/models/acknowledged.json with a
// reason, and the item stops failing the run.

import { fromLitellm, fromModelsDev } from "./lists.mjs";
import { AUDIO_FIELDS, PRICE_FIELDS, effectivePrice, round6 } from "./price.mjs";
import { SOURCES, sourceId } from "./sources.mjs";
import { notAddedKey } from "./new-models.mjs";

/** How far one run may move a price before a person has to confirm it. */
export const MAX_FACTOR = 3;
/** The per-1M band `test/usage.test.ts` holds every token price to. */
export const MIN_PRICE = 0.001;
export const MAX_PRICE = 1000;

const OFFICIAL = "official";
const PROBLEMS = {
  suspicious: { kind: "suspicious change", prefix: "suspicious change, not applied: " },
  field: { kind: "needs a new field", prefix: "" },
  threshold: { kind: "threshold differs", prefix: "" },
  kind: { kind: "cannot compare", prefix: "" },
  disagree: { kind: "lists disagree", prefix: "" },
  single: { kind: "only one list", prefix: "" },
};
const LISTS = "models.dev + litellm";

const LABELS = {
  input: "input",
  cached_input: "cached",
  cache_write: "cache write",
  cache_write_1h: "1h cache write",
  output: "output",
  image_input: "image input",
  audio_input: "audio input",
  video_input: "video input",
  image_output: "image output",
  long_input: "long input",
  long_cached_input: "long cached",
  long_cache_write: "long cache write",
  long_cache_write_1h: "long 1h cache write",
  long_output: "long output",
};

/**
 * Every price a source states, and only those: "input $3, output $15, no
 * cached price" rather than a figure the source never gave.
 */
function describe(price) {
  if (price.per_minute !== undefined) return `$${price.per_minute}/min`;
  if (price.per_hour !== undefined) return `$${price.per_hour}/h`;
  if (price.per_image !== undefined) return `$${price.per_image}/image`;
  const parts = PRICE_FIELDS.filter((field) => price[field] !== undefined).map(
    (field) => `${LABELS[field]} $${round6(price[field])}`,
  );
  if (price.cached_input === undefined) parts.push("no cached price");
  if (price.long_context_threshold !== undefined) parts.push(`long context above ${price.long_context_threshold / 1000}k`);
  return parts.join(", ");
}

/** The audio rate in the unit the catalog entry uses, or undefined. */
function audioRate(price, unit) {
  if (unit === "per_minute") {
    return price.per_minute ?? (price.per_hour !== undefined ? round6(price.per_hour / 60) : undefined);
  }
  return price.per_hour ?? (price.per_minute !== undefined ? round6(price.per_minute * 60) : undefined);
}

function suspicious(from, to) {
  if (!(to > MIN_PRICE && to < MAX_PRICE)) return `$${to} is outside $${MIN_PRICE}–$${MAX_PRICE}`;
  if (!(from > 0) || to / from > MAX_FACTOR || from / to > MAX_FACTOR) {
    return `$${from} → $${to} moves more than ${MAX_FACTOR}x`;
  }
  return null;
}

/**
 * What it takes to bring `ours` to `source`: the edits to fields `ours`
 * already has, or the one reason no edit is safe. Rule 4: compared on what
 * each would bill, never on which fields it spells out.
 */
export function compare(ours, source) {
  // An image price has no token or time equivalent to convert to or from.
  if (ours.per_image !== undefined) {
    if (source.per_image === undefined) return { problem: "kind", text: "the source has no per-image price" };
    const rate = round6(source.per_image);
    if (round6(ours.per_image) === rate) return { edits: [] };
    const guard = suspicious(ours.per_image, rate);
    if (guard) return { problem: "suspicious", text: `per_image: ${guard}` };
    return { edits: [{ field: "per_image", from: ours.per_image, to: rate }] };
  }
  const unit = AUDIO_FIELDS.find((field) => ours[field] !== undefined);
  if (unit !== undefined) {
    const rate = audioRate(source, unit);
    if (rate === undefined) return { problem: "kind", text: `the source has no ${unit.replace("_", "-")} price` };
    if (round6(ours[unit]) === rate) return { edits: [] };
    const guard = suspicious(ours[unit], rate);
    if (guard) return { problem: "suspicious", text: `${unit}: ${guard}` };
    return { edits: [{ field: unit, from: ours[unit], to: rate }] };
  }

  if (source.input === undefined || source.output === undefined) {
    return { problem: "kind", text: "the source has no per-token price" };
  }
  if (ours.long_context_threshold !== source.long_context_threshold) {
    return {
      problem: "threshold",
      text:
        `long-context threshold differs: ours ${ours.long_context_threshold ?? "none"}, ` +
        `source ${source.long_context_threshold ?? "none"} (source: ${describe(source)})`,
    };
  }
  const target = effectivePrice(source);
  const proposed = { ...ours };
  for (const field of PRICE_FIELDS) {
    if (ours[field] !== undefined && target[field] !== undefined && round6(ours[field]) !== target[field]) {
      proposed[field] = target[field];
    }
  }
  const after = effectivePrice(proposed);
  const missing = PRICE_FIELDS.filter((field) => target[field] !== undefined && after[field] !== target[field]);
  if (missing.length > 0) {
    return {
      problem: "field",
      text: `needs a new field: ${missing.map((field) => `${field} $${target[field]} (ours bills $${after[field]})`).join(", ")}`,
    };
  }
  const edits = PRICE_FIELDS.filter((field) => proposed[field] !== ours[field]).map((field) => ({
    field,
    from: ours[field],
    to: proposed[field],
  }));
  for (const edit of edits) {
    const guard = suspicious(edit.from, edit.to);
    if (guard) return { problem: "suspicious", text: `${edit.field}: ${guard}` };
  }
  return { edits };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * What the lists say about a model's retirement. Models.dev only flags a
 * model deprecated and LiteLLM only gives a date, so a date is trusted when
 * both speak: the flag from one, the date from the other.
 */
function listRetirement(lists, source, model) {
  const models = lists.modelsDev?.[source.modelsDev]?.models;
  const flagged = models !== undefined && Object.hasOwn(models, model) && models[model]?.status === "deprecated";
  const key = source.litellm?.(model);
  const entry = lists.litellm && Object.hasOwn(lists.litellm, key) ? lists.litellm[key] : undefined;
  const date = typeof entry?.deprecation_date === "string" && ISO_DATE.test(entry.deprecation_date)
    ? entry.deprecation_date
    : undefined;
  return { flagged, date };
}

/**
 * Rule 3 for two lists, field by field. A list that leaves a price out has
 * not said the price equals input; it has said nothing. So a field both lists
 * state must agree, and only such a field is ever changed. A field one list
 * states is only reported, and only when it differs from ours. A field
 * neither states is left alone.
 */
export function compareLists(ours, modelsDev, litellm) {
  if ([modelsDev, litellm].some((list) => list.input === undefined || list.output === undefined)) {
    return { problem: "kind", text: "a list has no per-token price" };
  }
  const both = new Set();
  const single = new Map();
  for (const field of [...PRICE_FIELDS, "long_context_threshold"]) {
    const [a, b] = [modelsDev[field], litellm[field]];
    if (a !== undefined && b !== undefined) {
      if (round6(a) !== round6(b)) {
        return { problem: "disagree", text: `lists disagree on ${LABELS[field] ?? field}: Models.dev $${round6(a)}, LiteLLM $${round6(b)}, ours ${ours[field] === undefined ? "none" : `$${ours[field]}`}` };
      }
      both.add(field);
    } else if (a !== undefined || b !== undefined) {
      single.set(field, a !== undefined ? ["Models.dev", a] : ["LiteLLM", b]);
    }
  }

  const threshold = modelsDev.long_context_threshold ?? litellm.long_context_threshold;
  if (threshold !== undefined && threshold !== ours.long_context_threshold) {
    return {
      problem: "threshold",
      text: `long-context threshold differs: ours ${ours.long_context_threshold ?? "none"}, lists ${threshold}`,
    };
  }

  // What ours bills for a field it may not spell out, as computeCost would.
  const billed = effectivePrice(ours);
  const edits = [];
  const unconfirmed = [];
  const missing = [];
  for (const field of PRICE_FIELDS) {
    const listed = both.has(field) ? round6(modelsDev[field]) : single.has(field) ? round6(single.get(field)[1]) : undefined;
    if (listed === undefined || billed[field] === undefined || listed === billed[field]) continue;
    if (!both.has(field)) {
      unconfirmed.push(`${single.get(field)[0]} gives ${LABELS[field]} $${listed}, ours bills $${billed[field]}`);
    } else if (ours[field] === undefined) {
      missing.push(`${field} $${listed} (ours bills $${billed[field]})`);
    } else {
      edits.push({ field, from: ours[field], to: listed });
    }
  }
  if (missing.length > 0) return { problem: "field", text: `needs a new field: ${missing.join(", ")}` };
  if (unconfirmed.length > 0) return { problem: "single", text: `only one list, unconfirmed: ${unconfirmed.join("; ")}` };
  for (const edit of edits) {
    const guard = suspicious(edit.from, edit.to);
    if (guard) return { problem: "suspicious", text: `${edit.field}: ${guard}` };
  }
  return { edits };
}

/**
 * Applies the rules to every model in the catalog.
 *
 * `official[provider]` and `deprecations[provider]` are `{ prices: Map }` or
 * `{ dates: Map }` when that provider's parser succeeded, `{ error }` when it
 * failed, and absent when there is none. `lists` holds the two parsed lists,
 * `null` for one that could not be read. `today` is `YYYY-MM-DD`, UTC.
 */
export function decide({ catalog, official, deprecations = {}, lists, acknowledged = [], today }) {
  const changes = [];
  const retirements = [];
  const retired = [];
  const deprecationNotes = [];
  const attention = [];
  const upcoming = [];
  const noSource = [];
  const newModels = [];
  const skippedModels = [];
  const acknowledgedKeys = new Map(acknowledged.map((item) => [item.key, item.reason]));
  const sources = [];

  const flag = (key, provider, model, text) => attention.push({ key, provider, model, text });

  for (const name of ["modelsDev", "litellm"]) {
    if (lists[name] === null) flag(`${name}: unavailable`, null, null, `${name === "modelsDev" ? "Models.dev" : "LiteLLM"} could not be read`);
  }

  for (const [provider, models] of Object.entries(catalog)) {
    const source = SOURCES[provider];
    if (!source) {
      flag(`${provider}: no source entry`, provider, null, "scripts/models/sources.mjs has no entry for this provider");
      continue;
    }

    // Retirement dates first: a model that has retired, or is about to, is
    // expected to leave its pricing page, and that is not news.
    const deprecation = deprecations[provider];
    if (deprecation?.error) {
      flag(`${provider}: deprecation parser failed`, provider, null, `official deprecation parser failed: ${deprecation.error}`);
    }
    const retiresOn = new Map();
    for (const [model, entry] of Object.entries(models)) {
      const where = `${provider}/${model}`;
      let date;
      let label;
      if (deprecation?.dates) {
        const found = deprecation.dates.get(sourceId(source.deprecations, model));
        if (found?.date) {
          [date, label] = [found.date, OFFICIAL];
        } else if (found?.deprecated) {
          deprecationNotes.push({ provider, model, text: "deprecated on the official page, no retirement date yet" });
        } else if (entry.retirement_date !== undefined) {
          // A date that disappears was postponed or withdrawn; which one is
          // for a person to find out, and ours stays until they do.
          flag(`${where}: retirement date withdrawn`, provider, model, `ours retires on ${entry.retirement_date}, the official deprecation page no longer gives a date`);
        }
      } else {
        const signal = listRetirement(lists, source, model);
        if (signal.flagged && signal.date) {
          [date, label] = [signal.date, LISTS];
        } else if ((signal.flagged || signal.date) && entry.retirement_date === undefined) {
          deprecationNotes.push({
            provider,
            model,
            text: signal.date
              ? `LiteLLM gives a deprecation date of ${signal.date}, Models.dev does not mark it deprecated`
              : "Models.dev marks it deprecated, LiteLLM gives no date",
          });
        }
      }
      if (date !== undefined && date !== entry.retirement_date) {
        retirements.push({ provider, model, from: entry.retirement_date, to: date, source: label });
      }
      const effective = date ?? entry.retirement_date;
      if (effective !== undefined) retiresOn.set(model, effective);
    }

    // Rule 2's last check: a page that parsed but holds under half of our
    // models has most likely changed shape, and fails like any other. Models
    // already retired are not expected on it.
    let page = official[provider];
    if (page?.prices) {
      const live = Object.keys(models).filter((model) => !(retiresOn.get(model) <= today));
      const found = live.filter((model) => page.prices.get(sourceId(source.official, model))).length;
      if (found * 2 < live.length) {
        page = { error: `only ${found} of ${live.length} catalog models found on the page` };
      }
    }
    const listed = source.modelsDev !== undefined || source.litellm !== undefined ? "lists" : "none";
    const retirementSource = deprecation?.dates ? "official" : deprecation?.error ? `official failed → ${listed}` : listed;
    if (page?.error) {
      flag(`${provider}: parser failed`, provider, null, `official parser failed: ${page.error}`);
      sources.push({ provider, text: `prices: official failed → ${listed}; retirements: ${retirementSource}` });
    } else if (page?.prices) {
      sources.push({ provider, text: `prices: official OK; retirements: ${retirementSource}` });
      const ours = new Set(Object.keys(models).map((model) => sourceId(source.official, model)));
      const fresh = [...page.prices.keys()].filter((id) => {
        if (ours.has(id)) return false;
        const reason = acknowledgedKeys.get(notAddedKey(provider, id));
        if (reason !== undefined) {
          skippedModels.push({ provider, model: id, reason });
          return false;
        }
        return true;
      });
      if (fresh.length > 0) newModels.push({ provider, ids: fresh });
    } else {
      sources.push({ provider, text: listed === "none" ? "no source" : `prices: lists only; retirements: ${retirementSource}` });
    }

    for (const [model, entry] of Object.entries(models)) {
      const where = `${provider}/${model}`;
      let price;
      let label;

      if (page?.prices) {
        // Rule 1: the official page outranks the lists, including when it no
        // longer lists the model at all.
        price = page.prices.get(sourceId(source.official, model));
        if (!price) {
          const date = retiresOn.get(model);
          if (date !== undefined) {
            retired.push({ provider, model, date, text: `not on the pricing page; ${date <= today ? "retired" : "retires"} on ${date}` });
          } else {
            flag(`${where}: not on official page`, provider, model, "not on official page (renamed or retired?)");
          }
          continue;
        }
        if (price.unpriced) {
          flag(`${where}: no public price`, provider, model, `official page lists no price: ${price.unpriced}`);
          continue;
        }
        label = OFFICIAL;
      } else {
        // Rule 3: only two lists that agree stand in for an official price.
        const modelsDev = fromModelsDev(lists.modelsDev, source.modelsDev, model);
        const litellm = source.litellm ? fromLitellm(lists.litellm, source.litellm(model)) : undefined;
        if (!modelsDev && !litellm) {
          noSource.push({ provider, model });
          continue;
        }
        if (!modelsDev || !litellm) {
          const [name, only] = modelsDev ? ["Models.dev", modelsDev] : ["LiteLLM", litellm];
          const result = compare(entry, only);
          // A single list that bills what we bill confirms nothing, but it
          // does not contradict anything either.
          if (result.edits?.length === 0) continue;
          flag(`${where}: only one list`, provider, model, `only one list, unconfirmed: ${name} ${describe(only)}, ours ${describe(entry)}`);
          continue;
        }
        const audio = AUDIO_FIELDS.find((field) => entry[field] !== undefined);
        if (audio) {
          if (audioRate(modelsDev, audio) === undefined || audioRate(modelsDev, audio) !== audioRate(litellm, audio)) {
            flag(`${where}: lists disagree`, provider, model, `lists disagree: Models.dev ${describe(modelsDev)}, LiteLLM ${describe(litellm)}, ours ${describe(entry)}`);
            continue;
          }
          price = modelsDev;
          label = LISTS;
        } else {
          const result = compareLists(entry, modelsDev, litellm);
          if (result.problem) {
            const { kind, prefix } = PROBLEMS[result.problem];
            flag(`${where}: ${kind}`, provider, model, `${prefix}${result.text} (${LISTS})`);
            continue;
          }
          for (const edit of result.edits) changes.push({ provider, model, ...edit, source: LISTS });
          continue;
        }
      }

      const result = compare(entry, price);
      if (result.problem) {
        const { kind, prefix } = PROBLEMS[result.problem];
        flag(`${where}: ${kind}`, provider, model, `${prefix}${result.text} (${label})`);
        continue;
      }
      for (const edit of result.edits) changes.push({ provider, model, ...edit, source: label });
      for (const next of price.upcoming ?? []) upcoming.push({ provider, model, ...next });
    }
  }

  const open = attention.filter((item) => !acknowledgedKeys.has(item.key));
  const seen = attention
    .filter((item) => acknowledgedKeys.has(item.key))
    .map((item) => ({ ...item, reason: acknowledgedKeys.get(item.key) }));

  return {
    changes,
    retirements,
    retired,
    deprecationNotes,
    attention: open,
    acknowledged: seen,
    upcoming,
    noSource,
    newModels,
    skippedModels,
    sources,
  };
}

/** Rule "needs a human": anything left in `attention` after acknowledgements. */
export function needsHuman(decision) {
  return decision.attention.length > 0;
}

/** Only current price changes trigger an update; retirement dates travel with them. */
export function catalogEdits(decision) {
  if (decision.changes.length === 0) return [];
  return [
    ...decision.changes.map(({ provider, model, field, to }) => ({ provider, model, field, to })),
    ...decision.retirements.map(({ provider, model, to }) => ({ provider, model, field: "retirement_date", to })),
  ];
}
