# App AI Gateway

This is a minimal AI gateway (proxy) for applications. Its main purpose is to quickly and securely give applications access to AI providers, with one monthly request allowance per organization, and provide observability of AI usage inside all the applications from one place.

The primary target is iOS applications, with secure measures for calling AI APIs directly from an iOS app: App Attest, user auth verification, and paid entitlement verification. Support for server applications via API keys is complementary — it makes it possible to observe multiple applications from one place. Android applications are not supported yet, but are planned for the future.

## Main principles

- The main consumers of this gateway are individuals or teams who develop many small to medium load applications and want a fast, easy way to give their apps access to AI providers. Ease of use therefore takes priority over scalability.
- The main aim is to keep this project simple and easy to use without compromising security and performance. Security, performance, and ease of use are the top 3 priorities.
- The project is distributed as an open-source, self-hosted project. It should be very easy to deploy for anyone who wants to self-host it.
- The project is also deployed as a hosted cloud version, so anyone who doesn't want to self-host can start using it right away. The cloud deployment process doesn't have to be as easy as the self-hosted one, but it must prioritize reliability and security for cloud customers.

## Code

- Every API operation is declared once in `src/contracts/catalog.ts`; the
  OpenAPI document, clients and server mounts derive from it. Never edit
  `openapi/openapi.json` manually; run `pnpm run openapi:generate` instead.
- Keep provider proxy bodies permissive: they preserve provider-native formats.
- Reach `@maxceem/cf-auth` only through `cfAuth()` in `src/auth/identity.ts` and
  never import `better-auth` directly: a static import puts them on every
  proxied request's cold start. Type-only imports are fine.
- There are two unrelated quota systems that must never read each other: the plan allowance (`billing_*`, `src/do/OrgQuota.ts`) for what a gateway customer pays for, and application limits (`app_*`, `src/do/UserLimiter.ts`) that a customer sets on their own app's end users.

## Documentation changes

- Handwritten guides live in `docs/content/docs/`. Everything generated from
  them — `docs/content/docs/api/` and the machine files under `docs/public/` —
  is gitignored; never edit it. Keep `automation/agent-manual.mdx` free of MDX
  components: it is served verbatim as `/agents.md`.
- Never write "organization", "tenant" or "operator" in a guide, and do not
  document billing or plans there. Say "you", "your account" or "all your
  apps" instead.
- Keep docs out of the gateway Worker and keep their deployment static-only: no
  route handlers, SSR, OpenNext, `run_worker_first` or Worker `main` entry
  without explicit approval.
- A custom docs domain belongs in a gitignored
  `docs/wrangler.<profile>.overlay.jsonc`, never in the tracked config.

## Security

- Never print or commit provider keys, `BETTER_AUTH_SECRET`, vault keys
  (`SECRET_VAULT_LOCAL_KEK_*`, `SECRET_VAULT_KMS_TOKEN`), management keys,
  gateway application keys, or development credentials.
- Provider keys are per-organization rows in D1, encrypted through
  `src/vault/`. They are write-only: no response body may ever contain a
  submitted secret, only its `secretHint`.
- Use Wrangler secret commands, stdin, hidden prompts, or ignored local files for
  secret values. Do not place secret values in command arguments.
- Everything the optional `MANAGEMENT_ANALYTICS` dataset is written is declared
  in `src/analytics/management.ts`, built field by field there: constants and
  bounded tokens, never an error message, a request value or a credential.
  Never write it from the application request path.
- Everything the optional `ANALYTICS` binding is sent is declared in
  `src/analytics/hook.ts`, built field by field there. Never pass it anything
  else, and never call it from the application request path.

## Verification

- `pnpm run check` — types across every project, plus generated-OpenAPI drift.
  About five seconds. Run it after every edit.
- `pnpm run test` — both test suites and the deploy-script tests, about a
  minute. Run it when a change touches behaviour, and while working on one
  prefer the files that cover it:
  `pnpm exec vitest run test/<name>.test.ts` for the Worker, or
  `pnpm --filter @app-ai-gateway/console exec vitest run src/<path>.test.tsx`
  for the console. Do not use `vitest --changed`: nearly every test imports the
  shared routes, so it selects most of the suite anyway.
- `pnpm run verify` — both of the above, once, before a commit or hand-off. It
  costs essentially no more than `pnpm run test` alone, because the checks run
  alongside the suites rather than after them.
- `verify` does not cover Worker configuration (`pnpm run deploy:dry-run`) or
  `docs/` (`pnpm run docs:build`).
- `smoke/` holds checks that run against a live deployment, not the code; see
  `smoke/README.md`. `verify` only typechecks them and runs the mock's offline
  tests. Each check is a contract with existing clients, and older releases'
  checks keep running against newer deployments: add a check for new
  behaviour, and change an existing assertion only when that contract changes
  on purpose, saying so in the pull request. Never print what `smoke/.state/`
  holds: it contains application keys.
- In tests, use `seedHuman` from `test/helpers.ts` rather than signing up, which
  costs about two and a half seconds.
- Do not verify a change by driving the app in a browser unless explicitly asked.
