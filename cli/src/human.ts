import { AppConfigSchema } from "../../src/contracts/schemas.ts";
import type { CommandName } from "./parser.ts";
import type { GatewayCapability, ProviderCapability } from "./resources.ts";
import type { RenderedResult } from "./results.ts";
import { plain, type Style } from "./style.ts";

/** What every line of human output is written against: which gateway, whose account. */
export interface OutputContext {
  url: string;
  accountId?: string;
  deploymentId?: string;
}

/** A value a key/value line can carry; `undefined` and `null` drop the line. */
type Cell = string | number | boolean | undefined | null;

/**
 * Key/value lines with the values in one column.
 *
 * The width is measured rather than fixed so that a renderer never has to know
 * what the longest label in its own block is, and a label added later cannot
 * silently break the alignment of the ones above it. The label is padded before
 * it is coloured: an escape sequence has width on nobody's terminal but every
 * string length.
 */
function kv(entries: readonly (readonly [string, Cell])[], style: Style): string[] {
  const rows: [string, string][] = [];
  for (const [key, value] of entries)
    if (value !== undefined && value !== null) rows.push([key, String(value)]);
  const width = Math.max(0, ...rows.map(([key]) => key.length + 1));
  return rows.map(
    ([key, value]) => style.dim(`${key}:`.padEnd(width + 1)) + style.state(value),
  );
}

/**
 * A padded-column table. No dependency: the columns are known strings and the
 * only thing a table library would add here is the box drawing nobody pipes.
 * Like `kv`, every width is measured on the plain text and the colour goes on
 * afterwards.
 */
function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  style: Style,
): string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[], tone: (cell: string) => string): string =>
    cells
      .map(
        (cell, column) =>
          tone(cell) +
          (column === widths.length - 1
            ? ""
            : " ".repeat((widths[column] ?? 0) + 2 - cell.length)),
      )
      .join("")
      .trimEnd();
  return [
    line(headers, (cell) => style.dim(cell)),
    ...rows.map((row) => line(row, (cell) => style.state(cell))),
  ];
}

const yesNo = (value: boolean): string => (value ? "yes" : "no");

/**
 * The human rendering of one command's result.
 *
 * Dispatched on the command and then narrowed on the result union: the results
 * are one union, so a shape a branch cannot render is a type error here instead
 * of `undefined` on somebody's terminal. A branch that meets a shape it does not
 * recognize at runtime falls back to the indented document rather than printing
 * a half-rendered line.
 *
 * `style` decides whether any of this is coloured, and defaults to plain: a
 * caller that has not been given a terminal never gets escape sequences.
 */
export function humanResult(
  command: CommandName,
  result: RenderedResult,
  context: OutputContext,
  style: Style = plain,
): string {
  // The snippet is source code somebody pipes into a file: off a terminal it is
  // the whole of this command's output, byte for byte, with no frame, no colour
  // and no trailing report. On a terminal nothing is being piped, so it is
  // framed like every other code block.
  if (command === "app snippet" && "snippet" in result && typeof result.snippet === "string") {
    if (!style.enabled) return result.snippet;
    const language = "language" in result ? result.language : "code";
    return style.code(result.snippet, language).join("\n") + "\n";
  }
  const lines = render(command, result, context, style);
  if ("unclaimedAccess" in result && result.unclaimedAccess)
    lines.push(`Free access ends: ${result.unclaimedAccess.endsAt}`);
  if ("account" in result && result.account?.expiresAt)
    lines.push(`Recovery deadline: ${result.account.expiresAt}`);
  return lines.join("\n") + "\n";
}

