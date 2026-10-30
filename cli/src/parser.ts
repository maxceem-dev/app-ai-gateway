import { fail, MANAGEMENT_KEY_ENV, VERSION } from "./common.ts";

const secret = "key-prompt! key-stdin! browser! no-open!";
const browser = "no-open!";
/** A management key pasted in, or — the default — a login approved in a browser. */
const managementKey = "key-prompt! key-stdin! no-open!";
const common = "json! no-input!";

export interface CommandSpec {
  /** How many positional resource arguments the command requires. */
  args: number;
  /** Space-separated flag names; `!` marks a boolean, `*` a repeatable value. */
  flags: string;
}

export const commands = {
  "deployment setup": {
    args: 0,
    flags:
      "name cloudflare-account-id domain no-domain! version release-archive dry-run! yes!",
  },
  "deployment connect": {
    args: 0,
    flags: `url cloud! ${managementKey}`,
  },
  "deployment status": { args: 0, flags: "" },
  "deployment update": {
    args: 0,
    flags: "version release-archive dry-run! yes!",
  },
  "deployment domain": {
    args: 0,
    flags: "hostname release-archive dry-run! yes!",
  },
  "account status": { args: 0, flags: "" },
  "account claim": { args: 0, flags: browser },
  "account login": { args: 0, flags: managementKey },
  "account logout": { args: 0, flags: "" },
  "provider types": { args: 0, flags: "" },
  "provider list": { args: 0, flags: "" },
  "provider show": { args: 1, flags: "" },
  "provider add": {
    args: 0,
    flags: `type name slug provider-gateway base-url pricing route ${secret}`,
  },
  "provider update": {
    args: 1,
    flags: `name status base-url clear-base-url! pricing clear-pricing! route clear-route! ${secret}`,
  },
  "provider rotate-key": { args: 1, flags: secret },
  "provider remove": { args: 1, flags: "yes!" },
  "provider-gateway types": { args: 0, flags: "" },
  "provider-gateway list": { args: 0, flags: "" },
  "provider-gateway show": { args: 1, flags: "" },
  "provider-gateway add": {
    args: 0,
    flags: `type name cloudflare-account-id gateway-id ${secret}`,
  },
  "provider-gateway update": { args: 1, flags: "name" },
  "provider-gateway rotate-key": { args: 1, flags: secret },
  "provider-gateway remove": { args: 1, flags: "yes!" },
  "app add": {
    args: 0,
    flags:
      "type name team-id bundle-id attest-environments verify-on provider* status file key-output dry-run!",
  },
  "app list": { args: 0, flags: "" },
  "app show": { args: 1, flags: "" },
  "app update": {
    args: 1,
    flags:
      "name team-id bundle-id attest-environments verify-on provider* all-providers! status file dry-run!",
  },
  "app validate": { args: 0, flags: "file" },
  "app check": { args: 1, flags: "" },
  "app snippet": { args: 1, flags: "language provider endpoint output" },
  "app remove": { args: 1, flags: "yes!" },
  "app key list": { args: 1, flags: "" },
  "app key add": { args: 1, flags: "name key-output" },
  "app key revoke": { args: 2, flags: "yes!" },
  "usage show": { args: 0, flags: "app month" },
  "usage breakdown": { args: 0, flags: "app by from to limit" },
  "operation status": { args: 1, flags: "" },
  "operation wait": { args: 1, flags: "timeout" },
  "support send": { args: 0, flags: "type message message-stdin! context* yes!" },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof commands;

/**
 * Every flag the table above can produce, by the type its declaration gives it.
 *
 * Written out rather than left as an index signature so that a command reading
 * `flags["team-id"]` gets a `string | undefined` and a misspelt flag name is a
 * type error. `provider` carries both types because it is repeatable on the
 * application commands and single-valued on `app snippet`.
 */
export interface Flags {
  json?: true;
  "no-input"?: true;
  help?: true;
  yes?: true;
  browser?: true;
  "no-open"?: true;
  "key-prompt"?: true;
  "key-stdin"?: true;
  "dry-run"?: true;
  cloud?: true;
  "no-domain"?: true;
  "clear-base-url"?: true;
  "clear-pricing"?: true;
  "clear-route"?: true;
  "all-providers"?: true;
  "message-stdin"?: true;
  message?: string;
  context?: string | string[];
  name?: string;
  type?: string;
  slug?: string;
  status?: string;
  url?: string;
  version?: string;
  "release-archive"?: string;
  hostname?: string;
  domain?: string;
  "cloudflare-account-id"?: string;
  "gateway-id"?: string;
  "provider-gateway"?: string;
  "base-url"?: string;
  pricing?: string;
  route?: string;
  "team-id"?: string;
  "bundle-id"?: string;
  "attest-environments"?: string;
  "verify-on"?: string;
  file?: string;
  "key-output"?: string;
  output?: string;
  language?: string;
  endpoint?: string;
  app?: string;
  month?: string;
  by?: string;
  from?: string;
  to?: string;
  limit?: string;
  timeout?: string;
  provider?: string | string[];
}

export type ParseResult =
  | { help: true; scope: string; version?: never; command?: never; flags?: never; args?: never }
  | { version: true; help?: never; command?: never; flags?: never; args?: never }
  | { command: CommandName; flags: Flags; args: string[]; help?: never; version?: never };

/** A repeatable flag's values, whichever way this command declared it. */
export function flagList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

type FlagType = "boolean" | "multiple" | "string";

export function parse(argv: string[]): ParseResult {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-")) break;
    words.push(token);
  }
  const command = (Object.keys(commands) as CommandName[])
    .sort((a, b) => b.length - a.length)
    .find((c) => words.slice(0, c.split(" ").length).join(" ") === c);
  const help = argv.includes("--help") || argv.includes("-h");
  if (!command) {
    if (argv.length === 1 && argv[0] === "--version") return { version: true };
    if (help || !argv.length) return { help: true, scope: words.join(" ") };
    fail("unknown_command", "Unknown command.");
  }
  const spec: CommandSpec = commands[command];
  const types: Record<string, FlagType> = Object.fromEntries(
    `${common} help! ${spec.flags}`
      .trim()
      .split(/\s+/)
      .map((f): [string, FlagType] => [
        f.replace(/[!*]$/, ""),
        f.endsWith("!") ? "boolean" : f.endsWith("*") ? "multiple" : "string",
      ]),
  );
  // Built loose and named once: the parser discovers flags by string, and the
  // declared `Flags` shape is what every command reads them through.
  const collected: Record<string, string | string[] | true> = {};
  const args: string[] = [];
  for (let i = command.split(" ").length; i < argv.length; i++) {
    let token = argv[i]!;
    if (token === "-h") token = "--help";
    if (token === "-y") token = "--yes";
    if (!token.startsWith("-")) {
      args.push(token);
      continue;
    }
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(token);
    if (!match || !types[match[1]!])
      fail(
        "unknown_flag",
        `Unknown flag ${token.split("=")[0]} for ${command}.`,
        // Resources are addressed positionally throughout, so the one mistake
        // worth answering with more than the help text is naming one as a flag.
        spec.args && ["id", "app", "app-id"].includes(match?.[1] ?? "")
          ? `Pass the identifier as an argument: agw ${command}${" <id>".repeat(spec.args)}.`
          : undefined,
      );
    const name = match[1]!;
    const inline = match[2];
    const type = types[name]!;
    if (Object.hasOwn(collected, name) && type !== "multiple")
      fail("duplicate_flag", `--${name} may only be supplied once.`);
    if (type === "boolean") {
      if (inline !== undefined)
        fail("invalid_input", `--${name} does not take a value.`);
      collected[name] = true;
    } else {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith("--"))
        fail("missing_value", `--${name} requires a value.`);
      if (type === "multiple") {
        const existing = collected[name];
        const list = Array.isArray(existing) ? existing : [];
        list.push(value);
        collected[name] = list;
      } else collected[name] = value;
    }
  }
  const flags = collected as Flags;
  if (flags.help) return { help: true, scope: command };
  if (args.length !== spec.args)
    fail(
      "invalid_arguments",
      `${command} requires ${spec.args} resource argument(s).`,
    );
  for (const group of [
    ["key-prompt", "key-stdin", "browser"],
    ["url", "cloud"],
    ["domain", "no-domain"],
    ["base-url", "clear-base-url"],
    ["pricing", "clear-pricing"],
    ["route", "clear-route"],
    ["provider", "all-providers"],
    ["message", "message-stdin"],
    ...(command === "app snippet" ? [["provider", "endpoint"]] : []),
  ]) {
    if (group.filter((k) => collected[k] !== undefined).length > 1)
      fail(
        "conflicting_flags",
        group.map((k) => `--${k}`).join(" and ") + " conflict.",
      );
  }
  if (flags["key-prompt"] && flags["no-input"])
    fail("conflicting_flags", "--key-prompt cannot be used with --no-input.");
  if (
    flags["no-open"] &&
    !flags.browser &&
    command !== "account claim" &&
    command !== "account login" &&
    command !== "deployment connect"
  )
    fail("invalid_input", "--no-open requires --browser.");
  if (flags["no-open"] && (flags["key-prompt"] || flags["key-stdin"]))
    fail(
      "conflicting_flags",
      "--no-open only applies to browser authentication.",
    );
  return { command, flags, args };
}

