import type { OperationHandler, OperationHandlerTable } from "../executor";
import { accountHandlers } from "./account";
import { appHandlers } from "./apps";
import { authEventHandlers } from "./auth-events";
import { keyHandlers } from "./keys";
import { operationHandlers } from "./operations";
import { priceHandlers } from "./prices";
import { providerGatewayHandlers } from "./provider-gateways";
import { providerHandlers } from "./providers";
import { supportHandlers } from "./support";
import { usageHandlers } from "./usage";
import { userHandlers } from "./users";

/**
 * Every operation any transport may run without HTTP of its own: the handler
 * takes the operation's parsed input and nothing else, so the HTTP adapter and
 * any later one call the same function through `runOperation`.
 *
 * What stays out is what needs the request itself — a cookie it sets, the
 * identity instance built from it, a relayed response, or a step of the CLI
 * handoff — and is mounted in `src/routes` with a handler of its own.
 */
const HANDLERS = {
  ...priceHandlers,
  ...appHandlers,
  ...keyHandlers,
  ...userHandlers,
  ...usageHandlers,
  ...authEventHandlers,
  ...providerHandlers,
  ...providerGatewayHandlers,
  ...accountHandlers,
  ...operationHandlers,
  ...supportHandlers,
} satisfies OperationHandlerTable;

/** The operations {@link OPERATION_HANDLERS} serves. */
export type RegisteredOperation = keyof typeof HANDLERS;

/**
 * The same table, typed so that indexing it with an operation name yields that
 * operation's handler even while the name is generic.
 */
export const OPERATION_HANDLERS: { readonly [K in RegisteredOperation]: OperationHandler<K> } = HANDLERS;
