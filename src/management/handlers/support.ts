import type { OperationHandlerTable } from "../executor";
import { sendSupportMessage } from "../support";

export const supportHandlers = {
  sendSupportMessage: ({ scope, actor, state, body }) => sendSupportMessage({ scope, actor, state, body }),
} satisfies OperationHandlerTable;
