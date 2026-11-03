/**
 * What the MCP server tells an agent about itself: the short `instructions`
 * every client receives with the server's identity, and the long form served
 * as the `agw://guide` resource.
 *
 * Written here, not imported from `docs/`: the Worker never bundles the
 * documentation site, and an agent connected to a self-hosted deployment may
 * have no route to the published docs at all.
 */

export const MCP_INSTRUCTIONS = [
  "This server manages an App AI Gateway account: the AI provider credentials it holds, the apps that call providers through it, their end users, and their usage.",
  "Read before you write: call get_account first, and list or get a resource before proposing a change to it.",
  "Secrets never pass through a tool: provider keys are entered by a person in a browser, and an app key is only ever revealed on a browser page.",
  "add_app and add_app_key take two calls: the first reserves and creates nothing, and the second, with the same arguments and the answer's handle, creates it once. Every answer that names an operation calls it id, which is what get_operation takes.",
  "A change that needs a secret answers a URL for a person to open; poll get_operation until it completes.",
  "An unclaimed account expires unless a person claims it; get_account says so, and claim_account starts the claim.",
  "Read agw://guide for the full rules.",
].join(" ");

export const MCP_GUIDE_URI = "agw://guide";

export const MCP_GUIDE = `# Working with App AI Gateway over MCP

App AI Gateway sits between a person's applications and AI providers such as
OpenAI, Anthropic and Gemini. The person stores a provider credential once,
and every app they create reaches providers through the gateway with its own
authentication, its own routing and its own limits on its users. This server
lets you read and manage all of that on the person's behalf.

## Who you are acting as

You connected with a credential that belongs to one account, and every tool
acts in that account only. What you may do is the credential's owner's role in
the account and the credential's grant together: a \`read\` credential lists,
inspects and validates, and nothing more. Call \`get_account\` first. It names
the account and the deployment, and says whether the account has a person as
its owner.

On a hosted deployment, an account nobody has claimed yet is temporary: its
free access ends thirty days after it was created, and the account is deleted
when its recovery deadline passes, unless a person claims it. When
\`get_account\` reports an unclaimed account, tell the person, and use \`claim_account\` to start the
claim: it returns a URL the person opens in their own browser. Never open that
URL yourself or act as the person approving it.

## Reading

- \`get_account\`, \`get_capabilities\` — the account, and what the deployment supports.
- \`list_models\` — the priced models an app may allow.
- \`list_providers\`, \`get_provider\`, \`list_provider_gateways\` — the provider
  credentials and provider gateways the account holds, as metadata.
- \`list_apps\`, \`get_app\` — the apps, and one app's whole stored document.
  Its \`warnings\` describe behaviour that will stop on the stated date: tell
  the person, and help them act before then.
- \`validate_app\` — whether an app document would be accepted, without saving it.
- \`check_app\` — whether an app can serve requests, without sending one.
- \`get_app_snippet\` — the first request an app can send.
- \`list_app_keys\` — a server app's keys, as metadata.
- \`list_app_users\`, \`get_app_user\` — an app's end users.
- \`list_app_events\`, \`list_auth_events\`, \`get_auth_event_summary\`,
  \`list_rejection_events\` — what an app's traffic did, and why requests or
  sign-ins were refused.
- \`get_usage\`, \`get_usage_breakdown\`, \`get_usage_timeseries\` — usage and
  cost, for the account or one app.

Every app tool takes the app's id as \`app\`; \`list_apps\` returns them. Lists
of events are newest first and page backwards: pass the \`next_before_id\` of
one answer as \`before_id\` to the next call. Months are \`YYYY-MM\` and days
\`YYYY-MM-DD\`, in UTC.

## Changing things

Read before you write. List providers and apps first so you use slugs and ids
that exist, read an app with \`get_app\` before proposing a change to it, and
check the change with \`validate_app\` before making it. An app document is
\`{name, config, status?}\`, as \`get_app\` returns it without its id,
revision, timestamps and warnings; the gateway assigns an app's id, which never changes, and an update carries the \`revision\` it was read at, so a document
someone changed since is refused rather than overwritten.
An update replaces the whole document: preserve every configuration field and
the current status unless the person asked to change them. Omitting status
enables the app.
An iOS app's \`authentication.app_attest.verify_on\` is \`every_request\` (the
default) or \`token_exchange\`; switch an app to \`every_request\` only after the
person confirms every build in use is on the AppAIGateway Swift package 1.4 or
later, because older builds are refused from then on.

Changes come in three shapes.

**Creates take two calls.** \`add_app\` and \`add_app_key\` first reserve: called
without \`handle\`, they check the arguments, create nothing, and answer a
\`handle\` and the reserved operation's \`id\`. Call the same tool again with
the same arguments and that \`handle\`, within 15 minutes, to create it; the
\`id\` is what \`get_operation\` takes, never a handle. If the creating call's
answer is lost, call again with the same handle: it answers the same result
with \`replayed: true\` and creates nothing more. A handle sent with different
arguments is refused with \`operation_mismatch\`; one that lapsed with
\`operation_expired\`; reserve again in either case. When a reservation answers a \`notice\`, an identical
request was made in the last hour: inspect it with \`get_operation\` before you
create a second.

**Changes that need a secret complete in a browser.** \`add_provider\`,
\`add_provider_gateway\`, \`rotate_provider_key\` and
\`rotate_provider_gateway_key\` take everything but the key or token, and answer
a URL. Give it to the person: they open it, enter the secret there and
approve. Poll \`get_operation\` with the answer's \`id\` until it is
\`completed\`, or \`expired\` (with \`denied\` when they declined). Never open the
URL yourself.

**Changes without a browser step**: \`update_provider\`,
\`update_provider_gateway\` and \`update_app\` carry the revision you read, so a
change someone made since is refused rather than overwritten;
\`remove_provider\`, \`remove_provider_gateway\` and \`remove_app\` delete for
good and need the id again as \`confirm\`; \`revoke_app_key\`,
\`block_app_user\` and \`unblock_app_user\` need no browser handoff. App and
provider changes, including key revocation, take up to a minute to reach live
traffic. User blocks stop new token exchanges immediately and existing gateway
tokens within ten seconds; header-based users must be blocked in the backend.
Prefer reversible changes: disable an app or a provider rather than deleting
it unless the person asked for the deletion.

\`get_operation\` reads any operation a change tool opened, by its id. It never
returns a secret.

## Human support

Where the deployment offers human support, \`contact_support\` emails its
support team on the person's behalf: \`kind\` is \`bug\`, \`support\` or
\`feedback\`. It is there so the person can ask you to write in for them;
it is not a way to ask for help yourself.

- Only when the person asked you to contact support. Show them the exact
  message first and send it only once they agree.
- Write it as they would: what happened, what they expected, what was tried.
  Put ids and error codes in \`context\` (\`app_id\`, \`request_id\`,
  \`error_code\`) so support can act without asking back.
- Never include a key, token or password. A message or context value that
  looks like one is refused with \`invalid_request\`, and nothing is sent.
- Support replies to the person's own email address, never to you. Tell them
  the answer's \`reference\` (such as \`SUP-7F3K2Q\`), which they can quote.
- The same message sent again within ten minutes sends nothing new: the answer
  has \`duplicate: true\` and the first reference. Do not resend it to make sure.
- \`support_plan_required\` means the account cannot use human support; tell
  the person what the message says rather than retrying.

## Secrets

No secret ever passes through a tool, in either direction. A provider
credential is typed by the person into a browser page, never given to you and
never accepted as a tool argument. A key \`add_app\` or \`add_app_key\` creates
is never in a tool result: the answer carries \`reveal_url\`, a page the person
opens signed in to the console as an owner or admin, where they see the key
once and copy it. Never ask the person to paste a secret into the
conversation, and never print one you come across.

How the server holds to that:

- **Credential names.** A field is named like a credential when its name,
  lower-cased and with \`_\` and \`-\` removed, is one of \`secret\`, \`token\`, \`apikey\`, \`password\`, \`passwd\`, \`passphrase\`, \`credential\`, \`credentials\`, \`authorization\`, \`accesstoken\`, \`refreshtoken\`, \`idtoken\`, \`authtoken\`, \`sessiontoken\`, \`bearertoken\`, \`clientsecret\`, \`apisecret\`, \`secretkey\` and \`privatekey\`. The whole name
  is compared: \`api_key\`, \`apiKey\` and \`Token\` match; \`secretHint\`,
  \`tokenHint\` and \`max_tokens\` do not.
- **Refused arguments.** Every tool that answers a URL for a browser step
  (\`add_provider\`, \`add_provider_gateway\`, \`rotate_provider_key\`,
  \`rotate_provider_gateway_key\`), and \`add_app\`, \`update_app\` and
  \`validate_app\` for the app document they take, refuse a call carrying a
  field with such a name anywhere in its arguments: at any depth, inside a
  list, beside the documented arguments or inside them. The refusal names the
  field, never its value, and nothing is stored.
- **URLs in a browser step.** Before a browser step is stored, every string in
  its arguments is trimmed; one longer than any field of a browser step accepts
  is refused at once, and the rest are read with the platform's URL parser, as
  a browser would read them. A \`baseUrl\` must pass the same rules the provider
  write applies: \`https://\` on a public domain name, no credentials, no query
  string or fragment, no port. Any other string the parser reads as a URL is
  refused when it carries credentials (\`https://user:pass@…\`, however it is
  written) or when its query or fragment names a credential: both are first
  percent-decoded, repeatedly, so an encoded delimiter delimits, then split on
  every \`?\`, \`&\`, \`#\` and \`;\`. A piece with an \`=\` is a parameter: its name is
  stripped of leading \`?\`, \`#\` and \`/\` and compared with the names above. A piece without one is a route or a flag and is not judged. So
  \`?api_key=…\`, \`#access_token=…\` and \`#/callback?token=…\` are refused, while
  \`https://example.com/?version=2\`, \`https://example.com/#/settings/password\`
  and a name like \`OpenAI: production\` are accepted.
- **Results.** In every tool result, a field with a credential name is shown
  as \`[redacted]\` — the whole field, whatever it holds: a string, a number, a
  list or an object — whatever stored it, since an app document written
  through the API may carry provider-native parameters of any name. The one
  exception is the metadata of the key a tool created, in the \`api_key\` of an
  \`add_app\` or \`add_app_key\` result and in \`result.api_key\` of a
  \`get_operation\` result (\`id\`, \`name\`, \`key_prefix\`, \`created_at\`), shown
  when it holds nothing else. An \`api_key\` anywhere else, inside an app
  document included, is redacted. A field holding \`null\` stays \`null\`, and
  hint fields such as \`secretHint\` are shown as they are. Do not send a
  \`[redacted]\` value back in an update or omit the field from a full
  replacement. Have the person make the change through the console or another
  authorized client that can preserve the original values.

## Errors

A refusal is a tool result marked as an error, not a protocol failure. Its
text is \`<code>: <message>. <what to do next>\`, and its structured content is
\`{error, message, status, next}\`. The code is the gateway's own and stable:
\`app_not_found\` means the id is not one of the account's apps, \`invalid_request\`
means the arguments break a rule the message names, and \`grant_insufficient\`
means the credential may read but not change. \`next\` names the tool to call or
the browser step to take. An \`internal_error\` is the gateway's failure, not
yours; try again later.

## Rules

1. Never send a request through an app to test it unless the person asks:
   every one reaches a provider and may cost them money. \`check_app\` and
   \`get_app_snippet\` send no inference. They do not test upstream keys,
   physical device attestation, user sign-in or subscription entitlements.
2. Changes take up to a minute to reach live traffic.
3. Report what you did with ids and names, never with a credential.
`;
