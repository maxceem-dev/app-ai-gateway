# Smoke tests

Tests that run against a **live, deployed** App AI Gateway over the network,
to answer one question: does this deployment work right now?

| | `test/` | `smoke/` |
|---|---|---|
| Runs against | The code, in a simulated Workers runtime | A real gateway at its real URL |
| When | Before a deploy, on every pull request | After a deploy, or on a schedule |
| Catches | Bugs in the code | Anything wrong in the real world: configuration, secrets, database, platform, network |

They use a dedicated **test account** on the gateway and a small **mock
provider** instead of real AI providers, so a run costs nothing and touches no
real data.

## What is checked

Two suites, for the two questions you ask of a live deployment.

**`monitor` — is something down?** A few cheap checks, run on a schedule. Each
covers a part that can fail on its own, without any change of yours:

- `apps-api`: the gateway is healthy, its vault opens, and a server app gets an
  answer from its provider through the proxy.
- `usage`: a proxied call shows up in usage, which is recorded in the background.
- `management`: a management key is accepted and the account's apps read back.
- `console`: the console page, its script and its capabilities load.

**`deploy` — did this deploy break something?** Everything that only changes
when the code does, run once after each deploy together with `monitor`:

- `apps/`, what your apps' end users depend on: every wire format through the
  proxy (OpenAI Chat Completions and Responses, Anthropic Messages, Gemini),
  plain and streamed, with the mock confirming the gateway sent the stored
  provider key in the right header and passed none of the app's credentials on;
  a provider's `429` and `500` reaching the app unchanged; custom endpoints;
  a signed-in user exchanging an identity token for a gateway token and calling
  a provider, and what signed-in apps refuse; and an iOS app's App Attest challenge, with
  anything that is not a real attestation refused as a client error. (Real
  attestations need a device.)
- `management/`, what you manage your apps with: creating, renaming and
  deleting apps and providers without a provider key ever being echoed back;
  the CLI; and an MCP client.

### They are a contract

A check states what a client of the gateway relies on: status codes, error
`code`s, the fields a response carries, the provider's own answer passed
through. Never wording, ordering or anything else a client should not depend
on.

That is what lets an older release's checks run against a newer deployment and
catch a change that breaks existing clients, even when the current checks were
updated along with it. So change an existing assertion only when the contract
changes on purpose, and say so where the change is reviewed; otherwise add a
check rather than editing one.

## Running them against your gateway

You need Node.js 22.19 or later and `pnpm install` at the repository root.

**1. The mock provider has to be reachable from your gateway** over public
HTTPS on port 443: the gateway refuses any other provider URL. Run it
somewhere with a public HTTPS name in front of it:

```sh
SMOKE_MOCK_SECRET=… SMOKE_ISSUER_KEY=… SMOKE_MOCK_PORT=8787 pnpm smoke:mock
```

For a quick try from your own machine, a tunnel such as
`cloudflared tunnel --url http://127.0.0.1:8787` gives it a temporary public
HTTPS address.

**2. Configure.** Settings come from environment variables; secrets are never
passed as arguments. Keep them in a private dotenv file and point
`SMOKE_ENV_FILE` at it:

| Variable | What it is |
|---|---|
| `SMOKE_GATEWAY_URL` | The gateway under test |
| `SMOKE_CONSOLE_URL` | Optional. Its console, when the deployment serves it on a host of its own (default `SMOKE_GATEWAY_URL`) |
| `SMOKE_MANAGEMENT_KEY` | A `manage` management key of a **dedicated** test account |
| `SMOKE_MOCK_URL` | The mock provider's public HTTPS origin |
| `SMOKE_MOCK_SECRET` | The fake provider key the mock accepts |
| `SMOKE_ISSUER_KEY` | The private key the test identity provider signs tokens with |
| `SMOKE_RUNNER` | Optional. Names this runner's app keys, so two runners never revoke each other's (default `local`) |
| `SMOKE_CLI_URL` | Optional. Where the CLI connects, when that differs: the CLI accepts only HTTPS or a loopback address |
| `SMOKE_CLI_VERSIONS` | Optional. CLI versions to check, comma-separated: `current` is this checkout's build, the rest published versions, such as `current,0.10.0` (default `current`) |

Generate the mock secret and the issuer key into your file:

```sh
pnpm --filter @app-ai-gateway/smoke run keygen --write-env /private/path/smoke.env
```

On a gateway that allows email sign-up without verification, `account`
creates the test account and its management key the same way:

```sh
SMOKE_GATEWAY_URL=https://ai.example.com \
  pnpm --filter @app-ai-gateway/smoke run account --email smoke@example.com --write-env /private/path/smoke.env
```

Otherwise create the account in the console and its key on the **Access** page.
Use an account with nothing else in it: the tests create and delete apps there.

**3. Set up the test account, then run.** `setup` creates the mock providers
and the test apps, and is safe to run before every run:

```sh
export SMOKE_ENV_FILE=/private/path/smoke.env
pnpm smoke:setup
pnpm cli:build              # the CLI check runs this checkout's build
pnpm smoke                  # both suites: what a check after a deploy runs
pnpm smoke -- --project monitor
```

`setup` keeps the app ids and app keys it creates in `smoke/.state/`
(gitignored, owner-only), one file per gateway.

## Layout

```
src/
  env.ts          configuration and the state file
  gateway.ts      HTTP helpers; failures name status and error code, never bodies
  fixtures.ts     what the test account holds
  setup.ts        brings the test account in line with fixtures.ts
  issuer.ts       the test identity provider: signing keys and end-user tokens
  mock/           the mock provider: OpenAI, Anthropic and Gemini formats, and the issuer's JWKS
  account.ts      creates a test account by email sign-up
  keygen.ts       generates the mock secret and the issuer key
tests/
  monitor/        is something down: one cheap check per part that can fail
  deploy/apps/    did a deploy break it: end-user paths
  deploy/management/  … and management paths
test/             offline unit tests of the mock itself (`pnpm smoke:test`)
```

A check is an ordinary Vitest test. Name what it proves in plain words: a
monitor shows test names when a check fails.
