import { Writable } from "node:stream";
import { appCommand } from "./apps.ts";
import { CLOUD, CliError, origin, VERSION } from "./common.ts";
import { Context, type ContextIo } from "./context.ts";
import { deploymentCommand } from "./deployment.ts";
import { CliErrorDetailsSchema } from "./errors.ts";
import { humanResult, type OutputContext } from "./human.ts";
import { helpText, parse, type ParseResult } from "./parser.ts";
import { required, resourceCommand } from "./resources.ts";
import type { CommandResult, RenderedResult } from "./results.ts";
import { StateStore } from "./state.ts";
import { supportCommand } from "./support.ts";
import { styleFor } from "./style.ts";
import { Transport } from "./transport.ts";
import { positive, usageCommand } from "./usage.ts";

/** Anything stdout can be pointed at, including the test suite's own sinks. */
export interface OutputSink {
  write(text: string, callback?: (error?: Error | null) => void): unknown;
}

export interface MainOptions {
  store?: Pick<
    StateStore,
    "read" | "write" | "reserve" | "directory" | "keyOutput" | "vaultKey"
  >;
  transport?: Pick<Transport, "request">;
  stdout?: OutputSink;
  stderr?: OutputSink;
  /** The browser, the loopback listener and the environment; `stderr` is the option above. */
  io?: Partial<Omit<ContextIo, "stderr">>;
}

type ParsedCommand = Extract<ParseResult, { command: string }>;

export async function execute(parsed: ParsedCommand, ctx: Context): Promise<CommandResult> {
  const { command, flags, args } = parsed;
  if (command.startsWith("provider"))
    return resourceCommand(ctx, command, args, flags);
  if (command.startsWith("app ")) return appCommand(ctx, command, args, flags);
  if (command.startsWith("usage ")) return usageCommand(ctx, command, flags);
  if (command === "support send") return supportCommand(ctx, flags);
  if (command.startsWith("operation "))
    return command === "operation wait"
      ? ctx.wait(args[0] ?? "", positive(flags.timeout ?? 300))
      : ctx.poll(args[0] ?? "");
  if (command === "account status") return (await ctx.call("getCliAccount")).data;
  if (command === "account login")
    return flags["key-stdin"] || flags["key-prompt"] ? ctx.keyLogin() : ctx.browserLogin();
  if (command === "account claim") return ctx.operation("claim", {});
  if (command === "account logout") return ctx.logout();
  if (command === "deployment connect") {
    const url = flags.cloud
      ? CLOUD
      : origin(
          flags.url ?? (await required(flags, "url", "Deployment HTTPS URL")),
        );
    if (flags["key-stdin"] || flags["key-prompt"]) return ctx.keyLogin(url);
    if (ctx.environmentKey) return ctx.connectWithEnvironment(url);
    return ctx.browserLogin(url);
  }
  if (command === "deployment status") {
    const { data } = await ctx.publicCall("getCliCapabilities");
    return {
      url: ctx.url,
      authenticated: Boolean(ctx.managementKey),
      ...data,
      connected: true,
    };
  }
  return deploymentCommand(ctx, command, flags);
}

export async function main(
  argv: string[] = process.argv.slice(2),
  {
    store = new StateStore(),
    transport = new Transport(),
    stdout = process.stdout,
    stderr = process.stderr,
    io = {},
  }: MainOptions = {},
): Promise<number> {
  const json = argv.includes("--json");
  try {
    const parsed = parse(argv);
    if (parsed.help) {
      stdout.write(helpText(parsed.scope));
      return 0;
    }
    if (parsed.version) {
      stdout.write(VERSION + "\n");
      return 0;
    }
    const run = async (): Promise<number> => {
      const state = await store.read((line) => stderr.write(line + "\n"));
      const ctx = new Context(store, state, transport, parsed.flags, { ...io, stderr });
      const result = await execute(parsed, ctx);
      const context: OutputContext = {
        url: ctx.url,
        ...(ctx.active?.account?.id === undefined ? {} : { accountId: ctx.active.account.id }),
        ...(ctx.active?.deployment?.id === undefined
          ? {}
          : { deploymentId: ctx.active.deployment.id }),
      };
      const rendered: RenderedResult = ctx.onboarding
        ? { ...result, ...ctx.onboarding }
        : result;
      const output = { schemaVersion: 1, ok: true, context, result: rendered };
      const text = json
        ? JSON.stringify(output) + "\n"
        : humanResult(parsed.command, rendered, context, styleFor(stdout));
      if (stdout instanceof Writable) {
        await new Promise<void>((resolve, reject) =>
          stdout.write(text, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      } else {
        // Lightweight injected sinks are synchronous; real streams acknowledge flush.
        stdout.write(text);
      }
      await ctx.acknowledgeOutput();
      return 0;
    };
    // No command-wide lock: each state write takes the lock for itself, so a
    // command that waits on a browser handoff for minutes does not hold one.
    return await run();
  } catch (error) {
    const e =
      error instanceof CliError
        ? error
        : new CliError(
            "internal_error",
            "The command could not complete.",
            "Inspect account/resource status before retrying a mutation.",
            4,
          );
    // Parsed on the way out for the same reason every response is: only the
    // fields this envelope declares may reach stdout. Fail-closed — details
    // that do not parse are dropped rather than printed, and never turn a
    // reportable failure into a crash inside the reporter.
    const details = e.details ? CliErrorDetailsSchema.safeParse(e.details) : undefined;
    const reported = {
      code: e.code,
      message: e.message,
      nextAction: e.nextAction,
      ...(details?.success ? { details: details.data } : {}),
    };
    if (json) {
      stdout.write(
        JSON.stringify({ schemaVersion: 1, ok: false, error: reported }) + "\n",
      );
      return e.exitCode;
    }
    // Text failures go to stderr, where a shell already expects them: stdout
    // stays clean for the command's own output, so `agw app snippet ... > f`
    // writes a snippet or an empty file, never half a report of a failure.
    // `--json` keeps its one document on stdout, which is what agents read.
    const style = styleFor(stderr);
    const lines = [
      style.alert(`Error: ${e.message}`),
      style.warn(`Next: ${e.nextAction}`),
      style.dim(`Code: ${e.code}`),
    ];
    // Every declared detail field is a string, a number or a boolean, so each
    // one is a line of its own rather than a nested document.
    for (const [key, value] of Object.entries(reported.details ?? {}))
      lines.push(`  ${style.dim(`${key}:`)} ${String(value)}`);
    stderr.write(lines.join("\n") + "\n");
    return e.exitCode;
  }
}