function render(
  command: CommandName,
  result: RenderedResult,
  context: OutputContext,
  style: Style,
): string[] {
  // A browser step answers whichever command opened it, so it is recognized
  // before that command's own renderer ever sees the result.
  if ("state" in result && result.state === "pending" && "url" in result && result.url)
    return [
      style.headline(`Waiting for browser approval (${result.id}).`),
      result.url,
      // A login's page shows the same code; checking it is what tells a person
      // the request they are approving is this one.
      ...("userCode" in result && result.userCode
        ? [`Pairing code: ${result.userCode} (check that the browser shows the same code)`]
        : []),
      `Resume: agw operation wait ${result.id}`,
    ];
  if (
    (command === "operation wait" || command === "operation status") &&
    "kind" in result && result.kind === "login" && result.state === "completed"
  )
    return [style.headline(`Signed in to ${context.url}.`), ...operation(result, style)];
  switch (command) {
    case "account status":
    case "account login":
    case "account claim":
    case "deployment connect":
    case "deployment status":
      return status(command, result, context, style);
    case "provider types":
    case "provider-gateway types":
    case "provider list":
    case "provider-gateway list":
    case "app list":
    case "app key list":
      return list(command, result, style);
    case "provider show":
    case "provider-gateway show":
    case "app show":
      return show(command, result, style);
    case "provider update":
    case "provider-gateway update":
    case "provider rotate-key":
    case "provider-gateway rotate-key":
    case "provider add":
    case "provider-gateway add":
    case "provider remove":
    case "provider-gateway remove":
    case "app remove":
    case "app key add":
    case "app key revoke":
    case "account logout":
      return mutation(command, result, context, style);
    case "usage show":
    case "usage breakdown":
      return usage(command, result, style);
    case "operation status":
    case "operation wait":
      return operation(result, style);
    case "app add":
    case "app update":
    case "app validate":
    case "app check":
    case "app snippet":
      return app(command, result, context, style);
    case "deployment setup":
    case "deployment update":
    case "deployment domain":
      return deployment(result, style);
    case "support send":
      return support(result, style);
  }
}

/** `support send`: the reference to quote, and where the reply goes. */
function support(result: RenderedResult, style: Style): string[] {
  if (!("reference" in result)) return [];
  return [
    style.headline(
      result.duplicate
        ? `Already sent as ${result.reference} in the last ten minutes; nothing new was sent.`
        : `Sent to human support as ${result.reference}.`,
    ),
    ...kv([["Replies go to", result.replyTo]], style),
  ];
}

/** `account status`, `deployment status`, and the two commands that connect. */
function status(
  command: CommandName,
  result: RenderedResult,
  context: OutputContext,
  style: Style,
): string[] {
  // A command that changed the selected connection confirms that first, the way
  // a mutation does; a plain status report has nothing to confirm.
  const did =
    command === "account login"
      ? [style.headline(`Signed in to ${context.url}.`)]
      : command === "deployment connect"
        ? [style.headline(`Connected to ${context.url}.`)]
        : [];
  if ("billing" in result)
    return [
      ...did,
      ...kv(
        [
          ["Gateway", context.url],
          ["Account", `${result.account.name} (${result.account.id})`],
          ["Claimed", yesNo(result.account.claimed)],
          ["Deployment", result.deployment.mode === "cloud" ? "cloud" : "self-hosted"],
          ["Console", result.deployment.consoleOrigin],
        ],
        style,
      ),
    ];
  if ("protocolVersion" in result)
    return [
      ...did,
      ...kv(
        [
          ["Gateway", result.url],
          ["Connected", yesNo(result.connected)],
          ["Authenticated", yesNo(result.authenticated)],
          ["Version", result.serverVersion],
          ["Deployment", result.deployment.mode === "cloud" ? "cloud" : "self-hosted"],
          ["Console", result.consoleOrigin],
          ["Provider types", result.providers.length],
          ["Provider gateway types", result.providerGateways.length],
        ],
        style,
      ),
    ];
  if ("state" in result) return [...did, ...operation(result, style)];
  return [...did, style.json(result)];
}

/**
 * One table per list command, each narrowed on the key that identifies its own
 * answer. Dispatched on the command first so that a key several results share
 * is read as the one this command can actually have returned.
 */
