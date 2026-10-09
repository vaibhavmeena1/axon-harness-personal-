import { join } from "node:path";

import type { PiConfig } from "../../cli/client-config.ts";
import { withFileLock } from "../../launcher/file-lock.ts";
import type { AxonPaths } from "../../product/paths.ts";
import { piSettingsPath, readPiSettings, writePiSettings } from "./setup/packages/settings.ts";

function settingsObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pi LiteLLM settings must be an object");
  }
  return value as Record<string, unknown>;
}

function isManagedRelayModel(value: unknown): boolean {
  if (value === null || typeof value !== "object" || !("baseUrl" in value)) return false;
  if (typeof value.baseUrl !== "string") return false;
  try {
    const url = new URL(value.baseUrl);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      (url.pathname === "/litellm" || url.pathname === "/litellm/v1")
    );
  } catch {
    return false;
  }
}

/** Configure the installed provider without saving a session token or a relay capability. */
export async function applyPiProviderDefaults(paths: AxonPaths): Promise<void> {
  await withFileLock(paths.piPackageLock, async () => {
    const settings = await readPiSettings(piSettingsPath(paths.pi));
    const litellm = settingsObject(settings.config["litellm"]);
    const mcp = settingsObject(litellm["mcp"]);
    const config = {
      ...settings.config,
      // The LiteLLM MCP bridge is optional and requires separate upstream permissions.
      // Keep explicitly configured MCP preferences and all organization MCP servers.
      litellm: { ...litellm, mcp: { enabled: false, ...mcp } },
    };

    const store = await readPiSettings(join(paths.pi, "models-store.json"));
    const cachedProvider = store.config["litellm"];
    if (
      cachedProvider !== null &&
      typeof cachedProvider === "object" &&
      "models" in cachedProvider
    ) {
      const models = cachedProvider.models;
      if (Array.isArray(models) && models.some(isManagedRelayModel)) {
        // This derived catalog belongs to a previous ephemeral relay. Pi applies its
        // stored catalog over the extension's freshly discovered startup models, then
        // hides the old endpoints. Invalidate just this provider so the fresh seed wins.
        const { litellm: _staleCatalog, ...otherProviders } = store.config;
        await writePiSettings(store, otherProviders);
      }
    }

    if (JSON.stringify(settings.config) !== JSON.stringify(config)) {
      await writePiSettings(settings, config);
    }
  });
}

/** Apply startup defaults only; project settings and Pi CLI flags can still override them. */
export async function applyPiDefaults(paths: AxonPaths, defaults: PiConfig): Promise<void> {
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

      if (JSON.stringify(current) !== JSON.stringify(tools)) {
        await writePiSettings(settings, { ...settings.config, defaultTools: tools });
      }
    },
    { timeoutMs: 700 },
  );
}
