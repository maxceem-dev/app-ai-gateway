import { Hono } from "hono";
import { sendSupportMessage } from "../../management/support";
import { adminRouter } from "../catalog-router";
import type { AdminVariables } from "../../middleware/admin";

type SupportEnv = { Bindings: Env; Variables: AdminVariables };

/** The console's Support menu; see `src/management/support.ts`. */
export const supportRoutes = new Hono<SupportEnv>();

adminRouter(supportRoutes).handle("sendSupportMessage", (c, { body }) => {
  const state = c.get("authState");
  const actor = c.get("actor");
  return sendSupportMessage(c.env, c.get("deployment"), {
    userId: actor.userId,
    email: state.user?.email,
    name: state.user?.name,
    organizationId: actor.organizationId,
    organizationName: state.organization?.name,
  }, body, c.get("billingRequestCache"));
});
