import type { AuthState } from "@maxceem/cf-auth";
import { Hono, type Context } from "hono";
import type { ConsoleCapabilitiesResponse } from "../contracts/responses";
import { googleAuthEnabled, identityAuthFor, MANAGEMENT_IDENTITY } from "../auth/identity";
import { registrationOpen } from "../policy/deployment";
import { clientAddress, enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import { GatewayError } from "../core/errors";
import { confirmEmailVerification, sendVerificationEmail } from "../auth/email-verification";
import { publicApiOrigin } from "../core/public-api-url";
import { supportInbox } from "../management/support";
import {
  allowOauthConsent,
  continueOauthWithoutAccount,
  denyOauthConsent,
  oauthConsentDetails,
} from "../management/oauth-consent";
import { managementActor, type AdminVariables } from "../middleware/admin";
import { catalogRouter } from "./catalog-router";
import { assertConsoleOrigin } from "./console-origin";

type ConsoleEnv = { Bindings: Env; Variables: AdminVariables };

export const consoleRoutes = new Hono<ConsoleEnv>();

function optionalUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

consoleRoutes.get("/capabilities", async (c) => c.json({
  billing: c.get("deployment").billing !== null,
  registrationOpen: registrationOpen(c.get("deployment")),
  googleAuth: googleAuthEnabled(c.env),
  // Legal documents are deployment-specific. The console shows the sign-up
  // consent line only when the operator configured both links.
  termsOfServiceUrl: optionalUrl(c.env.TERMS_OF_SERVICE_URL),
  privacyPolicyUrl: optionalUrl(c.env.PRIVACY_POLICY_URL),
  // Present only where the deployment publishes a separate host for application
  // clients; otherwise the console builds client URLs from its own origin.
  apiBaseUrl: publicApiOrigin(c.env),
  emailVerification: c.get("deployment").emailVerification === "required",
  supportEmail: supportInbox(c.env, c.get("deployment")) ?? undefined,
} satisfies ConsoleCapabilitiesResponse));

/**
 * The session this browser holds, read from its cookie alone: a key or an
 * OAuth token is no one here, because consenting is a person's act.
 */
async function browserSession(c: Context<ConsoleEnv>): Promise<AuthState> {
  const identity = await identityAuthFor(c, MANAGEMENT_IDENTITY);
  await identity.middleware<ConsoleEnv>({
    apiKeys: false,
    oauth: false,
    syncCurrentOrganizationCookie: false,
  })(c, async () => {});
  return c.get("authState");
}

// What the consent page is told is for this browser, now: never cached, and
// nothing about it handed on as a referrer.
consoleRoutes.use("/oauth/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
});

/*
 * The OAuth consent page's API. The console's own pages call it, so the
 * request has to come from the console's origin before anything else is read,
 * the way the CLI's browser handoff is guarded; allowing additionally takes
 * the person's session, which the catalog's `session` security and policy
 * then hold to an interactive human.
 */
const routes = catalogRouter(consoleRoutes, "/v1/console", {
  authorized: true,
  authenticate: async (c) => {
    assertConsoleOrigin(c);
    c.set("actor", await managementActor(await browserSession(c)));
  },
});

routes.handle("getOauthConsentDetails", async (c, { params, body, scope }) => {
  const session = await browserSession(c);
  return oauthConsentDetails(scope, session.authenticated ? session : null, params.id, body);
}, { before: assertConsoleOrigin });

routes.handle("allowOauthConsent", (_c, { params, body, state, scope }) =>
  allowOauthConsent(scope, state, params.id, body), { before: assertConsoleOrigin });

routes.handle("continueOauthWithoutAccount", (c, { params, body, scope }) =>
  continueOauthWithoutAccount(scope, params.id, body, clientAddress(c.req.raw)), { before: assertConsoleOrigin });

routes.handle("denyOauthConsent", (_c, { params, body, scope }) =>
  denyOauthConsent(scope, params.id, body), { before: assertConsoleOrigin });

/*
 * Email verification. Sending needs a person signed in to this browser, and
 * nothing more: whoever approves a claim has no account yet, and has to verify
 * before they can. Confirming needs nothing but the link, so it can be opened
 * on another device than the one that asked for it.
 */
routes.handle("sendVerificationEmail", async (c, { body }) => {
  const session = await browserSession(c);
  const user = session.authenticated ? session.user : null;
  if (!user || user.kind !== "human" || session.assurance !== "interactive") {
    throw new GatewayError(401, "session_required", "Sign in to the console to send a verification link");
  }
  const deployment = c.get("deployment");
  if (deployment.emailVerification === "off") {
    throw new GatewayError(409, "conflict", "This deployment does not verify email addresses");
  }
  if (!user.email) throw new GatewayError(409, "conflict", "This sign-in has no email address");
  if (user.emailVerified) return { status: "already_verified" as const, email: user.email };
  await enforceEndpointRateLimit(c.env, "verification_email", user.id);
  await sendVerificationEmail(
    c.env,
    deployment,
    { id: user.id, email: user.email },
    body.returnTo ?? null,
  );
  return { status: "sent" as const, email: user.email };
}, { before: assertConsoleOrigin });

routes.handle("confirmEmailVerification", (c, { body }) =>
  confirmEmailVerification(c.env, body.token), { before: assertConsoleOrigin });
