import { join } from "node:path";
import type { PiConfig } from "../../cli/client-config.ts";
import { withFileLock } from "../../launcher/file-lock.ts";
import type { AxonPaths } from "../../product/paths.ts";
import { piOptionTokens } from "./setup/packages/invocation.ts";
import { piSettingsPath, readPiSettings, writePiSettings } from "./setup/packages/settings.ts";

/** Pi's automatic pair format: the light theme first, the dark theme second. */
export const AXON_THEME_SETTING = "axon-light/axon-dark";

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
