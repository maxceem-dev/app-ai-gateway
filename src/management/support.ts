import { getBillingAccess, type BillingRequestCache } from "../billing/gateway";
import { SUPPORT_TOPICS, type SupportMessageRequest } from "../contracts/schemas";
import type { SupportMessageResponse } from "../contracts/responses";
import { enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import { errorFacts } from "../core/error-facts";
import { GatewayError } from "../core/errors";
import { log } from "../core/log";
import { emailSender, emailSetup } from "../email/sender";
import type { Deployment } from "../policy/deployment";

/**
 * Messages from the console's Support menu to the deployment's support inbox.
 *
 * Support is part of a paid plan, so it exists only where there are plans and
 * a way to send email, and only for an organization holding one. The email is
 * sent from the deployment's own address with the person's as its reply-to, so
 * answering it in the inbox answers them, and the conversation carries on in
 * email rather than in the console.
 */

/** Addresses accepted as an inbox: the same bare `local@domain` the sender reads. */
const INBOX_ADDRESS = /^[^\s<>()[\],;:"\\@\x00-\x1f\x7f]+@[^\s<>()[\],;:"\\@\x00-\x1f\x7f]+$/;

const SENDER_NAME = "App AI Gateway Support";

/**
 * The inbox the Support menu writes to, or null where the deployment offers no
 * support: no `SUPPORT_EMAIL`, no billing to tell a paid plan from a free one,
 * or no working way to send email. Reads strings only, so the public
 * capabilities answer can ask it on every request.
 */
export function supportInbox(env: Env, deployment: Deployment): string | null {
  const inbox = env.SUPPORT_EMAIL?.trim();
  if (!inbox || !INBOX_ADDRESS.test(inbox)) return null;
  if (deployment.billing === null) return null;
  return emailSetup(env).state === "ok" ? inbox : null;
}

/** Who is writing, as the session names them. */
export interface SupportSender {
  userId: string;
  email: string | null | undefined;
  name: string | null | undefined;
  organizationId: string;
  organizationName: string | null | undefined;
}

export async function sendSupportMessage(
  env: Env,
  deployment: Deployment,
  sender: SupportSender,
  input: SupportMessageRequest,
  cache?: BillingRequestCache,
): Promise<SupportMessageResponse> {
  const inbox = supportInbox(env, deployment);
  if (inbox === null) throw new GatewayError(404, "not_found", "This deployment does not offer support");

  /*
   * A paid plan is one that is not the service's default. An outage is not a
   * statement about the organization, and it is exactly when a paying customer
   * most needs to write in, so a message is still sent while billing cannot be
   * reached; the email says the plan could not be read.
   */
  const access = await getBillingAccess(deployment, sender.organizationId, cache);
  const plan = access.state === "billed" ? access.plan : null;
  if (access.state !== "unavailable" && (plan === null || plan.isDefault)) {
    throw new GatewayError(403, "forbidden", "Support is included with paid plans");
  }
  if (!sender.email) throw new GatewayError(409, "conflict", "This sign-in has no email address to reply to");

  await enforceEndpointRateLimit(env, "support_message", sender.userId);

  const facts: [string, string][] = [
    ["From", sender.name?.trim() ? `${sender.name.trim()} <${sender.email}>` : sender.email],
    ["User", sender.userId],
    ["Organization", sender.organizationName ? `${sender.organizationName} (${sender.organizationId})` : sender.organizationId],
    ["Plan", plan ? plan.planName : "unknown (billing unreachable)"],
    ...(input.page ? [["Page", new URL(input.page, deployment.consoleOrigin()).toString()] as [string, string]] : []),
  ];
  // The sender's address in it keeps two people's messages from threading
  // together, since every one comes from the same address with the same topic.
  const subject = `${SUPPORT_TOPICS[input.kind]} from ${sender.email}`;

  // `supportInbox` already required a sender that is ready.
  const setup = emailSetup(env) as Extract<ReturnType<typeof emailSetup>, { state: "ok" }>;
  const sendWith = emailSender(env)!;
  try {
    await sendWith.send({
      from: { email: setup.from, name: SENDER_NAME },
      replyTo: sender.email,
      to: inbox,
      subject,
      text: [input.message, "", "---", ...facts.map(([label, value]) => `${label}: ${value}`)].join("\n"),
      html: [
        `<div style="white-space:pre-wrap">${escapeHtml(input.message)}</div>`,
        "<hr>",
        `<table style="font-size:12px;color:#666">${facts
          .map(([label, value]) => `<tr><td style="padding-right:12px">${label}</td><td>${escapeHtml(value)}</td></tr>`)
          .join("")}</table>`,
      ].join(""),
    });
  } catch (error) {
    log("error", "support_email_failed", { transport: sendWith.transport, error: errorFacts(error) });
    throw new GatewayError(503, "email_unavailable", "Your message could not be sent. Try again in a few minutes.");
  }
  return { status: "sent", replyTo: sender.email };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