function list(command: CommandName, result: RenderedResult, style: Style): string[] {
  if (command === "provider types" || command === "provider-gateway types") {
    if (!Array.isArray(result)) return [style.json(result)];
    // The two capability lists differ by one column, and a gateway type has no
    // origin of its own: its adapter holds it.
    const types: readonly (ProviderCapability | GatewayCapability)[] = result;
    if (!types.length) return ["No types."];
    return table(
      ["TYPE", "NAME", "BASE URL"],
      types.map((entry) => [entry.type, entry.name, "baseUrl" in entry ? entry.baseUrl : ""]),
      style,
    );
  }
  if (command === "provider list") {
    // Three results in the union carry `providers`: this list, an `app check`
    // report (`appId`) and a deployment's capabilities (`protocolVersion`).
    // Naming the other two out is what leaves `ProviderSummary[]` here rather
    // than a union of three different arrays.
    if (!("providers" in result) || "appId" in result || "protocolVersion" in result)
      return [style.json(result)];
    if (!result.providers.length) return ["No providers."];
    return table(
      ["ID", "SLUG", "TYPE", "NAME", "STATUS", "CREATED"],
      result.providers.map((provider) => [
        provider.id,
        provider.slug,
        provider.type,
        provider.name,
        provider.status,
        provider.createdAt,
      ]),
      style,
    );
  }
  if (command === "provider-gateway list" && "gateways" in result) {
    if (!result.gateways.length) return ["No provider gateways."];
    return table(
      ["ID", "TYPE", "NAME", "STATUS", "PROVIDERS", "CREATED"],
      result.gateways.map((gateway) => [
        gateway.id,
        gateway.type,
        gateway.name,
        gateway.status,
        String(gateway.providerCount),
        gateway.createdAt,
      ]),
      style,
    );
  }
  // `apps` is also the account-wide usage report's per-app list, which is the
  // one other result carrying that key.
  if (command === "app list" && "apps" in result && !("totals" in result)) {
    if (!result.apps.length) return ["No apps."];
    return table(
      ["ID", "NAME", "AUTH", "STATUS", "PROVIDERS", "CREATED"],
      result.apps.map((entry) => [
        entry.id,
        entry.name,
        entry.authentication_type,
        entry.status,
        String(entry.providers.length),
        entry.created_at,
      ]),
      style,
    );
  }
  // Matched on `app_id` as well as `keys`, because every array in the union
  // answers to `keys` too: it is a method on `Array.prototype`.
  if (command === "app key list" && "keys" in result && "app_id" in result) {
    if (!result.keys.length) return [`No keys for ${result.app_id}.`];
    return table(
      ["ID", "NAME", "PREFIX", "STATUS", "CREATED", "LAST USED"],
      result.keys.map((key) => [
        key.id,
        key.name,
        key.key_prefix,
        key.status,
        key.created_at,
        key.last_used_at ?? "never",
      ]),
      style,
    );
  }
  return [style.json(result)];
}

/**
 * The full stored configuration, under a line naming what it is.
 *
 * The document stays indented JSON on purpose: `app show --json` output is what
 * the guides tell people to save and edit, and the plain run is how they read
 * the same thing before deciding to.
 */
function show(command: CommandName, result: RenderedResult, style: Style): string[] {
  if (command === "app show" && "app" in result && !("guidance" in result)) {
    return [
      style.headline(`${result.app.name} (${result.app.id})`),
      ...warnings(result.app.warnings ?? [], style),
      "",
      style.json(result),
    ];
  }
  if ("slug" in result)
    return [
      style.headline(`${result.name} (${result.id}), type ${result.type}, slug ${result.slug}`),
      "",
      style.json(result),
    ];
  if ("referencedCount" in result)
    return [
      style.headline(`${result.name} (${result.id}), type ${result.type}`),
      "",
      style.json(result),
    ];
  return [style.json(result)];
}

