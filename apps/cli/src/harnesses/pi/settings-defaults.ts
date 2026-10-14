import { join } from "node:path";

import type { PiConfig } from "../../cli/client-config.ts";
import { withFileLock } from "../../launcher/file-lock.ts";
import type { AxonPaths } from "../../product/paths.ts";
import { piOptionTokens } from "./setup/packages/invocation.ts";
import { piSettingsPath, readPiSettings, writePiSettings } from "./setup/packages/settings.ts";

/** Pi's automatic pair format: the light theme first, the dark theme second. */
export const AXON_THEME_SETTING = "axon-light/axon-dark";

function settingsObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pi LiteLLM settings must be an object");
  }
  return value as Record<string, unknown>;
}

/** Configure the installed provider without saving a session token or a relay capability. */
export async function applyPiProviderDefaults(paths: AxonPaths): Promise<void> {
  // Cache cleanup belongs to the adapter, which knows whether discovery will replace stale models.
  // Keep optional cache failures separate from required provider settings initialization.
  await withFileLock(paths.piPackageLock, async () => {
    const settings = await readPiSettings(piSettingsPath(paths.pi));
    const litellm = settingsObject(settings.config["litellm"]);
    const mcp = settingsObject(litellm["mcp"]);
    const config = {
      ...settings.config,
      // Without a fetched backend policy, leave the optional bridge off by default.
      // Keep previously applied/local preferences and all organization MCP servers.
      litellm: { ...litellm, mcp: { enabled: false, ...mcp } },
    };

    if (JSON.stringify(settings.config) !== JSON.stringify(config)) {
      await writePiSettings(settings, config);
    }
  });
}

/** Apply managed defaults; project settings and Pi CLI flags can still override them. */
export async function applyPiDefaults(
  paths: AxonPaths,
  defaults: PiConfig,
  options: { readonly beforeWrite?: () => Promise<void> } = {},
): Promise<void> {
  // Share the package synchronizer's lock because both update the same settings file.
  await withFileLock(
    paths.piPackageLock,
    async () => {
      const settings = await readPiSettings(piSettingsPath(paths.pi));
      const current = settings.config["defaultTools"];
      if (
        current !== undefined &&
        (!Array.isArray(current) || current.some((entry) => typeof entry !== "string"))
      ) {
        throw new Error("Pi defaultTools must be an array of strings");
      }

      let tools: string[];
      if (Array.isArray(current) && current.length === 0) {
        // Adding only a modifier to [] would accidentally restore Pi's built-in defaults.
        tools = defaults.codemodeEnabled ? ["codemode"] : [];
      } else {
        tools = ((current as string[] | undefined) ?? []).filter(
          (entry) => entry !== "+codemode" && entry !== "-codemode",
        );
        if (!defaults.codemodeEnabled || !tools.includes("codemode")) {
          tools.push(defaults.codemodeEnabled ? "+codemode" : "-codemode");
        }
      }

      const litellm = settingsObject(settings.config["litellm"]);
      const mcp = settingsObject(litellm["mcp"]);
      const config = {
        ...settings.config,
        defaultTools: tools,
        litellm: { ...litellm, mcp: { ...mcp, enabled: defaults.litellmMcpEnabled } },
      };
      if (JSON.stringify(settings.config) !== JSON.stringify(config)) {
        // Recheck the credential/cancellation after waiting for the shared settings lock.
        await options.beforeWrite?.();
        await writePiSettings(settings, config);
      }
    },
    { timeoutMs: 700 },
  );
}

/**
 * Select Axon's themes until the user picks one. `--use-theme` lasts for this run only, so a theme
 * saved through /settings (global or project) or passed explicitly always takes precedence.
 */
export async function axonThemeArguments(
  paths: AxonPaths,
  cwd: string,
  userArguments: readonly string[],
): Promise<readonly string[]> {
  if (piOptionTokens(userArguments).includes("--use-theme")) return [];
  for (const path of [piSettingsPath(paths.pi), join(cwd, ".pi", "settings.json")]) {
    try {
      if ((await readPiSettings(path)).config["theme"] !== undefined) return [];
    } catch {
      // Leave theme resolution to Pi when settings cannot be read safely.
      return [];
    }
  }
  return ["--use-theme", AXON_THEME_SETTING];
}
