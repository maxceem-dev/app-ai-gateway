import type { AuthState } from "@maxceem/cf-auth";
import { getBillingAccess } from "../billing/gateway";
import type { SupportMessageRequest } from "../contracts/schemas";
import type { SupportMessageResponse } from "../contracts/responses";
import { enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import { errorFacts } from "../core/error-facts";
import { GatewayError } from "../core/errors";
import { log } from "../core/log";
import type { HelpdeskChannel, HelpdeskTicketResult } from "../helpdesk/contract";
import type { Deployment } from "../policy/deployment";
import type { AdminActor } from "./actor";
import type { ManagementScope } from "./scope";

/**
 * Messages to human support, from the console's Human Support menu,
 * `agw support send` and the MCP `contact_support` tool alike.
 *
 * Support is part of a paid plan, so it exists only where there are plans and
 * a help desk bound as `HELPDESK`, and only for an organization holding one.
 * The help desk keeps the ticket, refuses a pasted credential, recognises a
 * repeated message, and emails the support inbox with the person's address as
 * the reply-to, so the conversation carries on in email rather than in the
 * console.
 */

/** The gateway's id at the help desk. */
export const HELPDESK_SERVICE_ID = "app-ai-gateway";

/** Addresses accepted as an inbox: a bare `local@domain`. */
const INBOX_ADDRESS = /^[^\s<>()[\],;:"\\@\x00-\x1f\x7f]+@[^\s<>()[\],;:"\\@\x00-\x1f\x7f]+$/;

/** The help desk's channel for each credential source. */
const CHANNELS: Record<string, HelpdeskChannel> = {
  web: "console",
  cli: "cli",
  mcp: "mcp",
  api: "api",
};

/**
 * The inbox the Human Support menu names, or null where the deployment offers
 * no support: no `HELPDESK` binding, no `SUPPORT_EMAIL` to show, or no billing
 * to tell a paid plan from a free one. The address is only shown, for people
 * who prefer their own mail app; the help desk decides where tickets go.
 * Reads the environment only, so the public capabilities answer can ask it on
 * every request.
 */
export function supportInbox(env: Env, deployment: Deployment): string | null {
  if (!env.HELPDESK) return null;
  const inbox = env.SUPPORT_EMAIL?.trim();
  if (!inbox || !INBOX_ADDRESS.test(inbox)) return null;
  return deployment.billing === null ? null : inbox;
}

export async function sendSupportMessage(input: {
  scope: ManagementScope;
  actor: AdminActor;
  state: AuthState;
  body: SupportMessageRequest;
}): Promise<SupportMessageResponse> {
  const { scope, actor, state, body } = input;
  const { env, deployment } = scope;
  const helpdesk = env.HELPDESK;
  if (!helpdesk || supportInbox(env, deployment) === null) {
    throw new GatewayError(404, "not_found", "This deployment does not offer human support");
  }

  /*
   * A paid plan is one that is not the service's default. An outage is not a
   * statement about the organization, and it is exactly when a paying customer
   * most needs to write in, so a message is still sent while billing cannot be
   * reached; the ticket says the plan could not be read.
   */
  const access = await getBillingAccess(deployment, actor.organizationId, scope.billingCache);
  const plan = access.state === "billed" ? access.plan : null;
  if (access.state !== "unavailable" && (plan === null || plan.isDefault)) {
    throw new GatewayError(
      403,
      "support_plan_required",
      "Human support is included with paid plans. An account owner can choose one on the Billing page of the console.",
    );
  }
  const email = state.user?.email;
  if (!email) throw new GatewayError(409, "conflict", "This credential's owner has no email address to reply to");

  await enforceEndpointRateLimit(env, "support_message", actor.userId);

  const name = state.user?.name?.trim();
  const organizationName = state.organization?.name?.trim();
  let result: HelpdeskTicketResult;
  try {
    result = await helpdesk.createTicket({
      serviceId: HELPDESK_SERVICE_ID,
      kind: body.kind,
      message: body.message,
      customer: { email, userId: actor.userId, ...(name ? { name: name.slice(0, 200) } : {}) },
      account: {
        tenantId: actor.organizationId,
        ...(organizationName ? { name: organizationName.slice(0, 200) } : {}),
        plan: plan ? plan.planName.slice(0, 100) : "unknown (billing unreachable)",
      },
      channel: CHANNELS[state.source ?? "api"] ?? "api",
      ...(body.client ? { client: body.client } : {}),
      ...(body.page ? { page: new URL(body.page, deployment.consoleOrigin()).toString() } : {}),
      ...(body.context ? { context: body.context } : {}),
    });
  } catch (error) {
    log("error", "support_helpdesk_failed", { error: errorFacts(error) });
    throw new GatewayError(503, "email_unavailable", "Your message could not be sent. Try again in a few minutes.");
  }

  if (result.ok) {
    return { status: "sent", reference: result.reference, replyTo: result.replyTo, duplicate: result.duplicate };
  }
  switch (result.code) {
    case "invalid_input":
    case "credential_detected":
      throw new GatewayError(400, "invalid_request", result.message);
    case "rate_limited":
      throw new GatewayError(
        429,
        "rate_limited",
        result.message,
        result.retryAfterSeconds === undefined ? undefined : { "Retry-After": String(result.retryAfterSeconds) },
      );
    case "unknown_service":
      log("error", "support_helpdesk_unknown_service", { serviceId: HELPDESK_SERVICE_ID });
      throw new GatewayError(404, "not_found", "This deployment does not offer human support");
  }
}