/** One line naming what happened, plus where a key was written. */
function mutation(
  command: CommandName,
  result: RenderedResult,
  context: OutputContext,
  style: Style,
): string[] {
  if ("loggedOut" in result)
    return [
      style.headline(`Signed out of ${context.url}.`) +
        (result.revoked
          ? " The key was revoked and removed from this machine."
          : " The stored credential was removed."),
    ];
  if ("deleted" in result) {
    if ("provider_id" in result)
      return [style.headline(`Removed provider ${result.provider_id}.`)];
    if ("provider_gateway_id" in result)
      return [style.headline(`Removed provider gateway ${result.provider_gateway_id}.`)];
    return [
      style.headline(`Removed app ${result.app_id}.`) +
        ` ${result.removed_users} users removed; usage events retained.`,
    ];
  }
  if ("key" in result)
    return [
      style.headline(
        `Revoked key ${result.key.name} (${result.key.id}) for app ${result.app_id}.`,
      ),
    ];
  if ("applicationKey" in result && "appId" in result)
    return [
      style.headline(
        `Created key ${result.applicationKey.name} (${result.applicationKey.id}) for app ${result.appId}.`,
      ),
      ...kv([["Key saved", result.applicationKey.storagePath]], style),
    ];
  if ("provider" in result) {
    const added = command === "provider add";
    return [
      style.headline(
        `${added ? "Stored" : "Updated"} provider ${result.provider.name} (${result.provider.id}).`,
      ),
      ...kv(
        [
          ["Gateway", context.url],
          ["Status", result.provider.status],
          ["Key hint", result.provider.secretHint],
        ],
        style,
      ),
      ...(added
        ? ["Credential stored; no upstream probe or inference was performed."]
        : []),
    ];
  }
  if ("gateway" in result) {
    const added = command === "provider-gateway add";
    return [
      style.headline(
        `${added ? "Stored" : "Updated"} provider gateway ${result.gateway.name} (${result.gateway.id}).`,
      ),
      ...kv(
        [
          ["Gateway", context.url],
          ["Status", result.gateway.status],
          ["Token hint", result.gateway.secretHint],
        ],
        style,
      ),
      ...(added
        ? ["Credential stored; no upstream probe or inference was performed."]
        : []),
    ];
  }
  return [style.json(result)];
}

function usage(command: CommandName, result: RenderedResult, style: Style): string[] {
  if (command === "usage breakdown" && "rows" in result) {
    const head = kv(
      [
        ["App", result.app_id],
        ["Grouped by", result.by],
        ["Period", `${result.from} to ${result.to}`],
      ],
      style,
    );
    const rows = result.rows.length
      ? table(
          ["KEY", "REQUESTS", "INPUT", "OUTPUT", "COST USD", "ERRORS"],
          result.rows.map((row) => [
            row.key ?? "(none)",
            String(row.requests),
            String(row.input_tokens),
            String(row.output_tokens),
            row.cost_usd.toFixed(4),
            String(row.errors),
          ]),
          style,
        )
      : ["No usage in this period."];
    return [...head, "", ...rows, "", result.coverage.source];
  }
  if ("totals" in result)
    return [
      ...kv(
        [
          ["Month", result.month],
          ["Requests", result.totals.requests],
          ["Input tokens", result.totals.input_tokens],
          ["Output tokens", result.totals.output_tokens],
          ["Cost USD", result.totals.cost_usd.toFixed(4)],
          ["Errors", result.totals.errors],
        ],
        style,
      ),
      "",
      // The totals are the sum of these rows, so the apps they came from are
      // printed rather than counted: a month is read to find which app spent it.
      ...(result.apps.length
        ? table(
            ["APP", "REQUESTS", "INPUT", "OUTPUT", "COST USD", "ERRORS"],
            result.apps.map((entry) => [
              entry.deleted ? `${entry.appId} (deleted)` : entry.appId,
              String(entry.requests),
              String(entry.input_tokens),
              String(entry.output_tokens),
              entry.cost_usd.toFixed(4),
              String(entry.errors),
            ]),
            style,
          )
        : ["No app usage recorded."]),
    ];
  if ("requests" in result)
    return kv(
      [
        ["App", result.app_id],
        ["Month", result.month],
        ["Requests", result.requests],
        ["Input tokens", result.input_tokens],
        ["Cached input tokens", result.cached_input_tokens],
        ["Cache write tokens", result.cache_write_tokens],
        ["Output tokens", result.output_tokens],
        ["Cost USD", result.cost_usd.toFixed(4)],
      ],
      style,
    );
  return [style.json(result)];
}

