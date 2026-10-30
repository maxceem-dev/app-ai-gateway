import { stderr, stdin } from "node:process";
import type { SupportMessageResponse } from "../../src/contracts/responses.ts";
import { SUPPORT_TOPICS, SupportMessageKindSchema, type SupportMessageKind } from "../../src/contracts/schemas.ts";
import { fail, VERSION } from "./common.ts";
import type { Context } from "./context.ts";
import { confirm, prompt } from "./input.ts";
import { flagList, type Flags } from "./parser.ts";

export type SupportResult = SupportMessageResponse;

/** The longest message the gateway accepts, read from stdin no further than this. */
const MAX_MESSAGE = 10_000;

/**
 * `agw support send`: a message to the deployment's human support, from the
 * person the connection belongs to. Support replies to their email address.
 *
 * Written for an agent acting on a person's request as much as for the person:
 * nothing is sent without `--yes` or a typed confirmation, so an agent has to
 * have shown the person the message and been told to send it. The gateway
 * refuses a message that looks like it carries a credential, and answers a
 * repeat within ten minutes with the first reference instead of a second
 * email.
 */
export async function supportCommand(ctx: Context, flags: Flags): Promise<SupportResult> {
  const kind = supportKind(flags.type ?? (await prompt("Type (bug, support or feedback)", flags)));
  if (flags.message !== undefined && flags["message-stdin"])
    fail("conflicting_flags", "--message and --message-stdin conflict.");
  const message = (
    flags["message-stdin"]
      ? await readMessage()
      : (flags.message ?? (await prompt("Message", flags)))
  ).trim();
  if (!message) fail("invalid_input", "Supply a nonempty message.");
  if (message.length > MAX_MESSAGE)
    fail("invalid_input", `The message is longer than ${MAX_MESSAGE} characters.`);
  const context = supportContext(flagList(flags.context));

  if (!flags.yes) {
    // Without a terminal there is nobody to ask here: whoever runs the command
    // has to have asked the person already, and says so with --yes.
    if (flags["no-input"] || !stdin.isTTY || !stderr.isTTY)
      fail(
        "confirmation_required",
        "Sending to human support needs confirmation.",
        "Show the person the exact message, and once they agree run the same command with --yes.",
      );
    stderr.write(preview(kind, message, context));
    await confirm("Send this to human support?", flags);
  }

  return (
    await ctx.call("sendSupportMessage", {
      body: {
        kind,
        message,
        ...(Object.keys(context).length ? { context } : {}),
        client: `agw ${VERSION}`,
      },
    })
  ).data;
}

function supportKind(value: string): SupportMessageKind {
  const parsed = SupportMessageKindSchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) fail("invalid_input", "--type must be bug, support or feedback.");
  return parsed.data;
}

/** `--context name=value`, repeatable, into the object the gateway takes. */
export function supportContext(entries: string[]): Record<string, string> {
  const context: Record<string, string> = {};
  for (const entry of entries) {
    const at = entry.indexOf("=");
    if (at < 1 || at === entry.length - 1)
      fail("invalid_input", "--context takes name=value, such as --context app_id=my-app.");
    context[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
  }
  return context;
}

async function readMessage(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > MAX_MESSAGE * 4) fail("invalid_input", `The message is longer than ${MAX_MESSAGE} characters.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

/** What is about to be sent, exactly, written to stderr before the question. */
function preview(kind: SupportMessageKind, message: string, context: Record<string, string>): string {
  const lines = [
    `To: human support (${SUPPORT_TOPICS[kind]})`,
    ...Object.entries(context).map(([name, value]) => `${name}: ${value}`),
    "",
    message,
    "",
  ];
  return lines.join("\n") + "\n";
}
