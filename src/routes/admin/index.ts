import { Hono } from "hono";
import { adminRouter } from "../catalog-router";
import type { AdminVariables } from "../../middleware/admin";
import { appRoutes } from "./apps";
import { authEventRoutes } from "./auth-events";
import { keyRoutes } from "./keys";
import { operationRoutes } from "./operations";
import { usageRoutes } from "./usage";
import { userRoutes } from "./users";
import { managementKeyRoutes } from "./management-keys";
import { providerRoutes } from "./providers";
import { providerGatewayRoutes } from "./provider-gateways";
import { organizationRoutes } from "./organizations";
import { billingRoutes } from "./billing";
import { supportRoutes } from "./support";

type AdminEnv = { Bindings: Env; Variables: AdminVariables };

export const adminRoutes = new Hono<AdminEnv>();

// Every operation under `/apps/{app}` resolves its application inside the
// caller's account in `runOperation`, before its policy runs.

/** Supplies the priced model catalog used by the proxy-policy editor. */
adminRouter(adminRoutes).handle("listModelPrices");

adminRoutes.route("/", appRoutes);
adminRoutes.route("/", keyRoutes);
adminRoutes.route("/", operationRoutes);
adminRoutes.route("/", userRoutes);
adminRoutes.route("/", usageRoutes);
adminRoutes.route("/", authEventRoutes);
adminRoutes.route("/", managementKeyRoutes);
adminRoutes.route("/", providerRoutes);
adminRoutes.route("/", providerGatewayRoutes);
adminRoutes.route("/", organizationRoutes);
adminRoutes.route("/billing", billingRoutes);
adminRoutes.route("/", supportRoutes);