/** An operation that is no longer pending: `operation status`, `operation wait`. */
function operation(result: RenderedResult, style: Style): string[] {
  if (!("state" in result)) return [style.json(result)];
  const stored = "result" in result ? result.result : undefined;
  return kv(
    [
      ["Operation", result.id],
      ["State", result.state],
      ["Expires", result.expiresAt],
      ["Account", stored?.accountId],
      ["Provider", stored?.provider && `${stored.provider.name} (${stored.provider.id})`],
      ["Provider gateway", stored?.gateway && `${stored.gateway.name} (${stored.gateway.id})`],
    ],
    style,
  );
}

/** Why an account would refuse an app's requests, as `app check` says it. */
const ACCOUNT_REFUSALS = {
  email_unverified: "refuses requests until its owner verifies their email (email_unverified)",
  unclaimed_access_expired: "refuses requests until a person claims it (unclaimed_access_expired)",
  account_expired: "refuses requests: its recovery deadline has passed (account_expired)",
} as const;

function app(
  command: CommandName,
  result: RenderedResult,
  context: OutputContext,
  style: Style,
): string[] {
  if ("output" in result) return [style.headline(`Saved: ${result.output}`)];
  if ("ready" in result)
    return [
      style.headline(
        `${result.appId} is ${result.ready ? "ready to serve requests" : "not ready to serve requests"}.`,
      ),
      ...kv(
        [
          ["Status", result.status],
          ["Providers", result.providers.length],
          ["Active providers", result.providers.filter((p) => p.status === "active").length],
          // Absent from a gateway older than the field, which reports none.
          ...(result.accountRefusal
            ? [["Account", ACCOUNT_REFUSALS[result.accountRefusal]] as [string, string]]
            : []),
        ],
        style,
      ),
      ...notes(result.limitations),
      ...warnings(result.warnings ?? [], style),
    ];
  if ("definition" in result) {
    const dryRun = "dryRun" in result;
    return [
      style.headline(
        `${dryRun ? "Dry run: " : ""}${result.definition.name} is valid${
          result.validation.remote ? " here and on the gateway" : " locally"
        }.`,
      ),
      ...kv(
        [
          ["Gateway", context.url],
          ["Status", result.definition.status],
          ["Authentication", result.definition.config.authentication.type],
          // Only an edit of an application that exists has an id to show; a
          // new one is judged as a draft and has none yet.
          ["App ID", result.validation.remote && "app_id" in result.validation ? result.validation.app_id : undefined],
        ],
        style,
      ),
      ...notes(result.validation.remote ? [] : result.validation.skipped),
      ...(dryRun ? ["", "Nothing was written."] : []),
    ];
  }
  if ("guidance" in result && "app" in result)
    return written(command, result, context, style);
  return [style.json(result)];
}

/**
 * An application's warnings: behaviour that stops on a stated date. Said
 * apart from the verdict, because none of them is a failure yet, and each
 * with its date and where to read about it.
 */
