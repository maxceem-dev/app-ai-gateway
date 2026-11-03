import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/common.ts";
import { humanResult } from "../src/human.ts";
import { parse } from "../src/parser.ts";
import { supportCommand, supportContext } from "../src/support.ts";
import { hasCode, stubContext } from "./helpers.ts";

const SENT = { status: "sent" as const, reference: "SUP-7F3K2Q", replyTo: "ada@example.test", duplicate: false };

/** A context whose gateway accepts the message, recording what each call sent. */
function supportContextStub() {
  const calls: { name: string; options?: Record<string, unknown> }[] = [];
  const ctx = stubContext({
    call: async (name: string, options?: Record<string, unknown>) => {
      calls.push({ name, ...(options ? { options } : {}) });
      return { data: SENT };
    },
  });
  return { ctx, calls };
}

test("support send parses its flags, and --message and --message-stdin conflict", () => {
  const parsed = parse(["support", "send", "--type", "bug", "--message", "It broke", "--context", "app_id=demo", "--context", "request_id=req_1", "--yes"]);
  assert.equal(parsed.command, "support send");
  assert.deepEqual(parsed.flags?.context, ["app_id=demo", "request_id=req_1"]);
  assert.throws(
    () => parse(["support", "send", "--type", "bug", "--message", "x", "--message-stdin"]),
    hasCode("conflicting_flags"),
  );
});

test("support send refuses to send without --yes when nobody can be asked", async () => {
  const { ctx, calls } = supportContextStub();
  await assert.rejects(
    supportCommand(ctx, { type: "bug", message: "It broke", "no-input": true }),
    hasCode("confirmation_required"),
  );
  assert.equal(calls.length, 0);
});

test("support send sends the message, its context and the CLI's version once confirmed", async () => {
  const { ctx, calls } = supportContextStub();
  const result = await supportCommand(ctx, {
    type: "Bug",
    message: "  Streams stop halfway.  ",
    context: ["app_id=demo", "request_id = req_1"],
    yes: true,
  });
  assert.deepEqual(result, SENT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "sendSupportMessage");
  assert.deepEqual(calls[0]?.options, {
    body: {
      kind: "bug",
      message: "Streams stop halfway.",
      context: { app_id: "demo", request_id: "req_1" },
      client: `agw ${VERSION}`,
    },
  });
});

test("support send refuses an unknown type, an empty message and malformed context", async () => {
  const { ctx, calls } = supportContextStub();
  await assert.rejects(supportCommand(ctx, { type: "urgent", message: "x", yes: true }), hasCode("invalid_input"));
  await assert.rejects(supportCommand(ctx, { type: "bug", message: "   ", yes: true }), hasCode("invalid_input"));
  assert.throws(() => supportContext(["app_id"]), hasCode("invalid_input"));
  assert.throws(() => supportContext(["=demo"]), hasCode("invalid_input"));
  assert.equal(calls.length, 0);
});

test("support send prints the reference and where the reply goes, and says when nothing new was sent", () => {
  const context = { url: "https://gw.test" };
  const sent = humanResult("support send", SENT, context);
  assert.match(sent, /Sent to human support as SUP-7F3K2Q\./u);
  assert.match(sent, /Replies go to: ada@example\.test/u);
  const again = humanResult("support send", { ...SENT, duplicate: true }, context);
  assert.match(again, /Already sent as SUP-7F3K2Q in the last ten minutes; nothing new was sent\./u);
});
