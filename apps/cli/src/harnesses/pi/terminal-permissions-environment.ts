import type { TerminalPermissionsConfig } from "../../cli/client-config.ts";
import type { EnvironmentOverrides } from "../../launcher/environment.ts";

export function createTerminalPermissionsOverrides(
  policy?: TerminalPermissionsConfig,
): EnvironmentOverrides {
  return {
    // Never accept an inherited launcher marker as a fetched policy. Without a
    // backend response, the extension uses local settings and approval defaults.
    PI_TERMINAL_MANAGED_CONFIG: policy === undefined ? undefined : JSON.stringify(policy),
  };
}