function warnings(
  values: readonly { message: string; until?: string; docs_url?: string }[],
  style: Style,
): string[] {
  if (!values.length) return [];
  return [
    "",
    style.warn("Warnings"),
    ...values.map((warning) =>
      `- ${warning.message}${warning.docs_url ? ` See ${warning.docs_url}` : ""}`),
  ];
}

/** The issue list a verdict is followed by, one per line, or nothing at all. */
const notes = (values: readonly string[]): string[] =>
  values.length ? ["", ...values.map((value) => `- ${value}`)] : [];

/**
 * What `app add` and `app update` report about the application they wrote.
 *
 * In the order somebody reads it in: what happened, what the application now
 * is, what to do next, and then the request it can already send.
 */
function written(
  command: CommandName,
  result: Extract<RenderedResult, { guidance: string }>,
  context: OutputContext,
  style: Style,
): string[] {
  const parsed = AppConfigSchema.safeParse(result.app.config);
  const details: [string, Cell][] = [];
  let language = "shell";
  if (parsed.success) {
    const config = parsed.data;
    if (config.authentication.type === "apple_app_attest") {
      language = "swift";
      const endUser = config.authentication.end_user;
      details.push(
        [
          "App Attest",
          (config.authentication.app_attest.environments ?? ["production"]).join(" + "),
        ],
        [
          "User identity",
          endUser.source === "app_install"
            ? "per installation; sign-in not required"
            : "verified issuer; integrate your sign-in SDK",
        ],
        [
          "Paid subscription check",
          endUser.source === "issuer" && endUser.issuer.required_claims.length
            ? "configured claim requirements"
            : "off",
        ],
      );
    } else details.push(["Authentication", "server application API key"]);
    const limits = config.limits?.per_user;
    details.push([
      "Per-user limits",
      `${limits?.requests.per_minute ?? "unlimited"} requests/minute, ${limits?.requests.per_day ?? "unlimited"}/day`,
    ]);
  }
  if (result.applicationKey)
    details.push(["Key saved", result.applicationKey.storagePath]);
  return [
    style.headline(
      `${command === "app add" ? "Created" : "Updated"} app ${result.app.name} (${result.app.id}).`,
    ),
    ...kv([["Gateway", context.url], ...details], style),
    ...(result.guidance ? ["", result.guidance] : []),
    ...("snippet" in result && result.snippet
      ? ["", ...style.code(result.snippet, language)]
      : []),
  ];
}

/** The three deployment plans, each printed as the fields it actually carries. */
function deployment(result: RenderedResult, style: Style): string[] {
  if ("hostname" in result)
    return kv(
      [
        [result.dryRun ? "Would attach domain" : "Domain", result.hostname],
        ["Worker", result.worker],
        ["Cloudflare account", result.accountId],
        ["Zone", result.zoneId],
        ["Previous URL", result.previousUrl],
        ["URL", result.url],
        ["Note", result.note],
      ],
      style,
    );
  if ("fromVersion" in result)
    return kv(
      [
        [result.dryRun ? "Would update worker" : "Worker", result.worker],
        ["Cloudflare account", result.accountId],
        ["Database", result.databaseId],
        ["From version", result.fromVersion],
        ["To version", result.toVersion],
        ["Updated", result.updated ? "yes" : undefined],
      ],
      style,
    );
  // Every setup answer carries one of these two: a dry run reports the plan it
  // would install, and the other two report an installation that is complete.
  if ("installed" in result || "resources" in result)
    return kv(
      [
        [result.dryRun ? "Would install worker" : "Worker", result.name],
        ["Cloudflare account", result.accountId],
        ["URL", result.url],
        ["Version", result.version],
        ["Domain", result.domain],
        ["Pending domain", result.pendingDomain],
        ["Deployment", result.deploymentId],
        ["Resources", result.resources?.join(", ")],
        ["Backup", result.backup],
        ["Installed", result.installed ? "yes" : undefined],
        ["Note", result.note],
      ],
      style,
    );
  return [style.json(result)];
}
