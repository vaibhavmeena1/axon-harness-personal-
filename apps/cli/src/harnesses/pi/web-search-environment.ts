import type { WebSearchConfig } from "../../cli/client-config.ts";
import type { EnvironmentOverrides } from "../../launcher/environment.ts";

export function isWebSearchDisabled(environment: NodeJS.ProcessEnv): boolean {
  const enabled = Reflect.get(environment, "PI_WEB_SEARCH_ENABLED") as string | undefined;
  return ["false", "0", "no", "off"].includes(enabled?.trim().toLowerCase() ?? "");
}

function boundedSetting(raw: string | undefined, maximum: number): string {
  const value = Number(raw);
  return String(Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum);
}

/** Pin authenticated routing; backend preferences configure the extension, not LiteLLM authorization. */
export function createWebSearchOverrides(
  environment: NodeJS.ProcessEnv,
  relay: { readonly origin: string; readonly capability: string },
  policy?: WebSearchConfig,
  offline = false,
): EnvironmentOverrides {
  const overrides: Record<string, string | undefined> = {
    PI_WEB_SEARCH_URL: new URL("/litellm/v1/chat/completions", relay.origin).toString(),
    PI_WEB_SEARCH_BASE_URL: undefined,
    PI_WEB_SEARCH_MODE: undefined,
    PI_WEB_SEARCH_SEARCH_TOOL: undefined,
    PI_WEB_SEARCH_API_KEY: relay.capability,
    PI_WEB_SEARCH_ENABLED:
      offline || isWebSearchDisabled(environment) || policy?.enabled === false ? "false" : "true",
  };
  if (policy === undefined) return overrides;

  Object.assign(overrides, {
    PI_WEB_SEARCH_TEMPERATURE: String(policy.temperature),
    PI_WEB_SEARCH_THINKING_LEVEL: policy.thinkingLevel ?? undefined,
    PI_WEB_SEARCH_SEARCH_CONTEXT_SIZE: policy.searchContextSize ?? undefined,
    PI_WEB_SEARCH_USE_URL_CONTEXT: String(policy.useUrlContext),
    PI_WEB_SEARCH_REQUIRE_GROUNDING: String(policy.requireGrounding),
  });
  const preferredModel = (
    Reflect.get(environment, "PI_WEB_SEARCH_MODEL") as string | undefined
  )?.trim();
  Reflect.set(
    overrides,
    "PI_WEB_SEARCH_MODEL",
    preferredModel && policy.allowedModels.includes(preferredModel) ? preferredModel : policy.model,
  );
  for (const [name, maximum] of [
    ["PI_WEB_SEARCH_TIMEOUT_MS", policy.timeoutMs],
    ["PI_WEB_SEARCH_MAX_QUERY_CHARACTERS", policy.maxQueryCharacters],
    ["PI_WEB_SEARCH_MAX_RESULT_CHARACTERS", policy.maxResultCharacters],
    ["PI_WEB_SEARCH_MAX_OUTPUT_TOKENS", policy.maxOutputTokens],
    ["PI_WEB_SEARCH_MAX_SOURCES", policy.maxSources],
  ] as const) {
    overrides[name] = boundedSetting(environment[name], maximum);
  }
  return overrides;
}
