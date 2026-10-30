/**
 * The help desk contract this gateway is written against.
 *
 * Support tickets live in a separate help desk Worker, bound as the optional
 * `HELPDESK` service binding, so no product has to keep its own. The gateway
 * declares the shape it calls here, as it does for billing in
 * `src/billing/contract.ts`; any Worker that satisfies it can be bound. A
 * deployment that binds nothing offers no human support.
 *
 * Keep this file free of implementation. It is a wire contract: changing a
 * field here is a breaking change against the Worker on the other side.
 */

/** How the person reached the gateway, named by the help desk. */
export type HelpdeskChannel = "console" | "cli" | "mcp" | "api";

export interface HelpdeskTicketInput {
  /** The gateway's own id at the help desk, `HELPDESK_SERVICE_ID`. */
  serviceId: string;
  kind: "bug" | "support" | "feedback";
  message: string;
  /** The signed-in person: their address is where support replies. */
  customer: { email: string; name?: string; userId?: string };
  /** The organization. `tenantId` is stored by the help desk, never interpreted. */
  account?: { tenantId: string; name?: string; plan?: string };
  channel: HelpdeskChannel;
  client?: string;
  /** An absolute http(s) URL. */
  page?: string;
  context?: Record<string, string>;
  idempotencyKey?: string;
}

/**
 * Refusals come back as values, not exceptions: an exception crossing RPC
 * loses its type. A thrown call means the help desk itself is unreachable.
 */
export type HelpdeskTicketResult =
  | { ok: true; reference: string; duplicate: boolean; delivered: boolean; replyTo: string }
  | {
      ok: false;
      code: "invalid_input" | "credential_detected" | "unknown_service" | "rate_limited";
      message: string;
      retryAfterSeconds?: number;
    };

/** The RPC surface the `HELPDESK` service binding must expose. */
export interface HelpdeskRuntime {
  createTicket(input: HelpdeskTicketInput): Promise<HelpdeskTicketResult>;
}
