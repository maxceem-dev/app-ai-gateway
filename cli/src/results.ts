import type {
  CliAccountResponse,
  CliCapabilitiesResponse,
  CliLogin,
  CliOperation,
} from "../../src/contracts/cli.ts";
import type { AppResult } from "./apps.ts";
import type { Onboarding } from "./context.ts";
import type { DeploymentResult } from "./deployment.ts";
import type { ResourceResult } from "./resources.ts";
import type { SupportResult } from "./support.ts";
import type { UsageResult } from "./usage.ts";

/** What `agw deployment status` reports about the selected connection. */
export type DeploymentStatusResult = CliCapabilitiesResponse & {
  url: string;
  authenticated: boolean;
  connected: true;
};

/** Everything a command can return, and therefore everything stdout can carry. */
export type CommandResult =
  | ResourceResult
  | AppResult
  | UsageResult
  | SupportResult
  | DeploymentResult
  | DeploymentStatusResult
  | CliAccountResponse
  | (CliAccountResponse & { connected: true })
  | CliOperation
  | CliLogin
  | { loggedOut: true; revoked?: boolean };

/**
 * A result as it is printed. A first-run command folds the account it just
 * created into its own answer, which is where the free-access dates come from.
 */
export type RenderedResult = CommandResult | (CommandResult & Onboarding);