export function helpText(scope = ""): string {
  const matches = Object.entries(commands).filter(
    ([c]) => !scope || c === scope || c.startsWith(scope + " "),
  );
  if (!matches.length) fail("unknown_command", "Unknown help topic.");
  return `agw ${VERSION} — App AI Gateway\n\n${matches
    .map(
      ([c, s]) =>
        `agw ${c}${" <id>".repeat(s.args)}\n  ${s.flags
          .split(" ")
          .filter(Boolean)
          .map(
            (f) =>
              "--" +
              f.replace(/[!*]$/, "") +
              (f.endsWith("!") ? "" : " <value>") +
              (f.endsWith("*") ? " (repeatable)" : ""),
          )
          .join(" ")}`,
    )
    .join(
      "\n\n",
    )}\n\n--json: structured stdout; --no-input: never prompt; --help, -h: this help.\nLogin: account login and deployment connect open the browser; check that it shows the pairing code the terminal prints. --no-open prints the URL instead; --key-stdin or --key-prompt takes a management key.\nCredentials: ${MANAGEMENT_KEY_ENV}, when set, is the management key for every command and overrides the saved login. account logout revokes the saved key.\nSecrets: hidden prompt by default; --key-stdin reads one line. Provider --browser submits credentials directly to your gateway.\nBrowser operations: --json or --no-input returns pending; operation wait resumes.\nSupport: support send emails human support for the signed-in person, who gets the reply by email. Without a terminal it needs --yes: show the person the message first. Never put a key or token in it.\nNo account is created by help, status, list, validation or dry runs.\n`;
}
